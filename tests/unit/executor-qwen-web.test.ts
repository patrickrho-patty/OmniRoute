import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { RegistryModel } from "../../open-sse/config/providers/shared.ts";

const mod = await import("../../open-sse/executors/qwen-web.ts");
const clearance = await import("../../open-sse/services/qwenBrowserBacked.ts");
const { REGISTRY } = await import("../../open-sse/config/providerRegistry.ts");
const { FREE_MODEL_BUDGETS } = await import("../../open-sse/config/freeModelCatalog.data.ts");

type FetchCall = { url: string; init: any };

const realFetch = globalThis.fetch;
let calls: FetchCall[] = [];

/** Build an SSE Response from an array of v2 "phase" delta events. */
function sseResponse(events: Array<Record<string, unknown>>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const ev of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function chatCreatedResponse(id = "chat-abc"): Response {
  return new Response(JSON.stringify({ success: true, data: { id } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** The 504 + HTML page Alibaba's gateway returns for the retired v1 endpoint
 *  and for WAF-blocked requests. */
function wafHtmlResponse(status = 504): Response {
  return new Response(
    "<html>\n<head><title>504 Gateway Time-out</title></head>\n<body>\n" +
      "<center><h1>504 Gateway Time-out</h1></center>\n<hr><center>alibaba-ga</center>\n" +
      '<meta name="aliyun_waf_aa" content="ff926c7f07e45e2e487a29a6197d3460">\n</body>\n</html>',
    { status, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("QwenWebExecutor (v2 migration)", () => {
  it("can be instantiated", () => {
    assert.ok(new mod.QwenWebExecutor());
  });

  it("uses the v2 two-step flow: chats/new then chat/completions?chat_id=", async () => {
    globalThis.fetch = (async (url: any, init: any = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/api/v2/chats/new")) return chatCreatedResponse("chat-xyz");
      return sseResponse([
        { choices: [{ delta: { phase: "answer", content: "Hello", status: "typing" } }] },
        { choices: [{ delta: { phase: "answer", content: " world", status: "finished" } }] },
      ]);
    }) as any;

    const executor = new mod.QwenWebExecutor();
    const result = await executor.execute({
      model: "qwen3.7-max",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "token=jwt-tok; cna=abc; ssxmod_itna=1-xyz" },
      signal: null,
    } as any);

    assert.equal(calls.length, 2, "should make exactly two upstream calls");
    assert.match(calls[0].url, /\/api\/v2\/chats\/new$/);
    assert.equal(calls[0].init.method, "POST");
    assert.match(calls[1].url, /\/api\/v2\/chat\/completions\?chat_id=chat-xyz/);
    assert.equal(calls[1].init.method, "POST");

    // chats/new payload shape
    const newBody = JSON.parse(calls[0].init.body);
    assert.deepEqual(newBody.models, ["qwen3.7-max"]);
    assert.equal(newBody.chat_type, "t2t");
    assert.equal(newBody.chat_mode, "normal");

    // completion payload references the created chat_id
    const compBody = JSON.parse(calls[1].init.body);
    assert.equal(compBody.chat_id, "chat-xyz");
    assert.equal(compBody.model, "qwen3.7-max");
    assert.equal(compBody.messages[0].role, "user");
    assert.equal(compBody.messages[0].content, "hi");
    assert.equal(compBody.messages[0].feature_config.thinking_enabled, false);

    const json = (await result.response.json()) as any;
    assert.equal(json.choices[0].message.content, "Hello world");
  });

  it("uses the fenced JSON synthetic tool envelope instead of Qwen's native tool_call syntax", async () => {
    globalThis.fetch = (async (url: any, init: any = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/api/v2/chats/new")) return chatCreatedResponse("chat-tools");
      return sseResponse([
        {
          choices: [
            {
              delta: {
                phase: "answer",
                content: '```json\n{"name":"bash","arguments":{"cmd":"pwd"}}\n```',
                status: "finished",
              },
            },
          ],
        },
      ]);
    }) as any;

    const executor = new mod.QwenWebExecutor();
    const result = await executor.execute({
      model: "qwen3.7-max",
      body: {
        messages: [{ role: "user", content: "inspect the repository" }],
        tools: [
          {
            type: "function",
            function: {
              name: "bash",
              description: "Run a shell command",
              parameters: { type: "object", properties: { cmd: { type: "string" } } },
            },
          },
        ],
      },
      stream: false,
      credentials: { apiKey: "token=jwt-tok; cna=abc" },
      signal: null,
    } as any);

    const completionBody = JSON.parse(calls[1].init.body);
    const prompt = String(completionBody.messages[0].content);
    assert.match(prompt, /OMNIROUTE TOOL PROTOCOL/);
    assert.match(prompt, /```json/);
    assert.doesNotMatch(prompt, /<tool_call>/);

    const json = (await result.response.json()) as any;
    assert.equal(json.choices[0].finish_reason, "tool_calls");
    assert.equal(json.choices[0].message.content, null);
    assert.equal(json.choices[0].message.tool_calls[0].function.name, "bash");
    assert.deepEqual(JSON.parse(json.choices[0].message.tool_calls[0].function.arguments), {
      cmd: "pwd",
    });
  });

  it("replays assistant tool calls and tool results on follow-up turns", async () => {
    globalThis.fetch = (async (url: any, init: any = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/api/v2/chats/new")) return chatCreatedResponse("chat-followup");
      return sseResponse([
        {
          choices: [
            {
              delta: {
                phase: "answer",
                content: "I found the relevant files.",
                status: "finished",
              },
            },
          ],
        },
      ]);
    }) as any;

    const executor = new mod.QwenWebExecutor();
    await executor.execute({
      model: "qwen3.7-max",
      body: {
        messages: [
          { role: "user", content: "Inspect the repository." },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-find",
                type: "function",
                function: {
                  name: "bash",
                  arguments: '{"cmd":"find /tmp -type f"}',
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call-find",
            content: "/tmp/a.ts\n/tmp/b.ts",
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "bash",
              description: "Run a shell command",
              parameters: { type: "object", properties: { cmd: { type: "string" } } },
            },
          },
        ],
      },
      stream: false,
      credentials: { apiKey: "token=jwt-tok; cna=abc" },
      signal: null,
    } as any);

    const completionBody = JSON.parse(calls[1].init.body);
    const prompt = String(completionBody.messages[0].content);
    assert.match(prompt, /Inspect the repository/);
    assert.match(prompt, /find \/tmp -type f/);
    assert.match(prompt, /Tool result for `bash`/);
    assert.match(prompt, /\/tmp\/a\.ts/);
    assert.match(prompt, /Continue the existing task from these tool results/);
  });

  it("bounds replayed tool history for very large sessions", async () => {
    globalThis.fetch = (async (url: any, init: any = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/api/v2/chats/new")) return chatCreatedResponse("chat-large");
      return sseResponse([
        { choices: [{ delta: { phase: "answer", content: "ok", status: "finished" } }] },
      ]);
    }) as any;

    const staleOutput = `stale-tool-marker ${"x".repeat(120_000)}`;
    const executor = new mod.QwenWebExecutor();
    await executor.execute({
      model: "qwen3.7-max",
      body: {
        messages: [
          { role: "system", content: "base system context" },
          { role: "user", content: "review the repository" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-stale",
                type: "function",
                function: { name: "bash", arguments: '{"cmd":"cat old.log"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call-stale", content: staleOutput },
          { role: "user", content: "latest-user-marker" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "bash",
              description: "Run a shell command",
              parameters: { type: "object", properties: { cmd: { type: "string" } } },
            },
          },
        ],
      },
      stream: false,
      credentials: { apiKey: "token=jwt-tok; cna=abc" },
      signal: null,
    } as any);

    const completionBody = JSON.parse(calls[1].init.body);
    const prompt = String(completionBody.messages[0].content);
    assert.ok(prompt.length < 60_000, `expected bounded prompt, got ${prompt.length}`);
    assert.match(prompt, /latest-user-marker/);
    assert.match(prompt, /OMNIROUTE TOOL PROTOCOL/);
  });

  it("decodes a fenced tool call emitted in the think phase when no answer phase arrives", async () => {
    globalThis.fetch = (async (url: any, init: any = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/api/v2/chats/new")) return chatCreatedResponse("chat-think");
      return sseResponse([
        {
          choices: [
            {
              delta: {
                phase: "think",
                content: '```json\n{"name":"bash","arguments":{"cmd":"pwd"}}\n```',
                status: "finished",
              },
            },
          ],
        },
      ]);
    }) as any;

    const executor = new mod.QwenWebExecutor();
    const result = await executor.execute({
      model: "qwen3.7-max",
      body: {
        messages: [{ role: "user", content: "inspect the repository" }],
        tools: [
          {
            type: "function",
            function: {
              name: "bash",
              description: "Run a shell command",
              parameters: { type: "object", properties: { cmd: { type: "string" } } },
            },
          },
        ],
      },
      stream: false,
      credentials: { apiKey: "token=jwt-tok; cna=abc" },
      signal: null,
    } as any);

    const json = (await result.response.json()) as any;
    assert.equal(json.choices[0].finish_reason, "tool_calls");
    assert.equal(json.choices[0].message.tool_calls[0].function.name, "bash");
  });

  it("replays the full cookie jar and the extracted bearer token on every call", async () => {
    globalThis.fetch = (async (url: any, init: any = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/api/v2/chats/new")) return chatCreatedResponse();
      return sseResponse([
        { choices: [{ delta: { phase: "answer", content: "ok", status: "finished" } }] },
      ]);
    }) as any;

    const cookieBlob = "token=jwt-secret; cna=CNA1; ssxmod_itna=1-AAA; ssxmod_itna2=1-BBB";
    const executor = new mod.QwenWebExecutor();
    await executor.execute({
      model: "qwen3.7-plus",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: cookieBlob },
      signal: null,
    } as any);

    for (const call of calls) {
      const headers = call.init.headers as Record<string, string>;
      const cookie = headers.Cookie || headers.cookie || "";
      assert.match(cookie, /cna=CNA1/, "full cookie jar must be replayed");
      assert.match(cookie, /ssxmod_itna=1-AAA/, "WAF cookies must be replayed");
      const auth = headers.Authorization || headers.authorization || "";
      assert.equal(auth, "Bearer jwt-secret", "bearer token extracted from token= cookie");
    }
  });

  it("sends the anti-bot headers required by the v2 endpoint", async () => {
    globalThis.fetch = (async (url: any, init: any = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/api/v2/chats/new")) return chatCreatedResponse();
      return sseResponse([
        { choices: [{ delta: { phase: "answer", content: "ok", status: "finished" } }] },
      ]);
    }) as any;

    const executor = new mod.QwenWebExecutor();
    await executor.execute({
      model: "qwen3.7-plus",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "token=t; cna=c" },
      signal: null,
    } as any);

    const headers = calls[0].init.headers as Record<string, string>;
    assert.ok(headers["bx-v"], "bx-v header present");
    assert.ok(headers["bx-umidtoken"], "bx-umidtoken header present");
    assert.equal(headers.source || headers.Source, "web", "source: web header present");
  });

  it("sends the Qwen SPA build 'version' header on the v2 chat completion request", async () => {
    globalThis.fetch = (async (url: any, init: any = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/api/v2/chats/new")) return chatCreatedResponse();
      return sseResponse([
        { choices: [{ delta: { phase: "answer", content: "ok", status: "finished" } }] },
      ]);
    }) as any;

    const executor = new mod.QwenWebExecutor();
    await executor.execute({
      model: "qwen3.7-plus",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "token=t; cna=c" },
      signal: null,
    } as any);

    // Without the `version` header the v2 endpoint short-circuits with a
    // Bad_Request envelope before ever reaching the model router — see
    // open-sse/executors/qwen-web.ts::QWEN_SPA_VERSION.
    const completionCall = calls.find((call) => call.url.includes("/api/v2/chat/completions"));
    assert.ok(completionCall, "chat/completions call must have been made");
    const headers = completionCall!.init.headers as Record<string, string>;
    assert.equal(headers.version, "0.2.81", "SPA build version header present");
  });

  it("maps the thinking phase to reasoning_content, not the answer content", async () => {
    globalThis.fetch = (async (url: any) => {
      if (String(url).includes("/api/v2/chats/new")) return chatCreatedResponse();
      return sseResponse([
        { choices: [{ delta: { phase: "think", content: "let me think", status: "typing" } }] },
        { choices: [{ delta: { phase: "think", content: "...", status: "finished" } }] },
        { choices: [{ delta: { phase: "answer", content: "Final answer", status: "finished" } }] },
      ]);
    }) as any;

    const executor = new mod.QwenWebExecutor();
    const result = await executor.execute({
      model: "qwen3.7-max",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "token=t; cna=c" },
      signal: null,
    } as any);

    const json = (await result.response.json()) as any;
    assert.equal(json.choices[0].message.content, "Final answer");
    assert.ok(
      !String(json.choices[0].message.content).includes("let me think"),
      "thinking content must not leak into the answer"
    );
  });

  it("classifies the retired-v1 / WAF 504 HTML page as a clear auth error (not raw HTML)", async () => {
    globalThis.fetch = (async (url: any) => {
      if (String(url).includes("/api/v2/chats/new")) return wafHtmlResponse(504);
      return chatCreatedResponse();
    }) as any;

    const executor = new mod.QwenWebExecutor();
    const result = await executor.execute({
      model: "qwen3.7-max",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "token=stale; cna=c" },
      signal: null,
    } as any);

    assert.ok([401, 403].includes(result.response.status), "should map to an auth status");
    const json = (await result.response.json()) as any;
    const msg = String(json.error?.message || "");
    assert.ok(!msg.includes("<html"), "raw HTML must not be returned to the client");
    assert.match(msg, /session|expired|WAF|re-?login|cookie/i, "actionable error message");
  });

  // Live capture (2026-08, VPS egress): the completion endpoint answers the
  // risk-control block with HTTP 200 + JSON (not SSE), carrying the baxia
  // punish payload. It must surface as an honest 429 risk-control error —
  // NOT flow downstream as an empty "successful" stream that #8649 later
  // mislabels "Provider returned empty content".
  function punishResponse(): Response {
    return new Response(
      JSON.stringify({
        ret: ["FAIL_SYS_USER_VALIDATE", "RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试"],
        data: {
          url: "https://chat.qwen.ai:443//api/v2/chat/completions/_____tmd_____/punish?x5secdata=xg41fa…&x5step=2&action=captcha&pureCaptcha=",
        },
      }),
      { status: 200, headers: { "content-type": "application/json;charset=UTF-8" } }
    );
  }

  it("surfaces the Aliyun baxia punish JSON (200, non-SSE) as an honest 429 risk-control error", async () => {
    globalThis.fetch = (async (url: any) => {
      if (String(url).includes("/api/v2/chats/new")) return chatCreatedResponse();
      return punishResponse();
    }) as any;

    const executor = new mod.QwenWebExecutor();
    const result = await executor.execute({
      model: "qwen3.8-max-preview",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: "token=valid-jwt; cna=abc; ssxmod_itna=1-xyz" },
      signal: null,
    } as any);

    // 429, not 401/403: the cookie is valid (chats/new succeeded) — 401/403
    // would expire/ban the healthy connection in chatCore's classifier.
    assert.equal(result.response.status, 429);
    const json = (await result.response.json()) as any;
    const msg = String(json.error?.message || "");
    assert.match(msg, /risk-control|captcha|proxy/i, "must name the real cause and remedy");
    assert.match(msg, /cookie is still valid|cookie.*valid/i, "must not blame the cookie");
  });

  it("also detects the punish shape on the chats/new step", async () => {
    globalThis.fetch = (async () => punishResponse()) as any;

    const executor = new mod.QwenWebExecutor();
    const result = await executor.execute({
      model: "qwen3.7-max",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "token=valid-jwt; cna=abc" },
      signal: null,
    } as any);

    assert.equal(result.response.status, 429);
    const json = (await result.response.json()) as any;
    assert.match(String(json.error?.message || ""), /risk-control/i);
  });

  // ── Browser-backed fallback (baxia per-request attestation) ──────────────
  // Only the SPA's own send path satisfies baxia; when the gate is on, a
  // punished completion retries through browserBackedChat via the shared
  // browser pool. These tests use the injection hook — no Chromium needed.

  it("punish + browser pool on + browser fallback success → serves the captured SSE", async () => {
    const prevPool = process.env.OMNIROUTE_BROWSER_POOL;
    process.env.OMNIROUTE_BROWSER_POOL = "on";
    let overrideParams: Record<string, unknown> | null = null;
    clearance.__setQwenBrowserCompletionOverrideForTesting(async (p: any) => {
      overrideParams = p;
      return sseResponse([
        { choices: [{ delta: { phase: "answer", content: "Hello", status: "finished" } }] },
      ]);
    });
    try {
      globalThis.fetch = (async (url: any) => {
        if (String(url).includes("/api/v2/chats/new")) return chatCreatedResponse("chat-bx");
        return punishResponse();
      }) as any;

      const executor = new mod.QwenWebExecutor();
      const result = await executor.execute({
        model: "qwen3.7-max",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: { apiKey: "token=jwt; cna=abc; ssxmod_itna=1-x" },
        signal: null,
      } as any);

      const json = (await result.response.json()) as any;
      assert.equal(
        json.choices[0].message.content,
        "Hello",
        "answer must come from the browser-captured SSE"
      );
      assert.ok(overrideParams, "browser fallback must have been invoked");
      assert.equal((overrideParams as any).chatId, "chat-bx");
      assert.equal((overrideParams as any).prompt, "hi");
    } finally {
      clearance.__setQwenBrowserCompletionOverrideForTesting(null);
      if (prevPool === undefined) delete process.env.OMNIROUTE_BROWSER_POOL;
      else process.env.OMNIROUTE_BROWSER_POOL = prevPool;
    }
  });

  it("punish + browser pool on + fallback failure → honest 429 risk-control error", async () => {
    const prevPool = process.env.OMNIROUTE_BROWSER_POOL;
    process.env.OMNIROUTE_BROWSER_POOL = "on";
    clearance.__setQwenBrowserCompletionOverrideForTesting(async () => null);
    try {
      globalThis.fetch = (async (url: any) => {
        if (String(url).includes("/api/v2/chats/new")) return chatCreatedResponse();
        return punishResponse();
      }) as any;

      const executor = new mod.QwenWebExecutor();
      const result = await executor.execute({
        model: "qwen3.7-max",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: { apiKey: "token=jwt; cna=abc" },
        signal: null,
      } as any);

      assert.equal(result.response.status, 429);
    } finally {
      clearance.__setQwenBrowserCompletionOverrideForTesting(null);
      if (prevPool === undefined) delete process.env.OMNIROUTE_BROWSER_POOL;
      else process.env.OMNIROUTE_BROWSER_POOL = prevPool;
    }
  });

  it("punish + browser pool OFF → 429 without invoking the browser path", async () => {
    const prevPool = process.env.OMNIROUTE_BROWSER_POOL;
    const prevWeb = process.env.WEB_COOKIE_USE_BROWSER;
    delete process.env.OMNIROUTE_BROWSER_POOL;
    delete process.env.WEB_COOKIE_USE_BROWSER;
    let invoked = false;
    clearance.__setQwenBrowserCompletionOverrideForTesting(async () => {
      invoked = true;
      return null;
    });
    try {
      globalThis.fetch = (async (url: any) => {
        if (String(url).includes("/api/v2/chats/new")) return chatCreatedResponse();
        return punishResponse();
      }) as any;

      const executor = new mod.QwenWebExecutor();
      const result = await executor.execute({
        model: "qwen3.7-max",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: { apiKey: "token=jwt; cna=abc" },
        signal: null,
      } as any);

      assert.equal(result.response.status, 429);
      assert.equal(invoked, false, "browser path must not run with the gate off");
    } finally {
      clearance.__setQwenBrowserCompletionOverrideForTesting(null);
      if (prevPool === undefined) delete process.env.OMNIROUTE_BROWSER_POOL;
      else process.env.OMNIROUTE_BROWSER_POOL = prevPool;
      if (prevWeb === undefined) delete process.env.WEB_COOKIE_USE_BROWSER;
      else process.env.WEB_COOKIE_USE_BROWSER = prevWeb;
    }
  });

  it("treats any other non-SSE 200 body as an honest upstream error (no empty stream)", async () => {
    globalThis.fetch = (async (url: any) => {
      if (String(url).includes("/api/v2/chats/new")) return chatCreatedResponse();
      return new Response(JSON.stringify({ code: "InvalidParameter", message: "bad model" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as any;

    const executor = new mod.QwenWebExecutor();
    const result = await executor.execute({
      model: "qwen3.7-max",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "token=t; cna=c" },
      signal: null,
    } as any);

    assert.ok(result.response.status >= 400, "non-SSE 200 must not pass as success");
    const json = (await result.response.json()) as any;
    assert.match(String(json.error?.message || ""), /InvalidParameter|Qwen error/);
  });

  it("streams answer-phase content as OpenAI chat.completion.chunk deltas", async () => {
    globalThis.fetch = (async (url: any) => {
      if (String(url).includes("/api/v2/chats/new")) return chatCreatedResponse();
      return sseResponse([
        { choices: [{ delta: { phase: "answer", content: "Hi", status: "typing" } }] },
        { choices: [{ delta: { phase: "answer", content: " there", status: "finished" } }] },
      ]);
    }) as any;

    const executor = new mod.QwenWebExecutor();
    const result = await executor.execute({
      model: "qwen3.7-max",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: "token=t; cna=c" },
      signal: null,
    } as any);

    const text = await result.response.text();
    assert.match(text, /chat\.completion\.chunk/);
    assert.match(text, /"content":"Hi"/);
    assert.match(text, /"content":" there"/);
    assert.match(text, /data: \[DONE\]/);
  });

  it("accepts a bare token (back-compat) without a cookie jar", async () => {
    globalThis.fetch = (async (url: any, init: any = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/api/v2/chats/new")) return chatCreatedResponse();
      return sseResponse([
        { choices: [{ delta: { phase: "answer", content: "ok", status: "finished" } }] },
      ]);
    }) as any;

    const executor = new mod.QwenWebExecutor();
    await executor.execute({
      model: "qwen3.7-plus",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "barejwttoken" },
      signal: null,
    } as any);

    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization || headers.authorization, "Bearer barejwttoken");
  });

  it("registry points at the v2 endpoint and the current model catalog", () => {
    const provider = (REGISTRY as any)["qwen-web"];
    assert.ok(provider, "qwen-web must be registered");
    assert.match(
      provider.baseUrl,
      /\/api\/v2\/chat\/completions$/,
      "registry must use v2 endpoint"
    );
    const ids = provider.models.map((m: any) => m.id);
    assert.deepEqual(ids.sort(), ["qwen3.6-plus", "qwen3.7-max", "qwen3.7-plus", "qwen3.8-max"]);

    const qwen38 = provider.models.find((model: RegistryModel) => model.id === "qwen3.8-max");
    assert.deepEqual(qwen38, {
      id: "qwen3.8-max",
      name: "Qwen3.8 Max",
      toolCalling: false,
      supportsReasoning: true,
      supportsVision: true,
      contextLength: 1_000_000,
      maxOutputTokens: 131_072,
    });

    const qwen37Max = provider.models.find((model: RegistryModel) => model.id === "qwen3.7-max");
    assert.equal(qwen37Max.supportsVision, false);
  });

  it("free-model catalog lists the current qwen-web ids (not the retired ones)", () => {
    const qwenModels = (FREE_MODEL_BUDGETS as any[]).filter((m) => m.provider === "qwen-web");
    const ids = qwenModels.map((m) => m.modelId);
    assert.ok(ids.includes("qwen3.8-max"), "catalog must list qwen3.8-max");
    assert.ok(ids.includes("qwen3.7-max"), "catalog must list qwen3.7-max");
    assert.ok(!ids.includes("qwen-plus"), "retired qwen-plus must be gone");
    assert.ok(
      qwenModels.every((m) => m.freeType !== "discontinued"),
      "qwen-web is no longer discontinued after the v2 migration"
    );
  });

  it("uses qwen3.8-max and maps its preview id for compatibility", async () => {
    globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/api/v2/chats/new")) return chatCreatedResponse();
      return sseResponse([
        { choices: [{ delta: { phase: "answer", content: "ok", status: "finished" } }] },
      ]);
    }) as typeof globalThis.fetch;

    const executor = new mod.QwenWebExecutor();
    await executor.execute({
      model: "qwen3.8-max-preview",
      body: {
        model: "qwen3.8-max-preview",
        messages: [{ role: "user", content: "hi" }],
      },
      stream: false,
      credentials: { apiKey: "token=t; cna=c" },
      signal: null,
    });

    const newBody = JSON.parse(calls[0].init.body);
    const completionBody = JSON.parse(calls[1].init.body);
    assert.deepEqual(newBody.models, ["qwen3.8-max"]);
    assert.equal(completionBody.model, "qwen3.8-max");
    assert.equal(completionBody.messages[0].feature_config.thinking_enabled, true);
    assert.equal(completionBody.messages[0].feature_config.auto_thinking, true);
  });

  it("maps legacy model ids to the current upstream catalog", async () => {
    globalThis.fetch = (async (url: any, init: any = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/api/v2/chats/new")) return chatCreatedResponse();
      return sseResponse([
        { choices: [{ delta: { phase: "answer", content: "ok", status: "finished" } }] },
      ]);
    }) as any;

    const executor = new mod.QwenWebExecutor();
    await executor.execute({
      model: "qwen3-max",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "token=t; cna=c" },
      signal: null,
    } as any);

    const newBody = JSON.parse(calls[0].init.body);
    assert.match(newBody.models[0], /^qwen3\.[67]-/, "legacy qwen3-max maps to a current model id");
  });
});
