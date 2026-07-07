import os from "node:os";
import path from "node:path";
import {
  CONFIDENCE_THRESHOLD,
  DEFAULT_SOURCE,
  EMBEDDING_DIM,
  IDLE_HOURS,
  RECALL_LIMIT,
} from "./constants.js";

export interface ClawmarkConfig {
  dbPath: string;
  source: "auto" | "lcm" | "transcripts";
  lcmDbPath: string | null;
  transcriptsDir: string | null;
  embeddingUrl: string;
  embeddingModel: string;
  embeddingDim: number;
  extractUrl: string;
  extractModel: string;
  confidenceThreshold: number;
  recallLimit: number;
  idleHours: number;
  rerankUrl: string | null;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Clawmark: missing required environment variable ${name}`);
  }
  return value;
}

function expandHome(p: string): string {
  return p.startsWith("~/") || p === "~" ? path.join(os.homedir(), p.slice(1)) : p;
}

export function getConfig(env: NodeJS.ProcessEnv = process.env): Readonly<ClawmarkConfig> {
  const source = (env.CLAWMARK_SOURCE?.trim() || DEFAULT_SOURCE) as ClawmarkConfig["source"];
  if (!["auto", "lcm", "transcripts"].includes(source)) {
    throw new Error(`Clawmark: CLAWMARK_SOURCE must be auto|lcm|transcripts, got "${source}"`);
  }
  const lcmDbPath = env.CLAWMARK_LCM_DB_PATH?.trim() || null;
  const transcriptsDir = env.CLAWMARK_TRANSCRIPTS_DIR?.trim() || null;
  if (source === "lcm" && !lcmDbPath) {
    throw new Error("Clawmark: CLAWMARK_SOURCE=lcm requires CLAWMARK_LCM_DB_PATH");
  }
  if (source === "transcripts" && !transcriptsDir) {
    throw new Error("Clawmark: CLAWMARK_SOURCE=transcripts requires CLAWMARK_TRANSCRIPTS_DIR");
  }
  if (source === "auto" && !lcmDbPath && !transcriptsDir) {
    throw new Error(
      "Clawmark: set CLAWMARK_LCM_DB_PATH and/or CLAWMARK_TRANSCRIPTS_DIR so a message source exists",
    );
  }
  return Object.freeze({
    dbPath: expandHome(required(env, "CLAWMARK_DB_PATH")),
    source,
    lcmDbPath: lcmDbPath ? expandHome(lcmDbPath) : null,
    transcriptsDir: transcriptsDir ? expandHome(transcriptsDir) : null,
    embeddingUrl: required(env, "CLAWMARK_EMBEDDING_URL").replace(/\/$/, ""),
    embeddingModel: required(env, "CLAWMARK_EMBEDDING_MODEL"),
    embeddingDim: Number(env.CLAWMARK_EMBEDDING_DIM ?? EMBEDDING_DIM),
    extractUrl: required(env, "CLAWMARK_EXTRACT_URL").replace(/\/$/, ""),
    extractModel: required(env, "CLAWMARK_EXTRACT_MODEL"),
    confidenceThreshold: Number(env.CLAWMARK_CONFIDENCE_THRESHOLD ?? CONFIDENCE_THRESHOLD),
    recallLimit: Number(env.CLAWMARK_RECALL_LIMIT ?? RECALL_LIMIT),
    idleHours: Number(env.CLAWMARK_IDLE_HOURS ?? IDLE_HOURS),
    rerankUrl: env.CLAWMARK_RERANK_URL?.trim()?.replace(/\/$/, "") || null,
  });
}
