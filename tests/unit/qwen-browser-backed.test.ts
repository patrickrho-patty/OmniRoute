import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

const browserChat = await import("../../open-sse/services/browserBackedChat.ts");
const qwenBrowser = await import("../../open-sse/services/qwenBrowserBacked.ts");

afterEach(() => {
  browserChat.__setBrowserBackedChatOverrideForTesting(null);
});

function result(options: { status?: number; contentType: string; body: string }) {
  return {
    status: options.status ?? 200,
    contentType: options.contentType,
    body: Buffer.from(options.body, "utf8"),
    isStealth: false,
    timing: {
      acquireContextMs: 1,
      navigateMs: 1,
      submitMs: 1,
      captureResponseMs: 1,
      totalMs: 1,
    },
  };
}

describe("qwen browser-backed capture validation", () => {
  it("accepts a Qwen SSE capture", async () => {
    browserChat.__setBrowserBackedChatOverrideForTesting(async () =>
      result({
        contentType: "text/event-stream; charset=utf-8",
        body: 'data: {"choices":[{"delta":{"phase":"answer","content":"ok"}}]}\n\ndata: [DONE]\n\n',
      })
    );

    const response = await qwenBrowser.qwenBrowserBackedCompletion({
      chatId: "chat-id",
      prompt: "hello",
      cookieHeader: "token=t; cna=c",
    });

    assert.ok(response);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /text\/event-stream/);
  });

  it("rejects a 200 application/json capture instead of forwarding an empty stream", async () => {
    browserChat.__setBrowserBackedChatOverrideForTesting(async () =>
      result({
        contentType: "application/json;charset=UTF-8",
        body: JSON.stringify({ errorCode: "NOT_FOUND", success: false }),
      })
    );

    const response = await qwenBrowser.qwenBrowserBackedCompletion({
      chatId: "chat-id",
      prompt: "hello",
      cookieHeader: "token=t; cna=c",
    });

    assert.equal(response, null);
  });

  it("rejects an SSE body with no Qwen phase deltas", async () => {
    browserChat.__setBrowserBackedChatOverrideForTesting(async () =>
      result({
        contentType: "text/event-stream; charset=utf-8",
        body: "data: [DONE]\n\n",
      })
    );

    const response = await qwenBrowser.qwenBrowserBackedCompletion({
      chatId: "chat-id",
      prompt: "hello",
      cookieHeader: "token=t; cna=c",
    });

    assert.equal(response, null);
  });
});
