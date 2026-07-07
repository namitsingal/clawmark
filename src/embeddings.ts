import type { ClawmarkConfig } from "./config.js";

const EMBED_TIMEOUT_MS = 15_000;
const QUERY_CACHE_MAX = 512;

export interface EmbeddingClient {
  /** Embed a batch. Returns all-null on any failure — callers degrade, never throw. */
  embedTexts(texts: string[]): Promise<(Float32Array | null)[]>;
  /** Embed a single query with an LRU cache. */
  embedQuery(text: string): Promise<Float32Array | null>;
}

export function l2Normalize(vec: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

/** Dot product — inputs are pre-normalized, so this is cosine similarity. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) sum += a[i] * b[i];
  return sum;
}

export function serializeVector(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function deserializeVector(buf: Buffer): Float32Array {
  const copy = Buffer.from(buf); // ensure alignment
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

export function createEmbeddingClient(
  config: Pick<ClawmarkConfig, "embeddingUrl" | "embeddingModel" | "embeddingDim">,
  log: (msg: string) => void = () => {},
): EmbeddingClient {
  const queryCache = new Map<string, Float32Array | null>();

  const embedTexts = async (texts: string[]): Promise<(Float32Array | null)[]> => {
    if (texts.length === 0) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
    try {
      const res = await fetch(`${config.embeddingUrl}/v1/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: config.embeddingModel, input: texts }),
        signal: controller.signal,
      });
      if (!res.ok) {
        log(`embedding server returned ${res.status}`);
        return texts.map(() => null);
      }
      const payload = (await res.json()) as {
        data?: { index?: number; embedding?: number[] }[];
      };
      const out: (Float32Array | null)[] = texts.map(() => null);
      for (let i = 0; i < (payload.data?.length ?? 0); i++) {
        const item = payload.data![i];
        const idx = item.index ?? i;
        const emb = item.embedding;
        if (!Array.isArray(emb) || idx < 0 || idx >= out.length) continue;
        if (emb.length !== config.embeddingDim) {
          log(`embedding dim mismatch: expected ${config.embeddingDim}, got ${emb.length}`);
          continue;
        }
        out[idx] = l2Normalize(new Float32Array(emb));
      }
      return out;
    } catch (err) {
      log(`embedding request failed: ${String(err)}`);
      return texts.map(() => null);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    embedTexts,
    async embedQuery(text: string): Promise<Float32Array | null> {
      if (queryCache.has(text)) {
        const hit = queryCache.get(text)!;
        // refresh LRU position
        queryCache.delete(text);
        queryCache.set(text, hit);
        return hit;
      }
      const [vec] = await embedTexts([text]);
      // Don't cache failures — the server may just be down right now.
      if (vec !== null) {
        queryCache.set(text, vec);
        if (queryCache.size > QUERY_CACHE_MAX) {
          const oldest = queryCache.keys().next().value as string;
          queryCache.delete(oldest);
        }
      }
      return vec;
    },
  };
}
