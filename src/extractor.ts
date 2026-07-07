import type { ClawmarkConfig } from "./config.js";
import { EXTRACT_BATCH, MAX_FACTS_PER_RUN, MIN_EXTRACT_MESSAGES } from "./constants.js";
import { type Db, getCursor, logEvent, setCursor } from "./db.js";
import { setFact } from "./facts.js";
import type { MessageSource, SourceMessage } from "./sources/source.js";

const EXTRACT_TIMEOUT_MS = 120_000;
const MSG_TRUNCATE_CHARS = 500;
/** Message-count triggers process at most this many batches; idle/boot may drain fully. */
const MAX_BATCHES_INCREMENTAL = 5;

export function extractCursorName(source: MessageSource): string {
  return `extract:${source.name}`;
}

const EXTRACTION_PROMPT = `You extract durable long-term facts from a conversation transcript. Return ONLY a JSON
object:

{"facts": [{"key": "pref.<topic>", "value": "<fact>", "confidence": 0.9}]}

Rules:
- Keys: lowercase dot-separated, starting with one of: pref. project. user. lesson.
- Only DURABLE facts: stated preferences, decisions, ongoing projects, corrections,
  stable facts about the user. Exclude small talk, transient state, secrets, and anything
  the user asked to keep private.
- confidence: 0.9+ only when the user stated it directly; 0.8 for strong inference;
  anything below 0.8 will be discarded, so omit weak guesses.
- Maximum ${MAX_FACTS_PER_RUN} facts. An empty array is fine and common.

Transcript:
`;

interface ExtractedFact {
  key: string;
  value: string;
  confidence: number;
}

function renderTranscript(messages: SourceMessage[]): string {
  return messages
    .map((m) => `${m.role}: ${m.text.slice(0, MSG_TRUNCATE_CHARS)}`)
    .join("\n");
}

function parseFacts(raw: string): ExtractedFact[] | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;
  // Take the largest {...} span, then narrow until it parses.
  for (let end = raw.lastIndexOf("}"); end > start; end = raw.lastIndexOf("}", end - 1)) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1)) as { facts?: unknown };
      if (!Array.isArray(parsed.facts)) return null;
      return parsed.facts
        .filter(
          (f): f is ExtractedFact =>
            !!f &&
            typeof f === "object" &&
            typeof (f as ExtractedFact).key === "string" &&
            typeof (f as ExtractedFact).value === "string" &&
            typeof (f as ExtractedFact).confidence === "number",
        )
        .slice(0, MAX_FACTS_PER_RUN);
    } catch {
      // keep narrowing
    }
  }
  return null;
}

async function callExtractModel(
  config: Pick<ClawmarkConfig, "extractUrl" | "extractModel">,
  transcript: string,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXTRACT_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.extractUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.extractModel,
        temperature: 0,
        max_tokens: 1500,
        // Qwen3-family servers otherwise spend the whole budget on reasoning before any
        // JSON (verified 2026-07-07). Harmlessly ignored by non-thinking models.
        chat_template_kwargs: { enable_thinking: false },
        messages: [{ role: "user", content: EXTRACTION_PROMPT + transcript }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const payload = (await res.json()) as {
      choices?: { message?: { content?: string | null } }[];
    };
    return payload.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read un-extracted messages behind a cursor, run one small-model call per batch, and
 * upsert surviving facts. The cursor advances in the same transaction as the fact
 * writes; a parse failure advances the cursor too (logged) so one bad batch can never
 * wedge the pipeline. Crash-safe by construction: re-running a batch is absorbed by the
 * upsert + precedence ladder.
 */
export async function runExtractor(
  db: Db,
  source: MessageSource,
  config: Pick<ClawmarkConfig, "extractUrl" | "extractModel" | "confidenceThreshold">,
  opts: { drain?: boolean } = {},
): Promise<{ written: number }> {
  const cursorName = extractCursorName(source);
  let written = 0;
  const maxBatches = opts.drain ? Number.POSITIVE_INFINITY : MAX_BATCHES_INCREMENTAL;
  for (let batchNo = 0; batchNo < maxBatches; batchNo++) {
    const batch = source.messagesAfter(getCursor(db, cursorName), EXTRACT_BATCH);
    if (batch.messages.length === 0) {
      if (batch.nextCursor !== null) setCursor(db, cursorName, batch.nextCursor);
      return { written };
    }
    const isFinalPartialBatch = batch.messages.length < EXTRACT_BATCH;
    if (isFinalPartialBatch && batch.messages.length < MIN_EXTRACT_MESSAGES) {
      // Not enough new material yet — wait for more; do NOT advance the cursor.
      return { written };
    }

    const raw = await callExtractModel(config, renderTranscript(batch.messages));
    if (raw === null) {
      // Model server down — retry this batch on the next trigger.
      return { written };
    }
    const facts = parseFacts(raw);
    const commit = db.transaction(() => {
      if (facts === null) {
        logEvent(db, {
          eventType: "extract_error",
          memoryKey: "extractor.parse_error",
          newValue: raw.slice(0, 300),
          source: "extractor",
        });
      } else {
        for (const fact of facts) {
          const result = setFact(db, fact.key, fact.value, fact.confidence, "extracted", config.confidenceThreshold);
          if (result.ok) written++;
        }
      }
      setCursor(db, cursorName, batch.nextCursor!);
    });
    commit();
    if (isFinalPartialBatch) return { written };
  }
  return { written };
}
