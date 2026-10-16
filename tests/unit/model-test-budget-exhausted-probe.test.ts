/**
 * A model health probe must not report a healthy model as broken just because the
 * probe's own output budget ran out.
 *
 * `opencode-go/muse-spark-1.3-contributor` is a reasoning-dominant model: asked for
 * a trivial answer it spends the whole budget thinking and returns
 *
 *   status: "incomplete", incomplete_details.reason: "max_output_tokens",
 *   output: [ { type: "reasoning", encrypted_content: "…", summary: [] } ],
 *   usage: { output_tokens: 256, output_tokens_details: { reasoning_tokens: 254 } }
 *
 * — the reasoning block is encrypted and its summary is empty, so there is no text
 * to extract anywhere, and the probe reported
 * "Provider returned HTTP 200 but no text content" for a model that had answered.
 *
 * Two gaps produced that: the Responses usage counter lives under
 * `output_tokens_details` (the helper only read the chat shape), and
 * `hasReasoningOnlyCompletion` required a `choices` array, so a Responses answer that
 * stopped on our own budget never reached the existing "[reasoning-only completion]"
 * fallback. The upstream generated output and stated its stop reason, which is proof
 * of reachability — and is what separates this from a body we could not read at all
 * (the #13070 class, which reports neither usage nor a stop reason).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-budget-probe-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const runner = await import("../../src/lib/api/modelTestRunner.ts");
const testHealth = await import("../../src/lib/combos/testHealth.ts");

const PROVIDER = "opencode-go";
const MODEL = "muse-spark-1.3-contributor";

/** The exact payload shape production returned for that model. */
const BUDGET_EXHAUSTED_RESPONSE = {
  id: "resp_probe",
  object: "response",
  status: "incomplete",
  incomplete_details: { reason: "max_output_tokens" },
  max_output_tokens: 256,
  model: MODEL,
  output: [
    {
      id: "rs_1",
      type: "reasoning",
      status: "incomplete",
      encrypted_content: "b3BhcXVl",
      summary: [],
    },
  ],
  usage: {
    input_tokens: 457,
    output_tokens: 256,
    total_tokens: 713,
    output_tokens_details: { reasoning_tokens: 254 },
  },
};

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

test("a Responses answer that stopped on the probe's budget counts as a completion", () => {
  const text = testHealth.extractComboTestResponseText(BUDGET_EXHAUSTED_RESPONSE);
  assert.notEqual(text, "", "a reasoning-only Responses answer must not extract as empty");
  // And the runner's classifier therefore accepts it as a healthy answer.
  assert.equal(runner.classifyModelTestOutput(false, text, false), "ok");
});

test("a readable Responses answer is returned as text, not as the fallback note", () => {
  const text = testHealth.extractComboTestResponseText({
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "pong" }] }],
    usage: { output_tokens: 12, output_tokens_details: { reasoning_tokens: 0 } },
  });
  assert.equal(text, "pong");
});

test("a body we could not read is still empty", () => {
  // The #13070 class: a Chat Completions reader facing a Responses body sees no
  // usage and no stop reason, and must keep failing.
  assert.equal(
    testHealth.extractComboTestResponseText({ choices: [{ message: { content: null } }] }),
    ""
  );
  assert.equal(runner.classifyModelTestOutput(false, "", false), "empty");
});

test("reasoning counters are read from the Responses usage shape", () => {
  const chat = {
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "" } }],
    usage: { completion_tokens_details: { reasoning_tokens: 12 } },
  };
  assert.notEqual(testHealth.extractComboTestResponseText(chat), "", "chat shape still works");
});

test("a timeout still wins over any reasoning fallback", () => {
  assert.equal(
    runner.classifyModelTestOutput(true, "[reasoning-only completion]", false),
    "timeout"
  );
});

// ---------------------------------------------------------------------------
// Dispatch — the probe result itself
// ---------------------------------------------------------------------------

test("the probe reports ok for a registry Responses model that exhausted the budget", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: PROVIDER,
    authType: "apikey",
    name: "opencode-go-budget-probe",
    apiKey: "sk-budget-probe",
    isActive: true,
    testStatus: "active",
  });
  const connectionId = String(connection.id);
  await modelsDb.addCustomModel(PROVIDER, MODEL, MODEL, "sync", "chat-completions", ["chat"]);
  await modelsDb.replaceSyncedAvailableModelsForConnection(PROVIDER, connectionId, [{ id: MODEL }]);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(BUDGET_EXHAUSTED_RESPONSE), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof globalThis.fetch;

  let result: Awaited<ReturnType<typeof runner.runSingleModelTest>>;
  try {
    result = await runner.runSingleModelTest({
      providerId: PROVIDER,
      modelId: MODEL,
      connectionId,
      timeoutMs: 15_000,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(
    result.status,
    "ok",
    `a reasoning-only answer must not read as broken (got ${result.status}: ${"error" in result ? result.error : ""})`
  );
});
