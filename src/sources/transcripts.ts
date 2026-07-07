import fs from "node:fs";
import path from "node:path";
import type { MessageBatch, MessageSource, SourceMessage } from "./source.js";

/**
 * Adapter over OpenClaw's native session transcripts:
 *   <dir>/<sessionId>.jsonl — append-only, one JSON object per line.
 * Line 1 is a session header (type:"session"); message entries carry a role and content.
 * Content may be a string or an array of typed parts ({type:"text", text}).
 *
 * ref     = "<filename>:<lineStartByteOffset>"
 * cursor  = "<filename>:<byteOffsetAfterLastConsumedLine>" — files iterate in name order;
 *           within the current file the offset grows; when a file is exhausted we move to
 *           the next file name. Append-only files make (file, offset) stable.
 */

interface TranscriptCursor {
  file: string;
  offset: number;
}

function parseCursor(cursor: string | null): TranscriptCursor | null {
  if (cursor === null) return null;
  const idx = cursor.lastIndexOf(":");
  if (idx <= 0) return null;
  return { file: cursor.slice(0, idx), offset: Number(cursor.slice(idx + 1)) };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
            ? (part as { text: string }).text
            : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

interface ParsedLine {
  message: SourceMessage | null; // null = header/tool/unknown line (skipped, cursor still moves)
}

function parseLine(raw: string, file: string, lineOffset: number, sessionId: string): ParsedLine {
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { message: null };
  }
  const type = entry.type;
  if (type !== "message" && type !== "custom_message") return { message: null };
  // Message payloads either carry role/content at the top level or under `message`.
  const payload =
    entry.message && typeof entry.message === "object"
      ? (entry.message as Record<string, unknown>)
      : entry;
  const role = typeof payload.role === "string" ? payload.role : null;
  if (role !== "user" && role !== "assistant") return { message: null };
  const text = extractText(payload.content ?? payload.text);
  if (!text.trim()) return { message: null };
  const ts =
    typeof entry.timestamp === "string"
      ? entry.timestamp
      : typeof entry.timestamp === "number"
        ? new Date(entry.timestamp).toISOString()
        : new Date(0).toISOString();
  return {
    message: {
      ref: `${file}:${lineOffset}`,
      conversationId: sessionId,
      role,
      text,
      ts,
    },
  };
}

function sessionIdOf(file: string): string {
  return path.basename(file).replace(/\.jsonl$/, "");
}

export function openTranscriptSource(dir: string): MessageSource {
  const listFiles = (): string[] => {
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort();
    } catch {
      return [];
    }
  };

  const readFrom = (file: string, startOffset: number, limit: number, out: SourceMessage[]): number => {
    const full = path.join(dir, file);
    let buf: Buffer;
    try {
      buf = fs.readFileSync(full);
    } catch {
      return startOffset;
    }
    let offset = startOffset;
    const sessionId = sessionIdOf(file);
    while (offset < buf.length && out.length < limit) {
      let end = buf.indexOf(0x0a, offset);
      if (end === -1) {
        // No trailing newline yet — the writer may still be mid-line; wait for the flush.
        break;
      }
      const raw = buf.subarray(offset, end).toString("utf8").trim();
      if (raw) {
        const { message } = parseLine(raw, file, offset, sessionId);
        if (message) out.push(message);
      }
      offset = end + 1;
    }
    return offset;
  };

  return {
    name: "transcripts",
    validate() {
      if (!fs.existsSync(dir)) return { ok: false, reason: `transcripts dir not found: ${dir}` };
      return { ok: true };
    },
    messagesAfter(cursor, limit): MessageBatch {
      const files = listFiles();
      if (files.length === 0) return { messages: [], nextCursor: null };
      const parsed = parseCursor(cursor);
      const out: SourceMessage[] = [];
      let curFile = parsed?.file ?? files[0];
      let curOffset = parsed?.offset ?? 0;
      // If the cursor's file vanished (shouldn't happen — append-only), restart after it by name.
      if (!files.includes(curFile)) {
        const next = files.find((f) => f > curFile);
        if (!next) return { messages: [], nextCursor: null };
        curFile = next;
        curOffset = 0;
      }
      let advanced = false;
      for (let i = files.indexOf(curFile); i < files.length && out.length < limit; i++) {
        const file = files[i];
        const start = file === curFile ? curOffset : 0;
        const newOffset = readFrom(file, start, limit, out);
        if (newOffset > start || file !== curFile) advanced = true;
        curFile = file;
        curOffset = newOffset;
        if (out.length >= limit) break;
      }
      if (out.length === 0 && !advanced) return { messages: [], nextCursor: null };
      return { messages: out, nextCursor: `${curFile}:${curOffset}` };
    },
    getMessages(refs): SourceMessage[] {
      const out: SourceMessage[] = [];
      for (const ref of refs) {
        const parsed = parseCursor(ref);
        if (!parsed) continue;
        const full = path.join(dir, parsed.file);
        let buf: Buffer;
        try {
          buf = fs.readFileSync(full);
        } catch {
          continue;
        }
        const end = buf.indexOf(0x0a, parsed.offset);
        const raw = buf
          .subarray(parsed.offset, end === -1 ? buf.length : end)
          .toString("utf8")
          .trim();
        if (!raw) continue;
        const { message } = parseLine(raw, parsed.file, parsed.offset, sessionIdOf(parsed.file));
        if (message) out.push(message);
      }
      return out;
    },
  };
}
