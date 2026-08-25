import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-compression-db-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const { getCompressionSettings, updateCompressionSettings } =
  await import("../../../src/lib/db/compression.ts");

beforeEach(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

afterEach(() => {
  core.resetDbInstance();
});

after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  if (ORIGINAL_DATA_DIR === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  }
});

describe("getCompressionSettings", () => {
  it("returns default settings structure", async () => {
    const settings = await getCompressionSettings();
    assert.equal(typeof settings.enabled, "boolean");
    assert.equal(typeof settings.defaultMode, "string");
    assert.equal(typeof settings.autoTriggerTokens, "number");
    assert.equal(typeof settings.cacheMinutes, "number");
    assert.equal(typeof settings.preserveSystemPrompt, "boolean");
    assert.equal(typeof settings.comboOverrides, "object");
    assert.equal(typeof settings.lite, "object");
    assert.equal(typeof settings.ultra, "object");
  });

  it("has correct default values", async () => {
    const settings = await getCompressionSettings();
    assert.equal(settings.enabled, false);
    assert.equal(settings.defaultMode, "off");
    assert.equal(settings.autoTriggerTokens, 0);
    assert.equal(settings.cacheMinutes, 5);
    assert.equal(settings.preserveSystemPrompt, true);
    assert.equal(settings.preserveSystemPromptMode, "always");
    assert.deepEqual(settings.liveZone, { enabled: false });
    assert.deepEqual(settings.comboOverrides, {});
    assert.equal(settings.lite?.compressToolResults, true);
    assert.equal(settings.ultra?.enabled, false);
    assert.equal(settings.ultra?.compressionRate, 0.5);
    assert.equal(settings.ultra?.minScoreThreshold, 0.3);
    assert.equal(settings.ultra?.slmFallbackToAggressive, true);
    assert.equal(settings.ultra?.maxTokensPerMessage, 0);
  });
});

