import test from "node:test";
import assert from "node:assert/strict";
import * as bodySizeGuard from "../../src/shared/middleware/bodySizeGuard.ts";
import {
  MAX_BODY_BYTES_AUDIO,
  MAX_BODY_BYTES_FILE,
  CLAUDE_MESSAGES_ROUTE,
  CLAUDE_MESSAGES_ABSOLUTE_MAX_BYTES,
  CLAUDE_MESSAGES_TOOL_HEAVY_MAX_BYTES,
  MAX_BODY_BYTES_IMAGE_EDIT,
  MAX_BODY_BYTES_LLM_API,
  RequestBodyTooLargeError,
  readRequestBodyWithLimit,
  getBodySizeLimit,
  checkBodySize,
  checkClaudeMessagesBodySize,
  isClaudeMessagesPath,
} from "../../src/shared/middleware/bodySizeGuard.ts";
import { requestBodyLimitMbToBytes } from "../../src/shared/constants/bodySize.ts";

test("body size guard public surface excludes the removed default MB helper", () => {
  assert.equal(Object.hasOwn(bodySizeGuard, "getDefaultRequestBodyLimitMb"), false);
  assert.equal(typeof bodySizeGuard.getBodySizeLimit, "function");
  assert.equal(typeof bodySizeGuard.checkBodySize, "function");
});

test("body size guard uses maxBodySizeMb from settings for regular API routes", () => {
  assert.equal(
    getBodySizeLimit("/api/v1/responses", { maxBodySizeMb: 100 }),
    requestBodyLimitMbToBytes(100)
  );
});

test("body size guard keeps dedicated upload limits as lower bounds", () => {
  assert.equal(
    getBodySizeLimit("/api/v1/responses", { maxBodySizeMb: 10 }),
    MAX_BODY_BYTES_LLM_API
  );
  assert.equal(
    getBodySizeLimit("/api/v1/chat/completions", { maxBodySizeMb: 10 }),
    MAX_BODY_BYTES_LLM_API
  );
  assert.equal(
    getBodySizeLimit("/api/v1/audio/transcriptions", { maxBodySizeMb: 1 }),
    MAX_BODY_BYTES_AUDIO
  );
  assert.equal(
    getBodySizeLimit("/api/v1/audio/transcriptions", { maxBodySizeMb: 200 }),
    requestBodyLimitMbToBytes(200)
  );
  assert.equal(
    getBodySizeLimit("/api/v1/images/edits", { maxBodySizeMb: 10 }),
    MAX_BODY_BYTES_IMAGE_EDIT
  );
});

test("/api/v1/images/edits admits a 20 MiB image in multipart or base64 JSON envelopes", () => {
  const multipartBytes = 20 * 1024 * 1024 + 1024 * 1024;
  const base64JsonBytes = Math.ceil((20 * 1024 * 1024 * 4) / 3) + 1024;
  for (const bytes of [multipartBytes, base64JsonBytes]) {
    const request = new Request("http://localhost/api/v1/images/edits", {
      method: "POST",
      headers: { "content-length": String(bytes) },
    });
    assert.equal(checkBodySize(request, getBodySizeLimit("/api/v1/images/edits")), null);
  }
});

test("bounded body reader enforces actual bytes when Content-Length is absent", async () => {
  const request = new Request("http://localhost/api/v1/images/edits", {
    method: "POST",
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
        controller.close();
      },
    }),
    // Node requires this for a streamed request body; no Content-Length is supplied.
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  await assert.rejects(
    () => readRequestBodyWithLimit(request, 5),
    (err: unknown) => err instanceof RequestBodyTooLargeError && err.limit === 5
  );
});

test("bounded body reader rejects a dishonest small Content-Length by actual byte count", async () => {
  const request = new Request("http://localhost/api/v1/images/edits", {
    method: "POST",
    headers: { "content-length": "1" },
    body: new Uint8Array([1, 2, 3, 4]),
  });

  await assert.rejects(() => readRequestBodyWithLimit(request, 3), RequestBodyTooLargeError);
});

test("checkBodySize reports the configured request limit in 413 responses", async () => {
  const limit = requestBodyLimitMbToBytes(100);
  const request = new Request("http://localhost/api/v1/responses", {
    method: "POST",
    headers: { "content-length": String(limit + 1) },
  });

  const response = checkBodySize(request, limit);

  assert.ok(response);
  assert.equal(response.status, 413);
  const body = await response.json();
  assert.equal(body.error.code, "PAYLOAD_TOO_LARGE");
  assert.match(body.error.message, /100 MB/);
});

