/**
 * Semantic message hashing for the incremental compression cache.
 *
 * The cache key for a message must be **stable across turns** even though the harness
 * mutates non-semantic fields between turns. The most important offender is prompt-cache
 * bookkeeping: Anthropic / OpenAI clients move `cache_control` (and `ephemeral`) markers
 * around as the conversation grows, so the *same* message arrives with a different
 * `cache_control` placement on a later turn. Hashing the raw JSON would treat that as a
 * new message → a cache miss on every turn → the cache would never warm.
 *
 * `semanticMessageHash` therefore hashes only the content that actually affects
 * compression output:
 *   - the message `role`,
 *   - all text / structural content (string content, `text` parts, `tool_use` /
 *     `tool_result` payloads, `tool_calls`, `tool_call_id`),
 *   - with volatile bookkeeping keys (`cache_control`, `ephemeral`) stripped recursively.
 *
 * The `cumulativeHash` folds each message hash into a rolling prefix hash so that a
 * message's cache key captures everything its compressed form depends on: itself **and**
 * the immutable prefix before it (cross-message dedup / tool-call context). Because the
 * prefix is append-only, `H[i]` is identical every turn ⇒ cache hits for all prior
 * messages, work only for the new tail.
 */

import crypto from "node:crypto";

/** Keys stripped before hashing — non-semantic, mutated between turns by the harness. */
const VOLATILE_KEYS = new Set(["cache_control", "ephemeral"]);

/**
 * Deep clone `value` with all volatile keys removed and object keys sorted, producing a
 * canonical, deterministic structure for hashing. Arrays preserve order (semantically
 * significant); object key order does not, so it is normalised. Exported so the pipeline
 * signature hashes config with the same key-order normalisation (avoids spurious cache resets
 * when two semantically-identical configs differ only in key insertion order).
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (VOLATILE_KEYS.has(key)) continue;
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Stable SHA-256 (hex) of a message's semantic content (role + content, volatile-free). */
export function semanticMessageHash(message: unknown): string {
  const canonical = canonicalize(message);
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Fold a message hash into the running cumulative prefix hash. `prev` is the cumulative
 * hash of messages[0..i-1]; the result is the cumulative hash of messages[0..i].
 */
export function foldCumulative(prev: string, messageHash: string): string {
  return crypto
    .createHash("sha256")
    .update(prev)
    .update("\u0000")
    .update(messageHash)
    .digest("hex");
}

/** Seed for an empty prefix (before any message is folded). */
export const CUMULATIVE_SEED = "incr-compression-v1";

/**
 * Compute the cumulative hash for every message position in order.
 * `out[i]` = cumulative hash of messages[0..i] — the cache key for message i.
 */
export function cumulativeHashes(messages: unknown[]): string[] {
  const out: string[] = [];
  let acc = CUMULATIVE_SEED;
  for (const msg of messages) {
    acc = foldCumulative(acc, semanticMessageHash(msg));
    out.push(acc);
  }
  return out;
}
