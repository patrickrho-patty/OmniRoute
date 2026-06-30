/**
 * O(n) cross-message suffix-block deduplication core.
 *
 * Replaces the previous O(n²) `findSuffixBlocks` approach (which materialised and
 * SHA-256-hashed every `lines.slice(start).join("\n")` suffix of every message —
 * ~quadratic in lines, run twice) with a single-pass **backward rolling suffix
 * hash**:
 *
 *   suffixHash[end] = SEED
 *   for start = n-1 downto 0:
 *     suffixHash[start] = mix(lineHash(line[start]), suffixHash[start+1])   // O(1)
 *
 * Each message contributes O(lines) suffix hashes computed in O(lines) total, so the
 * whole pass is O(total lines). Block text is never materialised except for the single
 * block that is actually replaced (and the single owner block reconstructed for the
 * collision-guard comparison).
 *
 * Semantics preserved vs. the old engine (byte-identical output on the same input):
 *   - Only non-system messages participate (caller filters).
 *   - A block must span ≥ MIN_BLOCK_LINES lines AND ≥ minBlockChars characters.
 *   - First occurrence is ALWAYS kept verbatim; only a LATER message's LONGEST suffix
 *     that matches an EARLIER message's suffix is replaced.
 *   - At most one replacement per message (the longest matching suffix).
 *   - Replacement only happens when the `[dedup:ref sha=<24hex>]` marker is shorter
 *     than the block.
 *   - Collision guard: a hash match is verified by reconstructing and comparing the
 *     owner's actual suffix text before substituting.
 *
 * The `DedupIndex` (first-seen map + owner line arrays) is exposed so a session-scoped
 * caller can PERSIST it across turns and only feed NEW messages each turn — turning the
 * per-turn cost from O(total) into O(new). Within a single request the engine builds a
 * fresh index; the incremental layer (Stage 2) supplies a persistent one.
 */

import crypto from "node:crypto";
import { fnv1a } from "../ionizer/sample.ts";

/** Minimum number of lines a suffix block must span to be a dedup candidate. */
export const MIN_BLOCK_LINES = 3;

/**
 * Hard cap on distinct suffix hashes retained in the first-seen index (FIFO eviction,
 * mirroring the CCR store's bounded-map pattern). Prevents unbounded memory on
 * pathological inputs while preserving dedup for all realistic conversations.
 */
export const MAX_DEDUP_INDEX_ENTRIES = 200_000;

/**
 * Cap on owner message line-arrays retained for collision verification. Bounds the
 * verification store independently of `firstSeen`: when an owner's lines are evicted while
 * one of its suffix hashes is still indexed, the collision guard simply treats it as a
 * non-match (safe — a missed dedup, never corruption). Kept generous so realistic sessions
 * never evict.
 */
export const MAX_OWNER_LINE_ENTRIES = 50_000;

/**
 * Order-sensitive mix for the backward rolling suffix hash. Because `acc` carries the
 * already-folded tail, equal trailing line-sequences fold to equal hashes regardless of
 * what precedes them — exactly the suffix-equality proxy we need. Collisions are
 * verified away by the caller.
 */
function mix(lineHashVal: number, acc: number): number {
  return Math.imul(acc ^ lineHashVal, 0x01000193) >>> 0;
}

/** 24-hex SHA-256 prefix — the value embedded in the `[dedup:ref sha=…]` marker. */
function hashBlock(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 24);
}

/** A suffix block candidate within one message: lines[startLine..end]. */
interface SuffixRef {
  ownerMsgIdx: number;
  startLine: number;
}

/**
 * Persistent, bounded first-seen index. Maps a rolling suffix hash → the first message
 * (and start line) that produced it, plus the owner message's line array so a match can
 * be verified without re-storing block text per hash.
 *
 * Designed to be carried across turns by the incremental layer: feed prior messages once,
 * then only new messages each subsequent turn.
 */
export interface DedupIndex {
  firstSeen: Map<number, SuffixRef>;
  /** ownerMsgIdx → that message's split lines (needed for collision-guard verification). */
  ownerLines: Map<number, string[]>;
}

export function createDedupIndex(): DedupIndex {
  return { firstSeen: new Map(), ownerLines: new Map() };
}

/**
 * Generic bounded `Map.set` with FIFO eviction (Map preserves insertion order). Used for
 * both the suffix-hash index and the owner-lines verification store; eviction of either is
 * safe — worst case a missed dedup, never corruption.
 */
