import { describe, expect, it } from "vitest";
import path from "node:path";
import type { ClawmarkConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { selectSource } from "../src/sources/source.js";
import { buildLcmFixture, tmpDir } from "./helpers.js";

function config(overrides: Partial<ClawmarkConfig>): ClawmarkConfig {
  return {
    dbPath: ":memory:",
    source: "auto",
    lcmDbPath: null,
    transcriptsDir: null,
    embeddingUrl: "http://embed.example.internal",
    embeddingModel: "m",
    embeddingDim: 4,
    extractUrl: "http://chat.example.internal",
    extractModel: "m",
    confidenceThreshold: 0.8,
    recallLimit: 6,
    idleHours: 3,
    rerankUrl: null,
    ...overrides,
  };
}

describe("selectSource", () => {
  it("auto prefers a valid LCM db", () => {
    const lcmPath = path.join(tmpDir(), "lcm.db");
    buildLcmFixture(lcmPath, [{ role: "user", content: "hello world message" }]);
    const db = openDb(":memory:");
    const source = selectSource(config({ lcmDbPath: lcmPath, transcriptsDir: tmpDir() }), db);
    expect(source.name).toBe("lcm");
  });

  it("auto falls back to transcripts on invalid LCM and logs source_fallback", () => {
    const db = openDb(":memory:");
    const source = selectSource(
      config({ lcmDbPath: path.join(tmpDir(), "missing.db"), transcriptsDir: tmpDir() }),
      db,
    );
    expect(source.name).toBe("transcripts");
    const events = db.prepare("SELECT event_type FROM memory_events").all() as { event_type: string }[];
    expect(events.some((e) => e.event_type === "source_fallback")).toBe(true);
  });

  it("forcing lcm with a bad db throws instead of silently degrading", () => {
    const db = openDb(":memory:");
    expect(() =>
      selectSource(config({ source: "lcm", lcmDbPath: path.join(tmpDir(), "missing.db") }), db),
    ).toThrow(/validation/);
  });

  it("forcing transcripts uses transcripts even when LCM is available", () => {
    const lcmPath = path.join(tmpDir(), "lcm.db");
    buildLcmFixture(lcmPath, [{ role: "user", content: "hello world message" }]);
    const db = openDb(":memory:");
    const source = selectSource(
      config({ source: "transcripts", lcmDbPath: lcmPath, transcriptsDir: tmpDir() }),
      db,
    );
    expect(source.name).toBe("transcripts");
  });
});
