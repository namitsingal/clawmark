import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

type PluginEntry = ReturnType<typeof definePluginEntry>;
import { getConfig } from "./config.js";
import { JOB_EVERY_N_MESSAGES } from "./constants.js";
import { buildContext } from "./context.js";
import { type Db, openDb, rotateEvents } from "./db.js";
import { createEmbeddingClient, type EmbeddingClient } from "./embeddings.js";
import { pruneStaleFacts } from "./facts.js";
import { runExtractor } from "./extractor.js";
import { runIndexer } from "./indexer.js";
import { type MessageSource, selectSource } from "./sources/source.js";
import { buildTools, type ClawmarkRuntime } from "./tools.js";

const IDLE_TICK_MS = 10 * 60 * 1000;

const entry: PluginEntry = definePluginEntry({
  id: "clawmark",
  name: "Clawmark",
  description:
    "Durable facts and semantic recall derived from the message history OpenClaw already keeps.",
  register(api) {
    const log = {
      info: (msg: string) => api.logger?.info?.(`clawmark: ${msg}`),
      warn: (msg: string) => api.logger?.warn?.(`clawmark: ${msg}`),
      error: (msg: string) => api.logger?.error?.(`clawmark: ${msg}`),
    };

    let runtime: ClawmarkRuntime | null = null;
    let idleTimer: ReturnType<typeof setInterval> | null = null;
    let messageCounter = 0;
    let lastActivity = Date.now();
    let jobsRunning = false;

    const runJobs = async (opts: { drain?: boolean } = {}): Promise<void> => {
      if (!runtime || jobsRunning) return;
      jobsRunning = true;
      try {
        const { db, source, embedder, config } = runtime;
        const indexed = await runIndexer(db, source, embedder);
        const extracted = await runExtractor(db, source, config, opts);
        const pruned = pruneStaleFacts(db);
        rotateEvents(db);
        if (indexed.indexed > 0 || extracted.written > 0 || pruned > 0) {
          log.info(
            `jobs: indexed ${indexed.indexed} messages, wrote ${extracted.written} facts, pruned ${pruned} stale facts`,
          );
        }
      } catch (err) {
        log.error(`background jobs failed: ${String(err)}`);
      } finally {
        jobsRunning = false;
      }
    };

    const noteActivity = (): void => {
      lastActivity = Date.now();
      messageCounter++;
      if (messageCounter >= JOB_EVERY_N_MESSAGES) {
        messageCounter = 0;
        void runJobs();
      }
    };

    api.on("gateway_start", () => {
      try {
        const config = getConfig();
        const db: Db = openDb(config.dbPath);
        const source: MessageSource = selectSource(config, db);
        const embedder: EmbeddingClient = createEmbeddingClient(config, log.warn);
        runtime = { db, source, embedder, config };
        log.info(`started — source=${source.name}, db=${config.dbPath}`);
        // Catch up on everything missed while the gateway was down. Cursor-based reads
        // of a durable log make this crash-safe: kill -9 at any point loses nothing.
        void runJobs({ drain: true });
        idleTimer = setInterval(() => {
          if (!runtime) return;
          if (Date.now() - lastActivity >= runtime.config.idleHours * 3_600_000) {
            void runJobs({ drain: true });
          }
        }, IDLE_TICK_MS);
        idleTimer.unref?.();
      } catch (err) {
        // Memory failures must never break the agent — stay inert and say why.
        log.error(`disabled (init failed): ${String(err)}`);
        runtime = null;
      }
    });

    api.on("gateway_stop", () => {
      try {
        if (idleTimer) clearInterval(idleTimer);
        idleTimer = null;
        if (runtime) {
          runtime.db.pragma("wal_checkpoint(TRUNCATE)");
          runtime.db.close();
        }
      } catch (err) {
        log.error(`shutdown error: ${String(err)}`);
      } finally {
        runtime = null;
      }
    });

    api.on("before_prompt_build", async (event) => {
      try {
        if (!runtime) return;
        const { db, source, embedder, config } = runtime;
        const block = await buildContext(
          db,
          source,
          embedder,
          event.prompt ?? "",
          config.recallLimit,
          config.confidenceThreshold,
        );
        if (!block) return;
        return { prependContext: block };
      } catch (err) {
        log.error(`before_prompt_build failed: ${String(err)}`);
        return;
      }
    });

    api.on("message_received", () => {
      try {
        noteActivity();
      } catch {
        /* never break the agent */
      }
    });

    api.on("agent_end", () => {
      try {
        noteActivity();
      } catch {
        /* never break the agent */
      }
    });

    api.on("session_end", () => {
      try {
        // Best-effort flush; the boot-time drain is the real guarantee.
        void runJobs();
      } catch {
        /* never break the agent */
      }
    });

    for (const tool of buildTools(() => runtime)) {
      try {
        // Cast: our minimal ToolResult structurally matches AgentToolResult.
        api.registerTool(tool as Parameters<typeof api.registerTool>[0], { optional: true });
      } catch (err) {
        log.error(`tool registration failed for ${tool.name}: ${String(err)}`);
      }
    }
  },
});

export default entry;