test("/api/v1/responses route guard allows 15 MB agent payloads by default", () => {
  const fifteenMb = 15 * 1024 * 1024;
  const request = new Request("http://localhost/api/v1/responses", {
    method: "POST",
    headers: { "content-length": String(fifteenMb) },
  });

  assert.equal(checkBodySize(request, getBodySizeLimit("/api/v1/responses")), null);
});

test("/api/v1/responses route guard rejects payloads above the LLM API floor", async () => {
  const tooBig = MAX_BODY_BYTES_LLM_API + 1;
  const request = new Request("http://localhost/api/v1/responses", {
    method: "POST",
    headers: { "content-length": String(tooBig) },
  });

  const response = checkBodySize(request, getBodySizeLimit("/api/v1/responses"));

  assert.ok(response);
  assert.equal(response.status, 413);
  const body = await response.json();
  assert.equal(body.error.code, "PAYLOAD_TOO_LARGE");
  assert.match(body.error.message, /50 MB/);
});

test("/api/v1/files route has 512 MB dedicated limit floor", () => {
  const limit = getBodySizeLimit("/api/v1/files", { maxBodySizeMb: 1 });
  assert.equal(limit, MAX_BODY_BYTES_FILE);
});

test("/api/v1/files route guard allows 500 MB file upload", () => {
  const thirtyMb = 500 * 1024 * 1024;
  const request = new Request("http://localhost/api/v1/files", {
    method: "POST",
    headers: { "content-length": String(thirtyMb) },
  });
  assert.equal(
    checkBodySize(request, getBodySizeLimit("/api/v1/files", { maxBodySizeMb: 10 })),
    null
  );
});

test("/api/v1/files route guard rejects >512 MB file upload", async () => {
  const tooBig = 600 * 1024 * 1024;
  const request = new Request("http://localhost/api/v1/files", {
    method: "POST",
    headers: { "content-length": String(tooBig) },
  });
  const response = checkBodySize(request, getBodySizeLimit("/api/v1/files", { maxBodySizeMb: 10 }));
  assert.ok(response);
  assert.equal(response.status, 413);
  const body = await response.json();
  assert.equal(body.error.code, "PAYLOAD_TOO_LARGE");
});

test("/api/v1/files route guard allows 15 MB (10 MB+ real-world scenario)", () => {
  const fifteenMb = 15 * 1024 * 1024;
  const request = new Request("http://localhost/api/v1/files", {
    method: "POST",
    headers: { "content-length": String(fifteenMb) },
  });
  assert.equal(checkBodySize(request, getBodySizeLimit("/api/v1/files")), null);
});

test("isClaudeMessagesPath accepts root and direct API Claude messages routes", () => {
  assert.equal(isClaudeMessagesPath("/v1/messages"), true);
  assert.equal(isClaudeMessagesPath("/api/v1/messages"), true);
  assert.equal(isClaudeMessagesPath("/v1/chat/completions"), false);
  assert.equal(isClaudeMessagesPath("/api/v1/responses/foo/v1/messages"), false);
});

test("Claude messages body guard rejects oversized requests without tools", async () => {
  const response = checkClaudeMessagesBodySize(
    new Request(`http://localhost${CLAUDE_MESSAGES_ROUTE}`, { method: "POST" }),
    CLAUDE_MESSAGES_ROUTE,
    {
      model: "claude/claude-opus-4-8",
      messages: [{ role: "user", content: "x".repeat(1100 * 1024) }],
    }
  );

  assert.ok(response);
  assert.equal(response.status, 413);
  const body = await response.json();
  assert.equal(body.error.code, "PAYLOAD_TOO_LARGE");
  assert.match(body.error.message, /maximum allowed: 1 mb/i);
});

test("Claude messages body guard also covers direct /api/v1/messages routes", async () => {
  const response = checkClaudeMessagesBodySize(
    new Request("http://localhost/api/v1/messages", { method: "POST" }),
    "/api/v1/messages",
    {
      model: "claude/claude-opus-4-8",
      messages: [{ role: "user", content: "x".repeat(1100 * 1024) }],
    }
  );

  assert.ok(response);
  assert.equal(response.status, 413);
});

