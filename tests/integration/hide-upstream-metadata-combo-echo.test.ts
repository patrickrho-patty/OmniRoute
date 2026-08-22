// tests/integration/hide-upstream-metadata-combo-echo.test.ts
//
// End-to-end reproduction of the live leak on omni.agents.patty.io:
// a combo named `claude-fable-5` whose targets are DeepSeek upstreams.
//
//   1. echoRequestedModelName=true alone (the operator's current config) must
//      already echo the combo name in the response body — this is the #1311
//      combo-path bug fix (executeChatWithBreaker used to overwrite body.model
//      with the upstream id before chatCore could capture it).
//   2. HIDE_UPSTREAM_METADATA additionally strips X-OmniRoute-Model/Provider/Decision
//      headers and combo-failure diagnostics identities.
//   3. The flag alone force-enables the echo (no echoRequestedModelName needed).

import test from "node:test";
import assert from "node:assert/strict";
import { createComboRoutingHarness } from "./_comboRoutingHarness.ts";

const h = await createComboRoutingHarness("hide-upstream-echo");
const {
  BaseExecutor,
  combosDb,
  handleChat,
  buildRequest,
  seedConnection,
  settingsDb,
  resetStorage,
} = h;

function comboBody(stream = false) {
  return {
    model: "claude-fable-5",
    stream,
    messages: [{ role: "user", content: "ping" }],
  };
}

test.beforeEach(async () => {
  BaseExecutor.RETRY_CONFIG.delayMs = 0;
  delete process.env.HIDE_UPSTREAM_METADATA;
  await resetStorage();
});
test.afterEach(async () => {
  BaseExecutor.RETRY_CONFIG.delayMs = h.originalRetryDelayMs;
  delete process.env.HIDE_UPSTREAM_METADATA;
  await resetStorage();
});
test.after(async () => {
  await h.cleanup();
});

async function seedFableCombo(targetModel = "openai/gpt-4o-mini") {
  await seedConnection("openai", { apiKey: "sk-hide-meta" });
  await combosDb.createCombo({
    name: "claude-fable-5",
    strategy: "priority",
    config: { maxRetries: 0, retryDelayMs: 0 },
    // The "upstream" is a mocked OpenAI endpoint — standing in for
    // opencode-go/deepseek-v4-pro on the live server. Success paths use a
    // registry model id (gpt-4o-mini) because response validation rejects
    // unregistered ids; the identity assertions only need upstream ≠ combo name.
    models: [targetModel],
  });
}

test("echoRequestedModelName echoes the COMBO name, not the upstream id (#1311 combo-path fix)", async () => {
  await seedFableCombo();
  await settingsDb.updateSettings({ echoRequestedModelName: true });
  h.installRecordingFetch();

  const res = await handleChat(buildRequest({ body: comboBody() }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(
    body.model,
    "claude-fable-5",
    `response body.model must echo the combo name, got: ${body.model}`
  );
  // The upstream dispatch really carried the upstream id (routing is unchanged).
  assert.equal(h.calls[0].model, "gpt-4o-mini");
  // And the upstream id must NOT appear anywhere in the client-facing body.
  assert.ok(!JSON.stringify(body).includes("gpt-4o-mini"), "upstream id leaked in body");
});

test("HIDE_UPSTREAM_METADATA omits model/provider/decision headers and still echoes the combo name", async () => {
  await seedFableCombo();
  await settingsDb.updateSettings({ echoRequestedModelName: true });
  process.env.HIDE_UPSTREAM_METADATA = "true";
  h.installRecordingFetch();

  const res = await handleChat(buildRequest({ body: comboBody() }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-omniroute-model"), null);
  assert.equal(res.headers.get("x-omniroute-provider"), null);
  assert.equal(res.headers.get("x-omniroute-decision"), null);
  // Neutral telemetry stays.
  assert.ok(res.headers.get("x-omniroute-version"));
  const body = await res.json();
  assert.equal(body.model, "claude-fable-5");
});

test("HIDE_UPSTREAM_METADATA force-enables the echo without echoRequestedModelName", async () => {
  await seedFableCombo();
  process.env.HIDE_UPSTREAM_METADATA = "true";
  h.installRecordingFetch();

  const res = await handleChat(buildRequest({ body: comboBody() }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.model, "claude-fable-5");
});

test("combo failure diagnostics carry no upstream identities under the flag", async () => {
  await seedFableCombo("openai/deepseek-v4-pro");
  process.env.HIDE_UPSTREAM_METADATA = "true";
  // Every upstream call fails, and the upstream error BODY itself names its model —
  // the exact raw-text leak class the flag must contain.
  h.installRecordingFetch(() =>
    h.failure(503, "deepseek-v4-pro is overloaded (model deepseek-v4-pro)")
  );

  const res = await handleChat(buildRequest({ body: comboBody() }));
  assert.ok(res.status >= 500, `expected combo failure status, got ${res.status}`);
  assert.equal(res.headers.get("x-omniroute-combo-excluded"), null);
  assert.equal(res.headers.get("x-omniroute-combo-terminal-reason"), null);
  const text = await res.text();
  assert.ok(!text.includes("deepseek"), `failure body must not name the upstream: ${text}`);
  assert.ok(!text.includes("openai/"), `failure body must not name the provider: ${text}`);
});

test("without the flag, failure diagnostics still expose identities (documented default)", async () => {
  await seedFableCombo("openai/deepseek-v4-pro");
  h.installRecordingFetch(() => h.failure(503));

  const res = await handleChat(buildRequest({ body: comboBody() }));
  assert.ok(res.status >= 500);
  const text = await res.text();
  assert.ok(text.includes("openai"), "default diagnostics keep provider identities");
});

test("streaming SSE chunks echo the combo name and metadata comments drop identities", async () => {
  await seedFableCombo();
  process.env.HIDE_UPSTREAM_METADATA = "true";
  // Mocked upstream streams standard OpenAI chunks carrying the upstream model id.
  const sseLines = [
    'data: {"id":"c1","object":"chat.completion.chunk","model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
    'data: {"id":"c1","object":"chat.completion.chunk","model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
    "data: [DONE]\n\n",
  ].join("");
  h.installRecordingFetch(
    () =>
      new Response(sseLines, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })
  );

  const res = await handleChat(buildRequest({ body: comboBody(true) }));
  assert.equal(res.status, 200);
  const raw = await res.text();
  // Every data chunk's model field must be the public combo name…
  for (const line of raw.split("\n")) {
    if (line.startsWith("data: {")) {
      assert.equal(JSON.parse(line.slice(5)).model, "claude-fable-5");
    }
    // …and no comment line may carry upstream identities.
    if (line.startsWith(":")) {
      assert.ok(!line.includes("gpt-4o-mini"), `SSE comment leaked upstream: ${line}`);
      assert.ok(!line.includes("provider=openai"), `SSE comment leaked provider: ${line}`);
    }
  }
  assert.ok(!raw.includes("gpt-4o-mini"), "upstream id must not appear anywhere in the stream");
});
