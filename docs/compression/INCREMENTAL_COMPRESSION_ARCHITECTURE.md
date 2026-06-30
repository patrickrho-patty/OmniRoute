---
title: Incremental Compression Architecture
---

# Incremental Compression Architecture

> Status: **Stage 1 + Stage 2 (in-memory) shipped; persistence + worker deferred.**
> Owner: compression hot-path.
> Goal: make OmniRoute lean **heavily** on compression while sustaining low latency,
> by never re-compressing immutable conversation history more than once.

## What is shipped vs deferred

| Piece                                                                                                          | State                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stage 1 — `session-dedup` O(n) rewrite (18 s → ~0.4 s)                                                         | **shipped & live**                                                                                                                                                                                                                                   |
| Stage 2 — in-memory incremental compressor (`incrementalCompressor.ts`), per-session context, per-message memo | **shipped** (default-off flag `config.incrementalCache`)                                                                                                                                                                                             |
| Incremental engines — `session-dedup` (persistent index, tail-only) + `rtk` (memoised per-message filtering)   | **shipped**, equivalence-tested                                                                                                                                                                                                                      |
| Equivalence property test (incremental ≡ full body, engagement-asserted)                                       | **shipped**                                                                                                                                                                                                                                          |
| **SQLite cross-restart persistence**                                                                           | **deferred → Stage 2.5** — needs dedup-index serialization (loading cached prefix output without rebuilding the index would make the tail dedup against an empty index and diverge). Scaffolding parked in `.claude/deferred/incremental-stage2.5/`. |
| **Worker pool** (Stage 3)                                                                                      | **deferred** — event-loop pressure is largely relieved by Stage 1 (0.4 s, not 18 s).                                                                                                                                                                 |

Enablement: the incremental path is **off by default**. Turn it on via
`compressionConfig.incrementalCache = true`, validate production timing, then default it on.

## Problem (measured, not theorized)

LLM harnesses (Claude Code, Codex, etc.) resend the **entire prior conversation**
plus a few new messages every turn. OmniRoute currently re-compresses the **whole
body from scratch** on every turn.

Evidence from production logs (jebo.ai, opus-4-8, ~200K-token sessions):

| Pipeline                                         | Wall time | Saved |
| ------------------------------------------------ | --------- | ----- |
| `session-dedup, rtk-filter, rtk-dedup, ponytail` | **18 s**  | 6 %   |
| `rtk-truncate, rtk-filter, ponytail`             | 0.4 s     | 19 %  |
| `rtk-filter, rtk-truncate, rtk-dedup`            | 0.6 s     | 21 %  |

Two independent defects:

1. **`session-dedup` is O(n²)** — `findSuffixBlocks()` materialises every suffix
   block of every message (`lines.slice(start).join("\n")` for each `start`), then
   SHA-256-hashes each. For a single 30k-line tool dump that is ~450M lines of string
   work, run **twice** (pass 1 + pass 2). This is the entire 18 s.
2. **No incremental reuse** — even the fast engines re-process ~199,400 immutable
   tokens every turn to handle ~600 new ones. Work is O(total) when it should be
   O(new).

Compression also runs **on the main thread**, so a slow pass freezes the event loop
and the dashboard health probe times out → the "server unresponsive" toast.

## Invariant that makes this tractable

**Conversations are append-only.** `messages[0..k]` never change once sent; each turn
only appends. Every compression engine in OmniRoute that is cross-message
(`session-dedup`, `ccr`) only ever replaces a **later** occurrence with a reference to
an **earlier** one (first occurrence kept verbatim). Therefore:

> The compressed form of `messages[i]` depends only on `messages[0..i]`, all of which
> are immutable. So `messages[i]`'s compressed output is **identical every turn** and
> can be cached.

This yields a provably **byte-identical** incremental result vs. a full re-run, while
doing O(new) work per turn.

## Engine classification

| Class                         | Engines                                                                             | Output of `msg[i]` depends on                                         |
| ----------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Per-message-deterministic** | `rtk`, `caveman`, `lite`, `aggressive`, `ultra`, `llmlingua`, `ponytail`, `ionizer` | only `msg[i]` (+ tool-call context from an immutable earlier message) |
| **Cross-message**             | `session-dedup`, `ccr`                                                              | `msg[0..i]` (references earlier blocks)                               |

Each engine declares `perMessageDeterministic: boolean` in its metadata.

## Components

