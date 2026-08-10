/**
 * Decoder + guard diagnostics for the chatgpt-web OMNIROUTE TOOL PROTOCOL.
 *
 * Goal: enumerate every realistic shape the chatgpt.com backend may emit and
 * verify the decoder/guard correctly classifies each. These tests are the
 * ground-truth signal we run new decoder changes against.
 *
 * Every input is a realistic completion from the chatgpt.com backend (fenced
 * JSON, prose wrappers, reasoning prefixes, malformed escapes, multi-call,
 * retries). Each test asserts the canonical decoder/guard contract.
 *
 * The canonical ChatGPT-Web protocol expected by this executor:
 *
 *   ```json
 *   {"name": "<tool_name>", "arguments": {...}}
 *   ```
 *
 * Decoded by open-sse/services/webProvider/toolDecoder.ts::decodeExplicitWebToolCalls.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  decodeExplicitWebToolCalls,
} from "../../open-sse/services/webProvider/toolDecoder.ts";
import {
  detectWebToolExcuse,
  detectPlanNarration,
  detectWebToolGuardViolation,
} from "../../open-sse/services/webProvider/excuseGuard.ts";
import { decodeWebToolResponse } from "../../open-sse/services/webProvider/toolPipeline.ts";

const TOOLS = [
  {
    type: "function",
    function: {
      name: "exec_command",
      description: "Run a shell command",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" } },
        required: ["cmd"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  },
];

/** chatgpt-web executor always passes fences:true. Mirror that for diagnostics. */
function decode(raw: string) {
  return decodeExplicitWebToolCalls(raw, "call-test", TOOLS, { fences: true });
}

function decodeResp(raw: string, toolChoice: "auto" | "none" | "required" | { type: "function"; name: string } = "auto") {
  return decodeWebToolResponse(raw, TOOLS, "call", toolChoice, { fences: true });
}

describe("chatgpt-web decoder: canonical fenced JSON", () => {
  test("single fenced JSON call", () => {
    const raw = '```json\n{"name":"exec_command","arguments":{"cmd":"ls"}}\n```';
    const { content, toolCalls } = decode(raw);
    assert.equal(content, "");
    assert.equal(toolCalls?.length, 1);
    assert.equal(toolCalls?.[0].function.name, "exec_command");
    assert.equal(JSON.parse(toolCalls?.[0].function.arguments || "{}").cmd, "ls");
  });

  test("fenced JSON with reasoning prefix", () => {
    const raw =
      '<thinking>\nThe user wants me to list files.\n</thinking>\n\n```json\n{"name":"list_files","arguments":{"path":"."}}\n```';
    const { content, toolCalls } = decode(raw);
    assert.equal(toolCalls?.length, 1);
    assert.equal(toolCalls?.[0].function.name, "list_files");
    // content keeps the prose around the call (stripping only the call envelope)
    assert.ok(content.includes("thinking"));
  });

  test("two independent calls in one turn", () => {
    const raw =
      'I will list files and then read the README.\n\n```json\n{"name":"list_files","arguments":{"path":"."}}\n```\n\n```json\n{"name":"exec_command","arguments":{"cmd":"cat README.md"}}\n```';
    const { content, toolCalls } = decode(raw);
    assert.equal(toolCalls?.length, 2);
    assert.ok(toolCalls?.some((c) => c.function.name === "list_files"));
    assert.ok(toolCalls?.some((c) => c.function.name === "exec_command"));
    assert.ok(content.includes("list files and then read"));
  });

  test("nested JSON args (multiline)", () => {
    // Use a JSON string with an inner escaped object (e.g. embedding JSON).
    const raw =
      "```json\n" +
      '{"name":"exec_command","arguments":{"cmd":"echo {\\"a\\":1}"}}\n' +
      "```";
    const { toolCalls } = decode(raw);
    assert.equal(toolCalls?.length, 1);
    const args = JSON.parse(toolCalls?.[0].function.arguments || "{}");
    assert.equal(args.cmd, 'echo {"a":1}');
  });
});

describe("chatgpt-web decoder: malformed-but-recoverable", () => {
  test("uppercase JSON tag", () => {
    const raw = '```JSON\n{"name":"exec_command","arguments":{"cmd":"ls"}}\n```';
    const { toolCalls } = decode(raw);
    assert.equal(toolCalls?.length, 1);
  });

  test("closing fence on the JSON line (no trailing newline)", () => {
    const raw = '```json\n{"name":"exec_command","arguments":{"cmd":"ls"}}```';
    const { toolCalls } = decode(raw);
    assert.equal(toolCalls?.length, 1);
  });

  test("missing language tag", () => {
    const raw = '```\n{"name":"exec_command","arguments":{"cmd":"ls"}}\n```';
    const { toolCalls } = decode(raw);
    assert.equal(toolCalls?.length, 1);
  });

  test("trailing whitespace after closing fence", () => {
    const raw =
      '```json\n{"name":"exec_command","arguments":{"cmd":"ls"}}\n```   \n';
    const { toolCalls } = decode(raw);
    assert.equal(toolCalls?.length, 1);
  });
});

