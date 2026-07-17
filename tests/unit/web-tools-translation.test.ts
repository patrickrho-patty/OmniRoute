import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  prepareWebToolRequest,
  decodeWebToolResponse,
} from "../../open-sse/services/webProvider/toolPipeline.ts";
import { buildWebToolContract } from "../../open-sse/services/webProvider/toolContract.ts";
import { decodeExplicitWebToolCalls } from "../../open-sse/services/webProvider/toolDecoder.ts";
import { detectWebToolExcuse } from "../../open-sse/services/webProvider/excuseGuard.ts";
import { buildWebToolContractFingerprint } from "../../open-sse/services/webProvider/toolFingerprint.ts";

// Regression coverage for the shared web-cookie tool-call translation helpers
// (#3259). These functions back tool-calling for the 8 pure-API web executors
// (adapta-web, blackbox-web, duckduckgo-web, inner-ai, muse-spark-web,
// perplexity-web, qwen-web, t3-chat-web), so the translation contract must hold.

const WEATHER_TOOL = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the weather for a city",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    },
  },
];

describe("web-provider tool contract", () => {
  test("returns empty string when there are no tools", () => {
    assert.equal(buildWebToolContract([]), "");
    assert.equal(buildWebToolContract(undefined), "");
  });

  test("lists each tool and makes the model choose whether to call it", () => {
    const prompt = buildWebToolContract(WEATHER_TOOL);
    assert.ok(prompt.includes("Available tools:"));
    assert.ok(prompt.includes("- get_weather: Get the weather for a city"));
    assert.ok(prompt.includes("<tool_call>"), "must teach the explicit tool-call envelope");
    assert.match(prompt, /Decide whether a tool is needed/);
    assert.match(prompt, /declared tools are available in this conversation/i);
    assert.match(prompt, /Never claim that a tool ran/i);
    assert.doesNotMatch(prompt, /files, repositories, folders, package scripts/i);
  });

  test("honors required and forced tool choices in the model contract", () => {
    const required = buildWebToolContract(WEATHER_TOOL, "required");
    const forced = buildWebToolContract(WEATHER_TOOL, {
      type: "function",
      function: { name: "get_weather" },
    });
    const responsesForced = buildWebToolContract(WEATHER_TOOL, {
      type: "function",
      name: "get_weather",
    });
    assert.match(required, /must call one or more declared tools/i);
    assert.match(forced, /must call the declared tool `get_weather`/i);
    assert.match(responsesForced, /must call the declared tool `get_weather`/i);
  });

  test("uses the ChatGPT Web action envelope without pretending native tools exist", () => {
    const prompt = buildWebToolContract(WEATHER_TOOL, "required", "chatgpt-web");
    assert.match(prompt, /OMNIROUTE TOOL PROTOCOL/);
    assert.match(prompt, /```json/);
    assert.match(prompt, /must emit one or more declared tool calls/i);
    assert.match(prompt, /read, list, search, or change files/i);
    assert.match(prompt, /never infer that a path is missing/i);
    assert.match(prompt, /only executable invocation syntax/i);
    assert.match(prompt, /earlier tool-channel/i);
    assert.doesNotMatch(prompt, /declared tools are available/i);
  });

  test("serializes Responses-style top-level function definitions into the action contract", () => {
    const prompt = buildWebToolContract(
      [
        {
          type: "function",
          name: "exec_command",
          description: "Run a command in the coding harness.",
          parameters: {
            type: "object",
            properties: { cmd: { type: "string" } },
            required: ["cmd"],
          },
        },
      ],
      "auto",
      "chatgpt-web"
    );
    assert.match(prompt, /Available tools:/);
    assert.match(prompt, /exec_command: Run a command in the coding harness/);
    assert.match(prompt, /"required":\["cmd"\]/);
  });

  test("rejects forced functions that are not declared", () => {
    assert.throws(
      () =>
        prepareWebToolRequest(
          { tools: WEATHER_TOOL, tool_choice: { type: "function", name: "missing" } },
          []
        ),
      /not declared/
    );
  });
});

describe("web-provider tool decoder", () => {
  test("parses a <tool> block into OpenAI tool_calls and strips it from content", () => {
    const text =
      'Sure, let me check.\n<tool>{"name": "get_weather", "arguments": {"city": "SP"}}</tool>';
    const { content, toolCalls } = decodeExplicitWebToolCalls(text, "call", WEATHER_TOOL);

    assert.ok(toolCalls && toolCalls.length === 1, "one tool call expected");
    assert.equal(toolCalls[0].function.name, "get_weather");
    assert.equal(
      typeof toolCalls[0].function.arguments,
      "string",
      "arguments must be a JSON string"
    );
    assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), { city: "SP" });
    assert.ok(!content.includes("<tool>"), "the <tool> block must be stripped from content");
  });

  test("parses the fenced JSON tool envelope (ChatGPT Web canonical)", () => {
    const text = '```json\n{"name":"get_weather","arguments":{"city":"Seoul"}}\n```';
    const { content, toolCalls } = decodeExplicitWebToolCalls(text, "call", WEATHER_TOOL, {
      fences: true,
    });
    assert.equal(content, "");
    assert.deepEqual(toolCalls?.[0], {
      id: "call_0",
      type: "function",
      function: { name: "get_weather", arguments: '{"city":"Seoul"}' },
    });
  });

  test("returns null tool calls for plain text with no tool block", () => {
    const { content, toolCalls } = decodeExplicitWebToolCalls(
      "just a normal answer",
      "call",
      WEATHER_TOOL
    );
    assert.equal(toolCalls, null);
    assert.equal(content, "just a normal answer");
  });

  test("decodes bare whole-body JSON but never fuzzy names as tool calls", () => {
    const bare = '{"name": "get_weather", "arguments": {"city": "RJ"}}';
    const typo = '<tool_call>{"name":"getWeather","arguments":{"city":"RJ"}}</tool_call>';
    // ChatGPT often skips the fence — a reply that IS one bare JSON call decodes.
    const { content, toolCalls } = decodeExplicitWebToolCalls(bare, "call", WEATHER_TOOL, {
      fences: true,
    });
    assert.equal(content, "");
    assert.deepEqual(toolCalls?.[0], {
      id: "call_0",
      type: "function",
      function: { name: "get_weather", arguments: '{"city":"RJ"}' },
    });
    // Fuzzy/undeclared names are never inferred.
    assert.equal(decodeExplicitWebToolCalls(typo, "call", WEATHER_TOOL).toolCalls, null);
  });
});

describe("web-provider request pipeline", () => {
  test("prepends a tool system prompt when tools are present", () => {
    const messages = [{ role: "user", content: "weather in SP?" }];
    const result = prepareWebToolRequest({ tools: WEATHER_TOOL }, messages);

    assert.equal(result.hasTools, true);
    assert.equal(result.effectiveMessages[0].role, "system");
    assert.ok(String(result.effectiveMessages[0].content).includes("get_weather"));
    assert.equal(result.effectiveMessages.length, messages.length + 1);
  });

  test("passes messages through untouched when there are no tools", () => {
    const messages = [{ role: "user", content: "hi" }];
    const result = prepareWebToolRequest({}, messages);

    assert.equal(result.hasTools, false);
    assert.equal(result.effectiveMessages, messages);
  });

  test("honors tool_choice none without adding a tool contract", () => {
    const messages = [{ role: "user", content: "weather in SP?" }];
    const result = prepareWebToolRequest({ tools: WEATHER_TOOL, tool_choice: "none" }, messages);
    assert.equal(result.hasTools, false);
    assert.equal(result.effectiveMessages, messages);
  });

  test("rejects required policy without a declared function", () => {
    assert.throws(
      () => prepareWebToolRequest({ tools: [], tool_choice: "required" }, []),
      /needs at least one declared function/
    );
    assert.throws(
      () => prepareWebToolRequest({ tools: [{ type: "function" }], tool_choice: "required" }, []),
      /needs at least one declared function/
    );
  });
});

describe("web-provider response pipeline", () => {
  test("finish_reason is tool_calls when a call is parsed, else stop", () => {
    const called = decodeWebToolResponse(
      '<tool>{"name": "get_weather", "arguments": {}}</tool>',
      WEATHER_TOOL
    );
    assert.equal(called.finishReason, "tool_calls");
    assert.ok(called.toolCalls && called.toolCalls.length === 1);

    const plain = decodeWebToolResponse("no tools here", WEATHER_TOOL);
    assert.equal(plain.finishReason, "stop");
    assert.equal(plain.toolCalls, null);
    assert.equal(plain.content, "no tools here");
  });

  test("enforces none, required, and forced tool choices while decoding", () => {
    const call = '<tool_call>{"name":"get_weather","arguments":{}}</tool_call>';
    const none = decodeWebToolResponse(call, WEATHER_TOOL, "call", "none");
    assert.equal(none.toolCalls, null);

    const required = decodeWebToolResponse("normal answer", WEATHER_TOOL, "call", "required");
    assert.match(required.policyViolation ?? "", /required tool call/);

    const forced = decodeWebToolResponse(
      '<tool_call>{"name":"other","arguments":{}}</tool_call>',
      [
        ...WEATHER_TOOL,
        { type: "function", function: { name: "other", parameters: { type: "object" } } },
      ],
      "call",
      { type: "function", name: "get_weather" }
    );
    assert.equal(forced.toolCalls, null);
    assert.match(forced.policyViolation ?? "", /forced tool/);
  });

  test("rejects tool calls with non-object arguments", () => {
    const invalid = decodeWebToolResponse(
      '<tool_call>{"name":"get_weather","arguments":["Seoul"]}</tool_call>',
      WEATHER_TOOL
    );
    assert.equal(invalid.toolCalls, null);
    assert.match(invalid.content, /tool_call/);
  });
});

test("web-provider tool fingerprint changes when the protocol inputs change", () => {
  const auto = buildWebToolContractFingerprint(WEATHER_TOOL, "auto");
  const required = buildWebToolContractFingerprint(WEATHER_TOOL, "required");
  assert.notEqual(auto, required);
});

describe("web-provider decoder: JSON envelopes (ChatGPT Web canonical)", () => {
  test("parses multiple fenced JSON blocks into parallel calls", () => {
    const text = [
      "```json",
      '{"name":"get_weather","arguments":{"city":"Seoul"}}',
      "```",
      "```json",
      '{"name":"get_weather","arguments":{"city":"Busan"}}',
      "```",
    ].join("\n");
    const { content, toolCalls } = decodeExplicitWebToolCalls(text, "call", WEATHER_TOOL, {
      fences: true,
    });
    assert.equal(content, "");
    assert.equal(toolCalls?.length, 2);
    assert.deepEqual(JSON.parse(toolCalls![1].function.arguments), { city: "Busan" });
  });

  test("parses a whole-body JSON array of calls", () => {
    const text =
      '[{"name":"get_weather","arguments":{"city":"Seoul"}},{"name":"get_weather","arguments":{"city":"Jeju"}}]';
    const { content, toolCalls } = decodeExplicitWebToolCalls(text, "call", WEATHER_TOOL, {
      fences: true,
    });
    assert.equal(content, "");
    assert.equal(toolCalls?.length, 2);
  });

  test("parses one bare JSON call object per line", () => {
    const text =
      '{"name":"get_weather","arguments":{"city":"Seoul"}}\n{"name":"get_weather","arguments":{"city":"Daejeon"}}';
    const { content, toolCalls } = decodeExplicitWebToolCalls(text, "call", WEATHER_TOOL, {
      fences: true,
    });
    assert.equal(content, "");
    assert.equal(toolCalls?.length, 2);
  });

  test("keeps prose and non-tool fenced JSON as content, strips only the call", () => {
    const text = [
      "Let me check the weather for you.",
      "```json",
      '{"name":"get_weather","arguments":{"city":"Seoul"}}',
      "```",
      "```json",
      '{"unrelated":true}',
      "```",
    ].join("\n");
    const { content, toolCalls } = decodeExplicitWebToolCalls(text, "call", WEATHER_TOOL, {
      fences: true,
    });
    assert.equal(toolCalls?.length, 1);
    assert.ok(content.includes("Let me check the weather"));
    assert.ok(content.includes('"unrelated"'), "non-tool JSON stays in content");
    assert.ok(!content.includes('"name":"get_weather"'), "the accepted call is stripped");
  });

  test("ignores a fenced call whose name is not declared", () => {
    const text = '```json\n{"name":"delete_everything","arguments":{}}\n```';
    const { content, toolCalls } = decodeExplicitWebToolCalls(text, "call", WEATHER_TOOL, {
      fences: true,
    });
    assert.equal(toolCalls, null);
    assert.equal(content, text);
  });
});

