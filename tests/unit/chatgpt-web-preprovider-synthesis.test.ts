// Pre-provider tool-call synthesis for the ChatGPT Web executor.
//
// synthesizePreProviderToolCall() intercepts filesystem/git/package.json
// requests BEFORE they reach ChatGPT, so the model never gets a chance to
// confabulate file contents or claim the filesystem is unavailable. These
// tests cover: positive cases (correct synthesis), false-positive guards
// (conversational mentions don't trigger), and security (shell injection
// is blocked by the regex char class + shellQuote).

import test from "node:test";
import assert from "node:assert/strict";

const { ChatGptWebExecutor, __resetChatGptWebCachesForTesting } =
  await import("../../open-sse/executors/chatgpt-web.ts");
const { __setTlsFetchOverrideForTesting } =
  await import("../../open-sse/services/chatgptTlsClient.ts");

// ─── Mock infrastructure (adapted from chatgpt-web-tools-5240.test.ts) ───────

function makeHeaders(map: Record<string, string> = {}) {
  const h = new Headers();
  for (const [k, v] of Object.entries(map)) h.set(k, String(v));
  return h;
}

function installMockFetch() {
  const calls = { urls: [] as string[], count: 0 };

  __setTlsFetchOverrideForTesting(async (url: string, opts: any = {}) => {
    const u = String(url);
    calls.urls.push(u);
    calls.count++;
    const json = (body: unknown, status = 200) => ({
      status,
      headers: makeHeaders({ "Content-Type": "application/json" }),
      text: JSON.stringify(body),
      body: null,
    });

    if (
      (u === "https://chatgpt.com/" || u === "https://chatgpt.com") &&
      (opts.method || "GET") === "GET"
    ) {
      return {
        status: 200,
        headers: makeHeaders({ "Content-Type": "text/html" }),
        text: '<html data-build="prod-test123"><script src="https://cdn.oaistatic.com/_next/static/chunks/main-test.js"></script></html>',
        body: null,
      };
    }
    if (u.includes("/api/auth/session")) {
      return json({
        accessToken: "jwt-abc",
        expires: new Date(Date.now() + 3600_000).toISOString(),
        user: { id: "u1" },
      });
    }
    if (u.includes("/sentinel/chat-requirements")) {
      return json({ token: "req-token", proofofwork: { required: false } });
    }
    if (u.includes("/backend-api/") && u.includes("conversation")) {
      // If synthesis works, this should NEVER be reached for synthesized cases.
      return {
        status: 200,
        headers: makeHeaders({ "Content-Type": "text/event-stream" }),
        text: `data: ${JSON.stringify({
          conversation_id: "tc-1",
          message: {
            id: "tm-1",
            author: { role: "assistant" },
            content: { content_type: "text", parts: ["ChatGPT replied (synthesis did NOT fire)"] },
            status: "finished_successfully",
          },
        })}\r\n\r\ndata: [DONE]\r\n\r\n`,
        body: null,
      };
    }
    return { status: 404, headers: makeHeaders(), text: "not mocked", body: null };
  });

  return {
    calls,
    restore() {
      __setTlsFetchOverrideForTesting(null);
    },
  };
}

