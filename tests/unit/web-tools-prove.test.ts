// Proof: the canonical web-provider pipeline works end-to-end for ALL
// web-cookie providers (chatgpt-web, qwen-web, gemini-web, huggingchat — they
// all call these same functions). Request side serializes OpenAI `tools` into a
// prompt contract; response side decodes explicit <tool_call>{...}</tool_call> blocks back into
// OpenAI tool_calls.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  prepareWebToolRequest,
  decodeWebToolResponse,
} from "../../open-sse/services/webProvider/toolPipeline.ts";
import { buildWebToolContract } from "../../open-sse/services/webProvider/toolContract.ts";

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file from disk",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  },
];

describe("web-provider pipeline: request serialization", () => {
  it("buildWebToolContract embeds the tool name + description in the contract", () => {
    const contract = buildWebToolContract(TOOLS);
    assert.match(contract, /read_file/, "tool name must appear in the contract");
    assert.match(contract, /Read a file from disk/, "description must appear");
  });

  it("prepareWebToolRequest injects the contract as a leading system message", () => {
    const body = { tools: TOOLS };
    const messages = [{ role: "user", content: "read /tmp/x" }];
    const { hasTools, effectiveMessages } = prepareWebToolRequest(body, messages);
    assert.equal(hasTools, true);
    assert.equal(effectiveMessages[0].role, "system");
    assert.match(String(effectiveMessages[0].content), /read_file/);
  });
});

describe("web-provider pipeline: response decoding", () => {
  it("parses an explicit tool envelope into a tool_call with finish_reason=tool_calls", () => {
    const modelOutput = `<tool_call>{"name":"read_file","arguments":{"path":"/tmp/x"}}</tool_call>`;
    const { content, toolCalls, finishReason } = decodeWebToolResponse(modelOutput, TOOLS, "test");
    assert.equal(finishReason, "tool_calls");
    assert.ok(toolCalls, "toolCalls must be produced");
    assert.equal(toolCalls[0].function.name, "read_file");
    const args = JSON.parse(toolCalls[0].function.arguments);
    assert.equal(args.path, "/tmp/x");
    assert.equal(content, "", "the tool block is stripped from plain content");
  });

  it("returns plain content with finish_reason=stop when no tool block is present", () => {
    const modelOutput = "Just a normal answer with no tool call.";
    const { content, toolCalls, finishReason } = decodeWebToolResponse(modelOutput, TOOLS, "test");
    assert.equal(finishReason, "stop");
    assert.equal(toolCalls, null);
    assert.equal(content, modelOutput);
  });

  it("handles prose around the tool block (keeps the text, extracts the call)", () => {
    const modelOutput =
      'I\'ll read that file for you.\n<tool_call>{"name":"read_file","arguments":{"path":"/etc/hosts"}}</tool_call>\nLet me know.';
    const { content, toolCalls, finishReason } = decodeWebToolResponse(modelOutput, TOOLS, "test");
    assert.equal(finishReason, "tool_calls");
    assert.ok(toolCalls);
    assert.equal(toolCalls[0].function.name, "read_file");
    assert.match(content, /I'll read that file for you/);
  });
});

describe("web-provider pipeline: provider parity", () => {
  // chatgpt-web, qwen-web, gemini-web, huggingchat all wire decodeWebToolResponse
  // with their idSeed. Prove each idSeed yields a valid tool_call id prefix.
  for (const provider of ["chatgpt-web", "qwen-web", "gemini-web", "huggingchat"]) {
    it(`${provider}: produces a valid tool_call under its idSeed`, () => {
      const out = decodeWebToolResponse(
        `<tool_call>{"name":"read_file","arguments":{"path":"/x"}}</tool_call>`,
        TOOLS,
        provider
      );
      assert.equal(out.finishReason, "tool_calls");
      assert.ok(out.toolCalls?.[0].id.startsWith(provider));
      assert.equal(out.toolCalls[0].function.name, "read_file");
    });
  }
});