describe("web-provider excuse guard", () => {
  test("flags excuses, confabulated failures, and bare intentions", () => {
    assert.equal(detectWebToolExcuse("I cannot access the filesystem in this chat."), true);
    assert.equal(
      detectWebToolExcuse(
        "I tried to open the repository workspace so I could inspect the files, but the workspace connector returned an upstream error (502)."
      ),
      true
    );
    assert.equal(detectWebToolExcuse("I'll start by inspecting the Git state and diffs."), true);
  });

  test("does not flag normal answers or grounded reports", () => {
    assert.equal(detectWebToolExcuse("The weather in Seoul is 22°C and sunny."), false);
    assert.equal(
      detectWebToolExcuse("Here is the file contents you asked for:\n\nconsole.log('hi')"),
      false
    );
    assert.equal(
      detectWebToolExcuse(
        "The command output shows the server returned an error on line 42, which means the config key is missing. " +
          "I found this in the tool result above."
      ),
      false
    );
  });
});

describe("web-provider decoder: hardening regressions", () => {
  test("fences are ignored by default (tag-contract providers unchanged)", () => {
    const text = '```json\n{"name":"get_weather","arguments":{"city":"Seoul"}}\n```';
    const { content, toolCalls } = decodeExplicitWebToolCalls(text, "call", WEATHER_TOOL);
    assert.equal(toolCalls, null);
    assert.equal(content, text);
  });

  test("a fenced tool_result envelope is never decoded as a call", () => {
    const text = '```json\n{"type":"tool_result","name":"get_weather","output":"sunny"}\n```';
    const { content, toolCalls } = decodeExplicitWebToolCalls(text, "call", WEATHER_TOOL, {
      fences: true,
    });
    assert.equal(toolCalls, null);
    assert.equal(content, text);
  });

  test("closing fence on the JSON line still decodes", () => {
    const text = '```json\n{"name":"get_weather","arguments":{"city":"Seoul"}}```';
    const { toolCalls } = decodeExplicitWebToolCalls(text, "call", WEATHER_TOOL, {
      fences: true,
    });
    assert.equal(toolCalls?.length, 1);
  });

  test("uppercase JSON language tag decodes", () => {
    const text = '```JSON\n{"name":"get_weather","arguments":{"city":"Seoul"}}\n```';
    const { toolCalls } = decodeExplicitWebToolCalls(text, "call", WEATHER_TOOL, {
      fences: true,
    });
    assert.equal(toolCalls?.length, 1);
  });

  test("a fence nested inside a tag decodes exactly once", () => {
    const text =
      '<tool>```json\n{"name":"get_weather","arguments":{"city":"Seoul"}}\n```</tool>tail text';
    const { content, toolCalls } = decodeExplicitWebToolCalls(text, "call", WEATHER_TOOL, {
      fences: true,
    });
    assert.equal(toolCalls?.length, 1);
    assert.ok(content.includes("tail text"), "trailing prose survives");
  });

  test("a mixed declared/undeclared array in one fence is all-or-nothing", () => {
    const text =
      '```json\n[{"name":"get_weather","arguments":{"city":"Seoul"}},{"name":"delete_everything","arguments":{}}]\n```';
    const { content, toolCalls } = decodeExplicitWebToolCalls(text, "call", WEATHER_TOOL, {
      fences: true,
    });
    assert.equal(toolCalls, null);
    assert.ok(content.includes("delete_everything"), "the fence stays visible to the user");
  });

  test("legacy omniroute_action tag still decodes", () => {
    const text =
      '<omniroute_action>{"name":"get_weather","arguments":{"city":"Seoul"}}</omniroute_action>';
    const { content, toolCalls } = decodeExplicitWebToolCalls(text, "call", WEATHER_TOOL);
    assert.equal(content, "");
    assert.equal(toolCalls?.[0]?.function.name, "get_weather");
  });
});

describe("web-provider excuse guard: precision regressions", () => {
  test("does not flag figurative intentions or grounded reports", () => {
    assert.equal(detectWebToolExcuse("Let me check the math: 2 + 2 = 4."), false);
    assert.equal(detectWebToolExcuse("Let me compare the two options for you."), false);
    assert.equal(detectWebToolExcuse("Let me list the pros and cons."), false);
    assert.equal(detectWebToolExcuse("Let me open with a summary of the results."), false);
    assert.equal(
      detectWebToolExcuse("The gateway returned the list of routes you asked about."),
      false
    );
    assert.equal(detectWebToolExcuse("Sure, I can send the file via email if you want."), false);
  });
});
