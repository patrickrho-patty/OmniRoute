# FORK_NOTES.md — OmniRoute fork and deployment customizations

This is the canonical record of **what we changed or configured that is not present in upstream OmniRoute**.

It covers two classes of change:

1. **Fork source changes** — committed code in `patrickrho-patty/OmniRoute`, branch `custom-features`.
2. **Operational/client customizations** — live-server config, Cloudflare setup, pi/OpenCode configs, and migration scripts. These are not upstream source commits, so their "commit" field is marked **external state / no repo commit**.

Keep this file updated whenever we add a new fork-only source patch or a production/client customization that future migrations depend on.

---

## Current git state

| Item                                | Value                                                                 |
| ----------------------------------- | --------------------------------------------------------------------- |
| Upstream repo                       | `github.com/diegosouzapw/OmniRoute`                                   |
| Fork remote                         | `git@github.com:patrickrho-patty/OmniRoute.git`                       |
| Fork branch carrying source patches | `custom-features`                                                     |
| Upstream baseline                   | `v3.8.38` (`7b139fdb5`) — rebased 2026-06-28                          |
| Current deploy HEAD                 | `3b5810bd4` (deployed to `jebo.ai` 2026-06-30)                        |
| Source divergence                   | ~25 commits ahead of upstream v3.8.38                                 |
| Pushed to GitHub                    | Yes — `custom-features` pushed to origin                              |
| VPS                                 | Contabo `109.123.231.227` (24 GB RAM, 8 CPU, 774 GB disk), port 12160 |
| Previous VPS                        | Oracle `161.33.162.164` (1 GB RAM), decommissioned                    |

Fork source patch commits on `custom-features` (most recent first):

| Commit      | Title                                                                                      | Docs        |
| ----------- | ------------------------------------------------------------------------------------------ | ----------- |
| `3b5810bd4` | feat(llmlingua): bundle tinybert ONNX model + load-from-repo-first logic                   | SRC-011     |
| `011760580` | fix(branding): use patty.io's actual favicon image (not a vector approximation)            | DOC         |
| `701433d7a` | fix(deploy): raise poller timeout to 25 min (build exceeds 10 min, caused false timeout)   | DOC         |
| `4aece25e1` | feat(dashboard): add relevance engine page + fix favicon flicker                           | DOC         |
| `c51b89128` | chore(branding): Patty rebrand login shell + anti-fingerprinting authz                     | DOC         |
| `21d21c592` | fix(compression): overflow safeguard + rtk incremental stat accuracy                       | SRC-011     |
| `27103d0b2` | fix(compression): address code-review findings on incremental + cache-safety               | SRC-011     |
| `501548d5e` | feat(usage): surface provider prompt-cache hit rate per request                            | SRC-011     |
| `17bb616cb` | feat(compression): preserve provider prompt cache — gate cache-unsafe engines              | SRC-011     |
| `28f2dbe6e` | feat(compression): incremental process-once compressor (Stage 2, default-off)              | SRC-011     |
| `6d598fc40` | feat(compression): merge upstream compression engines and add O(n) session-dedup (Stage 1) | SRC-012     |
| `959667005` | Fix hardcoded ports + Claude Messages API shape recognition                                | SRC-001/002 |
| `4bea2187b` | fix: add ChatGPT Web tool-call translation                                                 | SRC-003     |
| `95a0bd35c` | feat(compression): add ponytail engine and per-engine analytics separation                 | SRC-004     |
| `b166f0c97` | fix(sse): treat mid-stream client disconnect as disconnect, not a 502                      | SRC-005     |
| `b3134b958` | feat(telemetry): honor OMNIROUTE_ENABLE_LIVE_WS=0 in the live-WS forwarder                 | SRC-006     |
| `4d12f18aa` | feat(dashboard): add Ponytail submenu under Compression with run history                   | SRC-007     |
| `43d670f77` | feat(compression): wire session-dedup config persistence                                   | SRC-008     |
| `a55966c3b` | fix(compression): LLMLingua Worker path fix for Node 22                                    | SRC-009     |
| `aeab40d15` | feat(compression): add Microsoft + Arcoldd LLMLingua ONNX models                           | SRC-010     |

`main` in this fork is intentionally kept identical to upstream `main`; our deploy branch is `custom-features`.

---

## Source changes unique to this fork

### SRC-001 — Hardcoded port fallbacks fixed

| Field             | Value                                                         |
| ----------------- | ------------------------------------------------------------- |
| Commit            | `9b374c5870caebf1a7f0ff9f260d60ce7ab98613`                    |
| Commit title      | `Fix hardcoded ports + Claude Messages API shape recognition` |
| Date              | 2026-06-27 04:04:47 KST                                       |
| Upstream baseline | `555b21d29` / v3.8.37                                         |
| Status            | Deployed to `jebo.ai`; source pushed to fork                  |

#### Problem

OmniRoute upstream v3.8.37 had several internal loopback/live-WS call sites with literal fallback ports:

- `20128` for the main API/dashboard listener
- `20129` for the live-WS sidecar

That broke our deployment because `jebo.ai` runs OmniRoute on **port 80** behind Cloudflare Flexible SSL, not on the upstream default `20128`.

#### Root cause

`src/lib/runtime/ports.ts` already existed upstream, but several newer call sites bypassed it and used hardcoded literals.

#### Fix

The fork routes those call sites through `getRuntimePorts()`:

