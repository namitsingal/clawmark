import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { buildContext } from "../src/context.js";
import { openDb } from "../src/db.js";
import { runExtractor } from "../src/extractor.js";
import { runIndexer } from "../src/indexer.js";
import { openLcmSource } from "../src/sources/lcm.js";
import { fakeEmbedder } from "./fakes.js";
import { buildLcmFixture, tmpDir } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

describe("integration: fixture LCM → index + extract → context", () => {
  it("full loop produces a context block with the fact and a recalled excerpt", async () => {
    const lcmPath = path.join(tmpDir(), "lcm.db");
    buildLcmFixture(
      lcmPath,
      Array.from({ length: 12 }, (_, i) =>
        i === 5
          ? { role: "user", content: "for the record I prefer tabs over spaces in every project" }
          : { role: "user", content: `regular chatter about the weather number ${i}` },
      ),
    );
    const source = openLcmSource(lcmPath);
    const db = openDb(":memory:");
    const embedder = fakeEmbedder();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '{"facts": [{"key": "pref.indentation", "value": "prefers tabs over spaces", "confidence": 0.95}]}',
                },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    await runIndexer(db, source, embedder);
    const extracted = await runExtractor(db, source, {
      extractUrl: "http://chat.example.internal",
      extractModel: "m",
      confidenceThreshold: 0.8,
    });
    expect(extracted.written).toBe(1);

    const block = await buildContext(db, source, embedder, "tabs or spaces preference in projects", 6, 0.8);
    expect(block).toContain("pref.indentation: prefers tabs over spaces");
    expect(block).toContain("Recalled context");
    expect(block).toContain("tabs over spaces in every project");
    expect(block.endsWith("[End Memory]")).toBe(true);
  });
});
