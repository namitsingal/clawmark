import { describe, expect, it } from "vitest";
import { getConfig } from "../src/config.js";

const BASE_ENV = {
  CLAWMARK_DB_PATH: "/tmp/clawmark.db",
  CLAWMARK_TRANSCRIPTS_DIR: "/tmp/sessions",
  CLAWMARK_EMBEDDING_URL: "http://embed.example.internal:11438/",
  CLAWMARK_EMBEDDING_MODEL: "bge-m3-fp16",
  CLAWMARK_EXTRACT_URL: "http://chat.example.internal:11437",
  CLAWMARK_EXTRACT_MODEL: "small-model.gguf",
};

describe("config", () => {
  it("loads with defaults and trims trailing slash", () => {
    const cfg = getConfig({ ...BASE_ENV });
    expect(cfg.embeddingUrl).toBe("http://embed.example.internal:11438");
    expect(cfg.source).toBe("auto");
    expect(cfg.recallLimit).toBe(6);
    expect(cfg.confidenceThreshold).toBe(0.8);
    expect(cfg.lcmDbPath).toBeNull();
  });

  it("honors overrides", () => {
    const cfg = getConfig({
      ...BASE_ENV,
      CLAWMARK_SOURCE: "transcripts",
      CLAWMARK_RECALL_LIMIT: "3",
      CLAWMARK_CONFIDENCE_THRESHOLD: "0.9",
    });
    expect(cfg.source).toBe("transcripts");
    expect(cfg.recallLimit).toBe(3);
    expect(cfg.confidenceThreshold).toBe(0.9);
  });

  it("throws naming the missing var", () => {
    const env = { ...BASE_ENV } as Record<string, string>;
    delete env.CLAWMARK_EMBEDDING_URL;
    expect(() => getConfig(env)).toThrow(/CLAWMARK_EMBEDDING_URL/);
  });

  it("requires a source path for the chosen mode", () => {
    expect(() => getConfig({ ...BASE_ENV, CLAWMARK_TRANSCRIPTS_DIR: "", CLAWMARK_SOURCE: "transcripts" })).toThrow(
      /CLAWMARK_TRANSCRIPTS_DIR/,
    );
    expect(() => getConfig({ ...BASE_ENV, CLAWMARK_SOURCE: "lcm" })).toThrow(/CLAWMARK_LCM_DB_PATH/);
    expect(() => getConfig({ ...BASE_ENV, CLAWMARK_TRANSCRIPTS_DIR: "" })).toThrow(/message source/);
  });

  it("expands ~ in paths", () => {
    const cfg = getConfig({ ...BASE_ENV, CLAWMARK_DB_PATH: "~/x/clawmark.db" });
    expect(cfg.dbPath.startsWith("/")).toBe(true);
    expect(cfg.dbPath.endsWith("/x/clawmark.db")).toBe(true);
  });
});
