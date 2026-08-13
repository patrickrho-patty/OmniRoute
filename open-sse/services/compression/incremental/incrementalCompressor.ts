/**
 * Incremental ("process-once") compression orchestrator.
 *
 * LLM harnesses resend the entire prior conversation plus a few new messages every turn, so
 * re-compressing the whole body each turn is O(total) when it should be O(new). This driver
 * threads a per-session {@link IncrementalContext} into the existing stacked pipeline. Engines
 * that understand the context (session-dedup, rtk, the per-message-deterministic prose engines)
 * use it to do O(new-messages) work by reusing cross-turn state (a persistent dedup index, a
 * cumulative tool-call lookup, a per-message output memo). Engines that ignore it run normally.
 *
 * Correctness: the orchestrator itself changes nothing — it only *passes* the context. An
 * engine's incremental path MUST produce output byte-identical to its full run; that invariant
 * is enforced by the equivalence property test (incremental vs full body over random multi-turn
 * conversations). So with no incremental-aware engine the result is trivially identical, and each
 * engine that opts in is independently proven equivalent.
 */

import crypto from "node:crypto";
import type { CompressionMode, CompressionConfig, CompressionResult } from "../types.ts";
import { cumulativeHashes } from "./messageHash.ts";
import { pipelineSignature } from "./pipelineSignature.ts";
import { getOrCreateContext, resetContextState } from "./sessionStore.ts";
import type { IncrementalContext, IncrementalStats } from "./types.ts";

/** True when `prev` is a prefix of `next` — i.e. the conversation only grew (append-only). */
function isAppendOnlyExtension(prev: string[], next: string[]): boolean {
  if (prev.length > next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    if (prev[i] !== next[i]) return false;
  }
  return true;
}

/** A stacked-pipeline runner (the existing whole-body path), injected to avoid an import cycle. */
export type StackedRunner<O> = (
  body: Record<string, unknown>,
  options: O
) => Promise<CompressionResult>;

const MIN_MESSAGES_FOR_INCREMENTAL = 2;

/**
 * Derive a stable per-conversation session key from the first non-system message's semantic
 * content. Append-only conversations keep the same first message across turns, so this key is
 * stable for the life of the conversation and distinct between conversations.
 */
function deriveSessionKey(messages: unknown[]): string {
  for (const msg of messages) {
    const role = (msg as { role?: unknown })?.role;
    if (role === "system") continue;
    const content = (msg as { content?: unknown })?.content;
    const text =
      typeof content === "string" ? content : content != null ? JSON.stringify(content) : "";
    return crypto
      .createHash("sha256")
      .update(`${String(role)}\u0000${text}`)
      .digest("hex")
      .slice(0, 32);
  }
  return "__empty__";
}

/** Extract the messages array from a body, or null when it isn't a usable conversation. */
function getMessages(body: Record<string, unknown>): unknown[] | null {
  const messages = (body as { messages?: unknown }).messages;
  return Array.isArray(messages) ? messages : null;
}

export interface IncrementalRunOptions {
  principalId?: string;
  config?: CompressionConfig;
}

export interface IncrementalRunResult {
  result: CompressionResult;
  stats: IncrementalStats;
}

/**
 * Run the stacked pipeline incrementally for one turn. `runStacked` is the existing whole-body
 * async stacked runner; `injectContext` returns the options object to hand it, with the resolved
 * {@link IncrementalContext} attached (the caller owns the concrete options shape, so this stays
 * decoupled from `StackOptions`).
 */
export async function incrementalCompress<O>(params: {
  body: Record<string, unknown>;
  mode: CompressionMode;
  runOptions: IncrementalRunOptions;
  runStacked: StackedRunner<O>;
  injectContext: (context: IncrementalContext | undefined) => O;
}): Promise<IncrementalRunResult> {
  const { body, mode, runOptions, runStacked, injectContext } = params;
  const messages = getMessages(body);

  // Not a usable conversation → run the pipeline normally with no context (still correct).
  if (!messages || messages.length < MIN_MESSAGES_FOR_INCREMENTAL) {
    const result = await runStacked(body, injectContext(undefined));
    return {
      result,
      stats: {
        totalMessages: messages?.length ?? 0,
        cacheHits: 0,
        computed: messages?.length ?? 0,
        incremental: false,
      },
    };
  }

  const principalId = runOptions.principalId ?? "__anon__";
  const sig = pipelineSignature(mode, runOptions.config);
  const sessionKey = deriveSessionKey(messages);
  const context = getOrCreateContext(principalId, sessionKey, sig);

  // Hand engines the per-message cache keys for THIS turn.
  const cumulative = cumulativeHashes(messages);

  // Append-only guard: the incremental invariant (a prefix message's compressed form is stable)
  // holds ONLY while the conversation grows by appending. If the prior turn's cumulative hashes
  // are no longer a prefix of this turn's (a message was edited / deleted / reordered), the
  // carried memo + dedup index are stale and would silently diverge from a full run — so reset
  // the context and recompute everything this turn (correct, just not incremental this once).
  if (context.lastCumulative && !isAppendOnlyExtension(context.lastCumulative, cumulative)) {
    resetContextState(context);
  }
  context.cumulativeByIndex = cumulative;
  context.lastCumulative = cumulative;

  // Messages already folded into the session state on a prior turn are cache hits; the rest are
  // the new tail that engines actually compute this turn.
  let cacheHits = 0;
  for (const h of cumulative) {
    if (context.processedDedupHashes.has(h)) cacheHits++;
  }

  const result = await runStacked(body, injectContext(context));

  // Record this turn's messages as processed so next turn treats them as the cached prefix.
  for (const h of cumulative) context.processedDedupHashes.add(h);

  return {
    result,
    stats: {
      totalMessages: messages.length,
      cacheHits,
      computed: messages.length - cacheHits,
      incremental: true,
    },
  };
}
