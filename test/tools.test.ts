import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { listFacts } from "../src/facts.js";
import { buildTools, type ClawmarkRuntime, type JobsResult } from "../src/tools.js";
import { fakeEmbedder, memorySource } from "./fakes.js";

function makeRuntime(): ClawmarkRuntime {
  return {
    db: openDb(":memory:"),
    source: memorySource([]),
    embedder: fakeEmbedder(),
    config: {
      dbPath: ":memory:",
      source: "auto",
      lcmDbPath: null,
      transcriptsDir: "/tmp",
      embeddingUrl: "http://embed.example.internal",
      embeddingModel: "m",
      embeddingDim: 4,
      extractUrl: "http://chat.example.internal",
      extractModel: "m",
      confidenceThreshold: 0.8,
      recallLimit: 6,
      idleHours: 3,
      rerankUrl: null,
    },
  };
}

function toolByName(tools: ReturnType<typeof buildTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool;
}

describe("tools", () => {
  it("clawmark_reconcile runs the jobs with drain=true by default and reports counts", async () => {
    const calls: { drain?: boolean }[] = [];
    const runJobs = async (opts: { drain?: boolean } = {}): Promise<JobsResult> => {
      calls.push(opts);
      return { indexed: 12, written: 3, pruned: 1 };
    };
    const runtime = makeRuntime();
    const tools = buildTools(() => runtime, runJobs);
    const result = await toolByName(tools, "clawmark_reconcile").execute("t1", {});
    expect(calls).toEqual([{ drain: true }]);
    expect(result.content[0].text).toContain("indexed 12");
    expect(result.content[0].text).toContain("extracted 3 facts");
    expect(result.content[0].text).toContain("pruned 1");
  });

  it("clawmark_reconcile reports when a run is already in progress", async () => {
    const tools = buildTools(
      () => makeRuntime(),
      async () => null,
    );
    const result = await toolByName(tools, "clawmark_reconcile").execute("t1", { drain: false });
    expect(result.content[0].text).toMatch(/already in progress/);
  });

  it("clawmark_set stores a user fact through the tool surface", async () => {
    const runtime = makeRuntime();
    const tools = buildTools(
      () => runtime,
      async () => null,
    );
    await toolByName(tools, "clawmark_set").execute("t1", { key: "pref.editor", value: "dark mode" });
    expect(listFacts(runtime.db)[0]).toMatchObject({ key: "pref.editor", source: "user" });
  });

  it("tools throw a clear error when the runtime is not initialized", async () => {
    const tools = buildTools(
      () => null,
      async () => null,
    );
    await expect(toolByName(tools, "clawmark_reconcile").execute("t1", {})).rejects.toThrow(/not initialized/);
  });
});
