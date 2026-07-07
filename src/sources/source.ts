import type { ClawmarkConfig } from "../config.js";
import { type Db, logEvent } from "../db.js";
import { openLcmSource } from "./lcm.js";
import { openTranscriptSource } from "./transcripts.js";

export interface SourceMessage {
  /** Opaque, stable, unique per message within a source. */
  ref: string;
  conversationId: string;
  role: string;
  text: string;
  /** ISO-8601 timestamp. */
  ts: string;
}

export interface MessageBatch {
  messages: SourceMessage[];
  /** Cursor covering everything returned (and skipped) so far; null if nothing new. */
  nextCursor: string | null;
}

export interface MessageSource {
  name: "lcm" | "transcripts";
  validate(): { ok: true } | { ok: false; reason: string };
  /** Ordered, cursor-exclusive read. `cursor === null` means from the beginning. */
  messagesAfter(cursor: string | null, limit: number): MessageBatch;
  getMessages(refs: string[]): SourceMessage[];
}

export function selectSource(config: ClawmarkConfig, db: Db): MessageSource {
  const tryLcm = (): MessageSource | null => {
    if (!config.lcmDbPath) return null;
    const lcm = openLcmSource(config.lcmDbPath);
    const check = lcm.validate();
    if (check.ok) return lcm;
    logEvent(db, {
      eventType: "source_fallback",
      memoryKey: "source.lcm",
      newValue: check.reason,
      source: "selectSource",
    });
    return null;
  };

  if (config.source === "lcm") {
    const lcm = tryLcm();
    if (!lcm) throw new Error("Clawmark: CLAWMARK_SOURCE=lcm but the LCM database failed validation");
    return lcm;
  }
  if (config.source === "transcripts") {
    if (!config.transcriptsDir) throw new Error("Clawmark: transcripts source requires CLAWMARK_TRANSCRIPTS_DIR");
    return openTranscriptSource(config.transcriptsDir);
  }
  // auto
  const lcm = tryLcm();
  if (lcm) return lcm;
  if (!config.transcriptsDir) {
    throw new Error("Clawmark: no usable message source (LCM invalid/missing and no CLAWMARK_TRANSCRIPTS_DIR)");
  }
  return openTranscriptSource(config.transcriptsDir);
}
