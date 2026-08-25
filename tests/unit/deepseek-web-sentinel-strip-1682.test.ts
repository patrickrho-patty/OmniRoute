// @ts-nocheck
// Regression: the internal reasoning-replay sentinel "(prior reasoning summary
// unavailable)" (#1682) must never reach the client. DeepSeek's web API can echo
// it back through streamed content; the deepseek-web executor strips it at the
// text-introduction chokepoint (sendByPath / appendByPath) so it stays internal.
import test from "node:test";
import assert from "node:assert/strict";

const { DeepSeekWebExecutor } = await import("../../open-sse/executors/deepseek-web.ts");

const SENTINEL = "(prior reasoning summary unavailable)";

// Minimal mocked DeepSeek web flow. Completion stream echoes the sentinel in one
// fragment and emits real content in another.
async function mockFlowEchoingSentinel() {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, _opts) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    if (urlStr.includes("/users/current")) {
      return json({ code: 0, data: { biz_data: { token: "access-tok", email: "t@t.com" } } });
    }
    if (urlStr.includes("/chat_session/create")) {
      return json({ code: 0, data: { biz_data: { chat_session: { id: "sess-1" } } } });
    }
    if (urlStr.includes("/create_pow_challenge")) {
      return json({
        code: 0,
        data: {
          biz_data: {
            challenge: {
              algorithm: "DeepSeekHashV1",
              challenge: "311b26ae1e0fe7375e242958ce46db5552a6c67fea3f96880dcd846c63a74286",
              salt: "1122334455667788",
              signature: "sig123",
              difficulty: 1000,
              expire_at: 1778891543095,
              expire_after: 300000,
              target_path: "/api/v0/chat/completion",
            },
          },
        },
      });
    }
    if (urlStr.includes("/chat_session/delete")) {
      return json({ code: 0 });
    }
    if (urlStr.includes("/chat/completion")) {
      const encoder = new TextEncoder();
      const sse = [
        "event: ready\n",
        'data: {"request_message_id":1,"response_message_id":2}\n',
        "\n",
        // Fragment 1: DeepSeek echoes the internal reasoning-replay sentinel.
        `data: {"v":{"response":{"message_id":2,"fragments":[{"id":1,"type":"RESPONSE","content":${JSON.stringify(
          SENTINEL
        )}}]}}}\n`,
        "\n",
        // Fragment 2: real content that must survive.
        'data: {"v":{"response":{"message_id":2,"fragments":[{"id":2,"type":"RESPONSE","content":"The answer is 42."}]}}}\n',
        "\n",
        'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n',
        "\n",
        "event: close\n",
        'data: {"click_behavior":"none"}\n',
      ].join("");
      return new Response(encoder.encode(sse), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    return new Response("Not found", { status: 404 });
  };

  const dsMod = await import("../../open-sse/executors/deepseek-web.ts");
  dsMod.tokenCache?.clear();
  dsMod.sessionCache?.clear();
  return () => {
    globalThis.fetch = original;
    dsMod.tokenCache?.clear();
    dsMod.sessionCache?.clear();
  };
}

test("deepseek-web strips echoed reasoning-replay sentinel from streamed output (#1682)", async () => {
  const restore = await mockFlowEchoingSentinel();
  try {
    const executor = new DeepSeekWebExecutor();
    const result = await executor.execute({
      model: "default",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: "test-user-token-1234" },
      signal: AbortSignal.timeout(10000),
    });

    assert.ok(result.response.ok, "response should be ok");
    const text = await result.response.text();
    assert.ok(!text.includes(SENTINEL), "sentinel must NOT leak to the client");
    assert.ok(
      text.includes("The answer is 42."),
      "real content after the sentinel must be preserved"
    );
  } finally {
    restore();
  }
});
