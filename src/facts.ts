import {
  CONFIDENCE_TIE_BAND,
  FACT_KEY_PATTERN,
  INJECTION_PATTERNS,
  MAX_FACT_KEY_LEN,
  MAX_FACT_VALUE_CHARS,
} from "./constants.js";
import { type Db, logEvent } from "./db.js";

export type FactSource = "user" | "extracted";

export type SetFactResult =
  | { ok: true; action: "create" | "update" }
  | { ok: false; code: "KEY_FORMAT" | "VALUE_SIZE" | "CONFIDENCE" | "INJECTION" | "CONFLICT_SKIP"; reason: string };

export interface FactRow {
  key: string;
  value: string;
  confidence: number;
  source: string;
  created_at: string;
  updated_at: string;
}

export function setFact(
  db: Db,
  key: string,
  value: string,
  confidence: number,
  source: FactSource,
  confidenceThreshold: number,
): SetFactResult {
  if (key.length > MAX_FACT_KEY_LEN || key.includes("..") || !FACT_KEY_PATTERN.test(key)) {
    logEvent(db, { eventType: "reject", memoryKey: key, newValue: "KEY_FORMAT", source });
    return { ok: false, code: "KEY_FORMAT", reason: `invalid key "${key}"` };
  }
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_FACT_VALUE_CHARS) {
    logEvent(db, { eventType: "reject", memoryKey: key, newValue: "VALUE_SIZE", source });
    return { ok: false, code: "VALUE_SIZE", reason: `value must be 1..${MAX_FACT_VALUE_CHARS} chars` };
  }
  if (source === "extracted" && confidence < confidenceThreshold) {
    logEvent(db, { eventType: "reject", memoryKey: key, newValue: "CONFIDENCE", source });
    return { ok: false, code: "CONFIDENCE", reason: `confidence ${confidence} below ${confidenceThreshold}` };
  }
  if (INJECTION_PATTERNS.some((p) => p.test(value))) {
    logEvent(db, { eventType: "injection_blocked", memoryKey: key, newValue: value.slice(0, 200), source });
    return { ok: false, code: "INJECTION", reason: "value matched a prompt-injection pattern" };
  }

  const clamped = Math.max(0, Math.min(1, confidence));
  const existing = db
    .prepare("SELECT key, value, confidence, source FROM facts WHERE key = ? AND is_deleted = 0")
    .get(key) as Pick<FactRow, "key" | "value" | "confidence" | "source"> | undefined;

  if (existing) {
    const userWins = source === "user";
    const existingIsUser = existing.source === "user";
    const higherConfidence = clamped > existing.confidence;
    const tieBand = Math.abs(clamped - existing.confidence) < CONFIDENCE_TIE_BAND;
    const shouldWrite = userWins || (!existingIsUser && (higherConfidence || tieBand));
    if (!shouldWrite) {
      logEvent(db, {
        eventType: "conflict_skip",
        memoryKey: key,
        oldValue: existing.value,
        newValue: value,
        source,
      });
      return { ok: false, code: "CONFLICT_SKIP", reason: "existing fact wins by precedence/confidence" };
    }
  }

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO facts (key, value, confidence, source, created_at, updated_at, is_deleted)
     VALUES (?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value, confidence = excluded.confidence, source = excluded.source,
       updated_at = excluded.updated_at, is_deleted = 0`,
  ).run(key, value, clamped, source, now, now);
  logEvent(db, {
    eventType: existing ? "update" : "create",
    memoryKey: key,
    oldValue: existing?.value ?? null,
    newValue: value,
    source,
  });
  return { ok: true, action: existing ? "update" : "create" };
}

export function deleteFact(db: Db, key: string, source: string): boolean {
  const result = db
    .prepare("UPDATE facts SET is_deleted = 1, updated_at = ? WHERE key = ? AND is_deleted = 0")
    .run(new Date().toISOString(), key);
  if (result.changes > 0) {
    logEvent(db, { eventType: "delete", memoryKey: key, source });
    return true;
  }
  return false;
}

export function listFacts(db: Db): FactRow[] {
  return db
    .prepare(
      `SELECT key, value, confidence, source, created_at, updated_at
       FROM facts WHERE is_deleted = 0 ORDER BY updated_at DESC`,
    )
    .all() as FactRow[];
}
