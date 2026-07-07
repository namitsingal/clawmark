import { describe, expect, it } from "vitest";
import { getCursor, openDb } from "../src/db.js";
import { runIndexer } from "../src/indexer.js";
import { fakeEmbedder, memorySource, msg } from "./fakes.js";

function vectorCount(db: ReturnType<typeof openDb>): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM message_vectors").get() as { c: number }).c;
}

describe("indexer", () => {
  it("indexes all rows across batches and advances the cursor fully", async () => {
    const db = openDb(":memory:");
    const source = memorySource(
      Array.from({ length: 250 }, (_, i) => msg(i + 1, `substantial message content number ${i + 1}`)),
    );
    const result = await runIndexer(db, source, fakeEmbedder());
    expect(result.indexed).toBe(250);
    expect(vectorCount(db)).toBe(250);
    expect(getCursor(db, "index:lcm")).toBe("250");
  });

  it("skips short rows but still advances the cursor past them", async () => {
    const db = openDb(":memory:");
    const source = memorySource([
      msg(1, "ok"), // < MIN_INDEX_CHARS
      msg(2, "a long enough message to be indexed properly"),
      msg(3, "hi"), // < MIN_INDEX_CHARS
    ]);
    const result = await runIndexer(db, source, fakeEmbedder());
    expect(result.indexed).toBe(1);
    expect(getCursor(db, "index:lcm")).toBe("3");
  });

  it("embedder outage leaves the cursor untouched; retry succeeds without dupes", async () => {
    const db = openDb(":memory:");
    const source = memorySource([msg(1, "a long enough message to be indexed properly")]);
    const embedder = fakeEmbedder();
    embedder.down = true;
    expect((await runIndexer(db, source, embedder)).indexed).toBe(0);
    expect(getCursor(db, "index:lcm")).toBeNull();
    expect(vectorCount(db)).toBe(0);

    embedder.down = false;
    expect((await runIndexer(db, source, embedder)).indexed).toBe(1);
    expect(vectorCount(db)).toBe(1);

    // Re-run is a no-op (cursor consumed everything).
    expect((await runIndexer(db, source, embedder)).indexed).toBe(0);
    expect(vectorCount(db)).toBe(1);
  });
});