| File                                              | Fork change                                                                                  |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `open-sse/handlers/chatCore/telemetryHelpers.ts`  | Uses `getRuntimePorts().liveWsPort` instead of the `LIVE_WS_PORT` hardcoded `20129` fallback |
| `src/app/api/playground/improve-prompt/route.ts`  | Uses `getRuntimePorts().port` instead of `process.env.PORT ?? "20128"`                       |
| `src/app/api/providers/[id]/sync-models/route.ts` | Uses `getRuntimePorts().port` for two loopback readiness/model-sync call sites               |
| `src/app/api/v1/ws/route.ts`                      | Uses `getRuntimePorts().liveWsPort` for advertised live-WS metadata                          |
| `src/lib/cli-helper/tool-detector.ts`             | Tool-detection heuristic uses the runtime port instead of `localhost:20128`                  |
| `src/lib/runtime/ports.ts`                        | Adds live-WS defaulting: `liveWsPort = basePort + 1` unless `LIVE_WS_PORT` is explicit       |

Added behavior in `src/lib/runtime/ports.ts`:

```ts
const DEFAULT_LIVE_WS_PORT_OFFSET = 1;

liveWsPort: parsePort(process.env.LIVE_WS_PORT, basePort + DEFAULT_LIVE_WS_PORT_OFFSET),
liveWsPortExplicit: !!process.env.LIVE_WS_PORT,
```

This keeps upstream's historical pairing (`20128` main, `20129` live-WS) while making non-default deployments work (`80` main, `81` live-WS fallback unless overridden).

#### Verification used

After build + deploy to nic1:

- `POST https://jebo.ai/v1/messages` returned HTTP 200 with real Claude text.
- `POST https://jebo.ai/v1/chat/completions` streamed successfully.
- `GET https://jebo.ai/v1/models` returned HTTP 200 with the production `OMNIROUTE_API_KEY`.
- Service was active on port 80 behind Cloudflare Flexible SSL.

---

### SRC-002 — Claude Messages API responses no longer misclassified as malformed

| Field             | Value                                                         |
| ----------------- | ------------------------------------------------------------- |
| Commit            | `9b374c5870caebf1a7f0ff9f260d60ce7ab98613`                    |
| Commit title      | `Fix hardcoded ports + Claude Messages API shape recognition` |
| Date              | 2026-06-27 04:04:47 KST                                       |
| Upstream baseline | `555b21d29` / v3.8.37                                         |
| Status            | Deployed to `jebo.ai`; source pushed to fork                  |

#### Problem

`/v1/messages` returned 502 even when the upstream Claude request succeeded. The logs showed valid Claude responses with real `msg_...` IDs, real token counts, and valid text, but OmniRoute still returned 502 to the client.

#### Root cause

`open-sse/utils/diagnostics.ts::detectMalformedNonStream()` only recognized two non-streaming response shapes:

1. Responses API shape: `body.object === "response"` with `body.output[]`
2. Chat Completions shape: `body.choices[]`

Claude Messages API responses use a third shape:

```json
{
  "type": "message",
  "role": "assistant",
  "content": [{ "type": "text", "text": "..." }],
  "stop_reason": "end_turn",
  "usage": { "input_tokens": 123, "output_tokens": 45 }
}
```

The discriminator is `type === "message"`, **not** `object === "message"`.

Without a Claude branch, every successful Claude Messages response fell through to the Chat Completions validator, which expected `body.choices[]`. Claude never sets `choices`, so the validator returned `"empty_choices"`, and OmniRoute converted the successful response into a 502.

#### Fix

Added a Claude Messages branch to `detectMalformedNonStream()`:

```ts
if (body.type === "message") {
  const content = body.content;
  const hasOutput =
    Array.isArray(content) &&
    content.some((block) => {
      if (!block || typeof block !== "object") return false;
      const b = block as Record<string, unknown>;
      if (typeof b.text === "string" && (b.text as string).length > 0) return true;
      if (b.type === "tool_use" || b.type === "tool_result") return true;
      return false;
    });
  if (!hasOutput) return "empty_choices";
  return null;
}
```

#### Verification used

After rebuild + deploy:

- `POST https://jebo.ai/v1/messages` returned HTTP 200 with response text `2 + 2 = **4**`.
- `POST https://jebo.ai/v1/chat/completions` streamed SSE chunks successfully.
- The deployed minified bundle contained the `type === "message"` check.
- `GET https://jebo.ai/v1/models` returned HTTP 200 using the production `OMNIROUTE_API_KEY`.

#### Durable rule

If a new response format is added, update `detectMalformedNonStream()` with a shape-specific branch. Otherwise, valid non-OpenAI responses can be misclassified as `empty_choices` and returned as 502.

---

### SRC-003 — ChatGPT Web tool-call translation

| Field             | Value                                                  |
| ----------------- | ------------------------------------------------------ |
| Commit            | `e799ee98cc4205e1726b90f145f1159be55c72e4`             |
| Commit title      | `fix: add ChatGPT Web tool-call translation`           |
| Date              | 2026-06-28 03:19:11 KST                                |
| Upstream baseline | `555b21d29` / v3.8.37                                  |
| Files changed     | 2 (`chatgpt-web.ts`, `tests/unit/chatgpt-web.test.ts`) |
| Diff stat         | +308 / −11                                             |
| Status            | Deployed to `jebo.ai`; source pushed to fork           |

#### Problem

The `chatgpt-web` executor (ChatGPT web-session provider) ignored `body.tools` entirely, so any request asking the model to call a tool got plain text back instead of structured tool calls. Clients expecting OpenAI-format `tool_calls` could not use function-calling through the ChatGPT Web route.

#### Fix

`open-sse/executors/chatgpt-web.ts` now reuses the generic web-tool helpers and emits OpenAI-compatible tool-call output:

