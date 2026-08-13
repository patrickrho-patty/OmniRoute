import test from "node:test";
import assert from "node:assert/strict";

import { selectCompressionPlan } from "../../../open-sse/services/compression/strategySelector.ts";
import type { CompressionConfig } from "../../../open-sse/services/compression/types.ts";

function baseConfig(overrides: Partial<CompressionConfig> = {}): CompressionConfig {
  return {
    enabled: true,
    defaultMode: "stacked",
    autoTriggerMode: "lite",
    autoTriggerTokens: 100,
    cacheMinutes: 5,
    preserveSystemPrompt: true,
    comboOverrides: {},
    enginesExplicit: true,
    engines: {
      "session-dedup": { enabled: true },
      lite: { enabled: false },
      rtk: { enabled: true, level: "minimal" },
      llmlingua: { enabled: true },
    },
    activeComboId: null,
    stackedPipeline: [
      { engine: "session-dedup" },
      { engine: "rtk", intensity: "minimal" },
      { engine: "llmlingua" },
    ],
    ...overrides,
  } as CompressionConfig;
}

test("explicit engine toggles outrank stale autoTriggerMode=lite", () => {
  const plan = selectCompressionPlan(baseConfig(), null, 1000);
  assert.equal(plan.source, "default");
  assert.equal(plan.mode, "stacked");
  assert.deepEqual(
    plan.stackedPipeline.map((step) => step.engine),
    ["session-dedup", "rtk", "llmlingua"]
  );
});

test("auto-trigger can still select lite when the lite engine is explicitly enabled", () => {
  const config = baseConfig({
    engines: {
      "session-dedup": { enabled: false },
      lite: { enabled: true },
      rtk: { enabled: false },
      llmlingua: { enabled: false },
    },
  });
  const plan = selectCompressionPlan(config, null, 1000);
  assert.equal(plan.source, "auto-trigger");
  assert.equal(plan.mode, "lite");
});
