import assert from "node:assert/strict";
import test from "node:test";

import {
  createPattySettlementTransform,
  PattyGatewayError,
  isPattyBillingEndpoint,
  pattyHeaders,
  pattyNativeErrorResponse,
  pattyPreflight,
  preparePattyRequest,
  pattySettle,
  pattyTerminalUsageFromUsage,
  type PattyDecision,
  type PattyPreflightInput,
} from "../../../open-sse/services/pattyGateway.ts";

const input: PattyPreflightInput = {
  requestId: "request-1",
  turnId: "http",
  harness: "codex",
  publicModel: "gpt-5.3-codex",
  endpoint: "/v1/responses",
  transport: "sse",
  employeeCredential: "employee-secret",
  accountId: "employee-1",
  sourceAddress: "10.0.0.7",
};

const preflightBody = {
  preflight_ref: "opaque-preflight",
  request_id: "request-1",
  turn_id: "http",
  employee_id: "employee-1",
  device_id: "device-1",
  email: "employee@patty.io",
  harness: "codex",
  usage_identity: "usage-1",
  routing_group: "enterprise",
  public_model: "gpt-5.3-codex",
  route: {
    target: "codex/gpt-5.3-codex",
    price_multiplier: 1.25,
  },
  quota: {
    five_hour: { spend: 5, limit: 25, used_percent: 20, reset_at: 2_000_000_000 },
    seven_day: { spend: 80, limit: 200, used_percent: 40, reset_at: 2_000_500_000 },
  },
};

const env = {
  PATTY_GATEWAY_URL: "http://patty-sidecar:4100",
  PATTY_GATEWAY_TOKEN: "gateway-secret",
};

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function decision(): Promise<PattyDecision> {
  return pattyPreflight(input, {
    env,
    fetchImpl: async () => jsonResponse(preflightBody),
  });
}

test("preflight authenticates internally and binds the returned route to the request", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const result = await pattyPreflight(input, {
    env,
    fetchImpl: async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return jsonResponse(preflightBody);
    },
  });

  assert.equal(capturedUrl, "http://patty-sidecar:4100/patty-code/internal/gateway/preflight");
  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.get("authorization"), "Bearer gateway-secret");
  assert.equal(headers.get("x-patty-client-ip"), "10.0.0.7");
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    request_id: "request-1",
    turn_id: "http",
    harness: "codex",
    public_model: "gpt-5.3-codex",
    endpoint: "/v1/responses",
    transport: "sse",
    credential: "employee-secret",
    account_id: "employee-1",
  });
  assert.equal(result.routedModel, "codex/gpt-5.3-codex");
  assert.equal(result.publicModel, "gpt-5.3-codex");
  assert.equal(result.requestId, "request-1");
  assert.equal(result.turnId, "http");
  assert.equal(JSON.stringify(result).includes("employee-secret"), false);
  assert.equal(JSON.stringify(result).includes("gateway-secret"), false);
});

test("preflight fails closed on timeout and malformed or mismatched decisions", async () => {
  const unavailableFetch: typeof fetch = async (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });

  await assert.rejects(
    () => pattyPreflight(input, { env, fetchImpl: unavailableFetch, timeoutMs: 5 }),
    (error: unknown) =>
      error instanceof PattyGatewayError &&
      error.status === 503 &&
      error.code === "patty_policy_unavailable"
  );

  for (const body of [
    { ...preflightBody, request_id: "other" },
    { ...preflightBody, turn_id: "other" },
    { ...preflightBody, public_model: "other" },
    { ...preflightBody, route: { target: "", price_multiplier: 1 } },
    { ...preflightBody, preflight_ref: "" },
  ]) {
    await assert.rejects(
      () => pattyPreflight(input, { env, fetchImpl: async () => jsonResponse(body) }),
      (error: unknown) =>
        error instanceof PattyGatewayError &&
        error.status === 503 &&
        error.code === "patty_policy_invalid"
    );
  }
});

test("preflight preserves native Patty rejection status without exposing credentials", async () => {
  await assert.rejects(
    () =>
      pattyPreflight(input, {
        env,
        fetchImpl: async () =>
          jsonResponse(
            {
              error: { type: "usage_limit_reached", message: "Patty Code usage limit reached" },
              plan_type: "enterprise",
              resets_at: 2_000_000_000,
            },
            429
          ),
      }),
    (error: unknown) => {
      assert.ok(error instanceof PattyGatewayError);
      assert.equal(error.status, 429);
      assert.equal(error.code, "usage_limit_reached");
      assert.equal(error.message, "Patty Code usage limit reached");
      assert.equal(error.message.includes("employee-secret"), false);
      return true;
    }
  );
});

