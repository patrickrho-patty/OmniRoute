/**
 * Shared web-cookie tool-call synthesis — used by chatgpt-web and gemini-web.
 *
 * These functions intercept filesystem/git/package.json requests BEFORE the
 * model sees them, synthesizing proper OpenAI tool_calls. This is what makes
 * web-cookie providers reliable coding agents: the model never gets a chance
 * to confabulate file contents or claim the filesystem is unavailable.
 *
 * Two layers:
 * 1. synthesizeWebToolCall() — pre-provider: fires before the request reaches
 *    the model. Handles "Read X", "list files", "git status", "pnpm dev".
 * 2. isWebToolExcuse() + synthesizeWebFallbackToolCall() — post-response: fires
 *    when the model replied with an excuse ("I can't access files") instead of
 *    a tool call.
 */

import type { OpenAIToolCall } from "./webTools.ts";
import { randomUUID } from "node:crypto";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WebSynthesisHistory {
  role: string;
  content: string;
}

export interface WebSynthesisInput {
  /** The current user message text. */
  currentMsg: string;
  /** Conversation history (assistant/tool turns) for context. */
  history: WebSynthesisHistory[];
  /** The OpenAI tools array from the request body. */
  requestedTools: unknown;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SYNTH_BASH_TIMEOUT = 120;

function shellQuote(arg: string): string {
  const cleaned = arg.replace(/'/g, "");
  return `'${cleaned}'`;
}

function makeSyntheticToolCall(
  name: string,
  args: Record<string, unknown>
): OpenAIToolCall[] {
  return [
    {
      id: `web-synth-${randomUUID().slice(0, 12)}`,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
  ];
}

function getRequestedToolNameSet(tools: unknown): Set<string> {
  if (!Array.isArray(tools)) return new Set();
  const names = new Set<string>();
  for (const t of tools as Array<Record<string, unknown>>) {
    const fn = t?.function as Record<string, unknown> | undefined;
    const name = typeof fn?.name === "string" ? fn.name.trim() : "";
    if (name) names.add(name);
  }
  return names;
}

const READABLE_PATH_RE =
  /(?:`|\b)([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:json|sh|md|ts|tsx|js|jsx|mjs|cjs|yaml|yml|toml|py|go|rs|java|rb|php|css|scss|html|env))(?:`|\b)/g;

function findLastMentionedReadablePath(history: WebSynthesisHistory[]): string | null {
  for (const item of [...history].reverse()) {
    if (item.role !== "assistant" && item.role !== "user") continue;
    const matches = [...item.content.matchAll(READABLE_PATH_RE)].map((match) => match[1]);
    if (matches.length > 0) return matches[matches.length - 1];
  }
  return null;
}

function isVagueFileFollowup(currentMsg: string): boolean {
  const prompt = currentMsg.trim().toLowerCase();
  if (!prompt) return false;
  if (READABLE_PATH_RE.test(currentMsg)) {
    READABLE_PATH_RE.lastIndex = 0;
    return false;
  }
  READABLE_PATH_RE.lastIndex = 0;
  return /\b(yes|yeah|yep|please|inspect|open|read|check|look|that|it|this|go ahead|continue|do it)\b/i.test(
    prompt
  );
}

// ─── Pre-provider synthesis ──────────────────────────────────────────────────

/**
 * Synthesize a tool call from the user message BEFORE sending to the web model.
 * Returns null when no synthesis applies (let the model handle it).
 *
 * Handles: pnpm dev, vague follow-ups, list files, read <path>, git <cmd>.
 */
export function synthesizeWebToolCall(input: WebSynthesisInput): OpenAIToolCall[] | null {
  const toolNames = getRequestedToolNameSet(input.requestedTools);
  if (toolNames.size === 0) return null;

  const hasRead = toolNames.has("read");
  const hasBash = toolNames.has("bash");
  const currentMsg = input.currentMsg || "";

  if (!hasRead && !hasBash) return null;

  // pnpm dev / npm run dev / yarn dev → read package.json
  if (/\b(pnpm\s+dev|npm\s+run\s+dev|yarn\s+dev)\b/i.test(currentMsg)) {
    if (hasRead) return makeSyntheticToolCall("read", { path: "package.json" });
    if (hasBash)
      return makeSyntheticToolCall("bash", { command: "cat package.json", timeout: SYNTH_BASH_TIMEOUT });
  }

  // Vague follow-up ("yes", "read it", "check that") → read last mentioned path
  if (isVagueFileFollowup(currentMsg)) {
    const path = findLastMentionedReadablePath(input.history);
    if (path) {
      if (hasRead) return makeSyntheticToolCall("read", { path });
      if (hasBash)
        return makeSyntheticToolCall("bash", { command: `cat ${shellQuote(path)}`, timeout: SYNTH_BASH_TIMEOUT });
    }
  }

  // "list files / list directory / ls / show files"
  if (hasBash && /\b(?:(?:list|show|enumerate)\s+(?:the\s+)?(?:files|directory|dir|contents?)|(?:ls|ll))\b/i.test(currentMsg)) {
    const dirMatch = currentMsg.match(/(?:in|from|of|under)\s+(?:the\s+)?([./][\w./-]+|[\w./-]*\/[\w./-]+)/i)?.[1];
    const lsDir = dirMatch ?? ".";
    return makeSyntheticToolCall("bash", { command: `ls -la ${shellQuote(lsDir)}`, timeout: SYNTH_BASH_TIMEOUT });
  }

  // Direct "Read/open/inspect <path>" requests
  const directPathMatch = currentMsg.match(
    /(?:read|open|inspect|cat)\s+(?:the\s+)?(?:file\s+)?(\/[\w./-]+|[\w./-]+\.[\w-]+|[\w./-]*\/[\w./-]+)/i
  );
  if (directPathMatch?.[1] && directPathMatch[1].length > 1) {
    const path = directPathMatch[1];
    if (hasRead) return makeSyntheticToolCall("read", { path });
    if (hasBash) return makeSyntheticToolCall("bash", { command: `cat ${shellQuote(path)}`, timeout: SYNTH_BASH_TIMEOUT });
  }

  // "run/execute/show/get git <subcommand>"
  if (hasBash) {
    const gitCmdMatch = currentMsg.match(
      /\b(?:run|execute|do|check|show|get|give|tell)\s+(?:me\s+)?(?:the\s+)?(git\s+(?:status|diff|log|branch|fetch|pull))\b/i
    );
    if (gitCmdMatch?.[1]) {
      return makeSyntheticToolCall("bash", { command: gitCmdMatch[1], timeout: SYNTH_BASH_TIMEOUT });
    }
  }

  return null;
}

// ─── Post-response excuse detection + fallback synthesis ─────────────────────

/**
 * Detect when a web model replied with an excuse instead of a tool call.
 * ("I can't access the filesystem", "I don't have tools", etc.)
 */
export function isWebToolExcuse(content: string): boolean {
  return (
    /(filesystem|file system|repository|repo|workspace|project files|package\.json|tool|this chat|this environment|this runtime|this session).{0,200}(unavailable|not available|not exposed|not mounted|not present|not visible|can't|can’t|cannot|unable|don't see|don’t see|not seeing|sandbox|inspect|paste|isn't available|not accessible|doesn't have access)/i.test(
      content
    ) ||
    /(paste|provide|send|point me at).{0,120}(package\.json|file|repo|repository|folder|tree|output|workspace)/i.test(
      content
    ) ||
    /(package\.json|file|repo|repository|folder|tree|output|workspace).{0,120}(paste|provide|send|point me at)/i.test(
      content
    ) ||
    /\b(couldn't read|couldn't open|couldn't access|could not read|could not open|could not access|can't read|can't open|can't access|cannot read|cannot open|cannot access|not able to read|not able to access|unable to read|unable to access|i tried to open|i tried to read|read attempt|does not exist at that path|no such file|not a tool|isn't available in this chat|can't call a .* tool|don't have access to .* file|don't have .* tool access|connector.*returning|can't inspect live files|i cannot access|don't actually have access|nice try|can’t read|can’t open|can’t access|couldn’t read|couldn’t open|couldn’t access|don’t have access)\b/i.test(
      content
    )
  );
}

/**
 * Synthesize a fallback tool call when the model gave an excuse response.
 * Requires the original user message to have been about local project state.
 */
export function synthesizeWebFallbackToolCall(
  excuseContent: string,
  currentMsg: string,
  requestedTools: unknown
): OpenAIToolCall[] | null {
  const toolNames = getRequestedToolNameSet(requestedTools);
  if (toolNames.size === 0) return null;
  if (!isWebToolExcuse(excuseContent)) return null;

  // Only re-synthesize if the user was actually asking about local state
  const asksAboutLocal =
    /(repo|repository|workspace|project|file|folder|directory|package\.json|pnpm|npm|yarn|script|dev command|local state|read|list|ls|cat)/i.test(
      currentMsg
    );
  if (!asksAboutLocal) return null;

  const hasRead = toolNames.has("read");
  const hasBash = toolNames.has("bash");

  if (/\b(pnpm\s+dev|npm\s+run\s+dev|yarn\s+dev|package\.json|scripts?)\b/i.test(currentMsg)) {
    if (hasRead) return makeSyntheticToolCall("read", { path: "package.json" });
    if (hasBash)
      return makeSyntheticToolCall("bash", { command: "cat package.json", timeout: SYNTH_BASH_TIMEOUT });
  }

  // Path extraction — require path-shaped captures
  const pathMatch = currentMsg.match(
    /(?:read|open|inspect|cat)\s+(?:the\s+)?(?:file\s+)?(\/[\w./-]+|[\w./-]+\.[\w-]+|[\w./-]*\/[\w./-]+)/i
  );
  if (pathMatch?.[1] && hasRead) {
    return makeSyntheticToolCall("read", { path: pathMatch[1] });
  }

  if (hasBash && /\bpackages\b/i.test(currentMsg)) {
    return makeSyntheticToolCall("bash", { command: "ls packages", timeout: SYNTH_BASH_TIMEOUT });
  }

  return null;
}
