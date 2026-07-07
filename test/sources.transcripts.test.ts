import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openTranscriptSource } from "../src/sources/transcripts.js";
import { tmpDir } from "./helpers.js";

function line(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

function sessionFile(dir: string, name: string, entries: unknown[]): void {
  const header = line({ type: "session", id: name.replace(".jsonl", ""), timestamp: "2026-07-01T00:00:00Z" });
  fs.writeFileSync(path.join(dir, name), header + entries.map(line).join(""));
}

const userMsg = (text: string, ts = "2026-07-01T10:00:00Z") => ({
  type: "message",
  timestamp: ts,
  message: { role: "user", content: text },
});
const assistantMsg = (text: string) => ({
  type: "message",
  timestamp: "2026-07-01T10:01:00Z",
  message: { role: "assistant", content: [{ type: "text", text }] },
});

describe("transcript source", () => {
  it("validate fails on a missing dir", () => {
    expect(openTranscriptSource("/nonexistent/clawmark-dir").validate().ok).toBe(false);
  });

  it("parses string and part-array content; skips headers, tools, and malformed lines", () => {
    const dir = tmpDir();
    sessionFile(dir, "a.jsonl", [
      userMsg("hello there friend"),
      { type: "message", message: { role: "tool", content: "tool output ignored" } },
      assistantMsg("hi from the assistant"),
      { type: "compaction", summary: "ignored" },
    ]);
    fs.appendFileSync(path.join(dir, "a.jsonl"), "this is not json\n");
    fs.appendFileSync(path.join(dir, "a.jsonl"), line(userMsg("after the bad line")));

    const source = openTranscriptSource(dir);
    const batch = source.messagesAfter(null, 10);
    expect(batch.messages.map((m) => m.text)).toEqual([
      "hello there friend",
      "hi from the assistant",
      "after the bad line",
    ]);
    expect(batch.messages[0].role).toBe("user");
    expect(batch.messages[1].role).toBe("assistant");
    expect(batch.messages[0].conversationId).toBe("a");
  });

  it("cursor resumes mid-file and across files in name order", () => {
    const dir = tmpDir();
    sessionFile(dir, "a.jsonl", [userMsg("alpha one"), userMsg("alpha two")]);
    sessionFile(dir, "b.jsonl", [userMsg("beta one")]);

    const source = openTranscriptSource(dir);
    const first = source.messagesAfter(null, 1);
    expect(first.messages[0].text).toBe("alpha one");

    const second = source.messagesAfter(first.nextCursor, 10);
    expect(second.messages.map((m) => m.text)).toEqual(["alpha two", "beta one"]);

    const done = source.messagesAfter(second.nextCursor, 10);
    expect(done.messages).toEqual([]);
    expect(done.nextCursor).toBeNull();
  });

  it("append-during-read is safe: cursor picks up the appended tail", () => {
    const dir = tmpDir();
    sessionFile(dir, "a.jsonl", [userMsg("before restart")]);
    const source = openTranscriptSource(dir);
    const first = source.messagesAfter(null, 10);
    expect(first.messages.map((m) => m.text)).toEqual(["before restart"]);

    fs.appendFileSync(path.join(dir, "a.jsonl"), line(userMsg("after restart")));
    const second = source.messagesAfter(first.nextCursor, 10);
    expect(second.messages.map((m) => m.text)).toEqual(["after restart"]);
  });

  it("does not consume a partial line without trailing newline until it is flushed", () => {
    const dir = tmpDir();
    sessionFile(dir, "a.jsonl", [userMsg("complete line")]);
    const partial = JSON.stringify(userMsg("still being written")).slice(0, 30);
    fs.appendFileSync(path.join(dir, "a.jsonl"), partial);

    const source = openTranscriptSource(dir);
    const batch = source.messagesAfter(null, 10);
    expect(batch.messages.map((m) => m.text)).toEqual(["complete line"]);

    fs.appendFileSync(path.join(dir, "a.jsonl"), JSON.stringify(userMsg("still being written")).slice(30) + "\n");
    const next = source.messagesAfter(batch.nextCursor, 10);
    expect(next.messages.map((m) => m.text)).toEqual(["still being written"]);
  });

  it("getMessages resolves refs back to canonical text", () => {
    const dir = tmpDir();
    sessionFile(dir, "a.jsonl", [userMsg("find me later please")]);
    const source = openTranscriptSource(dir);
    const batch = source.messagesAfter(null, 10);
    const ref = batch.messages[0].ref;
    expect(source.getMessages([ref])[0].text).toBe("find me later please");
  });
});
