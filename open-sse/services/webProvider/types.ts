export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAIToolDef {
  type?: string;
  function?: {
    name?: string;
    description?: string;
    parameters?: unknown;
  };
}

export interface RequestedToolName {
  original: string;
  normalized: string;
}

export type WebToolChoice = "auto" | "none" | "required" | { type: "function"; name: string };

/**
 * Web UIs do not all follow an injected tool protocol equally well. The
 * envelope is therefore provider-selected while validation and decoding stay
 * in the shared pipeline.
 */
export type WebToolPromptStyle = "standard" | "chatgpt-web";

export class WebToolPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebToolPolicyError";
  }
}

export function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export interface WebToolRequest {
  hasTools: boolean;
  requestedTools: unknown;
  toolChoice: WebToolChoice;
  toolContract: string;
  effectiveMessages: Array<{ role: string; content: unknown }>;
}

export interface WebToolResponse {
  content: string;
  toolCalls: OpenAIToolCall[] | null;
  finishReason: "tool_calls" | "stop";
  policyViolation: string | null;
}
