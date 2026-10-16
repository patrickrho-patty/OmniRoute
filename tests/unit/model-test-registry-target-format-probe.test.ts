/**
 * The dashboard's per-model health test for a *registry* model that speaks the
 * Responses API, reached through a node that says "openai".
 *
 * Sibling of the #13070 suite (node-declared Responses). There the signal was the
 * provider node's `apiType`; here it is the model row in the provider registry.
 * `opencode-go/muse-spark-1.3-contributor` is served only on /v1/responses
 * (#12674), and the router honours that via `getModelTargetFormat`.
 *
 * The probe did not. `detectTestKind` read only the connection's imported
 * overlay — `apiFormat: "chat-completions"`, `supportedEndpoints: ["chat"]`, the
 * stale metadata an earlier catalog sync wrote — so the probe posted a
 * Chat Completions body with a 64-token budget and the model went red with
 * "Provider returned HTTP 200 but no text content" while normal requests over
 * the same connection worked.
 *
 * As in the #13070 suite, the classification tests alone prove nothing: they
 * stay green if the dispatch ignores `isResponses`. The last test reads the route
 * the probe actually hit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-registry-probe-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const runner = await import("../../src/lib/api/modelTestRunner.ts");
const callLogs = await import("../../src/lib/usage/callLogs.ts");

const PROVIDER = "opencode-go";
const MODEL = "muse-spark-1.3-contributor";

// Exactly what the connection's overlay held on the reporting host.
const STALE_OVERLAY = { apiFormat: "chat-completions", supportedEndpoints: ["chat"] };

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

test("a registry Responses model is recognised through a stale chat overlay", () => {
  const kind = runner.detectTestKind(
    `${PROVIDER}/${MODEL}`,
    STALE_OVERLAY,
    "openai",
    "openai-responses"
  );
  assert.equal(
    kind.isResponses,
    true,
    "the registry is authoritative for dispatch, so the probe must follow it"
  );
});

test("the overlay alone still decides when the registry has no Responses signal", () => {
  const kind = runner.detectTestKind(`${PROVIDER}/${MODEL}`, STALE_OVERLAY, "openai");
  assert.equal(kind.isResponses, false, "an imported chat overlay must not be promoted on its own");
});

test("a registry chat model is not promoted to Responses", () => {
  assert.equal(
    runner.detectTestKind("opencode-go/glm-5.3", null, "openai", "openai").isResponses,
    false
  );
  assert.equal(
    runner.detectTestKind("openai/gpt-4o", null, undefined, "openai").isResponses,
    false
  );
});

test("modality detection still wins over the registry Responses signal", () => {
  // A Responses-capable provider can still host embeddings; promoting those to
  // /v1/responses would break working setups rather than fix a broken one.
  assert.equal(
    runner.detectTestKind("baai/bge-m3", null, "openai", "openai-responses").isEmbedding,
    true
  );
  assert.equal(
    runner.detectTestKind("baai/bge-m3", null, "openai", "openai-responses").isResponses,
    false
  );
});

// ---------------------------------------------------------------------------
// Dispatch — the assertion that fails if the endpoint choice is reverted
// ---------------------------------------------------------------------------

test("the probe for a registry Responses model reaches /v1/responses", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: PROVIDER,
    authType: "apikey",
    name: "opencode-go-registry-probe",
    apiKey: "sk-registry-probe",
    isActive: true,
    testStatus: "active",
  });
  const connectionId = String(connection.id);

  // The overlay the reporting host had: chat, chat, chat.
  await modelsDb.addCustomModel(PROVIDER, MODEL, MODEL, "sync", "chat-completions", ["chat"]);
  // A non-empty synced catalog keeps prepareConnectionModelTest from attempting a
  // real catalog sync; only the probe itself should reach the network.
  await modelsDb.replaceSyncedAvailableModelsForConnection(PROVIDER, connectionId, [{ id: MODEL }]);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ output_text: "pong" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof globalThis.fetch;

  try {
    await runner.runSingleModelTest({
      providerId: PROVIDER,
      modelId: MODEL,
      connectionId,
      timeoutMs: 15_000,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  await callLogs.waitForCallLogSaves(10_000);
  const logs = await callLogs.getCallLogs({});
  const probe = logs.find((entry: { model?: string | null }) =>
    String(entry.model ?? "").includes(MODEL)
  );

  assert.ok(probe, "the model test should have produced a call log entry");
  assert.equal(
    probe.path,
    "/v1/responses",
    `a registry Responses model must be probed on /v1/responses (call log says ${probe.path})`
  );
});
