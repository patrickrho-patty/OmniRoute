// #2820 — tool-call translation for web-cookie providers (deepseek-web first).
// The web UIs accept only a plain prompt string and reply with tool invocations as
// raw text. These pure helpers (a) serialize the OpenAI `tools` array into a
// system-prompt contract, and (b) decode explicit upstream `<tool_call>{...}</tool_call>` text back
// into OpenAI `tool_calls`.
import test from "node:test";
import assert from "node:assert/strict";

const { buildWebToolContract } =
  await import("../../open-sse/services/webProvider/toolContract.ts");
const { decodeExplicitWebToolCalls } =
  await import("../../open-sse/services/webProvider/toolDecoder.ts");

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the current weather for a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  },
];

test("buildWebToolContract lists the tool and the explicit invocation contract", () => {
  const prompt = buildWebToolContract(TOOLS);
  assert.ok(prompt.includes("get_weather"), "tool name present");
  assert.ok(prompt.includes("Get the current weather"), "tool description present");
  assert.ok(prompt.includes("<tool_call>"), "invocation contract mentions the tool-call tag");
});

test("buildWebToolContract returns empty string for no tools", () => {
  assert.equal(buildWebToolContract([]), "");
  assert.equal(buildWebToolContract(undefined), "");
});

test("decodeExplicitWebToolCalls extracts a single tool call and strips it from content", () => {
  const text =
    'Sure, let me check.\n<tool>{"name": "get_weather", "arguments": {"city": "Paris"}}</tool>';
  const { content, toolCalls } = decodeExplicitWebToolCalls(text);
  assert.ok(toolCalls && toolCalls.length === 1, "one tool call parsed");
  assert.equal(toolCalls[0].type, "function");
  assert.equal(toolCalls[0].function.name, "get_weather");
  // OpenAI tool_calls arguments is a JSON *string*.
  assert.equal(typeof toolCalls[0].function.arguments, "string");
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), { city: "Paris" });
  assert.ok(toolCalls[0].id, "tool call has an id");
  assert.ok(!content.includes("<tool>"), "the raw block is stripped from content");
  assert.ok(content.includes("Sure, let me check."), "surrounding text preserved");
});

test("decodeExplicitWebToolCalls returns null toolCalls when there is no tool block", () => {
  const { content, toolCalls } = decodeExplicitWebToolCalls("just a normal answer");
  assert.equal(toolCalls, null);
  assert.equal(content, "just a normal answer");
});

test("decodeExplicitWebToolCalls decodes bare whole-body JSON but not fuzzy names", () => {
  const text = '{"name":"get_weather","arguments":{"city":"Paris"}}';
  const typo = '<tool_call>{"name":"getWeather","arguments":{"city":"Paris"}}</tool_call>';
  // ChatGPT often skips the fence — a reply that IS one bare JSON call decodes.
  const { content, toolCalls } = decodeExplicitWebToolCalls(text, "call", TOOLS, {
    fences: true,
  });
  assert.equal(content, "");
  assert.deepEqual(toolCalls?.[0], {
    id: "call_0",
    type: "function",
    function: { name: "get_weather", arguments: '{"city":"Paris"}' },
  });
  // Fuzzy/undeclared names are never inferred.
  assert.equal(decodeExplicitWebToolCalls(typo, "call", TOOLS).toolCalls, null);
});

test("decodeExplicitWebToolCalls parses multiple tool calls", () => {
  const text =
    '<tool>{"name": "a", "arguments": {"x": 1}}</tool>\n<tool>{"name": "b", "arguments": {}}</tool>';
  const { toolCalls } = decodeExplicitWebToolCalls(text);
  assert.equal(toolCalls?.length, 2);
  assert.equal(toolCalls[0].function.name, "a");
  assert.equal(toolCalls[1].function.name, "b");
});

test("decodeExplicitWebToolCalls tolerates a tool block with no arguments", () => {
  const { toolCalls } = decodeExplicitWebToolCalls('<tool>{"name": "ping"}</tool>');
  assert.equal(toolCalls?.length, 1);
  assert.equal(toolCalls[0].function.name, "ping");
  assert.equal(toolCalls[0].function.arguments, "{}");
});
