#!/usr/bin/env -S node --import tsx/esm
/**
 * chatgpt-web tool-call diagnostic harness.
 *
 * Runs against a deployed OmniRoute instance (default: the Contabo gateway at
 * https://omni.agents.patty.io) and probes the chatgpt-web provider with a
 * known tool-calling prompt. Captures:
 *
 *   - HTTP status + headers
 *   - the raw SSE chunks (parsed into events via scripts/homolog/lib/sseCheck)
 *   - the decoded tool calls
 *   - the assistant content + finish_reason
 *   - the upstream completion (when loggable)
 *
 * Use this against the deployed OmniRoute to confirm whether tool-calling is
 * actually working, and whether the symptom "Empty assistant response after
 * tool_calls completion" reproduces.
 *
 * Usage:
 *   # default — tests against omni.agents.patty.io
 *   node --import tsx/esm scripts/diagnose/chatgpt-web-tool-call.ts
 *
 *   # override URL, model, prompt
 *   OMNIROUTE_BASE=https://omni.example.com node --import tsx/esm scripts/diagnose/chatgpt-web-tool-call.ts
 *
 *   # custom upstream (test the fork locally)
 *   OMNIROUTE_BASE=http://127.0.0.1:20128 node --import tsx/esm scripts/diagnose/chatgpt-web-tool-call.ts
 *
 *   # repeat N times for noise measurement
 *   OMNIROUTE_ITERATIONS=10 node --import tsx/esm scripts/diagnose/chatgpt-web-tool-call.ts
 *
 * Required env vars:
 *   OMNIROUTE_API_KEY  — management-scoped API key for the target instance.
 *   OMNIROUTE_PROVIDER — provider ID (default chatgpt-web).
 *   OMNIROUTE_MODEL    — model ID (default gpt-5).
 *   OMNIROUTE_BASE     — base URL (default https://omni.agents.patty.io).
 *   OMNIROUTE_ITERATIONS — repeat count (default 1).
 */

import { setTimeout as delay } from "node:timers/promises";

import { parseSseChunk } from "../homolog/lib/sseCheck.mjs";

const BASE = process.env.OMNIROUTE_BASE || "https://omni.agents.patty.io";
const API_KEY = process.env.OMNIROUTE_API_KEY;
const PROVIDER = process.env.OMNIROUTE_PROVIDER || "chatgpt-web";
const MODEL = process.env.OMNIROUTE_MODEL || "gpt-5";
const STREAM = process.env.OMNIROUTE_STREAM !== "false";
const ITER = Math.max(1, Number(process.env.OMNIROUTE_ITERATIONS || "1"));

if (!API_KEY) {
  console.error(
    "Missing OMNIROUTE_API_KEY. Set it to a management-scoped API key for the target instance."
  );
  process.exit(2);
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "exec_command",
      description: "Run a shell command in the coding harness.",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string", description: "The command to run." } },
        required: ["cmd"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files at a path.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
      },
    },
  },
];

const PROMPT = [
  "You have access to the declared tools exec_command and list_files.",
  "When the user asks for filesystem information, emit a fenced JSON tool call.",
  "Task: list the files in /tmp and read the first one. Emit the appropriate declared tool calls.",
].join(" ");

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

type DiagnosticResult = {
  base: string;
  provider: string;
  model: string;
  status: number;
  durationMs: number;
  finishReason: string | null;
  content: string;
  toolCalls: ToolCall[];
  rawEvents: number;
  emptyAssistantAfterTools: boolean;
  notes: string[];
};

type StreamChoice = {
  finish_reason?: string;
  delta?: { content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> };
  message?: { content?: string; tool_calls?: ToolCall[] };
};

function noteEmptyAssistant(notes: string[], empty: boolean): void {
  if (!empty) return;
  notes.push(
    "[SYMPTOM] Empty assistant response after tool_calls completion — " +
      "this matches the deployed-instance log pattern. Likely cause: " +
      "the model emits the call and then no prose; check tool result " +
      "round-trip or the model's first-post-tool output."
  );
}