test("settlement sends terminal usage against the immutable preflight route", async () => {
  const preflight = await decision();
  let captured: Record<string, unknown> | undefined;
  await pattySettle(
    preflight,
    {
      provider: "openai",
      connection: "chatgpt",
      model: "gpt-5.3-codex",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheWriteTokens: 3,
      reasoningTokens: 10,
      status: "success",
      latencyMs: 250,
    },
    {
      env,
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body));
        return jsonResponse({ settled: true, duplicate: false, points: 0.1 });
      },
    }
  );

  assert.deepEqual(captured, {
    preflight_ref: "opaque-preflight",
    request_id: "request-1",
    turn_id: "http",
    route_target: "codex/gpt-5.3-codex",
    provider: "openai",
    connection: "chatgpt",
    model: "gpt-5.3-codex",
    input_tokens: 100,
    output_tokens: 20,
    cache_read_tokens: 5,
    cache_write_tokens: 3,
    reasoning_tokens: 10,
    status: "success",
    latency_ms: 250,
  });
  assert.equal(JSON.stringify(captured).includes("employee-secret"), false);
  assert.equal(JSON.stringify(captured).includes("gateway-secret"), false);
});

test("terminal usage normalizes OmniRoute token fields without double-counting cache", () => {
  assert.deepEqual(
    pattyTerminalUsageFromUsage(
      {
        prompt_tokens: 100,
        completion_tokens: 20,
        cached_tokens: 30,
        cache_creation_input_tokens: 5,
        reasoning_tokens: 7,
      },
      { status: "success", provider: "openai", model: "gpt-4.1", latencyMs: 25 }
    ),
    {
      provider: "openai",
      model: "gpt-4.1",
      inputTokens: 65,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 5,
      reasoningTokens: 7,
      status: "success",
      latencyMs: 25,
    }
  );
});

test("settlement fails closed when Patty does not durably acknowledge it", async () => {
  const preflight = await decision();
  await assert.rejects(
    () =>
      pattySettle(
        preflight,
        { inputTokens: 1, outputTokens: 1, status: "success" },
        { env, fetchImpl: async () => jsonResponse({ settled: false }) }
      ),
    (error: unknown) =>
      error instanceof PattyGatewayError &&
      error.status === 503 &&
      error.code === "patty_settlement_invalid"
  );
});

test("stream settlement withholds the terminal frame until durable acknowledgement", async () => {
  const encoder = new TextEncoder();
  let acknowledged = false;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode('event: response.output_text.delta\ndata: {"delta":"ok"}\n\n')
      );
      controller.enqueue(encoder.encode("event: response.com"));
      controller.enqueue(encoder.encode('pleted\ndata: {"type":"response.completed"}\n\n'));
      controller.close();
    },
  });
  const output = await new Response(
    source.pipeThrough(
      createPattySettlementTransform("codex", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        acknowledged = true;
      })
    )
  ).text();

  assert.equal(acknowledged, true);
  assert.match(output, /response\.output_text\.delta/);
  assert.match(output, /response\.completed/);
});

test("stream settlement failure replaces a success terminal with a native harness error", async () => {
  const encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
      controller.close();
    },
  });
  const output = await new Response(
    source.pipeThrough(
      createPattySettlementTransform("claude", async () => {
        throw new PattyGatewayError(
          503,
          "patty_settlement_unavailable",
          "Patty settlement is unavailable"
        );
      })
    )
  ).text();

  assert.doesNotMatch(output, /patty.*secret/i);
  assert.match(output, /event: error/);
  assert.match(output, /patty_settlement_unavailable/);
  assert.equal((output.match(/event: message_stop/g) || []).length, 1);
});