const READ_TOOL = {
  type: "function",
  function: {
    name: "read",
    description: "Read a file from the local filesystem",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
};

const BASH_TOOL = {
  type: "function",
  function: {
    name: "bash",
    description: "Execute a bash command",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
};

function baseOpts(extra: Record<string, unknown>) {
  return {
    model: "gpt-5.3-instant",
    credentials: { apiKey: "test" },
    signal: AbortSignal.timeout(10_000),
    log: null,
    ...extra,
  };
}

async function execSynthesis(body: Record<string, unknown>) {
  const m = installMockFetch();
  try {
    const executor = new ChatGptWebExecutor();
    const result = await executor.execute(baseOpts({ body, stream: false }) as any);
    const json = await (result.response as Response).json();
    return { json, convHitCount: m.calls.count };
  } finally {
    m.restore();
  }
}

function getToolCalls(json: any) {
  return json?.choices?.[0]?.message?.tool_calls;
}

// ─── Positive cases: synthesis fires correctly ───────────────────────────────

test("Pre-provider: 'Read package.json' → read('package.json')", async () => {
  __resetChatGptWebCachesForTesting();
  const { json } = await execSynthesis({
    messages: [{ role: "user", content: "Read the file package.json in the current directory" }],
    tools: [READ_TOOL],
  });
  const tcs = getToolCalls(json);
  assert.ok(tcs && tcs.length === 1, "one tool call synthesized");
  assert.equal(tcs[0].function.name, "read");
  assert.equal(JSON.parse(tcs[0].function.arguments).path, "package.json");
  assert.equal(json.choices[0].finish_reason, "tool_calls");
});

test("Pre-provider: 'Read /etc/hostname' → read('/etc/hostname')", async () => {
  __resetChatGptWebCachesForTesting();
  const { json } = await execSynthesis({
    messages: [{ role: "user", content: "Read /etc/hostname using the read tool" }],
    tools: [READ_TOOL],
  });
  const tcs = getToolCalls(json);
  assert.ok(tcs && tcs.length === 1);
  assert.equal(tcs[0].function.name, "read");
  assert.equal(JSON.parse(tcs[0].function.arguments).path, "/etc/hostname");
});

test("Pre-provider: 'pnpm dev' → read('package.json')", async () => {
  __resetChatGptWebCachesForTesting();
  const { json } = await execSynthesis({
    messages: [{ role: "user", content: "What does pnpm dev do?" }],
    tools: [READ_TOOL, BASH_TOOL],
  });
  const tcs = getToolCalls(json);
  assert.ok(tcs && tcs.length === 1);
  assert.equal(tcs[0].function.name, "read");
  assert.equal(JSON.parse(tcs[0].function.arguments).path, "package.json");
});

test("Pre-provider: 'List files' → bash('ls -la .')", async () => {
  __resetChatGptWebCachesForTesting();
  const { json } = await execSynthesis({
    messages: [{ role: "user", content: "List the files in the current directory" }],
    tools: [BASH_TOOL],
  });
  const tcs = getToolCalls(json);
  assert.ok(tcs && tcs.length === 1);
  assert.equal(tcs[0].function.name, "bash");
  const cmd = JSON.parse(tcs[0].function.arguments).command;
  assert.match(cmd, /^ls -la /);
});

test("Pre-provider: 'Run git status' → bash('git status')", async () => {
  __resetChatGptWebCachesForTesting();
  const { json } = await execSynthesis({
    messages: [{ role: "user", content: "Run git status to check the repo state" }],
    tools: [BASH_TOOL],
  });
  const tcs = getToolCalls(json);
  assert.ok(tcs && tcs.length === 1);
  assert.equal(tcs[0].function.name, "bash");
  assert.equal(JSON.parse(tcs[0].function.arguments).command, "git status");
});

test("Pre-provider: 'get me the git status' → bash('git status')", async () => {
  __resetChatGptWebCachesForTesting();
  const { json } = await execSynthesis({
    messages: [{ role: "user", content: "can you get me the git status" }],
    tools: [BASH_TOOL],
  });
  const tcs = getToolCalls(json);
  assert.ok(tcs && tcs.length === 1);
  assert.equal(tcs[0].function.name, "bash");
  assert.equal(JSON.parse(tcs[0].function.arguments).command, "git status");
});

test("Pre-provider: 'give me the git log' → bash('git log')", async () => {
  __resetChatGptWebCachesForTesting();
  const { json } = await execSynthesis({
    messages: [{ role: "user", content: "give me the git log" }],
    tools: [BASH_TOOL],
  });
  const tcs = getToolCalls(json);
  assert.ok(tcs && tcs.length === 1);
  assert.equal(tcs[0].function.name, "bash");
  assert.equal(JSON.parse(tcs[0].function.arguments).command, "git log");
});

test("Pre-provider: 'tell me the git branch' → bash('git branch')", async () => {
  __resetChatGptWebCachesForTesting();
  const { json } = await execSynthesis({
    messages: [{ role: "user", content: "tell me the git branch" }],
    tools: [BASH_TOOL],
  });
  const tcs = getToolCalls(json);
  assert.ok(tcs && tcs.length === 1);
  assert.equal(tcs[0].function.name, "bash");
  assert.equal(JSON.parse(tcs[0].function.arguments).command, "git branch");
});

// ─── False-positive guards: conversational mentions must NOT fire ─────────────

test("Pre-provider guard: 'the git log shows...' does NOT synthesize", async () => {
  __resetChatGptWebCachesForTesting();
  const { json } = await execSynthesis({
    messages: [
      {
        role: "user",
        content: "I think the git log shows the problem. Can you help me understand it?",
      },
    ],
    tools: [BASH_TOOL],
  });
  // No synthesis — either ChatGPT replies or no tool_calls in the response.
  const tcs = getToolCalls(json);
  if (tcs) {
    // If tool_calls exist, they must NOT be a bare 'git log' from conversation mention.
    for (const tc of tcs) {
      const cmd = JSON.parse(tc.function.arguments).command || "";
      assert.doesNotMatch(
        cmd,
        /^git (log|status|diff|branch)$/,
        "bare git command from conversational mention"
      );
    }
  }
});

test("Pre-provider guard: 'read the documentation' does NOT synthesize read()", async () => {
  __resetChatGptWebCachesForTesting();
  const { json } = await execSynthesis({
    messages: [
      { role: "user", content: "Can you read the documentation and explain how it works?" },
    ],
    tools: [READ_TOOL],
  });
  const tcs = getToolCalls(json);
  if (tcs) {
    // 'documentation' is not a path-shaped token, so read() should not fire.
    for (const tc of tcs) {
      if (tc.function.name === "read") {
        const p = JSON.parse(tc.function.arguments).path || "";
        assert.notEqual(p, "documentation", "'read the documentation' captured as path");
      }
    }
  }
});

test("Pre-provider guard: URL in message does NOT synthesize cat()", async () => {
  __resetChatGptWebCachesForTesting();
  const { json } = await execSynthesis({
    messages: [{ role: "user", content: "Check https://example.com for the latest updates" }],
    tools: [READ_TOOL, BASH_TOOL],
  });
  const tcs = getToolCalls(json);
  if (tcs) {
    for (const tc of tcs) {
      const cmd = JSON.parse(tc.function.arguments).command || "";
      const path = JSON.parse(tc.function.arguments).path || "";
      assert.doesNotMatch(cmd, /example\.com/, "URL captured into bash command");
      assert.doesNotMatch(path, /example\.com/, "URL captured into read path");
    }
  }
});

// ─── Security: shell injection blocked ────────────────────────────────────────

test("Pre-provider security: shell metacharacters in path are blocked by regex char class", async () => {
  __resetChatGptWebCachesForTesting();
  // The regex char class [\w./-] blocks ;, |, &, $, (, ), spaces, etc.
  // 'read foo;rm -rf /' → captures only 'foo' (stops at ';').
  const { json } = await execSynthesis({
    messages: [{ role: "user", content: "read foo;rm -rf /" }],
    tools: [BASH_TOOL],
  });
  const tcs = getToolCalls(json);
  if (tcs) {
    for (const tc of tcs) {
      const cmd = JSON.parse(tc.function.arguments).command || "";
      assert.doesNotMatch(cmd, /rm\s+-rf/, "shell injection via semicolon");
    }
  }
});

// ─── No-tools guard: synthesis does not run without tools ─────────────────────

test("Pre-provider guard: no tools → no synthesis, ChatGPT handles it", async () => {
  __resetChatGptWebCachesForTesting();
  const { json, convHitCount } = await execSynthesis({
    messages: [{ role: "user", content: "Read /etc/hostname" }],
    // No tools array
  });
  const tcs = getToolCalls(json);
  assert.ok(!tcs || tcs.length === 0, "no tool_calls when no tools are provided");
  // ChatGPT conversation endpoint was hit (synthesis skipped).
  assert.ok(convHitCount > 0, "request reached ChatGPT (synthesis correctly skipped)");
});
