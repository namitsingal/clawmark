import { Type } from "@sinclair/typebox";
import type { ClawmarkConfig } from "./config.js";
import type { Db } from "./db.js";
import type { EmbeddingClient } from "./embeddings.js";
import { deleteFact, listFacts, setFact, staleFacts } from "./facts.js";
import { recall } from "./recall.js";
import type { MessageSource } from "./sources/source.js";

interface ToolResult {
  content: { type: "text"; text: string }[];
  details: unknown;
}

function text(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    details: {},
  };
}

export interface ClawmarkRuntime {
  db: Db;
  source: MessageSource;
  embedder: EmbeddingClient;
  config: ClawmarkConfig;
}

export interface JobsResult {
  indexed: number;
  written: number;
  pruned: number;
}

export type RunJobsFn = (opts?: { drain?: boolean }) => Promise<JobsResult | null>;

/**
 * Tool definitions in the OpenClaw AgentTool shape. `clawmark_` prefix avoids
 * collisions with native memory tools and other memory plugins. Runtime is resolved
 * lazily so tools registered before gateway_start still work.
 */
export function buildTools(getRuntime: () => ClawmarkRuntime | null, runJobs: RunJobsFn) {
  const requireRuntime = (): ClawmarkRuntime => {
    const rt = getRuntime();
    if (!rt) throw new Error("Clawmark is not initialized (gateway not started or config invalid)");
    return rt;
  };

  return [
    {
      name: "clawmark_set",
      label: "Clawmark: remember fact",
      description:
        "Store a durable fact about the user (preference, decision, project, correction). " +
        "Key must be lowercase dot-separated starting with pref./project./user./lesson., " +
        'e.g. "pref.editor". User-set facts always win over extracted ones.',
      parameters: Type.Object({
        key: Type.String({ description: "Fact key, e.g. pref.editor" }),
        value: Type.String({ description: "The fact itself, one or two sentences" }),
      }),
      async execute(_id: string, params: { key: string; value: string }): Promise<ToolResult> {
        const { db, config } = requireRuntime();
        const result = setFact(db, params.key, params.value, 1.0, "user", config.confidenceThreshold);
        if (!result.ok) throw new Error(`clawmark_set rejected (${result.code}): ${result.reason}`);
        return text(`Remembered ${params.key} (${result.action}).`);
      },
    },
    {
      name: "clawmark_search",
      label: "Clawmark: search memory",
      description:
        "Search stored facts and past conversation history. Returns matching facts and " +
        "relevant excerpts from prior sessions.",
      parameters: Type.Object({
        query: Type.String({ description: "What to look for" }),
        limit: Type.Optional(Type.Number({ description: "Max recall excerpts (default 6)" })),
      }),
      async execute(_id: string, params: { query: string; limit?: number }): Promise<ToolResult> {
        const { db, source, embedder, config } = requireRuntime();
        const q = params.query.toLowerCase();
        const tokens = q.match(/[a-z0-9_]{2,}/g) ?? [];
        const facts = listFacts(db).filter((f) => {
          const hay = `${f.key} ${f.value}`.toLowerCase();
          return tokens.some((t) => hay.includes(t));
        });
        const excerpts = await recall(db, source, embedder, params.query, params.limit ?? config.recallLimit);
        return text({
          facts: facts.map((f) => ({ key: f.key, value: f.value, confidence: f.confidence })),
          recalled: excerpts.map((r) => ({ date: r.ts.slice(0, 10), role: r.role, excerpt: r.excerpt })),
        });
      },
    },
    {
      name: "clawmark_reconcile",
      label: "Clawmark: reconcile memory now",
      description:
        "Force the background memory jobs to run immediately instead of waiting for the " +
        "message-count or idle triggers: index new messages into the recall store, " +
        "extract durable facts from un-processed conversation, and prune stale facts. " +
        "Use when the user asks to sync/reconcile/refresh memory or after an important " +
        "conversation they want captured right away.",
      parameters: Type.Object({
        drain: Type.Optional(
          Type.Boolean({ description: "Process the entire backlog (default true); false = one incremental pass" }),
        ),
      }),
      async execute(_id: string, params: { drain?: boolean }): Promise<ToolResult> {
        requireRuntime();
        const result = await runJobs({ drain: params.drain ?? true });
        if (result === null) {
          return text("Reconcile already in progress (or plugin not initialized) — try again shortly.");
        }
        return text(
          `Reconciled: indexed ${result.indexed} new messages, extracted ${result.written} facts, ` +
            `pruned ${result.pruned} stale facts.`,
        );
      },
    },
    {
      name: "clawmark_review",
      label: "Clawmark: review stale facts",
      description:
        "List extracted facts that haven't been reinforced recently and are decaying " +
        "toward exclusion from context. Confirm each with the user: clawmark_set to " +
        "refresh a fact that's still true, clawmark_forget to drop one that isn't.",
      parameters: Type.Object({
        days: Type.Optional(Type.Number({ description: "Minimum days since last reinforcement (default 90)" })),
      }),
      async execute(_id: string, params: { days?: number }): Promise<ToolResult> {
        const { db } = requireRuntime();
        const stale = staleFacts(db, params.days);
        if (stale.length === 0) return text("No stale facts — everything has been reinforced recently.");
        return text(
          stale.map((f) => ({
            key: f.key,
            value: f.value,
            days_since_reinforced: f.days_since_reinforced,
            effective_confidence: f.effective_confidence,
          })),
        );
      },
    },
    {
      name: "clawmark_forget",
      label: "Clawmark: forget fact",
      description: "Delete a stored fact by key. Use clawmark_search first to find the key.",
      parameters: Type.Object({
        key: Type.String({ description: "Fact key to delete" }),
      }),
      async execute(_id: string, params: { key: string }): Promise<ToolResult> {
        const { db } = requireRuntime();
        const deleted = deleteFact(db, params.key, "user");
        return text(deleted ? `Forgot ${params.key}.` : `No fact stored under ${params.key}.`);
      },
    },
  ];
}
