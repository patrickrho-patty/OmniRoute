/**
 * Equivalence property test for the incremental ("process-once") compressor.
 * Run: node --import tsx/esm --test tests/unit/compression/incremental-equivalence.test.ts
 *
 * The safety gate for the whole incremental layer: for a growing, append-only conversation,
 * running the stacked pipeline INCREMENTALLY (persistent session context across turns) must
 * produce a body BYTE-IDENTICAL to running the full pipeline fresh on the whole body each turn.
 *
 * This is asserted turn-by-turn across multiple pipelines, including dedup-heavy ones with
 * repeated large blocks (the case incremental session-dedup must get exactly right). Any engine
 * whose incremental path diverges from its full run fails here immediately.
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { applyStackedCompressionAsync } from "../../../open-sse/services/compression/index.ts";
import { registerBuiltinCompressionEngines } from "../../../open-sse/services/compression/engines/index.ts";
import { incrementalCompress } from "../../../open-sse/services/compression/incremental/incrementalCompressor.ts";
import { clearAllContexts } from "../../../open-sse/services/compression/incremental/sessionStore.ts";
import type { CompressionPipelineStep } from "../../../open-sse/services/compression/types.ts";

// ── deterministic conversation generator ─────────────────────────────────────

/** Tiny seeded PRNG (Date.now/Math.random are unavailable / non-deterministic here). */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/** A few large, line-structured blocks that recur across turns so dedup actually fires. */
const BLOCKS = [
  Array.from(
    { length: 40 },
    (_, i) => `tool-output line ${i}: lorem ipsum dolor sit amet ${i}`
  ).join("\n"),
  Array.from({ length: 30 }, (_, i) => `file content row ${i}: const x${i} = compute(${i});`).join(
    "\n"
  ),
  Array.from({ length: 25 }, (_, i) => `stack frame ${i} at module/path/file.ts:${i * 7}`).join(
    "\n"
  ),
];

/** Build a conversation of `turns` turns; each turn appends a user+assistant pair. */
function buildConversation(turns: number, rng: () => number): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: "You are a helpful assistant." },
  ];
  for (let t = 0; t < turns; t++) {
    const block = BLOCKS[Math.floor(rng() * BLOCKS.length)];
    // Half the time, resend a verbatim earlier block (the dedup case); else fresh-ish text.
    const userText =
      rng() < 0.6
        ? `Turn ${t} request.\n${block}`
        : `Turn ${t} unique ask ${Math.floor(rng() * 1e6)}.\n${block}\nextra ${t}`;
    messages.push({ role: "user", content: userText });
    messages.push({ role: "assistant", content: `Acknowledged turn ${t}. ${block.slice(0, 50)}` });
  }
  return messages;
}

function bodyOf(messages: Array<Record<string, unknown>>): Record<string, unknown> {
  // Deep clone so the two paths can't share/mutate the same objects.
  return { model: "test", messages: JSON.parse(JSON.stringify(messages)) };
}

// ── the test ─────────────────────────────────────────────────────────────────

const PIPELINES: Record<string, CompressionPipelineStep[]> = {
  "session-dedup only": [{ engine: "session-dedup" }],
  "session-dedup + rtk": [{ engine: "session-dedup" }, { engine: "rtk" }],
  "rtk + session-dedup": [{ engine: "rtk" }, { engine: "session-dedup" }],
};

describe("incremental compression equivalence (incremental ≡ full body)", () => {
  before(() => {
    registerBuiltinCompressionEngines();
  });

  beforeEach(() => {
    clearAllContexts();
  });

  for (const [name, pipeline] of Object.entries(PIPELINES)) {
    it(`pipeline "${name}" is byte-identical to a full run every turn`, async () => {
      const TURNS = 8;
      const rng = makeRng(0xc0ffee + name.length);
      const full = buildConversation(TURNS, rng);

      // Replay the conversation turn by turn: at turn k the body is messages[0..2k+0].
      for (let t = 1; t <= TURNS; t++) {
        const upto = full.slice(0, 1 + t * 2); // system + t (user,assistant) pairs

        const fullResult = await applyStackedCompressionAsync(bodyOf(upto), pipeline, {});

        const { result: incResult, stats } = await incrementalCompress({
          body: bodyOf(upto),
          mode: "stacked",
          runOptions: {
            config: { enabled: true, defaultMode: "stacked", stackedPipeline: pipeline } as never,
          },
          runStacked: (b, opts) => applyStackedCompressionAsync(b, pipeline, opts as never),
          injectContext: (ctx) => ({ incremental: ctx }),
        });

        const fullMsgs = JSON.stringify((fullResult.body as { messages: unknown }).messages);
        const incMsgs = JSON.stringify((incResult.body as { messages: unknown }).messages);

        assert.equal(
          incMsgs,
          fullMsgs,
          `turn ${t}: incremental body diverged from full body (cacheHits=${stats.cacheHits}/${stats.totalMessages})`
        );

        // The test must prove the INCREMENTAL path actually ran — not that it silently fell back
        // to a full run (which would pass equivalence trivially and prove nothing). From turn 2
        // on, the immutable prefix must be served from cache.
        assert.equal(stats.incremental, true, `turn ${t}: incremental path was not engaged`);
        if (t > 1) {
          assert.ok(
            stats.cacheHits > 0,
            `turn ${t}: expected prefix cache hits (process-once), got ${stats.cacheHits}`
          );
          assert.equal(
            stats.computed,
            2,
            `turn ${t}: expected to compute only the 2 new messages, computed ${stats.computed}`
          );
        }
      }
    });
  }

  // Guards the append-only invariant: if a conversation stops being append-only (a middle
  // message is deleted/edited), the carried memo + dedup index are stale. The orchestrator's
  // append-only guard must detect this and reset the context so the result still matches a full
  // run — otherwise the tail would dedup against stale prefix state and diverge silently.
  it("resets and stays byte-identical when the conversation is NOT append-only (mid-message delete)", async () => {
    const pipeline = PIPELINES["session-dedup + rtk"];
    const rng = makeRng(0xbadbeef);
    const convo = buildConversation(6, rng);

    // Warm the session context with several append-only turns.
    for (let t = 1; t <= 4; t++) {
      const upto = convo.slice(0, 1 + t * 2);
      await incrementalCompress({
        body: bodyOf(upto),
        mode: "stacked",
        runOptions: {
          config: { enabled: true, defaultMode: "stacked", stackedPipeline: pipeline } as never,
        },
        runStacked: (b, opts) => applyStackedCompressionAsync(b, pipeline, opts as never),
        injectContext: (ctx) => ({ incremental: ctx }),
      });
    }

    // Now break append-only: drop a middle (user,assistant) pair, keep the rest (same session
    // key — message 0 is unchanged — so the SAME warmed context is reused, exercising the guard).
    const mutated = [...convo.slice(0, 3), ...convo.slice(5, 9)];

    const fullResult = await applyStackedCompressionAsync(bodyOf(mutated), pipeline, {});
    const { result: incResult } = await incrementalCompress({
      body: bodyOf(mutated),
      mode: "stacked",
      runOptions: {
        config: { enabled: true, defaultMode: "stacked", stackedPipeline: pipeline } as never,
      },
      runStacked: (b, opts) => applyStackedCompressionAsync(b, pipeline, opts as never),
      injectContext: (ctx) => ({ incremental: ctx }),
    });

    assert.equal(
      JSON.stringify((incResult.body as { messages: unknown }).messages),
      JSON.stringify((fullResult.body as { messages: unknown }).messages),
      "non-append-only mutation must reset the context and match a full run, not diverge"
    );
  });
});
