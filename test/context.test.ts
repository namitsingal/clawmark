import { describe, expect, it } from "vitest";
import { buildContext } from "../src/context.js";
import { openDb } from "../src/db.js";
import { setFact } from "../src/facts.js";
import { runIndexer } from "../src/indexer.js";
import { fakeEmbedder, memorySource, msg } from "./fakes.js";

const GUARD_OPEN = "[Memory —";
const GUARD_CLOSE = "[End Memory]";

describe("buildContext", () => {
  it("returns empty string when there is nothing to inject", async () => {
    const db = openDb(":memory:");
    const block = await buildContext(db, memorySource([]), fakeEmbedder(), "a question", 6, 0.8);
    expect(block).toBe("");
  });

  it("wraps content in guard markers and includes facts", async () => {
    const db = openDb(":memory:");
    setFact(db, "pref.editor", "prefers dark mode everywhere", 1.0, "user", 0.8);
    const block = await buildContext(db, memorySource([]), fakeEmbedder(), "", 6, 0.8);
    expect(block.startsWith(GUARD_OPEN)).toBe(true);
    expect(block.endsWith(GUARD_CLOSE)).toBe(true);
    expect(block).toContain("pref.editor: prefers dark mode everywhere");
    expect(block).toContain("NOT");
  });

  it("recall section is query-gated", async () => {
    const db = openDb(":memory:");
    const source = memorySource([msg(1, "the espresso dose is eighteen grams for the machine")]);
    const embedder = fakeEmbedder();
    await runIndexer(db, source, embedder);
    setFact(db, "pref.a", "some stored fact", 1.0, "user", 0.8);

    const noQuery = await buildContext(db, source, embedder, "", 6, 0.8);
    expect(noQuery).not.toContain("Recalled context");

    const withQuery = await buildContext(db, source, embedder, "espresso dose grams machine", 6, 0.8);
    expect(withQuery).toContain("Recalled context");
    expect(withQuery).toContain("espresso");
  });

  it("truncation preserves the closing guard", async () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 200; i++) {
      setFact(db, `pref.item${i}`, "x".repeat(120), 1.0, "user", 0.8);
    }
    const block = await buildContext(db, memorySource([]), fakeEmbedder(), "", 6, 0.8);
    expect(block.length).toBeLessThanOrEqual(12_100);
    expect(block.endsWith(GUARD_CLOSE)).toBe(true);
  });
});
