import {
  CONFIDENCE_TIE_BAND,
  FACT_DECAY_RATE,
  FACT_FRESH_DAYS,
  FACT_KEY_PATTERN,
  FACT_PRUNE_DAYS,
  INJECTION_PATTERNS,
  MAX_FACT_KEY_LEN,
  MAX_FACT_VALUE_CHARS,
} from "./constants.js";
import { type Db, logEvent } from "./db.js";

export type FactSource = "user" | "extracted";

export type SetFactResult =
  | { ok: true; action: "create" | "update" | "reinforce" }
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

  // Reinforcement: the extractor re-observing an unchanged value is the staleness
  // antidote — refresh updated_at (and keep the higher confidence) instead of
  // running the conflict ladder, so the fact's decay clock resets.
  if (existing && source === "extracted" && value.trim().toLowerCase() === existing.value.trim().toLowerCase()) {
    db.prepare("UPDATE facts SET confidence = ?, updated_at = ? WHERE key = ?").run(
      Math.max(existing.confidence, clamped),
      new Date().toISOString(),
      key,
    );
    logEvent(db, { eventType: "reinforce", memoryKey: key, oldValue: existing.value, source });
    return { ok: true, action: "reinforce" };
  }

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

/**
 * Confidence as seen by injection: user-stated facts never decay; extracted facts
 * keep full confidence for FACT_FRESH_DAYS after their last write/reinforcement,
 * then decay exponentially. Facts drifting below the confidence threshold stop
 * injecting but remain stored (and auditable) until pruned.
 */
export function effectiveConfidence(
  fact: Pick<FactRow, "confidence" | "source" | "updated_at">,
  nowMs: number = Date.now(),
): number {
  if (fact.source === "user") return fact.confidence;
  const ageDays = Math.max(0, (nowMs - Date.parse(fact.updated_at)) / 86_400_000) || 0;
  if (ageDays <= FACT_FRESH_DAYS) return fact.confidence;
  return fact.confidence * Math.exp(-FACT_DECAY_RATE * (ageDays - FACT_FRESH_DAYS));
}

export interface StaleFact extends FactRow {
  days_since_reinforced: number;
  effective_confidence: number;
}

/** Extracted facts not reinforced for `olderThanDays` — the clawmark_review surface. */
export function staleFacts(db: Db, olderThanDays: number = FACT_FRESH_DAYS, nowMs: number = Date.now()): StaleFact[] {
  const cutoff = new Date(nowMs - olderThanDays * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT key, value, confidence, source, created_at, updated_at
       FROM facts WHERE is_deleted = 0 AND source = 'extracted' AND updated_at < ?
       ORDER BY updated_at ASC`,
    )
    .all(cutoff) as FactRow[];
  return rows.map((row) => ({
    ...row,
    days_since_reinforced: Math.floor((nowMs - Date.parse(row.updated_at)) / 86_400_000),
    effective_confidence: Number(effectiveConfidence(row, nowMs).toFixed(3)),
  }));
}

/** Tombstone extracted facts unreinforced past FACT_PRUNE_DAYS. Returns pruned count. */
export function pruneStaleFacts(db: Db, nowMs: number = Date.now()): number {
  const cutoff = new Date(nowMs - FACT_PRUNE_DAYS * 86_400_000).toISOString();
  const doomed = db
    .prepare("SELECT key, value FROM facts WHERE is_deleted = 0 AND source = 'extracted' AND updated_at < ?")
    .all(cutoff) as { key: string; value: string }[];
  if (doomed.length === 0) return 0;
  const prune = db.transaction(() => {
    const stmt = db.prepare("UPDATE facts SET is_deleted = 1, updated_at = ? WHERE key = ?");
    for (const fact of doomed) {
      stmt.run(new Date().toISOString(), fact.key);
      logEvent(db, { eventType: "delete", memoryKey: fact.key, oldValue: fact.value, source: "decay" });
    }
  });
  prune();
  return doomed.length;
}
