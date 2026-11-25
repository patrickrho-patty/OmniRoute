import test from "node:test";
import assert from "node:assert/strict";

import {
  echoModelInObject,
  echoModelInSseLine,
  createModelEchoTransform,
} from "../../open-sse/services/responseModelEcho.ts";

// #1311: echo the requested alias/combo name back in the response model field so strict
// clients (Claude Desktop) that validate response.model === request.model stop 401-ing.

test("echoModelInObject rewrites a string model field", () => {
  const obj = { id: "x", model: "gpt-5.5", choices: [] };
  echoModelInObject(obj, "claude-sonnet-cx");
  assert.equal(obj.model, "claude-sonnet-cx");
});

test("echoModelInObject is a no-op when echoModel is falsy or model is absent", () => {
  const a = { model: "gpt-5.5" };
  echoModelInObject(a, null);
  assert.equal(a.model, "gpt-5.5");
  const b = { id: "x" } as Record<string, unknown>;
  echoModelInObject(b, "alias");
  assert.equal(b.model, undefined);
});

test("echoModelInSseLine rewrites a data chunk and leaves [DONE]/comments alone", () => {
  assert.equal(
    echoModelInSseLine('data: {"id":"1","model":"gpt-5.5","choices":[]}', "claude-sonnet-cx"),
    'data: {"id":"1","model":"claude-sonnet-cx","choices":[]}'
  );
  assert.equal(echoModelInSseLine("data: [DONE]", "claude-sonnet-cx"), "data: [DONE]");
  assert.equal(echoModelInSseLine(": keep-alive", "claude-sonnet-cx"), ": keep-alive");
  assert.equal(echoModelInSseLine("", "claude-sonnet-cx"), "");
});

test("createModelEchoTransform rewrites model across a streamed SSE response", async () => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const input = new ReadableStream({
    start(controller) {
      // split a frame across two chunks to exercise the cross-boundary buffer
      controller.enqueue(enc.encode('data: {"id":"1","model":"gpt-'));
      controller.enqueue(enc.encode('5.5","choices":[{"delta":{"content":"hi"}}]}\n\n'));
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  const out = input.pipeThrough(createModelEchoTransform("claude-sonnet-cx"));
  let text = "";
  for await (const chunk of out as unknown as AsyncIterable<Uint8Array>) {
    text += dec.decode(chunk, { stream: true });
  }
  assert.ok(text.includes('"model":"claude-sonnet-cx"'), text);
  assert.ok(!text.includes("gpt-5.5"), "upstream model name must be gone");
  assert.ok(text.includes("data: [DONE]"), "DONE sentinel preserved");
  assert.ok(text.includes('"content":"hi"'), "content preserved");
});

test("createModelEchoTransform with no echoModel passes bytes through unchanged", async () => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const input = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode('data: {"model":"gpt-5.5"}\n\n'));
      controller.close();
    },
  });
  const out = input.pipeThrough(createModelEchoTransform(null));
  let text = "";
  for await (const chunk of out as unknown as AsyncIterable<Uint8Array>) {
    text += dec.decode(chunk, { stream: true });
  }
  assert.ok(text.includes('"model":"gpt-5.5"'));
});

// ── Anthropic Messages (`/v1/messages`) streaming ──────────────────────────────
// `message_start` is the only event that carries the model, and it nests it under
// `message.model`. Before this case was covered, `HIDE_UPSTREAM_METADATA` + the
// echo setting left the upstream id visible to every Claude Code / Claude Desktop
// stream: the flag redacted headers and combo failures, but the response body still
// named the provider's model.

/** The exact payload shape `openaiToClaudeResponse` emits for `message_start`. */
function messageStartLine(model: string): string {
  return `data: ${JSON.stringify({
    type: "message_start",
    message: {
      id: "msg_probe",
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })}`;
}

test("echoModelInObject rewrites the nested Anthropic message.model", () => {
  const payload = {
    type: "message_start",
    message: { id: "msg_1", type: "message", role: "assistant", model: "deepseek-v4.1-flash" },
  };
  echoModelInObject(payload, "claude-opus-5.5");
  assert.equal(payload.message.model, "claude-opus-5.5");
});

test("echoModelInObject leaves an unrelated message.model alone", () => {
  // Only an Anthropic message container may be rewritten — a payload that merely
  // happens to hold a `message.model` must pass through untouched.
  const payload = { id: "x", message: { model: "deepseek-v4.1-flash" } } as Record<string, unknown>;
  echoModelInObject(payload, "claude-opus-5.5");
  assert.equal((payload.message as { model: string }).model, "deepseek-v4.1-flash");
});

test("echoModelInSseLine rewrites an Anthropic message_start line", () => {
  const out = echoModelInSseLine(messageStartLine("MiniMax-M3.1-Flash"), "claude-opus-5.5");
  assert.ok(out.includes('"model":"claude-opus-5.5"'), out);
  assert.ok(!out.includes("MiniMax-M3.1-Flash"), "upstream model must be gone");
  assert.equal(JSON.parse(out.slice(5)).message.type, "message", "message shape preserved");
});

test("createModelEchoTransform rewrites a Claude-format stream end to end", async () => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const input = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(`${messageStartLine("deepseek-v4.1-flash")}\n\n`));
      controller.enqueue(
        enc.encode(
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n'
        )
      );
      controller.close();
    },
  });
  const out = input.pipeThrough(createModelEchoTransform("claude-opus-5.5"));
  let text = "";
  for await (const chunk of out as unknown as AsyncIterable<Uint8Array>) {
    text += dec.decode(chunk, { stream: true });
  }
  assert.ok(text.includes('"model":"claude-opus-5.5"'), text);
  assert.ok(!text.includes("deepseek"), `upstream id leaked: ${text}`);
  assert.ok(text.includes('"text":"hi"'), "delta preserved");
});
