import { buildWebToolContract, resolveWebToolChoice } from "./toolContract.ts";
import { decodeExplicitWebToolCalls } from "./toolDecoder.ts";
import { errorResponse } from "../../utils/error.ts";
import type {
  WebToolChoice,
  WebToolPromptStyle,
  WebToolRequest,
  WebToolResponse,
} from "./types.ts";

export function prepareWebToolRequest(
  body: Record<string, unknown>,
  messages: Array<{ role: string; content: unknown }>,
  options: { promptStyle?: WebToolPromptStyle } = {}
): WebToolRequest {
  const requestedTools = body.tools;
  const toolChoice = resolveWebToolChoice(requestedTools, body.tool_choice);
  const toolContract = buildWebToolContract(requestedTools, toolChoice, options.promptStyle);
  if (!toolContract) {
    return {
      hasTools: false,
      requestedTools,
      toolChoice,
      toolContract,
      effectiveMessages: messages,
    };
  }
  return {
    hasTools: true,
    requestedTools,
    toolChoice,
    toolContract,
    effectiveMessages:
      options.promptStyle === "chatgpt-web"
        ? [...messages, { role: "system", content: toolContract }]
        : [{ role: "system", content: toolContract }, ...messages],
  };
}

/** Return one sanitized, provider-neutral response for an unmet tool policy. */
export function buildWebToolPolicyErrorResponse(): Response {
  return errorResponse(502, "The upstream provider did not honor the requested tool policy.");
}

export function decodeWebToolResponse(
  rawContent: string,
  requestedTools: unknown,
  idSeed = "call",
  toolChoice: WebToolChoice = "auto",
  options: { fences?: boolean } = {}
): WebToolResponse {
  if (toolChoice === "none") {
    return { content: rawContent, toolCalls: null, finishReason: "stop", policyViolation: null };
  }
  const { content, toolCalls } = decodeExplicitWebToolCalls(
    rawContent,
    `${idSeed}-${Date.now()}`,
    requestedTools,
    options
  );
  return enforceWebToolChoice(content, toolCalls, toolChoice);
}

/** Apply the canonical tool-choice policy to provider-specific decoders. */
export function enforceWebToolChoice(
  content: string,
  toolCalls: WebToolResponse["toolCalls"],
  toolChoice: WebToolChoice = "auto"
): WebToolResponse {
  const filteredCalls =
    typeof toolChoice === "object"
      ? (toolCalls?.filter((call) => call.function.name === toolChoice.name) ?? [])
      : (toolCalls ?? []);
  const matchingCalls = filteredCalls.length > 0 ? filteredCalls : null;
  const policyViolation =
    toolChoice === "required" && !matchingCalls?.length
      ? "The upstream model did not emit the required tool call"
      : typeof toolChoice === "object" && !matchingCalls?.length
        ? `The upstream model did not emit the forced tool \`${toolChoice.name}\``
        : null;
  return {
    content,
    toolCalls: matchingCalls,
    finishReason: matchingCalls ? "tool_calls" : "stop",
    policyViolation,
  };
}
