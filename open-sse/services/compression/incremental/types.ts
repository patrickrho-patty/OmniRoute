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
  /** Cumulative hashes already folded into `dedupIndex` (so prefix is never rescanned). */
  processedDedupHashes: Set<string>;
  /** Authenticated principal id for tenant-scoped persistence. */
  principalId: string;
  /** Pipeline signature this context was built under; mismatch ⇒ caller resets the context. */
  pipelineSig: string;
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
