import { afterEach, describe, expect, it, vi } from "vitest";
import { getCursor, openDb } from "../src/db.js";
import { runExtractor } from "../src/extractor.js";
import { listFacts } from "../src/facts.js";
import { memorySource, msg } from "./fakes.js";

const CONFIG = {
  extractUrl: "http://chat.example.internal",
  extractModel: "small.gguf",
  confidenceThreshold: 0.8,
};

function chatResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeMessages(count: number) {
  return Array.from({ length: count }, (_, i) => msg(i + 1, `user message number ${i + 1} with content`));
}

afterEach(() => vi.unstubAllGlobals());

describe("extractor", () => {
  it("writes facts and advances the cursor atomically", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        chatResponse('{"facts": [{"key": "pref.editor", "value": "dark mode", "confidence": 0.95}]}'),
      ),
    );
    const db = openDb(":memory:");
    const result = await runExtractor(db, memorySource(makeMessages(10)), CONFIG);
    expect(result.written).toBe(1);
    expect(listFacts(db)[0].key).toBe("pref.editor");
    expect(getCursor(db, "extract:lcm")).toBe("10");
  });

  it("sends enable_thinking:false and temperature 0", async () => {
    const fetchMock = vi.fn(async () => chatResponse('{"facts": []}'));
    vi.stubGlobal("fetch", fetchMock);
    const db = openDb(":memory:");
    await runExtractor(db, memorySource(makeMessages(10)), CONFIG);
    const init = fetchMock.mock.calls[0][1] as { body: string };
    const body = JSON.parse(init.body);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.temperature).toBe(0);
  });

  it("waits when fewer than MIN_EXTRACT_MESSAGES are available (cursor unchanged)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const db = openDb(":memory:");
    const result = await runExtractor(db, memorySource(makeMessages(3)), CONFIG);
    expect(result.written).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getCursor(db, "extract:lcm")).toBeNull();
  });

  it("parse failure logs extract_error but still advances the cursor", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => chatResponse("I could not find any facts, sorry!")));
    const db = openDb(":memory:");
    const result = await runExtractor(db, memorySource(makeMessages(10)), CONFIG);
    expect(result.written).toBe(0);
    expect(getCursor(db, "extract:lcm")).toBe("10");
    const events = db.prepare("SELECT event_type FROM memory_events").all() as { event_type: string }[];
    expect(events.some((e) => e.event_type === "extract_error")).toBe(true);
  });

  it("model-server outage leaves the cursor untouched for retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))));
    const db = openDb(":memory:");
    const result = await runExtractor(db, memorySource(makeMessages(10)), CONFIG);
    expect(result.written).toBe(0);
    expect(getCursor(db, "extract:lcm")).toBeNull();
  });

  it("re-running the same batch is a no-op (idempotent via upsert + precedence)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        chatResponse('{"facts": [{"key": "pref.editor", "value": "dark mode", "confidence": 0.95}]}'),
      ),
    );
    const db = openDb(":memory:");
    const source = memorySource(makeMessages(10));
    await runExtractor(db, source, CONFIG);
    // Simulate a crash-and-replay by resetting the cursor.
    db.prepare("DELETE FROM cursors").run();
    await runExtractor(db, source, CONFIG);
    expect(listFacts(db).length).toBe(1);
  });

  it("low-confidence extractions are dropped by the facts gate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        chatResponse(
          '{"facts": [{"key": "pref.weak", "value": "guess", "confidence": 0.5}, {"key": "pref.strong", "value": "stated", "confidence": 0.9}]}',
        ),
      ),
    );
    const db = openDb(":memory:");
    const result = await runExtractor(db, memorySource(makeMessages(10)), CONFIG);
    expect(result.written).toBe(1);
    expect(listFacts(db).map((f) => f.key)).toEqual(["pref.strong"]);
  });

  it("incremental mode processes at most 5 batches; drain processes everything", async () => {
    const fetchMock = vi.fn(async () => chatResponse('{"facts": []}'));
    vi.stubGlobal("fetch", fetchMock);
    // 400 messages = 8 full batches of EXTRACT_BATCH (50).
    const source = memorySource(makeMessages(400));

    const db1 = openDb(":memory:");
    await runExtractor(db1, source, CONFIG);
    expect(fetchMock.mock.calls.length).toBe(5);
    expect(getCursor(db1, "extract:lcm")).toBe("250");

    fetchMock.mockClear();
    const db2 = openDb(":memory:");
    await runExtractor(db2, source, CONFIG, { drain: true });
    expect(fetchMock.mock.calls.length).toBe(8);
    expect(getCursor(db2, "extract:lcm")).toBe("400");
  });
});
