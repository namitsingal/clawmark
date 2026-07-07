# Clawmark 🦞

Durable facts and semantic recall for [OpenClaw](https://openclaw.ai), derived from the
message history you already keep. Clawmark: the marks a claw leaves behind — traces of
past conversations.

## What it does

Clawmark adds the two memory capabilities a stock OpenClaw install lacks:

1. **Facts** — small, structured, always-injected: preferences, decisions, active
   projects, corrections. Written by an explicit tool (`clawmark_set`) and by a
   background extraction job, with confidence gating and user-beats-extracted precedence.
2. **Recall** — query-relevant retrieval over your full message history: an embedding
   index built *over the messages OpenClaw already stores*, injected as short excerpts
   when relevant to the current prompt.

What it deliberately does **not** do:

- **No duplicate message store.** Clawmark never copies your history. It reads the
  canonical log (Lossless Claw's database, or OpenClaw's own session transcripts)
  read-only, behind cursors.
- **No history summarization.** That's compaction's job (or Lossless Claw's).
- **No cloud.** Embeddings and extraction hit whatever OpenAI-compatible endpoints you
  configure — typically local llama.cpp servers.

## Why it's crash-safe by design

Both background jobs (the embedding indexer and the fact extractor) are cursor-based
readers of a durable log. Cursors advance in the same SQLite transaction as the writes
they cover. `kill -9` the gateway at any moment: on the next start, both jobs continue
from their last committed cursor. Nothing is lost, and re-processing a batch is a no-op
(upserts + a precedence ladder absorb repeats).

## Requirements

- OpenClaw `2026.5.28+`
- An OpenAI-compatible **embeddings** endpoint (e.g. llama.cpp/bge-m3, 1024 dims by default)
- An OpenAI-compatible **chat** endpoint for background fact extraction (a small 4–8B
  model is plenty — prefer one that doesn't share slots with your interactive chat model)
- No plugin dependencies. If [Lossless Claw](https://github.com/martian-engineering/lossless-claw)
  is installed, Clawmark auto-detects and prefers its message log.

## Install

```bash
openclaw plugins install openclaw-clawmark
```

Then set the environment (see `.env.example` for the full list):

```bash
CLAWMARK_DB_PATH=~/.openclaw/clawmark.db
CLAWMARK_TRANSCRIPTS_DIR=~/.openclaw/agents/main/sessions
CLAWMARK_EMBEDDING_URL=http://your-inference-box:11438
CLAWMARK_EMBEDDING_MODEL=bge-m3-fp16
CLAWMARK_EXTRACT_URL=http://your-inference-box:11437
CLAWMARK_EXTRACT_MODEL=your-small-model.gguf
```

Restart the gateway. Clawmark logs which message source it selected; if configuration is
incomplete it stays inert and logs the missing variable — it never breaks the agent.

## Configuration

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `CLAWMARK_DB_PATH` | yes | — | Clawmark's own SQLite DB (facts, vectors, cursors, audit events) |
| `CLAWMARK_SOURCE` | no | `auto` | `auto` \| `lcm` \| `transcripts` |
| `CLAWMARK_TRANSCRIPTS_DIR` | yes* | — | OpenClaw session-transcript dir (the always-available source) |
| `CLAWMARK_LCM_DB_PATH` | no | — | Lossless Claw's SQLite DB; auto-preferred when set and valid |
| `CLAWMARK_EMBEDDING_URL` / `_MODEL` | yes | — | OpenAI-compatible `/v1/embeddings` endpoint |
| `CLAWMARK_EMBEDDING_DIM` | no | `1024` | Embedding dimensionality |
| `CLAWMARK_EXTRACT_URL` / `_MODEL` | yes | — | OpenAI-compatible chat endpoint for extraction |
| `CLAWMARK_CONFIDENCE_THRESHOLD` | no | `0.8` | Extracted facts below this are discarded |
| `CLAWMARK_RECALL_LIMIT` | no | `6` | Max recalled excerpts per turn |
| `CLAWMARK_IDLE_HOURS` | no | `3` | Idle time before a full backlog drain |

\* required unless `CLAWMARK_LCM_DB_PATH` is set and valid.

## Tools

- `clawmark_set(key, value)` — remember a fact explicitly. User-set facts always win.
- `clawmark_search(query, limit?)` — search facts + recall excerpts from past sessions.
- `clawmark_forget(key)` — delete a fact.

## Security model

Everything Clawmark injects is wrapped in a guard block that labels it as **DATA, not
instructions**, and the closing marker survives truncation. On the write path, extracted
fact values are scanned against prompt-injection patterns before storage; blocked writes
are logged as `injection_blocked` audit events. Every mutation lands in an append-only
`memory_events` table:

```bash
sqlite3 ~/.openclaw/clawmark.db "SELECT event_type, COUNT(*) FROM memory_events GROUP BY 1;"
sqlite3 ~/.openclaw/clawmark.db "SELECT key, confidence, source FROM facts WHERE is_deleted=0 ORDER BY updated_at DESC LIMIT 20;"
```

## Running alongside other plugins

| Plugin | Status | Notes |
|---|---|---|
| Lossless Claw (LCM) | **compatible, preferred source** | Read-only, schema validated at startup; on drift Clawmark logs `source_fallback` and uses transcripts. Tested against the schema of LCM ≥ 2026.6. |
| OpenClaw native markdown memory | **compatible** | Clawmark never touches `MEMORY.md`. Once facts migrate into Clawmark you can trim the markdown to reclaim prompt budget. |
| Mem0 / ClawXMemory / Maximem / other memory plugins | **works, but redundant** | Two extractors double background LLM calls and inject overlapping context. Pick one fact-extraction layer. Tool names never collide (`clawmark_` prefix). |
| Everything else | untested | Clawmark only reads message logs and injects ≤ ~3.5k tokens via `before_prompt_build`; conflicts are unlikely but unverified. |

**Prompt-budget math**: Clawmark injects at most `TOTAL_CAP_CHARS` (12,000 chars ≈ 3.5k
tokens) per turn, and usually far less — facts cap at 6,000 chars and recall only fires
when the query matches something. Whatever Lossless Claw and other plugins inject is
additive; a typical combined turn looks like: system prompt + LCM context + Clawmark
block (0.5–3.5k tokens) + your message.

## Message sources — pluggable, nothing required

Clawmark reads history through a `MessageSource` interface (`src/sources/`). Out of the
box: a native-transcript adapter (always available) and a Lossless Claw adapter
(auto-preferred). Adapters are ~100 lines; contributions for other history stores are
welcome — implement `validate` / `messagesAfter` / `getMessages` with an opaque cursor.

## Development

```bash
npm install
npm test          # vitest — 60 tests, fixtures only, no network
npm run check     # tsc --noEmit
npm run build     # emit dist/
```

## License

MIT
