#!/usr/bin/env -S node --import tsx/esm
/**
 * chatgpt-web tool-call diagnostic harness.
 *
 * Runs against a deployed OmniRoute instance (default: the Contabo gateway at
 * https://omni.agents.patty.io) and probes the chatgpt-web provider with a
 * known tool-calling prompt. Captures:
 *
 *   - HTTP status + headers
 *   - the raw SSE chunks (parsed into events)
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
 * Required env vars:
 *   OMNIROUTE_API_KEY  — management-scoped API key for the target instance.
 *   OMNIROUTE_PROVIDER — provider ID (default chatgpt-web).
 *   OMNIROUTE_MODEL    — model ID (default gpt-5).
 *   OMNIROUTE_BASE     — base URL (default https://omni.agents.patty.io).
 */

import { setTimeout as delay } from "node:timers/promises";

const BASE = process.env.OMNIROUTE_BASE || "https://omni.agents.patty.io";
const API_KEY = process.env.OMNIROUTE_API_KEY;
const PROVIDER = process.env.OMNIROUTE_PROVIDER || "chatgpt-web";
const MODEL = process.env.OMNIROUTE_MODEL || "gpt-5";
const STREAM = process.env.OMNIROUTE_STREAM !== "false";

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
        properties: {
          cmd: { type: "string", description: "The command to run." },
        },
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
  'Task: list the files in /tmp and read the first one. Emit the appropriate declared tool calls.',
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
  const notes: string[] = [];
  const content: string[] = [];
  const toolCalls: ToolCall[] = [];
  let rawEvents = 0;
  let finishReason: string | null = null;
  if (STREAM && res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const event = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = event.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const data = line.slice("data: ".length).trim();
        if (!data || data === "[DONE]") continue;
        rawEvents += 1;
        try {
          const payload = JSON.parse(data);
          const choice = payload?.choices?.[0];
          if (!choice) continue;
          if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
          const delta = choice.delta ?? choice.message;
          if (typeof delta?.content === "string") content.push(delta.content);
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
        } catch {
          notes.push(`unparseable SSE event: ${data.slice(0, 100)}`);
        }
      }
    }
  } else {
    const json = await res.json() as {
      choices?: Array<{ finish_reason?: string; message?: { content?: string; tool_calls?: ToolCall[] } }>;
    };
    finishReason = json.choices?.[0]?.finish_reason ?? null;
    const msg = json.choices?.[0]?.message;
    if (msg?.content) content.push(msg.content);
    if (msg?.tool_calls) toolCalls.push(...msg.tool_calls);
  }
  const elapsed = Date.now() - t0;
  const fullContent = content.join("");
  const emptyAssistantAfterTools = toolCalls.length > 0 && fullContent.trim() === "";
  if (emptyAssistantAfterTools) {
    notes.push(
      "[SYMPTOM] Empty assistant response after tool_calls completion — " +
        "this matches the deployed-instance log pattern. Likely cause: " +
        "the model emits the call and then no prose; check tool result " +
        "round-trip or the model's first-post-tool output."
    );
  }
  return {
    base: BASE,
    provider: PROVIDER,
    model: MODEL,
    status: res.status,
    durationMs: elapsed,
    finishReason,
    content: fullContent,
    toolCalls,
    rawEvents,
    emptyAssistantAfterTools,
    notes,
  };
}

async function main() {
  console.error(`[diag] base=${BASE} provider=${PROVIDER} model=${MODEL} stream=${STREAM}`);
  try {
    const result = await runOnce();
    console.log(JSON.stringify(result, null, 2));
    if (result.emptyAssistantAfterTools) process.exitCode = 3;
  } catch (err) {
    console.error("[diag] failed:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

// Allow running once or N times in a loop (OMNIROUTE_ITERATIONS=N)
const ITER = Number(process.env.OMNIROUTE_ITERATIONS || "1");
async function runMany() {
  const results: DiagnosticResult[] = [];
  for (let i = 0; i < ITER; i += 1) {
    console.error(`[diag] iteration ${i + 1}/${ITER}`);
    try {
      const r = await runOnce();
      results.push(r);
    } catch (err) {
      console.error(`[diag] iteration ${i + 1} failed:`, err instanceof Error ? err.message : String(err));
      await delay(2_000);
    }
  }
  console.log(JSON.stringify({ iterations: results.length, summary: summarize(results) }, null, 2));
}

function summarize(rs: DiagnosticResult[]) {
  const totalCalls = rs.reduce((n, r) => n + r.toolCalls.length, 0);
  const emptyAssistantCount = rs.filter((r) => r.emptyAssistantAfterTools).length;
  const finishReasons = new Map<string, number>();
  for (const r of rs) {
    const k = r.finishReason ?? "unknown";
    finishReasons.set(k, (finishReasons.get(k) ?? 0) + 1);
  }
  return {
    totalCalls,
    emptyAssistantAfterToolsCount: emptyAssistantCount,
    finishReasons: Object.fromEntries(finishReasons),
  };
}

if (ITER > 1) {
  await runMany();
} else {
  await main();
}