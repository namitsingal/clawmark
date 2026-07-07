import { l2Normalize, type EmbeddingClient } from "../src/embeddings.js";
import type { MessageBatch, MessageSource, SourceMessage } from "../src/sources/source.js";

/**
 * Deterministic fake embedder: hashes tokens into a small dense vector so related
 * texts get similar vectors and unrelated ones don't. `down = true` simulates outage.
 */
export function fakeEmbedder(dim = 32): EmbeddingClient & { down: boolean } {
  const embedOne = (text: string): Float32Array => {
    const vec = new Float32Array(dim);
    for (const token of text.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []) {
      let hash = 0;
      for (let i = 0; i < token.length; i++) hash = (hash * 31 + token.charCodeAt(i)) >>> 0;
      vec[hash % dim] += 1;
    }
    return l2Normalize(vec);
  };
  const client = {
    down: false,
    async embedTexts(texts: string[]) {
      return texts.map((t) => (client.down ? null : embedOne(t)));
    },
    async embedQuery(text: string) {
      return client.down ? null : embedOne(text);
    },
  };
  return client;
}

/** In-memory MessageSource for indexer/extractor/recall tests. */
export function memorySource(messages: SourceMessage[]): MessageSource {
  return {
    name: "lcm",
    validate: () => ({ ok: true }),
    messagesAfter(cursor: string | null, limit: number): MessageBatch {
      const after = cursor === null ? -1 : Number(cursor);
      const slice = messages.filter((m) => Number(m.ref) > after).slice(0, limit);
      if (slice.length === 0) return { messages: [], nextCursor: null };
      return { messages: slice, nextCursor: slice[slice.length - 1].ref };
    },
    getMessages(refs: string[]): SourceMessage[] {
      const byRef = new Map(messages.map((m) => [m.ref, m]));
      return refs.flatMap((r) => (byRef.has(r) ? [byRef.get(r)!] : []));
    },
  };
}

export function msg(id: number, text: string, opts: Partial<SourceMessage> = {}): SourceMessage {
  return {
    ref: String(id),
    conversationId: "c1",
    role: "user",
    text,
    ts: new Date().toISOString(),
    ...opts,
  };
}
