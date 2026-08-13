import test from "node:test";
import assert from "node:assert/strict";

import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";
import { withInjectionGuard } from "../../src/middleware/promptInjectionGuard.ts";
import {
  applyClaudeMessagesLargeRequestMode,
  compactClaudeMessagesBody,
  estimateClaudeMessagesBodyBytes,
  resolveClaudeLargeMessagesConfig,
} from "../../src/shared/middleware/claudeMessagesVcc.ts";

const harness = await createChatPipelineHarness("claude-large-message-vcc");
const { buildClaudeResponse, buildRequest, handleChat, resetStorage, seedConnection } = harness;

const ORIGINAL_ENV = {
  mode: process.env.OMNIROUTE_CLAUDE_LARGE_MESSAGES_MODE,
  targetBytes: process.env.OMNIROUTE_CLAUDE_LARGE_MESSAGES_TARGET_BYTES,
  maxBytes: process.env.OMNIROUTE_CLAUDE_LARGE_MESSAGES_MAX_BYTES,
};

function restoreEnv() {
  if (ORIGINAL_ENV.mode === undefined) delete process.env.OMNIROUTE_CLAUDE_LARGE_MESSAGES_MODE;
  else process.env.OMNIROUTE_CLAUDE_LARGE_MESSAGES_MODE = ORIGINAL_ENV.mode;
  if (ORIGINAL_ENV.targetBytes === undefined) {
    delete process.env.OMNIROUTE_CLAUDE_LARGE_MESSAGES_TARGET_BYTES;
  } else {
    process.env.OMNIROUTE_CLAUDE_LARGE_MESSAGES_TARGET_BYTES = ORIGINAL_ENV.targetBytes;
  }
  if (ORIGINAL_ENV.maxBytes === undefined)
    delete process.env.OMNIROUTE_CLAUDE_LARGE_MESSAGES_MAX_BYTES;
  else process.env.OMNIROUTE_CLAUDE_LARGE_MESSAGES_MAX_BYTES = ORIGINAL_ENV.maxBytes;
}

function setVccEnv(targetBytes = 650 * 1024) {
  process.env.OMNIROUTE_CLAUDE_LARGE_MESSAGES_MODE = "vcc";
  process.env.OMNIROUTE_CLAUDE_LARGE_MESSAGES_TARGET_BYTES = String(targetBytes);
  process.env.OMNIROUTE_CLAUDE_LARGE_MESSAGES_MAX_BYTES = String(8 * 1024 * 1024);
}

function repeated(label: string, bytes: number): string {
  const prefix = `[${label}] `;
  if (bytes <= prefix.length) return prefix.slice(0, bytes);
  const chunk = `${label.replace(/[^a-z0-9_-]/gi, "_")} `;
  return (
    prefix +
    chunk.repeat(Math.ceil((bytes - prefix.length) / chunk.length)).slice(0, bytes - prefix.length)
  );
}

function buildLargeTool(index: number) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (let field = 0; field < 6; field++) {
    const name = `field_${field}`;
    required.push(name);
    properties[name] = {
      type: "string",
      description: repeated(`tool-${index}-field-${field}`, 2500),
      examples: [repeated(`tool-${index}-example-${field}`, 300)],
    };
  }
  return {
    name: `fixture_large_tool_${index}`,
    description: repeated(`tool-${index}-description`, 8000),
    input_schema: {
      type: "object",
      title: `Fixture Large Tool ${index}`,
      $comment: repeated(`tool-${index}-comment`, 2000),
      properties,
      required,
      additionalProperties: false,
    },
  };
}