| Change                 | Detail                                                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool-message prep      | Calls `prepareToolMessages()` (from `open-sse/translator/webTools.ts`) to translate `body.tools` into the message shape ChatGPT's web session expects |
| Tool-call parsing      | Calls `buildToolAwareResult()` to parse the model's tool-call text into structured calls                                                              |
| Synthetic `tool_calls` | Emits OpenAI-compatible `choices[].delta.tool_calls[]` / `message.tool_calls[]` so OpenAI-format clients see real tool calls                          |
| Streaming parity       | Includes `logprobs: null` in every streamed chunk (matches OpenAI's streaming shape)                                                                  |
| Non-streaming          | Buffers the tool-mode response and returns the assembled assistant message with `tool_calls`                                                          |

Verified symbols in deployed source: `prepareToolMessages` (import line 33, call site `chatgpt-web.ts:2809`), `buildToolAwareResult` (import line 34, call site `chatgpt-web.ts:1870`), `tool_calls` emission (`chatgpt-web.ts:1817, 1882`), `logprobs: null` across all chunk shapes.

#### Durable rule

Web-cookie executors that should support tool calling must go through `prepareToolMessages()` / `buildToolAwareResult()` rather than hand-rolling their own tool-call parsing. (Note: `deepseek-web.ts` is the exception — it has a specialized `parseDeepSeekToolCalls()` for DeepSeek's multiple tag formats.)

---

### SRC-004 — Ponytail compression engine + per-engine analytics separation

| Field             | Value                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| Commit            | `680b8c00c6763ad99e4173012f2ed99c9d6f1130`                                                       |
| Commit title      | `feat(compression): add ponytail engine and per-engine analytics separation`                     |
| Date              | 2026-06-28 06:35:19 KST                                                                          |
| Upstream baseline | `555b21d29` / v3.8.37                                                                            |
| Files changed     | 18 (15 modified + 3 new: `ponytail/index.ts`, `systemInstruction.ts`, `ponytail-engine.test.ts`) |
| Diff stat         | +591 / −126                                                                                      |
| Status            | Deployed to `jebo.ai`; source pushed to fork                                                     |

#### Problem

1. The compression suite had no Ponytail integration. Ponytail (DietrichGebert/ponytail) is a lazy-senior-dev YAGNI discipline for AI coding agents — it forces a 7-rung ladder (does this need to exist → already in codebase → stdlib → native → dependency → one line → minimum safe code) before writing any code.
2. Compression analytics showed only combined `stacked` totals. When multiple engines ran in a stacked pipeline (RTK → Caveman → …), the dashboard could not show how much each individual engine saved.

#### Fix — Ponytail engine

New stackable engine at `open-sse/services/compression/engines/ponytail/index.ts` (stackPriority 25, levels lite/full/ultra, default full):

- Injects Ponytail YAGNI instructions into endpoint system prompts via the **shared output-style injection path** (`applyOutputStyles()` with a custom `[OmniRoute Ponytail]` marker).
- Idempotent: the shared `injectSystemInstructionOnce()` helper (new in `open-sse/services/compression/systemInstruction.ts`) skips re-injection when the marker already exists.
- **Augmentation, not compression:** injecting instructions _adds_ tokens. Ponytail stats report `savingsPercent = 0` and track `augmentationTokens`; the stacked finalizer subtracts augmentation tokens from estimated savings so the suite total is not penalized by the added instruction.
- Wired through: `engineCatalog.ts` (catalog entry + `levels`), `engines/index.ts` (registry), `compression/index.ts` (exports), `types.ts` (`CompressionEngineId` union), `compressionConfigSchemas.ts` (Zod — resolves upstream issue #4955 engine-id drift gap), `compression.ts` (default engine map), `compressionCombos.ts` (combo normalization).

#### Fix — Per-engine analytics

`src/lib/db/compressionAnalytics.ts::getCompressionAnalyticsSummary()`:

- `byEngine` now prefers per-stage rows from `compression_engine_breakdown` and excludes the matching aggregate `compression_analytics` row (and null-`request_id` stacked rows) so stacked runs show RTK/Caveman/Ponytail separately instead of only `stacked`.
- Anti-join switched from unbounded `NOT IN` to indexed `NOT EXISTS`.
- Added index `idx_ceb_ts_engine ON compression_engine_breakdown(timestamp, engine)`.
- `avgSavingsPct` computed from weighted token sums, not averages of per-row percentages.
- `src/app/(dashboard)/dashboard/analytics/CompressionAnalyticsTab.tsx` renders a separate Engine Breakdown card.

#### Verification

`ponytail-engine.test.ts`, `compressionAnalytics.test.ts`, `engine-catalog.test.ts`, `mode-and-pipeline.test.ts`, `output-styles-apply.test.ts`, `output-styles-backcompat.test.ts`, `outputMode.test.ts`, `combos-engine-ui-schema-parity-4955.test.ts` → **55 pass / 0 fail**. `typecheck:core` clean, `check:cycles` OK (285 files).

Deployed bundle (`680b8c00c`) verified to contain `OmniRoute Ponytail` marker (chunks `26410.js`, `35827.js`), `augmentationTokens` (5 hits), `NOT EXISTS` anti-join (67 hits).

#### Durable rule

Augmentation engines (those that add tokens rather than remove them) must report `savingsPercent = 0` and set `augmentationTokens`; the stacked finalizer excludes augmentation tokens from the suite total so legitimate compression savings stay accurate.

## Production runtime customizations not in upstream source

These changes are required for the current `jebo.ai` deployment, but they are **not source commits** in OmniRoute.

### OPS-001 — Run OmniRoute on port 12160 behind Cloudflare Origin Rule

| Field   | Value                                                      |
| ------- | ---------------------------------------------------------- |
| Commit  | External runtime state / no repo commit                    |
| Host    | Contabo `109.123.231.227` (24 GB RAM, 8 CPU)               |
| Domain  | `https://jebo.ai`                                          |
| Purpose | Clean HTTPS base URL for coding agents without port suffix |

#### Current architecture

```text
Client → https://jebo.ai/v1 → Cloudflare edge TLS → Origin Rule (port 12160) → OmniRoute
```

Cloudflare SSL mode is **Flexible**. TLS terminates at Cloudflare. A Cloudflare **Origin Rule** rewrites the destination port from 443 to **12160**. The origin server listens on plain HTTP port 12160 (unprivileged — no `setcap` needed).

#### Required server settings

- `PORT=12160` in `.env`
- `REQUIRE_API_KEY=true`
- `OMNIROUTE_BASE_URL=http://127.0.0.1:12160`
- `NEXT_PUBLIC_BASE_URL=https://jebo.ai`
- `OMNIROUTE_PUBLIC_BASE_URL=https://jebo.ai`
- `NEXT_PUBLIC_APP_URL=https://jebo.ai`

#### Required Cloudflare settings

- **DNS:** A record `jebo.ai` → `109.123.231.227` (proxied, orange cloud)
- **Origin Rule:** hostname equals `jebo.ai` → destination port rewrite to `12160`
  (Rules → Overview → Create rule → Origin Rule)
- **AI bot detection:** disabled for `jebo.ai` (see OPS-003)

#### Deployment model

The new VPS builds from source (cloned repo at `/opt/OmniRoute`), unlike the old VPS which used rsync of a standalone bundle. Deploy flow:

```bash
cd /opt/OmniRoute && git pull origin custom-features && npm run build && systemctl restart omniroute.service
```

#### Previous VPS (decommissioned)

Oracle `161.33.162.164` (1 GB RAM), port 80, rsync-based deploys. Kept as backup but no longer receiving traffic.

---

### SRC-005—SRC-010 — Older infra / SSE / telemetry / dashboard patches

Existing patches on `custom-features` before the 2026-06-30 release:

| Commit      | Title                                                                      | Notes                                                            |
| ----------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `b166f0c97` | fix(sse): treat mid-stream client disconnect as disconnect, not a 502      | `open-sse/handlers/sse.ts` — distinguishes ECONNRESET on a fin   |
| `b3134b958` | feat(telemetry): honor OMNIROUTE_ENABLE_LIVE_WS=0 in the live-WS forwarder | `open-sse/handlers/chatCore/liveWsTelemetry.ts` — guards forward |
| `4d12f18aa` | feat(dashboard): add Ponytail submenu under Compression with run history   | `src/app/(dashboard)/dashboard/context/ponytail/*`               |
| `43d670f77` | feat(compression): wire session-dedup config persistence                   | dashboard Save button + config schema                            |
| `a55966c3b` | fix(compression): LLMLingua Worker path fix for Node 22                    | `engines/llmlingua/worker.ts` — `import.meta.url` workaround     |
| `aeab40d15` | feat(compression): add Microsoft + Arcoldd LLMLingua ONNX models           | added `bert-base-ms`, `bert-base` to `LLMLINGUA_MODELS`          |

Each is a self-contained, well-isolated patch. No further detail needed beyond the
diff; they exist primarily so the commit table above audit-trails what's deployed.

---

### SRC-011 — Compression: provider prompt-cache preservation + incremental cache + visibility

| Field             | Value                                                                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commits (chain)   | `6d598fc40` (Stage 1) → `28f2dbe6e` (Stage 2 default-off) → `17bb616cb` (cache gate) → `501548d5e` (visibility) → `27103d0b2` (review fixes) → `21d21c592` (overflow + stat fixes) |
| Upstream baseline | `v3.8.38` (`7b139fdb5`)                                                                                                                                                            |
| Files changed     | ~25 (engines/_, services/compression/_, tests/unit/compression/\*)                                                                                                                 |
| Status            | Stage 1 + cache gate + visibility deployed to `jebo.ai`; Stage 2 default-off, ready behind `incrementalCache` flag                                                                 |

#### Problem

Compression was being measured only by local tokens saved, with no view of whether it was
forfeiting the provider's prompt-cache discount. Anthropic/OpenAI/Gemini give a ~10×
discount on cached prefix tokens — rewrites that change the cached prefix byte-for-byte
bust the cache and dominate any local savings. Also:

- Stage 1 crisis: `session-dedup`'s `findSuffixBlocks` was O(n²) on the full conversation
  (~18 s on 200 K-token agentic sessions, freezing the event loop and triggering
  "Server is unreachable").
- No at-a-glance cache health — every change to the compression layer could silently
  drop the cache hit rate with no signal in logs.

#### Fix — 3 layers, with separate decision records

**(a) Cache-safety gate** — `open-sse/services/compression/strategySelector.ts::filterCacheUnsafeSteps()`.
Engines declare `cacheSafe: true|false` + `overflowCritical: true|false` in their metadata
(`open-sse/services/compression/engines/types.ts`). On the engine path:

| Engine                                                      | `cacheSafe`                        | Notes                                                                                                                                                  |
| ----------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| session-dedup, rtk, caveman, lite, ponytail, ccr, llmlingua | `true`                             | Per-message, content-addressed, prefix-stable                                                                                                          |
| aggressive, ultra, ionizer, relevance                       | `false`                            | Budget-driven or query-driven; mutates prefix → busts cache                                                                                            |
| headroom                                                    | `false` + `overflowCritical: true` | Budget-driven (cache-busting) but exempt from the gate because it prevents context-window overflow (the proper long-term fix is to make it tail-aware) |

In a caching context (provider in `CACHING_PROVIDERS` = claude/anthropic/openai/google
gemini/deepseek/qwen/alibaba/…), the stacked pipeline drops `cacheSafe === false`
engines, unless they're `overflowCritical`, to keep the provider cache alive. The
`CachingDetectionContext` is now threaded through `chatCore.ts` so native Claude
requests (`/v1/messages` with `cc/claude-*`) are correctly detected.

Overflow safeguard: if dropping cache-unsafe engines would leave the pipeline unable to
shrink the request at all (nothing in the kept set still compresses — ponytail only
augments) and no hard budget (`targetTokens`/`targetRatio`) is set, the filter falls
back to keeping everything. Context-window overflow upstream is worse than a cache miss.

**(b) Incremental "process-once" compressor (Stage 2)** — `open-sse/services/compression/incremental/`
(commits `28f2dbe6e`, `27103d0b2`, `21d21c592`). Optional, default-off via
`config.incrementalCache === true`. Maintains:

- A per-session memo (`ctx.memo`) keyed by cumulative message hash, so prefix messages
  reuse their compressed form verbatim across turns.
- An append-only invariant: the incremental memo is only valid while the conversation
  grows by appending. Mutating a past message forces a reset (handled by
  `isAppendOnlyExtension` — `_processMessages_ → resetContextState`).
- A pipeline signature (`pipelineSignature.ts`) with canonical key-sort so semantically-
  identical configs hash the same (no spurious cache resets from key insertion order).
- An incremental-safe gate (`pipelineIsIncrementalSafe()`) on the entry point: any
  cache-unsafe engine before a memoizing one would let stale memo output flow downstream
  and silently diverge — falls back to the full path when any `cacheSafe === false`
  engine is present.
- An rtk memo-stats fix (no undercounting for cached messages): `computeMessage` is
  pure; the caller accumulates stats for both cached and fresh messages.

**(c) Cache-hit visibility** — `open-sse/utils/usageTracking.ts` emits
`cache_hit=NN%` on every `[USAGE]` log line. The percentage is
`cache_read_input_tokens / input_tokens` (both fields are returned by Anthropic/OpenAI
per response). A sudden drop in `cache_hit%` is now an instant signal that something is
busting the cache. Verified against live `jebo.ai` Claude traffic: ~83 % on the principal.

#### Verification

49 compression tests pass (7/7 in `tests/unit/compression/cache-safety-filter.test.ts`,
8/8 in `incremental-equivalence.test.ts`, plus rtk + session-dedup + ponytail). Manual
load-from-bundled-repo end-to-end test: ~92 ms to load tinybert from
`models/llmlingua/...`, ~6 ms warm inference, 41 % token reduction on 292-char prose
input.

#### Durable rules

1. **Any new compression engine** must declare its `cacheSafe` flag in
   `metadata`. Default is "safe but unknown" — the filter keeps it. This guarantees a
   forgotten flag degrades to "keep the engine" rather than silently disabling it.
2. **Anything query- or budget-driven (LongLLMLingua, SCOPE, relevance, aggressive,
   ultra, ionizer, headroom)** must be tagged `cacheSafe: false` because it rewrites
   the prefix. From upstream: only `headroom` justifies the `overflowCritical` escape
   hatch.
3. **The incremental memo** is only valid for append-only growth. If the conversation
   stops being append-only, reset; never trust the memo across a structural change.

---

### SRC-012 — `session-dedup` O(n²) → O(n) rewrite (Stage 1)

| Field             | Value                                                    |
| ----------------- | -------------------------------------------------------- |
| Commit            | `6d598fc40`                                              |
| Upstream baseline | `v3.8.38` (`7b139fdb5`)                                  |
| Files changed     | session-dedup/{index,suffixDedup}.ts, + bounded eviction |
| Status            | Deployed to `jebo.ai` 2026-06-30                         |

#### Problem

`suffixDedup.ts::findSuffixBlocks()` materialized and SHA-hashed **every suffix of every
message** and ran twice on the full conversation history. On a 200 K-token / 385-message
production conversation this took **~18 s of event-loop block** per turn. The dashboard
surfaced it as "Server is unreachable."

#### Root cause

A textbook quadratic blowup: `O(n²)` strings × `O(n)` chars = `O(n³)` for a 200 K-token
string. Also vulnerable to thrashing on adjacent string-vs-multipart message boundaries
(fix in the same commit: string keys namespaced to `i*100000`).

#### Fix

Replaced the two suffix-materialization passes with a **single-pass backward rolling
suffix hash**:

| File                                                                 | Change                                                                                                                                                                |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open-sse/services/compression/engines/session-dedup/suffixDedup.ts` | New backward rolling-hash implementation; ~37 ms on the 200 K-token / 385-message fixture (~487× faster)                                                              |
| `engines/session-dedup/index.ts`                                     | Uses the new implementation; identical contract (longest suffix match, first-occurrence kept verbatim, reversible `[dedup:ref sha=]` markers, collision verification) |
| `engines/session-dedup/types.ts`                                     | Exports a `DedupIndex` type so the incremental compressor (`SRC-011`) can carry the cross-turn state                                                                  |

#### Bounded eviction

`ownerLines` (the verification store) and `firstSeen` (the suffix index) are bounded by
`boundedMapSet` (FIFO, capacity 5000 entries). Eviction is always a missed dedup, never
corruption.

#### Durable rule

If you add a new algorithm that touches every position of every message, assume it is
quadratic unless you can prove otherwise. The 200 K-token prod case is the test
fixture; test there first.

---

### SRC-013 — LLMLingua bundled-model repo (TinyBERT direct git blob)

| Field          | Value                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------- |
| Commit         | `3b5810bd4`                                                                               |
| Status         | Deployed to `jebo.ai` 2026-06-30. No HF download required on the VPS.                     |
| Disk footprint | 54 MB `model.onnx` (direct git blob; under GitHub's 100 MB limit) + ~1 MB tokenizer files |

#### Problem

LLMLingua downloaded its 710 MB BERT-base model from HuggingFace on first use. Every
fresh VPS deploy had to: (a) own network access to HF, (b) tolerate ~60 s for first-call
load, (c) eat transient disk pressure for the cache. Worst case: locked VPS billing
alert when the HF token auth changed.

#### Fix

Bundle a **57 MB TinyBERT** model directly in the repo:

- `models/llmlingua/atjsh/llmlingua-2-js-tinybert-meetingbank/`
  - `model.onnx` (54 MB direct git blob; public model; below GitHub's 100 MB hard file limit)
  - `config.json`, `tokenizer.json`, `tokenizer_config.json`, `special_tokens_map.json`, `vocab.txt`
- Git LFS is **not** used for this model: GitHub refused new LFS object uploads from this
  public fork (`can not upload new objects to public fork`).
- `open-sse/services/compression/engines/llmlingua/modelStore.ts::findBundledModelRoot()`
  resolves the bundled dir at runtime: walks `process.cwd()` and `process.argv[1]`
  ancestors up to 6 levels. Works in both dev (`tsx/esm`) and the standalone
  `.build/next/standalone/server.js` bundle.
- `configureTransformersEnv()` priority order:
  1. Explicit `modelPath` admin override (no network)
  2. Bundled in-repo copy (no network; `allowRemoteModels = false`)
  3. `~/.omniroute/models/llmlingua/` cache + HF download allowed (fallback)

- `LLMLINGUA_MODELS.tinybert` label changed from "requires HF auth" to "public, no HF
  auth required" (the model has always been public; the label was wrong).
- `DEFAULT_LLMLINGUA_MODEL = "tinybert"` (was `"bert-base"`); warm inference ~6 ms.

#### Verification

Manual load test from bundled path: ~92 ms load (first call), warm inference ~5.8 ms,
292 → 171 chars (41 % reduction). No network access during the load.

#### Durable rules

- **Always use `tinybert` as the default model** unless higher accuracy is mission-
  critical — the quality gap (5.9 → 7.4 / 10 on Claude Code sessions per the
  `kompress-small` benchmark) is offset by the size (57 vs 710 MB) and warm
  inference speed (~6 vs ~117 ms). Switch to `bert-base` / `bert-base-ms` only when
  every percentage of accuracy matters.
- **Future bundled models must either stay under GitHub's 100 MB file limit as direct blobs**
  or use a separate release artifact / object store. Do not rely on Git LFS for this public
  fork unless LFS uploads are explicitly enabled. Keep the path pattern
  `models/<family>/<hfRepo>/model.onnx` so `findBundledModelRoot()` finds them automatically.

---

---

### OPS-002 — `tls-client-node` global-install permission fix

| Field   | Value                                                                             |
| ------- | --------------------------------------------------------------------------------- |
| Commit  | External runtime state / no repo commit                                           |
| Purpose | Allow ChatGPT Web / browser-impersonation providers to download native TLS binary |

Global install with `sudo npm install -g omniroute` leaves `/usr/lib/node_modules/omniroute` owned by `root:root`. OmniRoute service runs as `ubuntu`. `tls-client-node` lazily downloads its native binary into the install tree on first use, so root ownership caused:

```text
EACCES: permission denied, mkdir '/usr/lib/node_modules/omniroute/dist/node_modules/tls-client-node/bin'
```

Required fix after global install or rebuild:

```bash
sudo chown -R ubuntu:ubuntu /usr/lib/node_modules/omniroute
```

Migration script `setup-new-vps.sh` bakes this in and also triggers a `tls-client-node` load as `ubuntu` before service start.

---

### OPS-003 — Cloudflare AI bot detection disabled for `jebo.ai`

| Field   | Value                                                               |
| ------- | ------------------------------------------------------------------- |
| Commit  | External Cloudflare state / no repo commit                          |
| Purpose | Stop Cloudflare from blocking Anthropic SDK / Stainless user agents |

Cloudflare's AI bot detection blocked requests from pi because pi uses the official Anthropic SDK, which sends headers like:

```text
User-Agent: Anthropic/JS 0.91.1
X-Stainless-...
```

After disabling Cloudflare AI bot detection, these user agents returned HTTP 200:

- `Anthropic/JS 0.91.1`
- `Anthropic/Python 0.91.1`
- `Anthropic/Go 1.0.0`
- full pi-style request with Stainless headers

No OmniRoute source patch was needed for this.

---

### OPS-004 — Live SQLite and secrets are the real production state

| Field          | Value                                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------------- |
| Commit         | External server state / no repo commit                                                                           |
| Critical files | `/home/ubuntu/.omniroute/storage.sqlite`, `/usr/lib/node_modules/omniroute/.env`, `/home/ubuntu/.omniroute/.env` |

For migration, source code is not enough. These files carry production state:

| Path                                         | Why it matters                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------------- |
| `/home/ubuntu/.omniroute/storage.sqlite`     | provider connections, API keys, provider nodes, compression combos, settings |
| `/home/ubuntu/.omniroute/storage.sqlite-wal` | pending WAL writes if service is running                                     |
| `/home/ubuntu/.omniroute/.env`               | data-dir/encryption metadata                                                 |
| `/usr/lib/node_modules/omniroute/.env`       | JWT/API-key secrets and OAuth/client settings                                |
| `/etc/systemd/system/omniroute.service`      | port/base-url/runtime flags                                                  |
| iptables rules                               | port 80 external reachability                                                |

Use SQLite `.backup` while the service is stopped or quiesced; do not blindly rsync a live WAL database.

---

## Client/tool customizations not in upstream source

These are local client configs that point coding tools at `jebo.ai`. They are not in the OmniRoute repo and should not be confused with fork source commits.

### CLIENT-001 — pi uses a single additive `omniroute` provider

| Field              | Value                                                  |
| ------------------ | ------------------------------------------------------ |
| Commit             | External client config / no repo commit                |
| Config files       | `~/.pi/agent/models.json`, `~/.pi/agent/settings.json` |
| Base URL           | `https://jebo.ai/v1`                                   |
| API key env syntax | `$OMNIROUTE_API_KEY`                                   |

Important decisions:

- Use one additive provider named `omniroute`, not built-in provider overrides.
- Keep model IDs exactly as OmniRoute exposes them (`cc/...`, `cx/...`, `mm/...`, `gl/...`, `km/...`, etc.).
- Use `api: anthropic-messages` for the routed models, including Codex/ChatGPT-Web models, so pi does not try to validate `OMNIROUTE_API_KEY` as a real OpenAI OAuth JWT.

Current OmniRoute-routed pi models include:

| Model ID                       | Notes                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------- |
| `cc/claude-opus-4-8`           | Claude Messages API, thinking medium/high/xhigh                                   |
| `cc/claude-opus-4-7`           | Claude Messages API, thinking medium/high/xhigh                                   |
| `cc/claude-opus-4-6`           | Claude Messages API, thinking medium/high/xhigh                                   |
| `cc/claude-sonnet-4-6`         | Claude Messages API, 200K context, thinking medium/high/xhigh                     |
| `mistral/mistral-large-latest` | Added later; no thinking map                                                      |
| `mm/MiniMax-M3`                | Anthropic-compatible route                                                        |
| `gl/glm-5.2`                   | Z.AI custom prefix `gl`; pi `xhigh` maps to OmniRoute/GLM `max`                   |
| `km/kimi-for-coding`           | Kimi custom prefix `km`                                                           |
| `cx/gpt-5.5`                   | Codex route; uses `anthropic-messages` to avoid OpenAI OAuth JWT validation in pi |
| `cgpt-web/gpt-5.5`             | ChatGPT Web route; uses `anthropic-messages`                                      |

#### Pi-specific constraint discovered

Pi's `ThinkingLevel` enum supports:

```text
off, minimal, low, medium, high, xhigh
```

There is no separate `max` thinking level in pi. For GLM 5.2, we map pi's `xhigh` to OmniRoute's `max`.

#### Codex-specific constraint discovered

Pi's `openai-codex-responses` handler expects the API key to be a real OpenAI OAuth JWT with `chatgpt_account_id`. `OMNIROUTE_API_KEY` is a static OmniRoute key, so pi throws:

```text
Failed to extract accountId from token
```

Workaround in config: use `api: anthropic-messages` and let OmniRoute handle Codex OAuth internally.

---

### CLIENT-002 — OpenCode provider renamed and aligned with pi

| Field                  | Value                                   |
| ---------------------- | --------------------------------------- |
| Commit                 | External client config / no repo commit |
| Config file            | `~/.config/opencode/opencode.jsonc`     |
| Provider name          | `omniroute`                             |
| Previous provider name | `9router`                               |
| Base URL               | `https://jebo.ai/v1`                    |
| API key env syntax     | `{env:OMNIROUTE_API_KEY}`               |
| Package                | `@ai-sdk/openai-compatible`             |

OpenCode sends OpenAI-format requests to OmniRoute's `/v1/chat/completions`. It uses variants rather than pi's `thinkingLevelMap`.

Current OpenCode models align with pi's model set:

- `cc/claude-opus-4-8`
- `cc/claude-opus-4-7`
- `cc/claude-opus-4-6`
- `cc/claude-sonnet-4-6`
- `mistral/mistral-large-latest`
- `mm/MiniMax-M3`
- `gl/glm-5.2`
- `km/kimi-for-coding`
- `cx/gpt-5.5`
- `cgpt-web/gpt-5.5`

Variant rules:

- Claude models: medium/high/xhigh
- Codex + ChatGPT-Web GPT-5.5: low/medium/high/xhigh
- GLM 5.2: high + xhigh where xhigh sends `max`
- Mistral Large: no thinking variants

---

## Provider-prefix customizations in OmniRoute DB

These are not source code changes; they live in OmniRoute's SQLite database.

| Prefix | Meaning                                      | Notes                                               |
| ------ | -------------------------------------------- | --------------------------------------------------- |
| `mm/`  | MiniMax custom/provider route                | Clean alias for MiniMax models                      |
| `gl/`  | Z.AI / GLM custom Anthropic-compatible route | Replaces ugly `anthropic-compatible-<uuid>/...` IDs |
| `km/`  | Kimi custom Anthropic-compatible route       | Replaces ugly `anthropic-compatible-<uuid>/...` IDs |

Key discovery: custom Anthropic-compatible provider rows have editable `provider_nodes.prefix`. The dashboard's compatible-node editor can change the catalog prefix, which is why pi/OpenCode can use clean IDs like `gl/glm-5.2` and `km/kimi-for-coding` instead of UUID-prefixed model IDs.

Prefix changes must be preserved by database backup/restore, not by source rebuild.

---

## Migration tooling created locally

These scripts are local operator tooling, not upstream source commits.

| File                                  | Lines | Purpose                                       | Commit                                 |
| ------------------------------------- | ----: | --------------------------------------------- | -------------------------------------- |
| `/Users/patrickrho/nic1-migration.sh` |   189 | Backup nic1 live state to `~/migration/`      | External local script / no repo commit |
| `/Users/patrickrho/setup-new-vps.sh`  |   158 | Restore/build OmniRoute on a fresh Ubuntu VPS | External local script / no repo commit |

### `nic1-migration.sh`

Backs up:

- SQLite DB via `.backup` (not raw live-WAL rsync)
- OmniRoute `.env` files
- `omniroute.service`
- iptables rules
- fstab/swap metadata
- network notes and restore map

Default SSH target:

```text
ubuntu@161.33.162.164
```

Default SSH key:

```text
~/.ssh/t1_fetcher_ed25519
```

### `setup-new-vps.sh`

Restores/builds on a fresh Ubuntu VPS:

1. Installs Node 22
2. Clones `patrickrho-patty/OmniRoute`
3. Checks out `custom-features`
4. Runs `npm install` and `npm run build`
5. Installs globally
6. Restores `.env` files and SQLite DB
7. Applies `setcap` for port 80
8. Installs systemd unit
9. Inserts TCP 80 ACCEPT above REJECT in iptables
10. Starts service and runs local sanity checks

---

## Headroom decision record

No Headroom source change has been committed yet.

What we found:

- OmniRoute's built-in `headroom` engine is only a **SmartCrusher/tabular JSON compaction subset**, not the full upstream Headroom project.
- The dashboard page for `/dashboard/context/headroom` does not persist `minRows` because `headroom` has no settings sub-object in `EngineConfigPage.tsx`; it resets to default `8`.
- Full upstream Headroom adds features OmniRoute does not currently have: lossy SmartCrusher sampler, CodeCompressor, Kompress-base, CacheAligner, IntelligentContext, image compression, wrappers/proxy/MCP tooling.
- Kompress-base is useful but optional; without it, a Headroom sidecar likely fits in 2 GB RAM alongside OmniRoute. With Kompress-base loaded, 4 GB RAM is the safer target.

Current decision:

- Do not add Headroom sidecar yet.
- If we want most of the gain without new infrastructure, the best source patch would be adding a lossy SmartCrusher sampler to OmniRoute's existing `headroom` engine. No commit exists for this yet.

---

## VPS sizing decision record

No source commit.

| Scenario                                                     |        RAM guidance |
| ------------------------------------------------------------ | ------------------: |
| OmniRoute only, strict minimum                               | 1 GB (works, swaps) |
| OmniRoute only, recommended                                  |                2 GB |
| OmniRoute + bundled TinyBERT LLMLingua (57 MB ONNX, default) |              2.5 GB |
| OmniRoute + LLMLingua BERT-base (710 MB ONNX, optional)      |                4 GB |
| OmniRoute + LLMLingua + future-proofing                      |                8 GB |

The TinyBERT switch (see `SRC-013`) halved the model footprint and reduced warm
inference from ~117 ms to ~6 ms. The 4 GB row is now only relevant if an admin
explicitly switches `DEFAULT_LLMLINGUA_MODEL` to `bert-base` / `bert-base-ms`.

Current VPS: **Contabo 24 GB / 8 vCPU / 774 GB** — no memory constraints.

Previous VPS (Oracle 1 GB) hit OOM crashes with v3.8.38 bundle + LLMLingua. The
BERT-base ONNX model alone needs ~1.5 GB runtime memory for inference; with the
switch to TinyBERT this is now ~0.7 GB (fits in the old 1 GB VPS at the boundary,
but Contabo is still recommended).

---

## Rebase procedure for future upstream releases

When upstream releases a new version:

```bash
git fetch upstream

git switch main
git merge upstream/main --ff-only

git switch custom-features
git rebase main
```

After rebase, verify:

```bash
git diff --name-only main..custom-features
# should include only intentional fork files

# Claude Messages branch still exists
grep -n 'body.type === "message"' open-sse/utils/diagnostics.ts

# hardcoded port literals are not back in source
ast-grep --pattern '"20128"' src open-sse || true
ast-grep --pattern '"20129"' src open-sse || true
```

Then build and smoke test:

```bash
npm run build

curl -sS https://jebo.ai/v1/models \
  -H "Authorization: Bearer $OMNIROUTE_API_KEY" \
  -o /tmp/models.json -w '%{http_code}\n'

curl -sS https://jebo.ai/v1/messages \
  -H "Authorization: Bearer $OMNIROUTE_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"cc/claude-sonnet-4-6","max_tokens":16,"messages":[{"role":"user","content":"2+2?"}]}' \
  -o /tmp/messages.json -w '%{http_code}\n'
```

---

## Untracked local repo files

These were present when this document was reviewed:

| Path                                               | What it is                 | Commit?                           |
| -------------------------------------------------- | -------------------------- | --------------------------------- |
| `.pi/`                                             | pi runtime/context helpers | No — stays local, never committed |
| `docs/setup/README.md`                             | Operator setup/runbook doc | Yes, recommended after review     |
| `docs/setup/ARCHITECTURE.md`                       | Operator architecture doc  | Yes, recommended after review     |
| `docs/setup/STRUCTURE.md`                          | Operator structure doc     | Yes, recommended after review     |
| `omniroute-backup-2026-06-26T17-48-48-221Z.sqlite` | Stale DB backup            | No; do not commit DB backups      |

`FORK_NOTES.md` itself is committed (in `515465908` / `88de13291`).

---

## Open items

- [x] Commit `FORK_NOTES.md` after review. — Done 2026-06-28.
- [x] Rebase onto upstream v3.8.38. — Done 2026-06-28 (all conflicts resolved).
- [x] Migrate to new VPS (Contabo). — Done 2026-06-29.
- [x] Get LLMLingua working in production. — Done 2026-06-29. Fixed Worker path for Node 22, timeout, and model access.
- [x] Wire session-dedup config persistence (Save button). — Done (`43d670f77`).
- [x] Stage 1 + cache safety + cache-hit visibility deployed to jebo.ai. — Done 2026-06-30.
- [x] Bundle TinyBERT ONNX model in repo as a direct git blob. — Done 2026-06-30 (`3b5810bd4`; corrected after GitHub rejected LFS uploads from the public fork).
- [x] Update `docs/ops/DEPLOY_FORK_VPS.md` to match the current VPS-side build flow. — Done 2026-06-30.
- [ ] Re-authenticate OAuth providers (Claude, Codex, ChatGPT-web) on the new VPS.
- [ ] Review and possibly commit `docs/setup/*.md` as operator docs.
- [ ] Decide whether to PR SRC-001/002/005 upstream. All are self-contained.
- [ ] Decommission the old Oracle VPS (`161.33.162.164`) once new VPS is stable.
- [ ] If Headroom work resumes, decide between source patch (lossy SmartCrusher) or sidecar.
- [ ] Enable Stage 2 (`incrementalCache`) on one principal and observe cache_hit% before enabling globally.
- [ ] Decide on Kompress / external prompt-compression engines from the 2026-06-30 research — none added today; revisit if tinybert quality proves insufficient for pasted-prose workloads.
