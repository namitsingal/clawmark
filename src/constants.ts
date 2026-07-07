export const CONFIDENCE_THRESHOLD = 0.8; // env CLAWMARK_CONFIDENCE_THRESHOLD
export const MAX_EVENTS = 10_000;
export const MIN_INDEX_CHARS = 20;
export const MAX_INDEX_CHARS = 2000;
export const RECALL_LIMIT = 6; // env CLAWMARK_RECALL_LIMIT
export const RECALL_MIN_COSINE = 0.45;
export const DECAY_RATE = 0.01; // per day; ~69-day half-life
export const JACCARD_DUP_THRESHOLD = 0.8;
export const MIN_EXTRACT_MESSAGES = 8;
export const EXTRACT_BATCH = 50; // messages per LLM call; keeps prompts ~6-7k tokens
export const MAX_FACTS_PER_RUN = 15;
export const JOB_EVERY_N_MESSAGES = 30;
export const IDLE_HOURS = 3; // env CLAWMARK_IDLE_HOURS
export const FACTS_CAP_CHARS = 6_000;
export const TOTAL_CAP_CHARS = 12_000;
export const EMBEDDING_DIM = 1024; // env CLAWMARK_EMBEDDING_DIM

export const MAX_FACT_KEY_LEN = 100;
export const MAX_FACT_VALUE_CHARS = 2000;
export const FACT_KEY_PATTERN = /^[a-z][a-z0-9_.]*[a-z0-9]$/;
export const CONFIDENCE_TIE_BAND = 0.1;

// This is an open-source plugin: NO personal endpoints in code. URL/model/path values
// are REQUIRED via environment; getConfig() throws naming the missing var.
export const DEFAULT_SOURCE = "auto"; // env CLAWMARK_SOURCE: auto | lcm | transcripts

export const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /disregard\s+(all\s+)?(previous|prior|above)/i,
  /you\s+are\s+now\s+/i,
  /forget\s+(everything|all|your)\s/i,
  /new\s+instructions\s*:/i,
  /system\s+prompt\s*:/i,
  /<\s*\/?\s*(system|instructions?|assistant|human)\s*>/i,
  /\[\s*system\s*\]/i,
  /\bBEGIN\s+(SYSTEM|ADMIN)\b/i,
  /override\s+(safety|previous|system)/i,
  /do\s+not\s+(tell|inform|reveal\s+to)\s+the\s+user/i,
  /respond\s+only\s+with/i,
];
