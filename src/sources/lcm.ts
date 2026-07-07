import Database from "better-sqlite3";
import fs from "node:fs";
import type { MessageBatch, MessageSource, SourceMessage } from "./source.js";

/**
 * Read-only adapter over Lossless Claw's SQLite database (`lcm.db`).
 *
 * Schema (from lossless-claw src/db/migration.ts):
 *   messages(message_id INTEGER PK AUTOINCREMENT, conversation_id INTEGER, seq,
 *            role TEXT, content TEXT, token_count, identity_hash,
 *            transcript_entry_id, created_at TEXT)
 *
 * Cursor/ref = stringified message_id (monotonic autoincrement).
 * validate() checks the expected columns exist so a schema change in a future LCM
 * release degrades to the transcript source instead of crashing.
 */
const REQUIRED_COLUMNS = ["message_id", "conversation_id", "role", "content", "created_at"];

interface LcmRow {
  message_id: number;
  conversation_id: number;
  role: string;
  content: string;
  created_at: string;
}

function toMessage(row: LcmRow): SourceMessage {
  return {
    ref: String(row.message_id),
    conversationId: String(row.conversation_id),
    role: row.role,
    text: row.content,
    ts: row.created_at,
  };
}

export function openLcmSource(dbPath: string): MessageSource {
  let db: Database.Database | null = null;
  const open = (): Database.Database => {
    if (!db) db = new Database(dbPath, { readonly: true, fileMustExist: true });
    return db;
  };

  return {
    name: "lcm",
    validate() {
      if (!fs.existsSync(dbPath)) {
        return { ok: false, reason: `LCM database not found at ${dbPath}` };
      }
      try {
        const cols = open()
          .prepare("SELECT name FROM pragma_table_info('messages')")
          .all() as { name: string }[];
        const names = new Set(cols.map((c) => c.name));
        const missing = REQUIRED_COLUMNS.filter((c) => !names.has(c));
        if (cols.length === 0) return { ok: false, reason: "LCM 'messages' table not found" };
        if (missing.length > 0) {
          return { ok: false, reason: `LCM schema drift: missing columns ${missing.join(", ")}` };
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: `LCM database unreadable: ${String(err)}` };
      }
    },
    messagesAfter(cursor, limit): MessageBatch {
      const after = cursor === null ? 0 : Number(cursor);
      const rows = open()
        .prepare(
          `SELECT message_id, conversation_id, role, content, created_at
           FROM messages WHERE message_id > ? ORDER BY message_id ASC LIMIT ?`,
        )
        .all(after, limit) as LcmRow[];
      if (rows.length === 0) return { messages: [], nextCursor: null };
      return {
        messages: rows.map(toMessage),
        nextCursor: String(rows[rows.length - 1].message_id),
      };
    },
    getMessages(refs): SourceMessage[] {
      if (refs.length === 0) return [];
      const placeholders = refs.map(() => "?").join(",");
      const rows = open()
        .prepare(
          `SELECT message_id, conversation_id, role, content, created_at
           FROM messages WHERE message_id IN (${placeholders})`,
        )
        .all(...refs.map(Number)) as LcmRow[];
      const byRef = new Map(rows.map((r) => [String(r.message_id), toMessage(r)]));
      return refs.flatMap((ref) => {
        const msg = byRef.get(ref);
        return msg ? [msg] : [];
      });
    },
  };
}