```
open-sse/services/compression/incremental/
  types.ts                — CompressionSession, CachedMessage, IncrementalResult
  messageHash.ts          — semantic content hash (strips volatile cache_control/ephemeral)
  pipelineSignature.ts    — stable hash of ordered engine list + configs
  sessionContext.ts       — per-session state: msg cache, dedup index, tool lookup
  contextStore.ts         — LRU(memory) + SQLite write-behind; TTL 15 min; size-bounded
  incrementalCompressor.ts— orchestrator: split prefix/tail, reuse cache, compress tail

open-sse/services/compression/worker/
  compressionWorker.ts    — long-lived worker; owns session contexts; runs the pipeline
  workerPool.ts           — N workers; session-affinity (consistent hash) for context reuse
  workerClient.ts         — main-thread facade; promise map; fail-open to inline

src/lib/db/compressionSessionCache.ts — SQLite persistence (survives restart/deploy)
db/migrations/109_compression_session_cache.sql
```

## Cache key correctness

`messageHash(msg)` hashes **semantic content only**:

- role + text parts + structural `tool_use` / `tool_result` content,
- **strips** volatile fields that the harness moves between turns:
  `cache_control`, `ephemeral` markers, per-request ids.

A message's cache entry is keyed by its **cumulative** prefix hash
`H[i] = sha256(H[i-1] ‖ messageHash(msg[i]))` plus the **pipeline signature**
(`sha256(ordered engine ids ‖ their resolved configs)`) plus the **principal id**
(tenant isolation, mirroring the existing CCR store scoping).

Changing any compression setting changes the pipeline signature → the cache is
invalidated automatically. No stale-config hazard.

## Per-turn flow (`incrementalCompress`)

1. Resolve pipeline signature; if it differs from the session's, reset the session.
2. Compute `H[0..n]` (cheap — hashing only).
3. Split: largest `k` with `H[0..k]` all present in the session message cache = the
   cached prefix; `messages[k+1..n]` = new tail (append-only ⇒ this is just the new
   messages).
4. Prefix → pull compressed forms from cache (O(1) each). Their dedup-index
   contributions are already in `session.dedupIndex`.
5. Tail → run the pipeline on the new messages **with** access to `session.dedupIndex`
   (dedup against the immutable prefix) and the cumulative tool-call lookup. Update the
   index; cache each new message's compressed output by `H[i]`.
6. Reassemble `compressedPrefix ‖ compressedTail`. Persist session (memory now, SQLite
   write-behind).

## session-dedup O(n) rewrite

Replace `findSuffixBlocks` (O(n²)) with **backward rolling suffix hashes**:

```
suffixHash[end] = SEED
for start = n-1 downto 0:
  suffixHash[start] = mix(suffixHash[start+1], hash(line[start]))   // O(1) per line
```

- O(n) suffix hashes per message, O(n) total.
- `firstSeen: Map<suffixHash, {msgIdx, startLine}>` records the first owner (no text
  stored → O(n) memory).
- Pass 2: for each message pick the **longest** suffix whose hash was first seen
  earlier; verify the candidate once against the owner's reconstructed suffix (collision
  guard); replace if the marker shrinks. Preserves the exact external contract
  (`[dedup:ref sha=…]` markers, first-occurrence kept, reversibility).
- The `firstSeen` map lives in the **session context**, so across turns only the new
  messages are scanned ⇒ O(new) per turn.

## Worker pool (multi-core, sustained speed)

- A long-lived **worker pool** (size = `min(cores-1, configured)`) owns session
  contexts in worker memory.
- **Session affinity**: a session is always routed to the same worker (consistent hash
  on session id) so its hot context is reused without re-sending history.
- Main thread sends only the **new messages** + session id + pipeline signature — never
  the full 200K-token body. The worker holds the prefix.
- Cold worker miss → worker loads the session context from SQLite.
- Fail-open: if the worker errors or times out, the client falls back to inline
  compression so a worker bug can never drop a request.

## Persistence (no Redis — single VPS)

- Hot path: in-memory LRU in each worker.
- Durability: SQLite write-behind (`compression_session_cache`) so a deploy/restart does
  not cold-start every session. Sub-ms reads, **zero new infrastructure**.
- The store is behind a `CompressionSessionStore` interface; a Redis implementation is a
  drop-in for a future multi-instance deployment, but is **not** required and not built
  now.

## Correctness proof sketch

Because every cross-message engine only references **earlier** messages and the prefix
is immutable, the compressed output of any prefix message is invariant across turns;
the new tail is compressed against the identical prefix index a full run would see.
Therefore `incrementalCompress(body)` is **byte-identical** to
`applyCompressionAsync(body)` for every turn. This equivalence is asserted by a
property test that runs random multi-turn conversations through both paths and diffs the
final bodies.

## Staging (each stage independently tested + shipped)

1. **Stage 1** — `session-dedup` O(n) rewrite + session-context skeleton + equivalence
   and perf tests. _Measured 36× win; self-contained._
2. **Stage 2** — incremental compressor + per-message cache + SQLite persistence +
   multi-turn equivalence property test.
3. **Stage 3** — worker pool + session affinity + fail-open client; wire into
   `chatCore` behind a settings flag; load-test.

Each stage: focused tests + `npm run typecheck:core`, then deploy and observe the
production log timing deltas before starting the next.