test("quota headers retain the existing Claude and Codex client contracts", async () => {
  const result = await decision();
  assert.deepEqual(pattyHeaders(result), {
    "anthropic-ratelimit-unified-5h-reset": "2000000000",
    "anthropic-ratelimit-unified-5h-utilization": "0.2",
    "anthropic-ratelimit-unified-7d-reset": "2000500000",
    "anthropic-ratelimit-unified-7d-utilization": "0.4",
    "anthropic-ratelimit-unified-representative-claim": "seven_day",
    "anthropic-ratelimit-unified-reset": "2000500000",
    "x-codex-primary-reset-at": "2000000000",
    "x-codex-primary-used-percent": "20",
    "x-codex-primary-window-minutes": "300",
    "x-codex-secondary-reset-at": "2000500000",
    "x-codex-secondary-used-percent": "40",
    "x-codex-secondary-window-minutes": "10080",
  });
});

test("native errors preserve Anthropic and Codex response shapes", async () => {
  const error = new PattyGatewayError(429, "usage_limit_reached", "Patty limit reached", {
    resetAt: 2_000_000_000,
  });
  const claude = pattyNativeErrorResponse("claude", error);
  const codex = pattyNativeErrorResponse("codex", error);

  assert.equal(claude.status, 429);
  assert.deepEqual(await claude.json(), {
    type: "error",
    error: { type: "usage_limit_reached", message: "Patty limit reached" },
  });
  assert.equal(codex.status, 429);
  assert.deepEqual(await codex.json(), {
    error: { type: "usage_limit_reached", message: "Patty limit reached" },
    plan_type: "enterprise",
    resets_at: 2_000_000_000,
  });
});

test("catalog and token-count endpoints remain non-billing", () => {
  assert.equal(isPattyBillingEndpoint("/v1/messages"), true);
  assert.equal(isPattyBillingEndpoint("/v1/responses"), true);
  assert.equal(isPattyBillingEndpoint("/v1/models"), false);
  assert.equal(isPattyBillingEndpoint("/v1/messages/count_tokens"), false);
});

test("request preparation replaces only the routed model and preserves client instructions", async () => {
  const body = {
    model: "gpt-5.3-codex",
    instructions: "Keep this employee instruction exactly",
    input: [{ role: "user", content: "hello" }],
    stream: true,
  };
  const request = new Request("https://chatgpt.com/v1/responses", {
    method: "POST",
    headers: {
      "x-patty-harness": "codex",
      "x-patty-original-authorization": "employee-secret",
      "x-patty-client-ip": "10.0.0.7",
      "x-patty-account-id": "employee-1",
      accept: "text/event-stream",
    },
    body: JSON.stringify(body),
  });

  const prepared = await preparePattyRequest(request, body, "request-1", {
    env,
    fetchImpl: async () => jsonResponse(preflightBody),
  });

  assert.equal(prepared.decision?.routedModel, "codex/gpt-5.3-codex");
  assert.deepEqual(prepared.body, {
    ...body,
    model: "codex/gpt-5.3-codex",
  });
  assert.equal(prepared.body.instructions, body.instructions);
  assert.deepEqual(prepared.body.input, body.input);
  assert.equal(body.model, "gpt-5.3-codex", "the caller-owned body is not mutated");
});

test("request preparation is disabled only when both Patty settings are absent", async () => {
  const body = { model: "gpt-5.3-codex", input: [{ role: "user", content: "hello" }] };
  const request = new Request("https://chatgpt.com/v1/responses", {
    method: "POST",
    headers: { "x-patty-harness": "codex" },
    body: JSON.stringify(body),
  });
  const disabled = await preparePattyRequest(request, body, "request-1", { env: {} });
  assert.equal(disabled.body, body);
  assert.equal(disabled.decision, null);

  await assert.rejects(
    () =>
      preparePattyRequest(request, body, "request-1", {
        env: { PATTY_GATEWAY_URL: env.PATTY_GATEWAY_URL },
      }),
    (error: unknown) =>
      error instanceof PattyGatewayError && error.code === "patty_policy_unavailable"
  );
});

test("request preparation rejects a trusted-harness mismatch before policy lookup", async () => {
  const request = new Request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-patty-harness": "codex",
      "x-patty-client-ip": "10.0.0.7",
    },
    body: JSON.stringify({ model: "claude-fable-5", messages: [] }),
  });
  await assert.rejects(
    () =>
      preparePattyRequest(request, { model: "claude-fable-5", messages: [] }, "request-1", { env }),
    (error: unknown) =>
      error instanceof PattyGatewayError && error.code === "patty_harness_mismatch"
  );
});