function buildLargeClaudeMessagesBody() {
  const body = {
    model: "claude/claude-opus-4-8",
    stream: false,
    max_tokens: 512,
    system: "You are a careful coding assistant.",
    messages: [
      {
        role: "user",
        content: repeated("old-user-context", 280 * 1024),
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: repeated("old-assistant-context", 180 * 1024) },
          {
            type: "tool_use",
            id: "toolu_fixture_0001",
            name: "fixture_large_tool_0",
            input: { field_0: repeated("tool-input", 4096) },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_fixture_0001",
            content: repeated("old-tool-result", 300 * 1024),
          },
        ],
      },
      {
        role: "user",
        content: `LATEST USER REQUEST MARKER\n${repeated("latest-user-context", 70 * 1024)}`,
      },
    ],
    tools: Array.from({ length: 24 }, (_, index) => buildLargeTool(index)),
  };

  assert.ok(
    Buffer.byteLength(JSON.stringify(body), "utf8") > 1024 * 1024,
    "fixture should exceed the current Claude absolute guard"
  );

  return body;
}

test.beforeEach(async () => {
  restoreEnv();
  await resetStorage();
});

test.after(async () => {
  restoreEnv();
  await harness.cleanup();
});

test("resolveClaudeLargeMessagesConfig prefers persisted settings over env fallback", () => {
  const config = resolveClaudeLargeMessagesConfig(
    {
      OMNIROUTE_CLAUDE_LARGE_MESSAGES_MODE: "reject",
      OMNIROUTE_CLAUDE_LARGE_MESSAGES_TARGET_BYTES: "1024",
      OMNIROUTE_CLAUDE_LARGE_MESSAGES_MAX_BYTES: "2048",
    } as NodeJS.ProcessEnv,
    {
      claudeLargeMessagesMode: "vcc",
      claudeLargeMessagesTargetKb: 900,
      claudeLargeMessagesMaxMb: 50,
    }
  );

  assert.equal(config.mode, "vcc");
  assert.equal(config.targetBytes, 900 * 1024);
  assert.equal(config.maxBytes, 50 * 1024 * 1024);
  assert.equal(config.thresholdBytes, 1024 * 1024);
});

test("resolveClaudeLargeMessagesConfig honors settings-driven threshold", () => {
  const config = resolveClaudeLargeMessagesConfig({} as NodeJS.ProcessEnv, {
    claudeLargeMessagesMode: "vcc",
    claudeLargeMessagesThresholdKb: 512,
    claudeLargeMessagesTargetKb: 256,
    claudeLargeMessagesMaxMb: 10,
  });
  assert.equal(config.thresholdBytes, 512 * 1024);
  assert.equal(config.targetBytes, 256 * 1024);
});

test("resolveClaudeLargeMessagesConfig keeps compact env alias for compatibility", () => {
  const config = resolveClaudeLargeMessagesConfig({
    OMNIROUTE_CLAUDE_LARGE_MESSAGES_MODE: "compact",
  } as NodeJS.ProcessEnv);

  assert.equal(config.mode, "vcc");
});

test("applyClaudeMessagesLargeRequestMode rejects oversized requests in reject mode", () => {
  const result = applyClaudeMessagesLargeRequestMode(
    new Request("http://localhost/api/v1/messages", { method: "POST" }),
    "/api/v1/messages",
    buildLargeClaudeMessagesBody(),
    {
      config: {
        mode: "reject",
        thresholdBytes: 1024 * 1024,
        targetBytes: 650 * 1024,
        maxBytes: 8 * 1024 * 1024,
      },
    }
  );

  assert.ok(result.rejection);
  assert.equal(result.compacted, false);
  assert.equal(result.stats, null);
});

test("compactClaudeMessagesBody shrinks an oversized Claude request below target while preserving valid structure", () => {
  const body = buildLargeClaudeMessagesBody();
  const targetBytes = 650 * 1024;

  const result = compactClaudeMessagesBody(body, { targetBytes });
  const compacted = result.body as typeof body;
  const compactedBytes = estimateClaudeMessagesBodyBytes(compacted);

  assert.equal(result.compacted, true);
  assert.ok(compactedBytes <= targetBytes, `expected ${compactedBytes} <= ${targetBytes}`);
  assert.equal(compacted.model, body.model);
  assert.equal(compacted.max_tokens, body.max_tokens);
  assert.equal(compacted.stream, body.stream);
  assert.equal(compacted.tools.length, body.tools.length);
  assert.equal(compacted.tools[0].name, body.tools[0].name);
  assert.deepEqual(compacted.tools[0].input_schema.required, body.tools[0].input_schema.required);
  assert.equal(compacted.tools[0].input_schema.type, "object");
  assert.equal(
    "examples" in (compacted.tools[0].input_schema.properties.field_0 as Record<string, unknown>),
    false,
    "schema examples should be pruned before dropping required shape"
  );
  assert.match(String(compacted.messages.at(-1)?.content), /LATEST USER REQUEST MARKER/);
  const toolResult = (compacted.messages[2].content as Array<Record<string, unknown>>)[0];
  assert.equal(toolResult.tool_use_id, "toolu_fixture_0001");
  assert.match(String(toolResult.content), /truncated/);
});

