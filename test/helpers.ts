import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawmark-test-"));
}

/** Build a fixture Lossless Claw DB with the schema recorded in the LCM adapter. */
export function buildLcmFixture(dbPath: string, messages: { role: string; content: string; ts?: string }[]): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE conversations (
      conversation_id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT, session_key TEXT, active INTEGER
    );
    CREATE TABLE messages (
      message_id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      identity_hash TEXT,
      transcript_entry_id TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (conversation_id, seq)
    );
  `);
  db.prepare("INSERT INTO conversations (session_id, session_key, active) VALUES ('s1', 'k1', 1)").run();
  const insert = db.prepare(
    "INSERT INTO messages (conversation_id, seq, role, content, token_count, created_at) VALUES (1, ?, ?, ?, 0, ?)",
  );
  messages.forEach((m, i) => insert.run(i, m.role, m.content, m.ts ?? new Date().toISOString()));
  db.close();
}
