/**
 * Types for the incremental ("process-once") compression layer.
 *
 * Model B (robust): the full engine pipeline still runs over the whole body each turn, so
 * every engine always sees real cross-message context (tool-call lookups, dedup prefixes).
 * The expensive PER-MESSAGE work is memoised by `(engineId, cumulativeHash)` — because the
 * cumulative hash determines a message's entire input (itself + immutable prefix), the
 * memo can never change output, only skip recomputation. This makes the memo a pure
 * optimisation that a property test validates as byte-identical to the non-incremental path.
 *
 * `IncrementalContext` is threaded to engines via `CompressionEngineApplyOptions.incremental`.
 * Engines that don't understand it ignore it and run normally (correct, just not faster).
 */

import type { DedupIndex } from "../engines/session-dedup/suffixDedup.ts";

export interface IncrementalContext {
  /** Stable per-message cache keys: cumulativeByIndex[i] = cumulative hash of messages[0..i]. */
  cumulativeByIndex: string[];
  /**
   * Per-engine per-message memo, keyed `${engineId}\u0000${cumulativeHash}`. Value is the
   * engine's compressed output for that message (string or multipart content). Shared
   * across turns via the session context; populated lazily on first compute.
   */
  memo: Map<string, unknown>;
  /** Persistent cross-message dedup index (session-dedup), carried across turns. */
  dedupIndex: DedupIndex;
  /**
   * Cumulative hashes seen on prior turns — telemetry only. The orchestrator uses it to report
   * cacheHits/computed (how much of this turn was prefix vs new). Engines decide cached-vs-new
   * via their own `memo`, not this set; it does not gate any compression work.
   */
  processedDedupHashes: Set<string>;
  /** Authenticated principal id for tenant-scoped persistence. */
  principalId: string;
  /** Pipeline signature this context was built under; mismatch ⇒ caller resets the context. */
  pipelineSig: string;
  /**
   * The previous turn's `cumulativeByIndex`. The incremental invariant holds only for
   * APPEND-ONLY conversations; if the prior array is no longer a prefix of this turn's
   * (a message was edited / deleted / reordered), the carried memo + dedup index are stale and
   * the orchestrator resets the context for a correct full recompute. Undefined on first turn.
   */
  lastCumulative?: string[];
}

/** Build a memo key for an engine + message. */
export function memoKey(engineId: string, cumulativeHash: string): string {
  return `${engineId}\u0000${cumulativeHash}`;
}

/** Telemetry returned alongside an incremental run. */
export interface IncrementalStats {
  totalMessages: number;
  cacheHits: number;
  computed: number;
  /** True when the pipeline could be incrementalised; false ⇒ full-body fallback ran. */
  incremental: boolean;
}