test("compactClaudeMessagesBody starts recent-tail compaction at a user message", () => {
  const body = {
    model: "claude/claude-opus-4-8",
    max_tokens: 512,
    messages: Array.from({ length: 300 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: repeated(`tail-boundary-${index}`, 2048),
    })),
    tools: Array.from({ length: 24 }, (_, index) => buildLargeTool(index)),
  };

  const result = compactClaudeMessagesBody(body, { targetBytes: 64 * 1024 });
  const compacted = result.body as typeof body;

  assert.equal(result.compacted, true);
  assert.equal(compacted.messages[0].role, "user");
  assert.equal(
    Array.isArray(compacted.messages[0].content) &&
      compacted.messages[0].content.some((part) => part.type === "tool_result"),
    false,
    "tail compaction must not start with an orphan tool_result"
  );
  assert.ok(compacted.messages.length < body.messages.length, "fixture should exercise tail drop");
  assert.ok(estimateClaudeMessagesBodyBytes(compacted) <= 64 * 1024);
});

test("withInjectionGuard compacts oversized Claude messages in VCC mode instead of rejecting", async () => {
  setVccEnv(650 * 1024);
  const payload = buildLargeClaudeMessagesBody();
  const originalBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  const request = new Request("http://localhost/api/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": String(originalBytes) },
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
  let parsedBytes = 0;
  const wrapped = withInjectionGuard(
    async (_request: Request, _context: unknown, preParsedBody: unknown) => {
      innerCalled = true;
      parsedBytes = estimateClaudeMessagesBodyBytes(preParsedBody);
      return Response.json({ ok: true, parsedBytes });
    }
  );

  const response = await wrapped(request, {});
  const json = (await response.json()) as { ok?: boolean; parsedBytes?: number };

  assert.equal(response.status, 200);
  assert.equal(json.ok, true);
  assert.equal(innerCalled, true);
  assert.equal(cloneCount, 0, "Claude messages path should still avoid request.clone()");
  assert.ok(parsedBytes <= 650 * 1024, `expected compacted preParsedBody, got ${parsedBytes}`);
});

test("handleChat sends the compacted Claude Messages body upstream in VCC mode", async () => {
  setVccEnv(650 * 1024);
  await seedConnection("claude", { apiKey: "sk-claude-vcc" });

  const payload = buildLargeClaudeMessagesBody();
  const originalBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  let upstreamCalled = false;
  let upstreamBytes = 0;
  let upstreamBody: Record<string, unknown> | null = null;

  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    upstreamCalled = true;
    upstreamBytes = Buffer.byteLength(String(init?.body ?? ""), "utf8");
    upstreamBody = JSON.parse(String(init?.body ?? "{}"));
    return buildClaudeResponse("ok");
  };

  const response = await handleChat(
    buildRequest({
      url: "http://localhost/v1/messages",
      body: payload,
    })
  );

  assert.equal(response.status, 200);
  assert.equal(upstreamCalled, true);
  assert.ok(
    upstreamBytes < originalBytes,
    `expected upstream body ${upstreamBytes} < ${originalBytes}`
  );
  assert.ok(upstreamBytes <= 650 * 1024, `expected upstream body ${upstreamBytes} <= target`);
  assert.equal((upstreamBody?.tools as unknown[]).length, payload.tools.length);
  assert.match(JSON.stringify(upstreamBody), /LATEST USER REQUEST MARKER/);
});
