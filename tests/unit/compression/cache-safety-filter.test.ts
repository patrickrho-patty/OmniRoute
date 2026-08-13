/**
 * Cache-safety pipeline filter — preserves provider prompt caching.
 * Run: node --import tsx/esm --test tests/unit/compression/cache-safety-filter.test.ts
 *
 * Research (Anthropic/OpenAI/Gemini docs + arXiv 2601.06007, unanimous): provider prompt
 * caching is keyed on an EXACT prefix match; an engine that rewrites earlier content based on
 * later content or total budget mutates the cached prefix and busts the ~10x cache discount —
 * which far outweighs the engine's local savings. So in a caching context the stacked pipeline
 * drops `cacheSafe === false` engines, EXCEPT `overflowCritical` ones (headroom) that must run
 * to prevent context-window overflow. Outside a caching context nothing is dropped.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import { filterCacheUnsafeSteps } from "../../../open-sse/services/compression/index.ts";
import { registerBuiltinCompressionEngines } from "../../../open-sse/services/compression/engines/index.ts";

const FULL_PIPELINE = [
  { engine: "session-dedup" },
  { engine: "rtk" },
  { engine: "aggressive" },
  { engine: "ultra" },
  { engine: "ionizer" },
  { engine: "headroom" },
  { engine: "ponytail" },
];

const body = { model: "claude-opus-4-6", messages: [{ role: "user", content: "hi" }] };
const ids = (steps: Array<{ engine: string }>) => steps.map((s) => s.engine);

describe("cache-safety pipeline filter", () => {
  before(() => registerBuiltinCompressionEngines());

  it("drops cache-unsafe compression engines in a caching context (claude), keeps overflow-critical", () => {
    const { steps, dropped } = filterCacheUnsafeSteps(FULL_PIPELINE, body, {
      cachingContext: { provider: "claude" },
    });
    // aggressive/ultra/ionizer are budget-driven (cacheSafe:false) → dropped.
    assert.deepEqual(dropped.sort(), ["aggressive", "ionizer", "ultra"]);
    // session-dedup + rtk + ponytail (cacheSafe) and headroom (overflowCritical) survive.
    assert.deepEqual(ids(steps), ["session-dedup", "rtk", "headroom", "ponytail"]);
  });

  it("keeps headroom (overflowCritical) even though it is cacheSafe:false", () => {
    const { steps, dropped } = filterCacheUnsafeSteps([{ engine: "headroom" }], body, {
      cachingContext: { provider: "anthropic" },
    });
    assert.deepEqual(dropped, []);
    assert.deepEqual(ids(steps), ["headroom"]);
  });

  it("drops NOTHING outside a caching context (non-caching provider)", () => {
    // ollama (local) does not do upstream prompt caching, so there is no cache to protect.
    const { steps, dropped } = filterCacheUnsafeSteps(
      FULL_PIPELINE,
      { model: "ollama-llama3", messages: [{ role: "user", content: "hi" }] },
      { cachingContext: { provider: "ollama" } }
    );
    assert.deepEqual(dropped, []);
    assert.deepEqual(ids(steps), ids(FULL_PIPELINE));
  });

  it("drops relevance in a caching context (scores against the changing query → cache-unsafe)", () => {
    const { dropped } = filterCacheUnsafeSteps(
      [{ engine: "session-dedup" }, { engine: "relevance" }, { engine: "rtk" }],
      body,
      { cachingContext: { provider: "claude" } }
    );
    assert.deepEqual(dropped, ["relevance"]);
  });

  it("overflow safety: keeps a cache-buster if dropping leaves NO compression and no hard budget", () => {
    // [aggressive] alone in a caching context: dropping it would leave nothing to shrink the
    // request → context-overflow risk. Overflow safety wins → keep it (accept the cache cost).
    const r1 = filterCacheUnsafeSteps([{ engine: "aggressive" }], body, {
      cachingContext: { provider: "claude" },
    });
    assert.deepEqual(r1.dropped, [], "should keep aggressive — nothing else compresses");

    // Same, but a hard budget guarantees the fit → safe to drop.
    const r2 = filterCacheUnsafeSteps([{ engine: "aggressive" }], body, {
      cachingContext: { provider: "claude" },
      config: { targetTokens: 50000 } as never,
    });
    assert.deepEqual(r2.dropped, ["aggressive"], "hard budget present → safe to drop");

    // Only ponytail (an augmenter, doesn't compress) survives → keep the cache-buster.
    const r3 = filterCacheUnsafeSteps([{ engine: "aggressive" }, { engine: "ponytail" }], body, {
      cachingContext: { provider: "claude" },
    });
    assert.deepEqual(r3.dropped, [], "only ponytail remains (no real compression) → keep");

    // A cache-safe compressor survives (session-dedup) → dropping is safe.
    const r4 = filterCacheUnsafeSteps(
      [{ engine: "aggressive" }, { engine: "session-dedup" }],
      body,
      { cachingContext: { provider: "claude" } }
    );
    assert.deepEqual(r4.dropped, ["aggressive"], "session-dedup still compresses → safe to drop");
  });

  it("the user's production pipeline is unchanged in a caching context (no pure cache-busters)", () => {
    const prod = [
      { engine: "session-dedup" },
      { engine: "rtk" },
      { engine: "headroom" },
      { engine: "ponytail" },
    ];
    const { steps, dropped } = filterCacheUnsafeSteps(prod, body, {
      cachingContext: { provider: "claude" },
    });
    assert.deepEqual(dropped, []);
    assert.deepEqual(ids(steps), ids(prod));
  });
});
