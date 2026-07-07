import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { MAX_EVENTS } from "./constants.js";

export type Db = Database.Database;

export type EventType =
  | "create"
  | "update"
  | "reinforce"
  | "delete"
  | "conflict_skip"
  | "injection_blocked"
  | "extract_error"
  | "reject"
  | "source_fallback";

export interface MemoryEvent {
  eventType: EventType;
  memoryKey: string;
  oldValue?: string | null;
  newValue?: string | null;
  source: string;
}

const MIGRATIONS: string[] = [
  // v1
  `
  CREATE TABLE facts (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      is_deleted INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_facts_deleted ON facts(is_deleted);

  CREATE TABLE message_vectors (
      source_ref TEXT PRIMARY KEY,
      conversation_id TEXT,
      ts TEXT NOT NULL,
      embedding BLOB NOT NULL
  );
  CREATE INDEX idx_vectors_ts ON message_vectors(ts);

  CREATE TABLE cursors (
      name TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
  );

  CREATE TABLE memory_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      memory_key TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
  );
  CREATE INDEX idx_events_key ON memory_events(memory_key);
  `,
];

export function openDb(dbPath: string): Db {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null };
  const current = row.v ?? 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    const apply = db.transaction(() => {
      db.exec(MIGRATIONS[i]);
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(
        i + 1,
        new Date().toISOString(),
      );
    });
    apply();
  }
  return db;
}

export function logEvent(db: Db, evt: MemoryEvent): void {
  db.prepare(
    `INSERT INTO memory_events (event_type, memory_key, old_value, new_value, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    evt.eventType,
    evt.memoryKey,
    evt.oldValue ?? null,
    evt.newValue ?? null,
    evt.source,
    new Date().toISOString(),
  );
}

export function rotateEvents(db: Db, maxRows: number = MAX_EVENTS): void {
  db.prepare(
    `DELETE FROM memory_events WHERE id <= (
       SELECT id FROM memory_events ORDER BY id DESC LIMIT 1 OFFSET ?
     )`,
  ).run(maxRows);
}

export function getCursor(db: Db, name: string): string | null {
  const row = db.prepare("SELECT value FROM cursors WHERE name = ?").get(name) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setCursor(db: Db, name: string, value: string): void {
  db.prepare(
    `INSERT INTO cursors (name, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(name, value, new Date().toISOString());
}
