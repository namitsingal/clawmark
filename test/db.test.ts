import { describe, expect, it } from "vitest";
import path from "node:path";
import { getCursor, logEvent, openDb, rotateEvents, setCursor } from "../src/db.js";
import { tmpDir } from "./helpers.js";

describe("db", () => {
  it("migrations are idempotent (open twice)", () => {
    const dbPath = path.join(tmpDir(), "m.db");
    openDb(dbPath).close();
    const db = openDb(dbPath);
    const version = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
    expect(version.v).toBe(1);
    db.close();
  });

  it("cursor roundtrip and upsert", () => {
    const db = openDb(":memory:");
    expect(getCursor(db, "index:lcm")).toBeNull();
    setCursor(db, "index:lcm", "42");
    expect(getCursor(db, "index:lcm")).toBe("42");
    setCursor(db, "index:lcm", "file.jsonl:1024");
    expect(getCursor(db, "index:lcm")).toBe("file.jsonl:1024");
  });

  it("event rotation trims to the cap", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 30; i++) {
      logEvent(db, { eventType: "create", memoryKey: `k${i}`, source: "test" });
    }
    rotateEvents(db, 10);
    const count = db.prepare("SELECT COUNT(*) AS c FROM memory_events").get() as { c: number };
    expect(count.c).toBe(10);
    const newest = db.prepare("SELECT memory_key FROM memory_events ORDER BY id DESC LIMIT 1").get() as {
      memory_key: string;
    };
    expect(newest.memory_key).toBe("k29");
  });
});
