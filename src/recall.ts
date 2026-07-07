import { DECAY_RATE, JACCARD_DUP_THRESHOLD, RECALL_MIN_COSINE } from "./constants.js";
import type { Db } from "./db.js";
import { cosine, deserializeVector, type EmbeddingClient } from "./embeddings.js";
import type { MessageSource } from "./sources/source.js";

export interface RecallResult {
  ref: string;
  ts: string;
  role: string;
  excerpt: string;
}

const EXCERPT_CHARS = 400;

function tokenSet(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Query-relevant retrieval: cosine over the full vector index with a recency decay,
 * then a cheap token-Jaccard diversity pass. Returns [] when the embedder is down —
 * facts still inject without recall.
 */
export async function recall(
  db: Db,
  source: MessageSource,
  embedder: EmbeddingClient,
  query: string,
  limit: number,
): Promise<RecallResult[]> {
  if (!query.trim() || limit <= 0) return [];
  const queryVec = await embedder.embedQuery(query);
  if (queryVec === null) return [];

  const now = Date.now();
  const scored: { ref: string; ts: string; score: number }[] = [];
  const rows = db
    .prepare("SELECT source_ref, ts, embedding FROM message_vectors")
    .iterate() as IterableIterator<{ source_ref: string; ts: string; embedding: Buffer }>;
  for (const row of rows) {
    const sim = cosine(queryVec, deserializeVector(row.embedding));
    if (sim < RECALL_MIN_COSINE) continue;
    const ageDays = Math.max(0, (now - Date.parse(row.ts)) / 86_400_000) || 0;
    scored.push({ ref: row.source_ref, ts: row.ts, score: sim * Math.exp(-DECAY_RATE * ageDays) });
  }
  scored.sort((a, b) => b.score - a.score);

  const candidates = scored.slice(0, limit * 3);
  const messages = new Map(source.getMessages(candidates.map((c) => c.ref)).map((m) => [m.ref, m]));
  const selected: RecallResult[] = [];
  const selectedTokens: Set<string>[] = [];
  for (const cand of candidates) {
    if (selected.length >= limit) break;
    const msg = messages.get(cand.ref);
    if (!msg) continue;
    const tokens = tokenSet(msg.text);
    if (selectedTokens.some((prev) => jaccard(prev, tokens) > JACCARD_DUP_THRESHOLD)) continue;
    selectedTokens.push(tokens);
    selected.push({
      ref: msg.ref,
      ts: msg.ts,
      role: msg.role,
      excerpt: msg.text.slice(0, EXCERPT_CHARS),
    });
  }
  return selected;
}
