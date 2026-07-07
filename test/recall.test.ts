import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { runIndexer } from "../src/indexer.js";
import { recall } from "../src/recall.js";
import { fakeEmbedder, memorySource, msg } from "./fakes.js";

const DAY = 86_400_000;

describe("recall", () => {
  it("returns relevant excerpts and filters unrelated ones by min-cosine", async () => {
    const db = openDb(":memory:");
    const source = memorySource([
      msg(1, "we discussed the espresso machine dose and grind settings at length"),
      msg(2, "the kubernetes cluster upgrade is scheduled for next month by platform"),
    ]);
    const embedder = fakeEmbedder();
    await runIndexer(db, source, embedder);

    const results = await recall(db, source, embedder, "espresso machine dose grind", 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].excerpt).toMatch(/espresso/);
    expect(results.every((r) => !r.excerpt.includes("kubernetes"))).toBe(true);
  });

  it("recency decay ranks newer above older at equal similarity", async () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const source = memorySource([
      msg(1, "favorite coffee brewing ratio discussion", { ts: new Date(now - 200 * DAY).toISOString() }),
      msg(2, "favorite coffee brewing ratio discussion again", { ts: new Date(now - 1 * DAY).toISOString() }),
    ]);
    const embedder = fakeEmbedder();
    await runIndexer(db, source, embedder);
    const results = await recall(db, source, embedder, "favorite coffee brewing ratio", 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].ref).toBe("2");
  });

  it("collapses near-duplicate texts (token-Jaccard diversity)", async () => {
    const db = openDb(":memory:");
    const source = memorySource([
      msg(1, "the deploy pipeline uses github actions with a staging gate"),
      msg(2, "the deploy pipeline uses github actions with a staging gate"),
      msg(3, "the deploy pipeline uses github actions with a staging gate today"),
    ]);
    const embedder = fakeEmbedder();
    await runIndexer(db, source, embedder);
    const results = await recall(db, source, embedder, "deploy pipeline github actions staging", 5);
    expect(results.length).toBe(1);
  });

  it("returns [] on empty index or embedder outage", async () => {
    const db = openDb(":memory:");
    const source = memorySource([]);
    const embedder = fakeEmbedder();
    expect(await recall(db, source, embedder, "anything at all", 5)).toEqual([]);
    embedder.down = true;
    expect(await recall(db, source, embedder, "anything at all", 5)).toEqual([]);
  });
});
