import { describe, expect, it } from "vitest";
import { buildContext } from "../src/context.js";
import { openDb } from "../src/db.js";
import {
  effectiveConfidence,
  listFacts,
  pruneStaleFacts,
  setFact,
  staleFacts,
} from "../src/facts.js";
import { fakeEmbedder, memorySource } from "./fakes.js";

const DAY = 86_400_000;
const THRESHOLD = 0.8;

function backdate(db: ReturnType<typeof openDb>, key: string, days: number): void {
  db.prepare("UPDATE facts SET updated_at = ? WHERE key = ?").run(
    new Date(Date.now() - days * DAY).toISOString(),
    key,
  );
}

describe("reinforcement", () => {
  it("re-emitting an unchanged extracted value refreshes updated_at and logs reinforce", () => {
    const db = openDb(":memory:");
    setFact(db, "pref.editor", "dark mode", 0.85, "extracted", THRESHOLD);
    backdate(db, "pref.editor", 120);
    const before = listFacts(db)[0].updated_at;

    const result = setFact(db, "pref.editor", "  Dark Mode ", 0.8, "extracted", THRESHOLD);
    expect(result.ok && result.action).toBe("reinforce");
    const after = listFacts(db)[0];
    expect(after.updated_at > before).toBe(true);
    expect(after.confidence).toBe(0.85); // keeps the higher confidence
    const events = db.prepare("SELECT event_type FROM memory_events").all() as { event_type: string }[];
    expect(events.some((e) => e.event_type === "reinforce")).toBe(true);
  });

  it("a changed value still goes through the conflict ladder, not reinforcement", () => {
    const db = openDb(":memory:");
    setFact(db, "pref.editor", "dark mode", 0.85, "extracted", THRESHOLD);
    const result = setFact(db, "pref.editor", "light mode", 0.9, "extracted", THRESHOLD);
    expect(result.ok && result.action).toBe("update");
    expect(listFacts(db)[0].value).toBe("light mode");
  });
});

describe("effectiveConfidence decay", () => {
  it("no decay inside the grace period; decay after; user facts never decay", () => {
    const now = Date.now();
    const fresh = { confidence: 0.9, source: "extracted", updated_at: new Date(now - 30 * DAY).toISOString() };
    const aging = { confidence: 0.9, source: "extracted", updated_at: new Date(now - 200 * DAY).toISOString() };
    const user = { confidence: 0.9, source: "user", updated_at: new Date(now - 400 * DAY).toISOString() };
    expect(effectiveConfidence(fresh, now)).toBeCloseTo(0.9, 5);
    expect(effectiveConfidence(aging, now)).toBeLessThan(0.4); // 110 days past grace
    expect(effectiveConfidence(user, now)).toBe(0.9);
  });

  it("decayed extracted facts stop injecting; user facts of the same age still inject", async () => {
    const db = openDb(":memory:");
    setFact(db, "pref.stale", "old extracted thing", 0.85, "extracted", THRESHOLD);
    setFact(db, "user.durable", "old but user-stated", 0.85, "user", THRESHOLD);
    backdate(db, "pref.stale", 250);
    backdate(db, "user.durable", 250);

    const block = await buildContext(db, memorySource([]), fakeEmbedder(), "", 6, THRESHOLD);
    expect(block).toContain("user.durable");
    expect(block).not.toContain("pref.stale");
    // Still stored — only injection is affected.
    expect(listFacts(db).map((f) => f.key)).toContain("pref.stale");
  });
});

describe("staleFacts review surface", () => {
  it("lists only unreinforced extracted facts with age and effective confidence", () => {
    const db = openDb(":memory:");
    setFact(db, "pref.fresh", "recently seen", 0.9, "extracted", THRESHOLD);
    setFact(db, "pref.old", "not seen in a while", 0.9, "extracted", THRESHOLD);
    setFact(db, "user.old", "user facts never appear here", 1.0, "user", THRESHOLD);
    backdate(db, "pref.old", 150);
    backdate(db, "user.old", 150);

    const stale = staleFacts(db, 90);
    expect(stale.map((f) => f.key)).toEqual(["pref.old"]);
    expect(stale[0].days_since_reinforced).toBeGreaterThanOrEqual(149);
    expect(stale[0].effective_confidence).toBeLessThan(0.9);
  });
});

describe("pruneStaleFacts", () => {
  it("tombstones extracted facts past the prune horizon, never user facts", () => {
    const db = openDb(":memory:");
    setFact(db, "pref.ancient", "long forgotten", 0.9, "extracted", THRESHOLD);
    setFact(db, "pref.recent", "still around", 0.9, "extracted", THRESHOLD);
    setFact(db, "user.ancient", "explicit and permanent", 1.0, "user", THRESHOLD);
    backdate(db, "pref.ancient", 400);
    backdate(db, "user.ancient", 400);

    expect(pruneStaleFacts(db)).toBe(1);
    expect(listFacts(db).map((f) => f.key).sort()).toEqual(["pref.recent", "user.ancient"]);
    const events = db
      .prepare("SELECT memory_key, source FROM memory_events WHERE event_type = 'delete'")
      .all() as { memory_key: string; source: string }[];
    expect(events).toEqual([{ memory_key: "pref.ancient", source: "decay" }]);
    // Idempotent.
    expect(pruneStaleFacts(db)).toBe(0);
  });
});
