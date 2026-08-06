import assert from "node:assert/strict";
import test from "node:test";

import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

const harness = await createChatPipelineHarness("patty-chat-pipeline");
const { buildOpenAIResponse, buildRequest, handleChat, resetStorage, seedConnection } = harness;

const originalEnv = {
  url: process.env.PATTY_GATEWAY_URL,
  token: process.env.PATTY_GATEWAY_TOKEN,
};

test.beforeEach(async () => {
  await resetStorage();
  process.env.PATTY_GATEWAY_URL = "http://patty-sidecar:4100";
  process.env.PATTY_GATEWAY_TOKEN = "gateway-secret";
});

test.afterEach(async () => {
  await resetStorage();
  if (originalEnv.url === undefined) delete process.env.PATTY_GATEWAY_URL;
  else process.env.PATTY_GATEWAY_URL = originalEnv.url;
  if (originalEnv.token === undefined) delete process.env.PATTY_GATEWAY_TOKEN;
  else process.env.PATTY_GATEWAY_TOKEN = originalEnv.token;
});

test.after(async () => {
  await harness.cleanup();
});

test("Patty preflight selects the provider route and settlement precedes the HTTP response", async () => {
  await seedConnection("openai", { apiKey: "provider-secret" });
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = {
      url: String(url),
      body: JSON.parse(String(init.body || "{}")),
      headers: new Headers(init.headers),
    };
    calls.push(call);
    if (call.url.endsWith("/patty-code/internal/gateway/preflight")) {
      return Response.json({
        preflight_ref: "opaque-preflight",
        request_id: call.body.request_id,
        turn_id: "http",
        employee_id: "employee-1",
        device_id: "device-1",
        email: "employee@patty.io",
        harness: "codex",
        usage_identity: "usage-1",
        routing_group: "enterprise",
        public_model: "gpt-5.3-codex",
        route: { target: "openai/gpt-4.1", price_multiplier: 1.25 },
        quota: {
          five_hour: { spend: 5, limit: 25, used_percent: 20, reset_at: 2_000_000_000 },
          seven_day: { spend: 80, limit: 200, used_percent: 40, reset_at: 2_000_500_000 },
        },
      });
    }
    if (call.url.endsWith("/patty-code/internal/gateway/settle")) {
      return Response.json({ settled: true, duplicate: false, points: 0.01 });
    }
    return buildOpenAIResponse("Patty routed response", "gpt-4.1", {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
    });
  };

  try {
    const response = await handleChat(
      buildRequest({
        url: "http://localhost/v1/responses",
        headers: {
          authorization: "Bearer internal-omniroute-key",
          "x-patty-harness": "codex",
          "x-patty-original-authorization": "employee-secret",
          "x-patty-client-ip": "10.0.0.7",
          "x-patty-account-id": "employee-1",
        },
        body: {
          model: "gpt-5.3-codex",
          stream: false,
          instructions: "Keep this instruction",
          input: [{ role: "user", content: "hello" }],
        },
      })
    );
    const responseBody = (await response.json()) as { model?: string };

    assert.equal(response.status, 200);
    assert.equal(responseBody.model, "gpt-5.3-codex", "the public model is echoed to Codex");
    assert.equal(response.headers.get("x-codex-primary-used-percent"), "20");
    assert.equal(response.headers.get("x-codex-secondary-used-percent"), "40");
    assert.equal(calls.length, 3);
    assert.match(calls[0].url, /gateway\/preflight$/);
    assert.equal(calls[0].body.credential, "employee-secret");
    assert.equal(calls[0].headers.get("authorization"), "Bearer gateway-secret");
    assert.equal(calls[1].body.model, "gpt-4.1");
    assert.equal(JSON.stringify(calls[1]).includes("employee-secret"), false);
    assert.match(calls[2].url, /gateway\/settle$/);
    assert.equal(calls[2].body.route_target, "openai/gpt-4.1");
    assert.equal(calls[2].body.input_tokens, 100);
    assert.equal(calls[2].body.output_tokens, 20);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Patty settlement completes before a Codex stream emits its terminal event", async () => {
  await seedConnection("openai", { apiKey: "provider-secret" });
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  const encoder = new TextEncoder();
  globalThis.fetch = async (url, init = {}) => {
    const requestUrl = String(url);
    const requestBody = JSON.parse(String(init.body || "{}"));
    if (requestUrl.endsWith("/patty-code/internal/gateway/preflight")) {
      calls.push("preflight");
      return Response.json({
        preflight_ref: "stream-preflight",
        request_id: requestBody.request_id,
        turn_id: "http",
        employee_id: "employee-1",
        device_id: "device-1",
        email: "employee@patty.io",
        harness: "codex",
        usage_identity: "usage-1",
        routing_group: "enterprise",
        public_model: "gpt-5.3-codex",
        route: { target: "openai/gpt-4.1", price_multiplier: 1.25 },
        quota: {
          five_hour: { spend: 5, limit: 25, used_percent: 20, reset_at: 2_000_000_000 },
          seven_day: { spend: 80, limit: 200, used_percent: 40, reset_at: 2_000_500_000 },
        },
      });
    }
    if (requestUrl.endsWith("/patty-code/internal/gateway/settle")) {
      calls.push("settle:start");
      await new Promise((resolve) => setTimeout(resolve, 40));
      calls.push("settle:complete");
      return Response.json({ settled: true, duplicate: false, points: 0.01 });
    }

    calls.push("provider");
    const chunks = [
      {
        id: "resp-stream",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4.1",
        choices: [
          { index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null },
        ],
      },
      {
        id: "resp-stream",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4.1",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      },
    ];
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } }
    );
  };

  try {
    const response = await handleChat(
      buildRequest({
        url: "http://localhost/v1/responses",
        headers: {
          authorization: "Bearer internal-omniroute-key",
          "x-patty-harness": "codex",
          "x-patty-original-authorization": "employee-secret",
          "x-patty-client-ip": "10.0.0.7",
        },
        body: {
          model: "gpt-5.3-codex",
          stream: true,
          input: [{ role: "user", content: "hello" }],
        },
      })
    );
    const streamBody = await response.text();

    assert.equal(response.status, 200);
    assert.match(streamBody, /"type":"response\.completed"/);
    assert.match(streamBody, /"model":"gpt-5\.3-codex"/);
    assert.deepEqual(calls, ["preflight", "provider", "settle:start", "settle:complete"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Patty settles a final upstream rejection before returning it to Codex", async () => {
  await seedConnection("openai", { apiKey: "provider-secret" });
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (url, init = {}) => {
    const requestUrl = String(url);
    const requestBody = JSON.parse(String(init.body || "{}"));
    if (requestUrl.endsWith("/patty-code/internal/gateway/preflight")) {
      calls.push("preflight");
      return Response.json({
        preflight_ref: "failure-preflight",
        request_id: requestBody.request_id,
        turn_id: "http",
        employee_id: "employee-1",
        device_id: "device-1",
        email: "employee@patty.io",
        harness: "codex",
        usage_identity: "usage-1",
        routing_group: "enterprise",
        public_model: "gpt-5.3-codex",
        route: { target: "openai/gpt-4.1", price_multiplier: 1.25 },
        quota: {
          five_hour: { spend: 5, limit: 25, used_percent: 20, reset_at: 2_000_000_000 },
          seven_day: { spend: 80, limit: 200, used_percent: 40, reset_at: 2_000_500_000 },
        },
      });
    }
    if (requestUrl.endsWith("/patty-code/internal/gateway/settle")) {
      calls.push(`settle:${requestBody.status}`);
      return Response.json({ settled: true, duplicate: false, points: 0 });
    }
    calls.push("provider");
    return Response.json(
      { error: { type: "invalid_request_error", message: "provider rejected request" } },
      { status: 400 }
    );
  };

  try {
    const response = await handleChat(
      buildRequest({
        url: "http://localhost/v1/responses",
        headers: {
          authorization: "Bearer internal-omniroute-key",
          "x-patty-harness": "codex",
          "x-patty-original-authorization": "employee-secret",
          "x-patty-client-ip": "10.0.0.7",
        },
        body: {
          model: "gpt-5.3-codex",
          stream: false,
          input: [{ role: "user", content: "hello" }],
        },
      })
    );

    assert.equal(response.status, 400);
    assert.deepEqual(calls, ["preflight", "provider", "settle:error"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Patty keeps Claude on Anthropic wire shapes while OmniRoute routes the provider model", async () => {
  await seedConnection("openai", { apiKey: "provider-secret" });
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = {
      url: String(url),
      body: JSON.parse(String(init.body || "{}")),
    };
    calls.push(call);
    if (call.url.endsWith("/patty-code/internal/gateway/preflight")) {
      return Response.json({
        preflight_ref: "claude-preflight",
        request_id: call.body.request_id,
        turn_id: "http",
        employee_id: "employee-1",
        device_id: "device-1",
        email: "employee@patty.io",
        harness: "claude",
        usage_identity: "usage-claude",
        routing_group: "enterprise",
        public_model: "claude-fable-5",
        route: { target: "openai/gpt-4.1", price_multiplier: 1 },
        quota: {
          five_hour: { spend: 5, limit: 25, used_percent: 20, reset_at: 2_000_000_000 },
          seven_day: { spend: 80, limit: 200, used_percent: 40, reset_at: 2_000_500_000 },
        },
      });
    }
    if (call.url.endsWith("/patty-code/internal/gateway/settle")) {
      return Response.json({ settled: true, duplicate: false, points: 0.01 });
    }
    return buildOpenAIResponse("Claude-compatible response", "gpt-4.1", {
      prompt_tokens: 12,
      completion_tokens: 3,
      total_tokens: 15,
    });
  };

  try {
    const response = await handleChat(
      buildRequest({
        url: "http://localhost/v1/messages",
        headers: {
          authorization: "Bearer internal-omniroute-key",
          "x-patty-harness": "claude",
          "x-patty-original-authorization": "employee-secret",
          "x-patty-client-ip": "10.0.0.7",
        },
        body: {
          model: "claude-fable-5",
          max_tokens: 256,
          stream: false,
          messages: [{ role: "user", content: "hello" }],
        },
      })
    );
    const body = (await response.json()) as {
      type?: string;
      role?: string;
      model?: string;
      content?: Array<{ type?: string; text?: string }>;
    };

    assert.equal(response.status, 200);
    assert.equal(body.type, "message");
    assert.equal(body.role, "assistant");
    assert.equal(body.model, "claude-fable-5");
    assert.equal(body.content?.[0]?.type, "text");
    assert.equal(body.content?.[0]?.text, "Claude-compatible response");
    assert.equal(response.headers.get("anthropic-ratelimit-unified-5h-utilization"), "0.2");
    assert.equal(calls[1].body.model, "gpt-4.1");
    assert.match(calls[2].url, /gateway\/settle$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
