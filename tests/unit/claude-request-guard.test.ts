import test from "node:test";
import assert from "node:assert/strict";

import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

import { withInjectionGuard } from "../../src/middleware/promptInjectionGuard.ts";

const harness = await createChatPipelineHarness("claude-request-guard");
const {
  buildClaudeResponse,
  buildOpenAIResponse,
  buildRequest,
  handleChat,
  resetStorage,
  seedConnection,
} = harness;

function buildTool(index: number) {
  return {
    name: `tool_${index}`,
    description: `Tool ${index} ${"x".repeat(7000)}`,
    input_schema: {
      type: "object",
      properties: {
        payload: {
          type: "string",
          description: "y".repeat(1200),
        },
      },
      required: ["payload"],
    },
  };
}

function buildOversizedClaudeBody() {
  const body = {
    model: "claude/claude-opus-4-8",
    stream: false,
    max_tokens: 256,
    system: "You are a careful coding assistant.",
    messages: [
      {
        role: "user",
        content: "z".repeat(360 * 1024),
      },
    ],
    tools: Array.from({ length: 24 }, (_, index) => buildTool(index)),
  };

  assert.ok(
    JSON.stringify(body).length > 512 * 1024,
    "test fixture must exceed the large-request guard threshold"
  );

  return body;
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await harness.cleanup();
});

test("tool-heavy oversized Claude-format requests are rejected before upstream execution", async () => {
  await seedConnection("claude", { apiKey: "sk-claude-guard" });

  let upstreamCalled = false;
  globalThis.fetch = async () => {
    upstreamCalled = true;
    return buildClaudeResponse("should not be called");
  };

  for (const url of ["http://localhost/v1/messages", "http://localhost/api/v1/messages"]) {
    const response = await handleChat(
      buildRequest({
        url,
        body: buildOversizedClaudeBody(),
      })
    );

    assert.equal(response.status, 413);
    const json = (await response.json()) as {
      error?: { message?: string; code?: string };
    };
    assert.equal(json.error?.code, "PAYLOAD_TOO_LARGE");
    assert.match(json.error?.message ?? "", /too large/i);
    assert.match(json.error?.message ?? "", /tool/i);
  }

  assert.equal(upstreamCalled, false, "oversized requests must be rejected before upstream fetch");
});

test("smaller Claude-format requests with tools still route normally", async () => {
  await seedConnection("claude", { apiKey: "sk-claude-ok" });

  let upstreamCalled = false;
  globalThis.fetch = async () => {
    upstreamCalled = true;
    return buildClaudeResponse("ok");
  };

  const response = await handleChat(
    buildRequest({
      url: "http://localhost/v1/messages",
      body: {
        model: "claude/claude-haiku-4-5",
        stream: false,
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        tools: Array.from({ length: 4 }, (_, index) => buildTool(index)),
      },
    })
  );

  assert.equal(response.status, 200);
  assert.equal(upstreamCalled, true, "valid requests should still reach upstream");
});

test("withInjectionGuard rejects oversized Claude messages without cloning or calling inner handler", async () => {
  const payload = buildOversizedClaudeBody();
  const request = new Request("http://localhost/api/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  let cloneCount = 0;
  const originalClone = request.clone.bind(request);
  Object.defineProperty(request, "clone", {
    value: () => {
      cloneCount++;
      return originalClone();
    },
    writable: true,
  });

  let innerCalled = false;
  const wrapped = withInjectionGuard(async () => {
    innerCalled = true;
    return new Response("should not be called");
  });

  const response = await wrapped(request, {});
  const body = (await response.json()) as { error?: { code?: string } };

  assert.equal(response.status, 413);
  assert.equal(body.error?.code, "PAYLOAD_TOO_LARGE");
  assert.equal(cloneCount, 0, "Claude messages guard should consume the original request once");
  assert.equal(innerCalled, false, "oversized requests should not reach the route handler");
});

test("tool-heavy oversized requests on non-Claude routes are not blocked by the Claude guard", async () => {
  await seedConnection("openai", { apiKey: "sk-openai-ok" });

  let upstreamCalled = false;
  globalThis.fetch = async () => {
    upstreamCalled = true;
    return buildOpenAIResponse("ok");
  };

  const oversizedBody = buildOversizedClaudeBody();
  const response = await handleChat(
    buildRequest({
      url: "http://localhost/v1/chat/completions",
      body: {
        ...oversizedBody,
        model: "openai/gpt-4.1",
      },
    })
  );

  assert.equal(response.status, 200);
  assert.equal(
    upstreamCalled,
    true,
    "non-Claude routes should not be rejected by the Claude guard"
  );
});