describe("chatgpt-web decoder: should NOT decode", () => {
  test("prose-only response", () => {
    const raw = "I'll list the files in the current directory.";
    const { content, toolCalls } = decode(raw);
    assert.equal(toolCalls, null);
    assert.ok(content.includes("list the files"));
  });

  test("prose response with non-tool JSON example", () => {
    const raw = 'For example, the response format is:\n```json\n{"foo":"bar"}\n```';
    const { toolCalls } = decode(raw);
    assert.equal(toolCalls, null);
  });

  test("fenced tool_result envelope is not a call", () => {
    const raw =
      '```json\n{"type":"tool_result","name":"exec_command","output":"hello"}\n```';
    const { toolCalls } = decode(raw);
    assert.equal(toolCalls, null);
  });

  test("undeclared tool name in a fence is dropped", () => {
    const raw = '```json\n{"name":"unknown_tool","arguments":{}}\n```';
    const { toolCalls } = decode(raw);
    assert.equal(toolCalls, null);
  });

  test("calls without 'name' or 'arguments' keys are dropped", () => {
    const raw = '```json\n{"foo":"bar"}\n```';
    const { toolCalls } = decode(raw);
    assert.equal(toolCalls, null);
  });
});

describe("chatgpt-web excuse guard: real production patterns", () => {
  test("flags 'cannot access' excuses", () => {
    assert.equal(detectWebToolExcuse("I can't access the filesystem in this chat."), true);
  });

  test("flags fabricated upstream-error excuses", () => {
    assert.equal(
      detectWebToolExcuse("I tried to run it but the workspace connector returned an upstream error (502)."),
      true
    );
  });

  test("flags bare intention ('I'll start by inspecting the repo')", () => {
    // INTENT detected by the excuse guard (not the narrow plan-narration guard)
    assert.equal(detectWebToolExcuse("I'll start by inspecting the repo."), true);
    assert.equal(detectWebToolExcuse("Let me read package.json."), true);
  });

  test("plan-narration: 'I'll continue' style is flagged", () => {
    // PLAN_NARRATION_PATTERNS handles explicit narration verbs
    assert.equal(detectPlanNarration("I'll continue with the next step."), true);
    assert.equal(detectPlanNarration("I'll create a README.md file."), true);
  });

  test("does NOT flag a tool result continuation", () => {
    const grounded = "The file contains: hello world.\nLet me also format this for you.";
    assert.equal(detectWebToolExcuse(grounded), false);
  });

  test("does NOT flag a figurative 'I'll compare the options'", () => {
    assert.equal(detectPlanNarration("I'll compare the options before deciding."), false);
  });

  test("does NOT flag past-tense work reports", () => {
    assert.equal(
      detectWebToolExcuse("I read package.json — it lists the dependencies."),
      false
    );
  });

  test("does NOT flag third-person infrastructure reports (no confabulation)", () => {
    assert.equal(
      detectWebToolExcuse("The workspace connector returned 200 with the expected payload."),
      false
    );
  });
});

describe("chatgpt-web end-to-end: response decoder policy", () => {
  test("tool_choice=required: model omitted the call → policyViolation", () => {
    const out = decodeResp(
      "I cannot access files in this chat.",
      "required"
    );
    assert.equal(out.toolCalls, null);
    assert.equal(out.finishReason, "stop");
    assert.match(out.policyViolation ?? "", /did not emit the required tool call/);
  });

  test("tool_choice=forced (list_files): wrong call → policyViolation", () => {
    const raw = '```json\n{"name":"exec_command","arguments":{"cmd":"ls"}}\n```';
    const out = decodeResp(raw, { type: "function", name: "list_files" });
    assert.equal(out.toolCalls, null);
    assert.match(out.policyViolation ?? "", /did not emit the forced tool/);
  });

  test("tool_choice=auto: call is preserved", () => {
    const raw = '```json\n{"name":"exec_command","arguments":{"cmd":"ls"}}\n```';
    const out = decodeResp(raw, "auto");
    assert.equal(out.toolCalls?.length, 1);
    assert.equal(out.finishReason, "tool_calls");
    assert.equal(out.policyViolation, null);
  });
});

describe("chatgpt-web guard modes (off / plan / full)", () => {
  test("off: nothing is flagged", () => {
    assert.equal(detectWebToolGuardViolation("I'll start by reading package.json.", "off"), false);
  });

  test("plan: only plan-narration flagged, not excuses", () => {
    // plan mode = narrow precision; only PLAN_NARRATION_PATTERNS, not excuse guard
    assert.equal(detectWebToolGuardViolation("I'll continue with the next step.", "plan"), true);
    assert.equal(detectWebToolGuardViolation("I cannot access the filesystem.", "plan"), false);
  });

  test("full: both plan-narration and excuses flagged", () => {
    assert.equal(detectWebToolGuardViolation("I'll start by reading package.json.", "full"), true);
    assert.equal(detectWebToolGuardViolation("I cannot access the filesystem.", "full"), true);
  });
});
