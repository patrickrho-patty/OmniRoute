/**
 * In-memory LRU store of per-session incremental compression contexts.
 *
 * A context holds the cross-turn state that makes "process once" possible: the per-engine
 * per-message memo and the persistent session-dedup index. Keyed by
 * `(principalId, sessionKey, pipelineSig)` so a config change or a different conversation
 * starts a fresh context. TTL-aligned with sessionManager (15 min) and size-bounded.
 *
 * This is the hot tier. Durability across process restarts is provided separately by the
 * SQLite message cache (contextStore.ts) — the in-memory context is always safe to drop
 * and rebuild from the resent conversation.
 */

import { createDedupIndex } from "../engines/session-dedup/suffixDedup.ts";
import { SESSION_TTL_MS } from "../../sessionManager.ts";
import type { IncrementalContext } from "./types.ts";

// Single source of truth — aligned with sessionManager's session TTL (imported, not copied, so
// the two can never silently drift).
const TTL_MS = SESSION_TTL_MS;
const MAX_CONTEXTS = 500;

interface Entry {
  context: IncrementalContext;
  lastUsedAt: number;
}

const contexts = new Map<string, Entry>();

function compositeKey(principalId: string, sessionKey: string, pipelineSig: string): string {
  return `${principalId}\u0000${sessionKey}\u0000${pipelineSig}`;
}

function evict(): void {
  const now = Date.now();
  for (const [k, e] of contexts) {
    if (now - e.lastUsedAt > TTL_MS) contexts.delete(k);
  }
  while (contexts.size > MAX_CONTEXTS) {
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [k, e] of contexts) {
      if (e.lastUsedAt < oldest) {
        oldest = e.lastUsedAt;
        oldestKey = k;
      }
    }
    if (oldestKey === null) break;
    contexts.delete(oldestKey);
  }
}

/**
 * Get the existing context for this session+pipeline, or create a fresh one. A context
 * whose pipeline signature no longer matches is replaced (config changed ⇒ stale memo).
 */
export function getOrCreateContext(
  principalId: string,
  sessionKey: string,
  pipelineSig: string
): IncrementalContext {
  const key = compositeKey(principalId, sessionKey, pipelineSig);
  const existing = contexts.get(key);
  if (existing && existing.context.pipelineSig === pipelineSig) {
    existing.lastUsedAt = Date.now();
    return existing.context;
  }
  const context: IncrementalContext = {
    cumulativeByIndex: [],
    memo: new Map(),
    dedupIndex: createDedupIndex(),
    processedDedupHashes: new Set(),
    principalId,
    pipelineSig,
  };
  evict();
  contexts.set(key, { context, lastUsedAt: Date.now() });
  return context;
}

/**
 * Reset a context's carried state IN PLACE (memo, dedup index, processed set, last-cumulative)
 * without changing its identity. Used when the conversation stops being append-only — the
 * carried state is stale, so the next run recomputes everything from scratch (correct).
 */
export function resetContextState(context: IncrementalContext): void {
  context.memo.clear();
  context.dedupIndex = createDedupIndex();
  context.processedDedupHashes.clear();
  context.lastCumulative = undefined;
}

/** Test/maintenance helper: drop all in-memory contexts. */
export function clearAllContexts(): void {
  contexts.clear();
}

/** Current number of live contexts (metrics/tests). */
export function contextCount(): number {
  return contexts.size;
}