describe("updateCompressionSettings", () => {
  it("updates enabled flag", async () => {
    await updateCompressionSettings({ enabled: true } as any);
    const settings = await getCompressionSettings();
    assert.equal(settings.enabled, true);
    // Reset
    await updateCompressionSettings({ enabled: false } as any);
  });

  it("persists the Lite proactive tool-result truncation switch across reload", async () => {
    await updateCompressionSettings({ lite: { compressToolResults: false } });
    core.resetDbInstance();

    const settings = await getCompressionSettings();
    assert.equal(settings.lite?.compressToolResults, false);
  });

  it("updates defaultMode", async () => {
    await updateCompressionSettings({ defaultMode: "lite" } as any);
    const settings = await getCompressionSettings();
    assert.equal(settings.defaultMode, "lite");
    // Reset
    await updateCompressionSettings({ defaultMode: "off" } as any);
  });

  it("round-trips preserveSystemPromptMode and ignores unknown tokens (T05/C5)", async () => {
    await updateCompressionSettings({ preserveSystemPromptMode: "never" } as any);
    let settings = await getCompressionSettings();
    assert.equal(settings.preserveSystemPromptMode, "never");

    await updateCompressionSettings({ preserveSystemPromptMode: "whenNoCache" } as any);
    settings = await getCompressionSettings();
    assert.equal(settings.preserveSystemPromptMode, "whenNoCache");

    // An unknown persisted token is rejected on read and falls back to the safe
    // default mode ("always"), never crashing the settings load.
    await updateCompressionSettings({ preserveSystemPromptMode: "garbage" } as any);
    settings = await getCompressionSettings();
    assert.equal(settings.preserveSystemPromptMode, "always");

    // Reset
    await updateCompressionSettings({ preserveSystemPromptMode: "always" } as any);
  });

  it("updates autoTriggerTokens", async () => {
    await updateCompressionSettings({ autoTriggerTokens: 5000 } as any);
    const settings = await getCompressionSettings();
    assert.equal(settings.autoTriggerTokens, 5000);
    // Reset
    await updateCompressionSettings({ autoTriggerTokens: 0 } as any);
  });

  it("round-trips cache-aligned live-zone compression", async () => {
    await updateCompressionSettings({ liveZone: { enabled: true } });
    let settings = await getCompressionSettings();
    assert.deepEqual(settings.liveZone, { enabled: true });

    await updateCompressionSettings({ liveZone: { enabled: false } });
    settings = await getCompressionSettings();
    assert.deepEqual(settings.liveZone, { enabled: false });
  });

  it("updates multiple settings at once", async () => {
    await updateCompressionSettings({
      enabled: true,
      defaultMode: "lite",
      autoTriggerTokens: 1000,
      cacheMinutes: 10,
    } as any);
    const settings = await getCompressionSettings();
    assert.equal(settings.enabled, true);
    assert.equal(settings.defaultMode, "lite");
    assert.equal(settings.autoTriggerTokens, 1000);
    assert.equal(settings.cacheMinutes, 10);
    // Reset all
    await updateCompressionSettings({
      enabled: false,
      defaultMode: "off",
      autoTriggerTokens: 0,
      cacheMinutes: 5,
    } as any);
  });

  it("preserves unmodified settings", async () => {
    const before = await getCompressionSettings();
    await updateCompressionSettings({ enabled: true } as any);
    const after = await getCompressionSettings();
    assert.equal(after.enabled, true);
    assert.equal(after.defaultMode, before.defaultMode);
    assert.equal(after.cacheMinutes, before.cacheMinutes);
    // Reset
    await updateCompressionSettings({ enabled: false } as any);
  });

  it("keeps legacy runtime fields in sync when engines map disables caveman", async () => {
    // Simulate the drift we saw in production: UI engine map says caveman is off, but
    // legacy rows still contain caveman. updateCompressionSettings({ engines }) must clean
    // those rows so dispatch cannot keep injecting caveman/terse behavior.
    await updateCompressionSettings({
      enabled: true,
      stackedPipeline: [
        { engine: "rtk", intensity: "standard" },
        { engine: "caveman", intensity: "full" },
      ],
      cavemanConfig: { enabled: true, intensity: "lite" },
      cavemanOutputMode: { enabled: true, intensity: "lite", autoClarity: true },
      outputStyles: [{ id: "terse-prose", level: "lite" }],
    } as any);

    const settings = await updateCompressionSettings({
      engines: {
        "session-dedup": { enabled: true },
        rtk: { enabled: true, level: "standard" },
        headroom: { enabled: true },
        llmlingua: { enabled: true },
        caveman: { enabled: false, level: "lite" },
        ponytail: { enabled: false, level: "full" },
      },
    } as any);

    assert.equal(settings.cavemanConfig?.enabled, false);
    assert.equal(settings.cavemanOutputMode?.enabled, false);
    // Output styles are independent user settings; do not silently clear them when an engine
    // toggle changes. The caveman-specific legacy output mode is what must be disabled.
    assert.deepEqual(settings.outputStyles, [{ id: "terse-prose", level: "lite" }]);
    assert.equal(settings.defaultMode, "stacked");
    assert.deepEqual(
      settings.stackedPipeline.map((s) => s.engine),
      ["session-dedup", "rtk", "headroom", "llmlingua"]
    );
  });

  it("lets explicit engine toggles win over stale full-config legacy fields", async () => {
    const settings = await updateCompressionSettings({
      enabled: true,
      defaultMode: "lite",
      autoTriggerMode: "lite",
      autoTriggerTokens: 100,
      stackedPipeline: [{ engine: "lite" }],
      engines: {
        "session-dedup": { enabled: true },
        lite: { enabled: false },
        rtk: { enabled: true, level: "minimal" },
        llmlingua: { enabled: true },
      },
    } as any);

    assert.equal(settings.enginesExplicit, true);
    assert.equal(settings.defaultMode, "stacked");
    assert.equal(settings.autoTriggerMode, "stacked");
    assert.deepEqual(
      settings.stackedPipeline.map((s) => s.engine),
      ["session-dedup", "rtk", "llmlingua"]
    );
  });

  it("updates and normalizes ultra config", async () => {
    await updateCompressionSettings({
      defaultMode: "ultra",
      ultra: {
        enabled: true,
        compressionRate: 0.25,
        minScoreThreshold: 0.4,
        slmFallbackToAggressive: false,
        modelPath: "  /tmp/model.onnx  ",
        maxTokensPerMessage: 512,
      },
    } as any);

    const settings = await getCompressionSettings();
    assert.equal(settings.defaultMode, "ultra");
    assert.equal(settings.ultra?.enabled, true);
    assert.equal(settings.ultra?.compressionRate, 0.25);
    assert.equal(settings.ultra?.minScoreThreshold, 0.4);
    assert.equal(settings.ultra?.slmFallbackToAggressive, false);
    assert.equal(settings.ultra?.modelPath, "/tmp/model.onnx");
    assert.equal(settings.ultra?.maxTokensPerMessage, 512);
  });

  it("round-trips ultraEngine + ultraSlmPrewarm (Phase 4 B), defaulting off", async () => {
    const before = await getCompressionSettings();
    assert.equal(before.ultraEngine, "heuristic");
    assert.equal(before.ultraSlmPrewarm, false);

    await updateCompressionSettings({
      ultraEngine: "slm",
      ultraSlmPrewarm: true,
    } as any);

    const after = await getCompressionSettings();
    assert.equal(after.ultraEngine, "slm");
    assert.equal(after.ultraSlmPrewarm, true);
  });
});