function parseStreamEvents(events: string[]): {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  rawEvents: number;
} {
  let content = "";
  const toolCalls: ToolCall[] = [];
  let finishReason: string | null = null;
  let rawEvents = 0;
  for (const data of events) {
    if (!data || data === "[DONE]") continue;
    rawEvents += 1;
    let payload: { choices?: StreamChoice[] };
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }
    const choice = payload?.choices?.[0];
    if (!choice) continue;
    if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
    const delta = choice.delta ?? choice.message;
    if (typeof delta?.content === "string") content += delta.content;
    if (Array.isArray(delta?.tool_calls)) {
      for (const tc of delta.tool_calls) {
        if (!tc?.function?.name) continue;
        toolCalls.push({
          id: tc.id ?? `tc-${toolCalls.length}`,
          type: "function",
          function: { name: tc.function.name, arguments: tc.function.arguments ?? "{}" },
        });
      }
    }
  }
  return { content, toolCalls, finishReason, rawEvents };
}

async function readStream(res: Response): Promise<string[]> {
  const events: string[] = [];
  if (!res.body) return events;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lastSep = buffer.lastIndexOf("\n\n");
    if (lastSep < 0) continue;
    events.push(...parseSseChunk(buffer.slice(0, lastSep + 2)));
    buffer = buffer.slice(lastSep + 2);
  }
  // flush — the final block may arrive without a trailing "\n\n".
  if (buffer.trim()) events.push(...parseSseChunk(buffer));
  return events;
}

function parseJsonResponse(json: {
  choices?: Array<{ finish_reason?: string; message?: { content?: string; tool_calls?: ToolCall[] } }>;
}): { content: string; toolCalls: ToolCall[]; finishReason: string | null; rawEvents: number } {
  const choice = json.choices?.[0];
  const msg = choice?.message;
  return {
    content: typeof msg?.content === "string" ? msg.content : "",
    toolCalls: Array.isArray(msg?.tool_calls) ? msg.tool_calls : [],
    finishReason: choice?.finish_reason ?? null,
    rawEvents: 1,
  };
}

async function runOnce(): Promise<DiagnosticResult> {
  const url = `${BASE.replace(/\/$/, "")}/v1/chat/completions`;
  const body = {
    model: MODEL,
    stream: STREAM,
    provider: PROVIDER,
    messages: [{ role: "user", content: PROMPT }],
    tools: TOOLS,
    tool_choice: "auto",
    max_tokens: 1024,
  };
  const t0 = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_KEY}`,
      accept: STREAM ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
  }
  const parsed = STREAM
    ? parseStreamEvents(await readStream(res))
    : parseJsonResponse((await res.json()) as Parameters<typeof parseJsonResponse>[0]);
  const elapsed = Date.now() - t0;
  const emptyAssistantAfterTools = parsed.toolCalls.length > 0 && parsed.content.trim() === "";
  const notes: string[] = [];
  noteEmptyAssistant(notes, emptyAssistantAfterTools);
  return {
    base: BASE,
    provider: PROVIDER,
    model: MODEL,
    status: res.status,
    durationMs: elapsed,
    finishReason: parsed.finishReason,
    content: parsed.content,
    toolCalls: parsed.toolCalls,
    rawEvents: parsed.rawEvents,
    emptyAssistantAfterTools,
    notes,
  };
}

function summarize(rs: DiagnosticResult[]): Record<string, unknown> {
  const totalCalls = rs.reduce((n, r) => n + r.toolCalls.length, 0);
  const emptyAssistantCount = rs.filter((r) => r.emptyAssistantAfterTools).length;
  const finishReasons = new Map<string, number>();
  for (const r of rs) {
    const k = r.finishReason ?? "unknown";
    finishReasons.set(k, (finishReasons.get(k) ?? 0) + 1);
  }
  return {
    iterations: rs.length,
    totalCalls,
    emptyAssistantAfterToolsCount: emptyAssistantCount,
    finishReasons: Object.fromEntries(finishReasons),
  };
}

async function main(): Promise<void> {
  console.error(`[diag] base=${BASE} provider=${PROVIDER} model=${MODEL} stream=${STREAM} iterations=${ITER}`);
  const results: DiagnosticResult[] = [];
  for (let i = 0; i < ITER; i += 1) {
    if (ITER > 1) console.error(`[diag] iteration ${i + 1}/${ITER}`);
    try {
      results.push(await runOnce());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (ITER === 1) {
        console.error(`[diag] failed: ${msg}`);
        process.exitCode = 1;
        return;
      }
      console.error(`[diag] iteration ${i + 1} failed: ${msg}`);
      await delay(2_000);
    }
  }
  const empty = results.some((r) => r.emptyAssistantAfterTools);
  const output = ITER > 1 ? summarize(results) : (results[0] ?? null);
  console.log(JSON.stringify(output, null, 2));
  if (empty) process.exitCode = 3;
}

await main();