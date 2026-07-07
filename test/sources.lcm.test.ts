import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import path from "node:path";
import { openLcmSource } from "../src/sources/lcm.js";
import { buildLcmFixture, tmpDir } from "./helpers.js";

describe("lcm source", () => {
  it("validate fails cleanly on a missing file (no throw)", () => {
    const source = openLcmSource(path.join(tmpDir(), "nope.db"));
    const check = source.validate();
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(/not found/);
  });

  it("validate detects schema drift (renamed column)", () => {
    const dbPath = path.join(tmpDir(), "drift.db");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE messages (message_id INTEGER PRIMARY KEY, convo_id INTEGER, role TEXT, content TEXT, created_at TEXT)");
    db.close();
    const check = openLcmSource(dbPath).validate();
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(/conversation_id/);
  });

  it("messagesAfter is cursor-exclusive and ordered; getMessages preserves refs", () => {
    const dbPath = path.join(tmpDir(), "lcm.db");
    buildLcmFixture(dbPath, [
      { role: "user", content: "first message here" },
      { role: "assistant", content: "second message here" },
      { role: "user", content: "third message here" },
    ]);
    const source = openLcmSource(dbPath);
    expect(source.validate().ok).toBe(true);

    const all = source.messagesAfter(null, 10);
    expect(all.messages.map((m) => m.text)).toEqual([
      "first message here",
      "second message here",
      "third message here",
    ]);
    expect(all.nextCursor).toBe("3");

    const tail = source.messagesAfter("1", 10);
    expect(tail.messages.map((m) => m.ref)).toEqual(["2", "3"]);

    const empty = source.messagesAfter("3", 10);
    expect(empty.messages).toEqual([]);
    expect(empty.nextCursor).toBeNull();

    const picked = source.getMessages(["3", "1"]);
    expect(picked.map((m) => m.ref)).toEqual(["3", "1"]);
  });

  it("limit is respected and cursor resumes across calls (no message lost or repeated)", () => {
    const dbPath = path.join(tmpDir(), "big.db");
    buildLcmFixture(dbPath, Array.from({ length: 25 }, (_, i) => ({ role: "user", content: `message number ${i}` })));
    const source = openLcmSource(dbPath);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (;;) {
      const batch = source.messagesAfter(cursor, 10);
      if (batch.messages.length === 0) break;
      seen.push(...batch.messages.map((m) => m.ref));
      cursor = batch.nextCursor;
    }
    expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => String(i + 1)));
  });
});
