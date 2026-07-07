import { MAX_INDEX_CHARS, MIN_INDEX_CHARS } from "./constants.js";
import { type Db, getCursor, setCursor } from "./db.js";
import { type EmbeddingClient, serializeVector } from "./embeddings.js";
import type { MessageSource } from "./sources/source.js";

const BATCH_SIZE = 100;

export function indexCursorName(source: MessageSource): string {
  return `index:${source.name}`;
}

/**
 * Incrementally embed new source messages into message_vectors.
 * Cursor advances in the same transaction as the inserts; an embedder outage
 * leaves the cursor untouched so the next trigger retries the same batch.
 */
export async function runIndexer(
  db: Db,
  source: MessageSource,
  embedder: EmbeddingClient,
): Promise<{ indexed: number }> {
  const cursorName = indexCursorName(source);
  let indexed = 0;
  for (;;) {
    const batch = source.messagesAfter(getCursor(db, cursorName), BATCH_SIZE);
    if (batch.messages.length === 0) {
      // Skipped-only progress (e.g. a stretch of tool lines) still advances the cursor.
      if (batch.nextCursor !== null) setCursor(db, cursorName, batch.nextCursor);
      return { indexed };
    }
    const eligible = batch.messages.filter((m) => m.text.trim().length >= MIN_INDEX_CHARS);
    const texts = eligible.map((m) => m.text.slice(0, MAX_INDEX_CHARS));
    const vectors = await embedder.embedTexts(texts);
    if (eligible.length > 0 && vectors.every((v) => v === null)) {
      // Embedding server down — retry this batch on the next trigger.
      return { indexed };
    }
    const insert = db.prepare(
      `INSERT OR IGNORE INTO message_vectors (source_ref, conversation_id, ts, embedding)
       VALUES (?, ?, ?, ?)`,
    );
    const commit = db.transaction(() => {
      for (let i = 0; i < eligible.length; i++) {
        const vec = vectors[i];
        if (vec === null) continue;
        insert.run(eligible[i].ref, eligible[i].conversationId, eligible[i].ts, serializeVector(vec));
        indexed++;
      }
      setCursor(db, cursorName, batch.nextCursor!);
    });
    commit();
    if (batch.messages.length < BATCH_SIZE) return { indexed };
  }
}
