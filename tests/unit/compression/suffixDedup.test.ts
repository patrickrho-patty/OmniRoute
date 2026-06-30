/**
 * Tests for the O(n) suffix-dedup core (replaces the O(n²) findSuffixBlocks).
 * Run: node --import tsx/esm --test tests/unit/compression/suffixDedup.test.ts
 *
 * Covers:
 *   - correctness: longest-suffix match, first-occurrence kept, marker shape
 *   - incremental equivalence: a persistent DedupIndex fed turn-by-turn yields the
 *     SAME decisions as a single batch (the Stage-2 incremental foundation)
 *   - performance: the pathological large-message case that took ~18 s in prod
 *     completes in well under a second
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  dedupMessageTexts,
  createDedupIndex,
} from "../../../open-sse/services/compression/engines/session-dedup/suffixDedup.ts";

function block(tag: string, lines = 6): string {
  return Array.from({ length: lines }, (_, i) => `${tag} line ${i} with enough text to pass`).join(
    "\n"
  );
}

describe("suffixDedup O(n) core", () => {
  it("replaces a later message's repeated suffix block, keeps the first intact", () => {
    const b = block("alpha");
    const msgs = [
      { msgIdx: 0, text: `intro\n${b}` },
      { msgIdx: 1, text: `different content entirely here, nothing shared at all` },
      { msgIdx: 2, text: `please re-review\n${b}` },
    ];

    const { deduped, dedupCount } = dedupMessageTexts(msgs, 80);

    assert.equal(dedupCount, 1, "exactly one message should dedup");
    assert.equal(deduped.has(0), false, "first occurrence kept intact");
    assert.ok(deduped.has(2), "later duplicate should be replaced");
    assert.match(deduped.get(2)!, /\[dedup:ref sha=[0-9a-f]{24}\]/);
    assert.ok(!deduped.get(2)!.includes(b), "raw repeated block removed from later message");
  });

  it("does not dedup blocks below MIN_BLOCK_LINES or minBlockChars", () => {
    const tiny = "a\nb"; // 2 lines, below MIN_BLOCK_LINES
    const shortChars = "x\ny\nz"; // 3 lines but tiny char count
    const msgs = [
      { msgIdx: 0, text: tiny },
      { msgIdx: 1, text: tiny },
      { msgIdx: 2, text: shortChars },
      { msgIdx: 3, text: shortChars },
    ];
    const { dedupCount } = dedupMessageTexts(msgs, 80);
    assert.equal(dedupCount, 0, "tiny/short blocks must not dedup");
  });

  it("picks the LONGEST matching suffix when nested blocks repeat", () => {
    const small = block("beta", 4);
    const big = `${block("gamma", 5)}\n${small}`;
    const msgs = [
      { msgIdx: 0, text: `head\n${big}` }, // owns both `big` and its `small` suffix
      { msgIdx: 1, text: `again\n${big}` }, // should match the LONGEST (big), not just small
    ];
    const { deduped } = dedupMessageTexts(msgs, 80);
    const out = deduped.get(1)!;
    assert.ok(out.includes("[dedup:ref sha="), "should replace with a marker");
    assert.ok(!out.includes(big), "the longest matching suffix should be gone");
  });

  it("incremental: a persistent index fed turn-by-turn == single batch", () => {
    const a = block("alpha");
    const b = block("bravo");
    const all = [
      { msgIdx: 0, text: `t0\n${a}` },
      { msgIdx: 1, text: `t1 unique chatter goes here for a while padding chars` },
      { msgIdx: 2, text: `t2\n${a}` }, // dup of msg 0
      { msgIdx: 3, text: `t3\n${b}` },
      { msgIdx: 4, text: `t4\n${b}` }, // dup of msg 3
    ];

    // Single batch (fresh index)
    const batch = dedupMessageTexts(all, 80);

    // Turn-by-turn with one persistent index (simulating append-only turns)
    const idx = createDedupIndex();
    const r0 = dedupMessageTexts(all.slice(0, 2), 80, idx);
    const r1 = dedupMessageTexts(all.slice(2, 4), 80, idx);
    const r2 = dedupMessageTexts(all.slice(4, 5), 80, idx);

    const incremental = new Map<number, string>([...r0.deduped, ...r1.deduped, ...r2.deduped]);

    assert.equal(incremental.size, batch.deduped.size, "incremental dedup count must equal batch");
    for (const [k, v] of batch.deduped) {
      assert.equal(incremental.get(k), v, `message ${k} must dedup identically incrementally`);
    }
  });

  it("PERF: large repeated messages dedup in well under a second", () => {
    // Reproduces the production shape: a few very large messages (tens of thousands of
    // lines) where a big block repeats. The old O(n²) findSuffixBlocks took ~18 s on
    // bodies like this; the O(n) core must be sub-second.
    const huge = Array.from(
      { length: 30_000 },
      (_, i) => `tool output line ${i} :: some path/file and a value ${i * 7}`
    ).join("\n");

    const msgs = [
      { msgIdx: 0, text: `first tool dump\n${huge}` },
      { msgIdx: 1, text: `a short reply` },
      { msgIdx: 2, text: `resent verbatim\n${huge}` }, // exact repeat → should dedup
      { msgIdx: 3, text: `another short reply` },
      { msgIdx: 4, text: `resent again\n${huge}` }, // repeat again
    ];

    const start = performance.now();
    const { dedupCount } = dedupMessageTexts(msgs, 80);
    const elapsedMs = performance.now() - start;

    assert.ok(dedupCount >= 2, `expected the repeats to dedup, got ${dedupCount}`);
    assert.ok(
      elapsedMs < 1000,
      `O(n) dedup must be sub-second on large bodies, took ${elapsedMs.toFixed(0)}ms`
    );
  });
});
