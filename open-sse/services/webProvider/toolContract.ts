import { getRequestedToolNames } from "./toolDecoder.ts";
import {
  toRecord,
  WebToolPolicyError,
  type WebToolChoice,
  type WebToolPromptStyle,
} from "./types.ts";

export const WEB_TOOL_PROTOCOL_VERSION = "2026-07-17";

export function resolveWebToolChoice(tools: unknown, rawChoice: unknown = "auto"): WebToolChoice {
  if (rawChoice === undefined || rawChoice === null || rawChoice === "auto") return "auto";
  if (rawChoice === "none") return rawChoice;
  if (rawChoice === "required") {
    if (getRequestedToolNames(tools).length === 0) {
      throw new WebToolPolicyError("tool_choice required needs at least one declared function");
    }
    return rawChoice;
  }

  const choice = toRecord(rawChoice);
  const nestedFunction = toRecord(choice?.function);
  const name = nestedFunction?.name ?? choice?.name;
  if (choice?.type !== "function" || typeof name !== "string" || !name.trim()) {
    throw new WebToolPolicyError(
      "tool_choice must be auto, none, required, or a declared function"
    );
  }
  const declared = getRequestedToolNames(tools).some((tool) => tool.original === name.trim());
  if (!declared) {
    throw new WebToolPolicyError(`Forced tool \`${name.trim()}\` is not declared in tools`);
  }
  return { type: "function", name: name.trim() };
}

/**
 * Marker line that begins the generated chatgpt-web tool protocol. Imported by
 * the executor (open-sse/executors/chatgpt-web.ts) whose system-context
 * strippers (Codex memory blocks, Skills/Plugins sections) and replay preamble
 * reference the same constant so they cannot drift apart.
 */
export const CHATGPT_WEB_PROTOCOL_MARKER = "OMNIROUTE TOOL PROTOCOL";

export function buildWebToolContract(
  tools: unknown,
  rawChoice: unknown = "auto",
  promptStyle: WebToolPromptStyle = "standard"
): string {
  const toolChoice = resolveWebToolChoice(tools, rawChoice);
  if (!Array.isArray(tools) || tools.length === 0 || toolChoice === "none") return "";

  const definitions = tools
    .map((tool) => {
      const toolRecord = toRecord(tool);
      if (toolRecord?.type !== "function") return null;
      const fn = toRecord(toolRecord?.function) ?? toolRecord;
      const name = typeof fn?.name === "string" ? fn.name.trim() : "";
      if (!name) return null;
      const description = typeof fn?.description === "string" ? fn.description : "";
      let parameters = "";
      try {
        parameters = fn?.parameters ? JSON.stringify(fn.parameters) : "";
      } catch {
        parameters = "";
      }
      return `- ${name}${description ? `: ${description}` : ""}${parameters ? `\n  parameters: ${parameters}` : ""}`;
    })
    .filter((definition): definition is string => Boolean(definition));
  if (definitions.length === 0) return "";

  const forcedName = typeof toolChoice === "object" ? toolChoice.name : "";
  const choiceInstruction =
    toolChoice === "required"
      ? "- You must call one or more declared tools before answering this turn."
      : forcedName
        ? `- You must call the declared tool \`${forcedName}\` before answering this turn.`
        : "- Decide whether a tool is needed from the user request and the declared tool descriptions. Do not call a tool merely because its name, a path, or a command appears in the request.";

  if (promptStyle === "chatgpt-web") {
    const jsonInstruction =
      toolChoice === "required"
        ? "- You must emit one or more declared tool calls before answering this turn."
        : forcedName
          ? `- You must emit the declared tool \`${forcedName}\` before answering this turn.`
          : "- Decide whether a tool is needed from the user request and the declared tool descriptions.";
    // ChatGPT is far more reliable with fenced JSON than with custom XML tags —
    // this mirrors the function-calling shape it was trained on. The contract,
    // the few-shot example, the history replay, and the decoder must all use
    // this EXACT same envelope (see serializeActionRecord/serializeActionResult
    // in open-sse/executors/chatgpt-web.ts).
    return [
      `${CHATGPT_WEB_PROTOCOL_MARKER} v${WEB_TOOL_PROTOCOL_VERSION}:`,
      "You are the reasoning component of an integration host. The host executes tool calls after this response and sends their results back in the next turn.",
      jsonInstruction,
      "- When a tool is needed, reply with ONLY a fenced JSON tool call — no prose in that turn:",
      "  ```json",
      '  {"name":"<exact declared tool name>","arguments":{...}}',
      "  ```",
      "- For several independent calls, emit one fenced JSON block per call in a single turn.",
      "- This JSON tool call is the only executable invocation syntax available in this upstream conversation.",
      "- Earlier tool-channel, namespace, or API invocation directions describe the downstream host only; invoke those capabilities by emitting this JSON, not by following another call syntax.",
      "- Use an exact declared tool name and a JSON object for arguments.",
      "- Do not say a tool is unavailable, and never invent errors, connectors, or results. The host reports real outcomes as tool results.",
      "- Never claim that you inspected a file, ran a command, or checked local/current state unless a tool result in this conversation contains that evidence.",
      "- If the task requires local filesystem, command, external, or current information, emit an appropriate declared tool call first.",
      "- Requests to read, list, search, or change files, inspect a repository, or run a command require declared tools; you cannot perform those operations directly.",
      "- Never infer that a path is missing or inaccessible. Emit a declared tool call and wait for its result.",
      "- If no tool is needed, answer normally.",
      "",
      "Example (single tool call):",
      "user: read the file /tmp/notes.txt",
      "assistant:",
      "```json",
      '{"name":"exec_command","arguments":{"cmd":"cat /tmp/notes.txt"}}',
      "```",
      "user:",
      "Tool result for `exec_command`:",
      "```json",
      '{"type":"tool_result","name":"exec_command","output":"hello world"}',
      "```",
      "assistant: The file contains: hello world",
      "",
      "Available tools:",
      ...definitions,
    ].join("\n");
  }

  return [
    `TOOL CALL CONTRACT v${WEB_TOOL_PROTOCOL_VERSION}:`,
    choiceInstruction,
    "- The declared tools are available in this conversation. Do not claim they are unavailable; either call a declared tool when needed or answer normally.",
    "- Never claim that a tool ran or cite tool output unless a tool-result message in this conversation contains that result. If the task requires external, local, or current information, call an appropriate declared tool first.",
    "- To call a tool, output one or more <tool_call> blocks and no prose in that turn:",
    '  <tool_call>{"name":"<exact declared tool name>","arguments":{...}}</tool_call>',
    "- Use an exact declared tool name and a JSON object for arguments.",
    "- Wait for tool results before deciding the next step. If no tool is needed, answer normally.",
    "",
    "Available tools:",
    ...definitions,
  ].join("\n");
}