test("Claude messages body guard ignores non-Claude routes", () => {
  const response = checkClaudeMessagesBodySize(
    new Request("http://localhost/v1/chat/completions", { method: "POST" }),
    "/v1/chat/completions",
    {
      model: "openai/gpt-4.1",
      messages: [{ role: "user", content: "x".repeat(1100 * 1024) }],
      tools: Array.from({ length: 24 }, () => ({ name: "tool" })),
    }
  );

  assert.equal(response, null);
});

test("Claude messages body guard rejects parsed body even when content-length is understated", async () => {
  const response = checkClaudeMessagesBodySize(
    new Request(`http://localhost${CLAUDE_MESSAGES_ROUTE}`, {
      method: "POST",
      headers: { "content-length": "1" },
    }),
    CLAUDE_MESSAGES_ROUTE,
    {
      model: "claude/claude-opus-4-8",
      messages: [{ role: "user", content: "x".repeat(1100 * 1024) }],
    }
  );

  assert.ok(response);
  assert.equal(response.status, 413);
});

test("Claude messages body guard counts UTF-8 bytes for non-ASCII payloads", async () => {
  const response = checkClaudeMessagesBodySize(
    new Request(`http://localhost${CLAUDE_MESSAGES_ROUTE}`, { method: "POST" }),
    CLAUDE_MESSAGES_ROUTE,
    {
      model: "claude/claude-opus-4-8",
      messages: [{ role: "user", content: "한".repeat(400 * 1024) }],
    }
  );

  assert.ok(response);
  assert.equal(response.status, 413);
});

test("Claude messages body guard counts object keys for schema-heavy payloads", async () => {
  const keyHeavySchema = Object.fromEntries(
    Array.from({ length: 6_000 }, (_, index) => [`field_${index}_${"x".repeat(200)}`, ""])
  );

  const response = checkClaudeMessagesBodySize(
    new Request(`http://localhost${CLAUDE_MESSAGES_ROUTE}`, { method: "POST" }),
    CLAUDE_MESSAGES_ROUTE,
    {
      model: "claude/claude-opus-4-8",
      messages: [{ role: "user", content: "small" }],
      metadata: keyHeavySchema,
    }
  );

  assert.ok(response);
  assert.equal(response.status, 413);
});

test("Claude messages body guard rejects declared content-length for tool-heavy requests", async () => {
  const response = checkClaudeMessagesBodySize(
    new Request(`http://localhost${CLAUDE_MESSAGES_ROUTE}`, {
      method: "POST",
      headers: { "content-length": String(CLAUDE_MESSAGES_TOOL_HEAVY_MAX_BYTES + 1) },
    }),
    CLAUDE_MESSAGES_ROUTE,
    {
      model: "claude/claude-opus-4-8",
      messages: [{ role: "user", content: "small" }],
      tools: Array.from({ length: 20 }, (_, index) => ({ name: `tool_${index}` })),
    }
  );

  assert.ok(response);
  assert.equal(response.status, 413);
});

test("Claude messages body guard allows exact declared thresholds", () => {
  const absoluteResponse = checkClaudeMessagesBodySize(
    new Request(`http://localhost${CLAUDE_MESSAGES_ROUTE}`, {
      method: "POST",
      headers: { "content-length": String(CLAUDE_MESSAGES_ABSOLUTE_MAX_BYTES) },
    }),
    CLAUDE_MESSAGES_ROUTE,
    {
      model: "claude/claude-opus-4-8",
      messages: [{ role: "user", content: "small" }],
    }
  );

  const toolHeavyResponse = checkClaudeMessagesBodySize(
    new Request(`http://localhost${CLAUDE_MESSAGES_ROUTE}`, {
      method: "POST",
      headers: { "content-length": String(CLAUDE_MESSAGES_TOOL_HEAVY_MAX_BYTES) },
    }),
    CLAUDE_MESSAGES_ROUTE,
    {
      model: "claude/claude-opus-4-8",
      messages: [{ role: "user", content: "small" }],
      tools: Array.from({ length: 20 }, (_, index) => ({ name: `tool_${index}` })),
    }
  );

  assert.equal(absoluteResponse, null);
  assert.equal(toolHeavyResponse, null);
});