function boundedMapSet<K, V>(map: Map<K, V>, key: K, value: V, maxSize: number): void {
  if (!map.has(key) && map.size >= maxSize) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

/** Compute backward rolling suffix hashes. `out[s]` = hash of lines[s..end]. */
function suffixHashes(lines: string[]): number[] {
  const n = lines.length;
  const out = new Array<number>(n + 1);
  out[n] = 0x811c9dc5; // SEED (empty suffix)
  for (let s = n - 1; s >= 0; s--) {
    out[s] = mix(fnv1a(lines[s]), out[s + 1]);
  }
  return out;
}

/**
 * Compute the joined char length of each suffix. `out[s]` = `lines.slice(s).join("\n")`
 * length, accumulated backward in O(n) (no string materialisation).
 */
function suffixCharLengths(lines: string[]): number[] {
  const n = lines.length;
  const out = new Array<number>(n + 1);
  out[n] = 0;
  for (let s = n - 1; s >= 0; s--) {
    const sep = s + 1 < n ? 1 : 0; // newline between line[s] and a non-empty tail
    out[s] = lines[s].length + sep + out[s + 1];
  }
  return out;
}

/** Reconstruct an owner's suffix text for the collision-guard comparison. */
function ownerSuffixText(index: DedupIndex, ref: SuffixRef): string | null {
  const lines = index.ownerLines.get(ref.ownerMsgIdx);
  if (!lines) return null;
  return lines.slice(ref.startLine).join("\n");
}

export interface DedupOutcome {
  /** msgIdx → replaced text (only entries that changed). */
  deduped: Map<number, string>;
  dedupCount: number;
}

/**
 * Single-pass O(n) dedup over an ordered list of (msgIdx, text). Processes messages in
 * order: for each message, finds the longest suffix block whose hash was first seen in an
 * earlier message (verified), replaces it with a marker if shorter, then registers the
 * message's own suffix hashes (first occurrence wins).
 *
 * @param index  Optional persistent index. When supplied, prior turns' messages are
 *               already registered and only the new `msgTexts` are processed/added.
 */
export function dedupMessageTexts(
  msgTexts: Array<{ msgIdx: number; text: string }>,
  minBlockChars: number,
  index: DedupIndex = createDedupIndex()
): DedupOutcome {
  const deduped = new Map<number, string>();
  let dedupCount = 0;

  for (const { msgIdx, text } of msgTexts) {
    const lines = text.split("\n");
    const n = lines.length;
    if (n < MIN_BLOCK_LINES) continue;

    const hashes = suffixHashes(lines);
    const charLens = suffixCharLengths(lines);
    const maxStart = n - MIN_BLOCK_LINES; // line-count bound: ≥ MIN_BLOCK_LINES lines

    // ── Find the LONGEST valid suffix (smallest start) owned by an earlier message. ──
    // start ascending = length descending, so the first match is the longest. charLens
    // decreases with start, so once it dips below minBlockChars no larger start qualifies.
    let matchedStart = -1;
    let matchedSha = "";
    for (let start = 0; start <= maxStart; start++) {
      if (charLens[start] < minBlockChars) break;
      const ref = index.firstSeen.get(hashes[start]);
      if (!ref || ref.ownerMsgIdx >= msgIdx) continue;
      const block = lines.slice(start).join("\n");
      if (ownerSuffixText(index, ref) !== block) continue; // collision guard
      matchedStart = start;
      matchedSha = hashBlock(block);
      break;
    }

    if (matchedStart >= 0) {
      const block = lines.slice(matchedStart).join("\n");
      const marker = `[dedup:ref sha=${matchedSha}]`;
      if (marker.length < block.length) {
        const idx = text.indexOf(block);
        if (idx !== -1) {
          deduped.set(msgIdx, text.slice(0, idx) + marker + text.slice(idx + block.length));
          dedupCount++;
        }
      }
    }

    // ── Register this message's valid suffix hashes (first occurrence wins). ──
    let owns = false;
    for (let start = 0; start <= maxStart; start++) {
      if (charLens[start] < minBlockChars) break;
      const key = hashes[start];
      if (index.firstSeen.has(key)) continue;
      boundedMapSet(
        index.firstSeen,
        key,
        { ownerMsgIdx: msgIdx, startLine: start },
        MAX_DEDUP_INDEX_ENTRIES
      );
      owns = true;
    }
    if (owns) boundedMapSet(index.ownerLines, msgIdx, lines, MAX_OWNER_LINE_ENTRIES);
  }

  return { deduped, dedupCount };
}
