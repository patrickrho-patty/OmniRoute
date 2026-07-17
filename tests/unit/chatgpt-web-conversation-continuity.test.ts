import assert from "node:assert/strict";
import test from "node:test";

const { ChatGptWebExecutor, __resetChatGptWebCachesForTesting } =
  await import("../../open-sse/executors/chatgpt-web.ts");
const { __setTlsFetchOverrideForTesting } =
  await import("../../open-sse/services/chatgptTlsClient.ts");

const THREAD_ID = "019f5db4-7d15-79b1-ba06-7440d86ee5d4";
const TOOL_CALL_TEXT =
  '```json\n{"name":"exec_command","arguments":{"cmd":"sed -n \'1,240p\' dashboard/api/src/server.ts"}}\n```';

function makeHeaders(map: Record<string, string> = {}) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(map)) headers.set(key, value);
  return headers;
}

function conversationSse(conversationId: string, messageId: string, text: string): string {
  const event = {
    conversation_id: conversationId,
    message: {
      id: messageId,
      author: { role: "assistant" },
      content: { content_type: "text", parts: [text] },
      status: "finished_successfully",
    },
  };
  return `data: ${JSON.stringify(event)}\r\n\r\ndata: [DONE]\r\n\r\n`;
}

interface MockConversationResponse {
  conversationId?: string;
  messageId?: string;
  text?: string;
  status?: number;
}

interface MockFetchOptions {
  beforeConversationResponse?: () => Promise<void> | void;
}

function installMockFetch(responses: MockConversationResponse[], options: MockFetchOptions = {}) {
  const conversationBodies: Record<string, unknown>[] = [];
  let responseIndex = 0;
  let activeConversationPosts = 0;
  let maxConcurrentConversationPosts = 0;

  __setTlsFetchOverrideForTesting(async (url: string, opts: Record<string, unknown> = {}) => {
    const target = String(url);
    const json = (body: unknown, status = 200) => ({
      status,
      headers: makeHeaders({ "Content-Type": "application/json" }),
      text: JSON.stringify(body),
      body: null,
    });

    if (
      (target === "https://chatgpt.com/" || target === "https://chatgpt.com") &&
      (opts.method || "GET") === "GET"
    ) {
      return {
        status: 200,
        headers: makeHeaders({ "Content-Type": "text/html" }),
        text: '<html data-build="prod-test"><script src="https://cdn.oaistatic.com/_next/static/chunks/main-test.js"></script></html>',
        body: null,
      };
    }
    if (target.includes("/api/auth/session")) {
      return json({
        accessToken: "jwt-test",
        expires: new Date(Date.now() + 3_600_000).toISOString(),
        user: { id: "user-1" },
      });
    }
    if (target.includes("/sentinel/chat-requirements")) {
      return json({ token: "req-token", proofofwork: { required: false } });
    }
    if (
      target.endsWith("/backend-api/f/conversation") ||
      target.endsWith("/backend-api/conversation") ||
      /\/backend-api\/(f\/)?conversation\?/.test(target)
    ) {
      conversationBodies.push(JSON.parse(String(opts.body)));
      activeConversationPosts += 1;
      maxConcurrentConversationPosts = Math.max(
        maxConcurrentConversationPosts,
        activeConversationPosts
      );
      try {
        await options.beforeConversationResponse?.();
        const next = responses[Math.min(responseIndex, responses.length - 1)];
        responseIndex += 1;
        if ((next.status ?? 200) >= 400) {
          return {
            status: next.status ?? 500,
            headers: makeHeaders({ "Content-Type": "application/json" }),
            text: JSON.stringify({ error: "stale conversation" }),
            body: null,
          };
        }
        return {
          status: 200,
          headers: makeHeaders({ "Content-Type": "text/event-stream" }),
          text: conversationSse(
            next.conversationId ?? "conv-default",
            next.messageId ?? "msg-default",
            next.text ?? "ok"
          ),
          body: null,
        };
      } finally {
        activeConversationPosts -= 1;
      }
    }

    return { status: 404, headers: makeHeaders(), text: "not mocked", body: null };
  });

  return {
    conversationBodies,
    get maxConcurrentConversationPosts() {
      return maxConcurrentConversationPosts;
    },
    restore() {
      __setTlsFetchOverrideForTesting(null);
    },
  };
}

const EXEC_COMMAND_TOOL = {
  type: "function",
  function: {
    name: "exec_command",
    description: "Runs a command in a PTY.",
    parameters: {
      type: "object",
      properties: {
        cmd: { type: "string" },
        workdir: { type: "string" },
      },
      required: ["cmd"],
    },
  },
};

function executeBody(
  messages: Array<Record<string, unknown>>,
  apiKey = "test-cookie",
  connectionId?: string,
  callerIdentity = "api-key:test-principal"
) {
  const executor = new ChatGptWebExecutor();
  return executor.execute({
    model: "gpt-5.5-thinking",
    body: {
      model: "gpt-5.5-thinking",
      prompt_cache_key: THREAD_ID,
      messages,
      tools: [EXEC_COMMAND_TOOL],
    },
    stream: false,
    credentials: { apiKey, connectionId },
    clientHeaders: {
      "thread-id": THREAD_ID,
      "session-id": THREAD_ID,
    },
    callerIdentity,
    signal: AbortSignal.timeout(10_000),
    log: null,
  } as never);
}

test("ChatGPT Web retries a stale cached conversation once with typed stateless replay", async () => {
  __resetChatGptWebCachesForTesting();
  const mock = installMockFetch([
    { conversationId: "conv-stale", messageId: "msg-tool", text: TOOL_CALL_TEXT },
    { status: 404 },
    { conversationId: "conv-fresh", messageId: "msg-fresh-answer", text: "복구했습니다." },
    { conversationId: "conv-fresh", messageId: "msg-next-answer", text: "계속했습니다." },
  ]);

  try {
    const first = await executeBody([
      { role: "user", content: "dashboard/api/src/server.ts를 읽어줘" },
    ]);
    const firstJson = await first.response.json();
    const toolCall = firstJson.choices[0].message.tool_calls[0];

    const second = await executeBody([
      { role: "user", content: "dashboard/api/src/server.ts를 읽어줘" },
      { role: "assistant", content: null, tool_calls: [toolCall] },
      {
        role: "tool",
        tool_call_id: toolCall.id,
        content: "export function startServer() { return 3000; }",
      },
    ]);
    assert.equal(second.response.status, 200);
    await second.response.json();

    const third = await executeBody([{ role: "user", content: "다음 단계도 계속해줘" }]);
    await third.response.json();

    assert.equal(mock.conversationBodies.length, 4);
    assert.equal(mock.conversationBodies[1].conversation_id, "conv-stale");
    assert.equal(mock.conversationBodies[2].conversation_id, null);
    const fallbackSerialized = JSON.stringify(mock.conversationBodies[2]);
    assert.match(fallbackSerialized, /Prior conversation turns \(structured JSON replay/);
    assert.match(fallbackSerialized, /Tool result for `/);
    assert.match(fallbackSerialized, /\\"name\\":\\"exec_command\\"/);
    assert.equal(mock.conversationBodies[3].conversation_id, "conv-fresh");
  } finally {
    mock.restore();
    __resetChatGptWebCachesForTesting();
  }
});

test("ChatGPT Web retries an empty cached tool continuation with typed stateless replay", async () => {
  __resetChatGptWebCachesForTesting();
  const mock = installMockFetch([
    { conversationId: "conv-empty", messageId: "msg-tool", text: TOOL_CALL_TEXT },
    { conversationId: "conv-empty", messageId: "msg-empty", text: "" },
    { conversationId: "conv-recovered", messageId: "msg-answer", text: "Recovered answer." },
  ]);

  try {
    const first = await executeBody([{ role: "user", content: "Read server.ts" }]);
    const firstJson = await first.response.json();
    const toolCall = firstJson.choices[0].message.tool_calls[0];

    const second = await executeBody([
      { role: "user", content: "Read server.ts" },
      { role: "assistant", content: null, tool_calls: [toolCall] },
      {
        role: "tool",
        tool_call_id: toolCall.id,
        content: "export function startServer() { return 20128; }",
      },
    ]);

    assert.equal(second.response.status, 200);
    const secondJson = await second.response.json();
    assert.equal(secondJson.choices[0].message.content, "Recovered answer.");
    assert.equal(mock.conversationBodies.length, 3);
    assert.equal(mock.conversationBodies[1].conversation_id, "conv-empty");
    assert.equal(mock.conversationBodies[2].conversation_id, null);
    const replay = JSON.stringify(mock.conversationBodies[2]);
    assert.match(replay, /Prior conversation turns \(structured JSON replay/);
    assert.match(replay, /Tool result for `/);
    assert.match(replay, /\\"name\\":\\"exec_command\\"/);
    assert.match(replay, /startServer/);
  } finally {
    mock.restore();
    __resetChatGptWebCachesForTesting();
  }
});

test("ChatGPT Web returns a typed error instead of a successful blank tool turn", async () => {
  __resetChatGptWebCachesForTesting();
  const mock = installMockFetch([
    { conversationId: "conv-empty-a", messageId: "msg-empty-a", text: "" },
    { conversationId: "conv-empty-b", messageId: "msg-empty-b", text: "" },
  ]);

  try {
    const result = await executeBody([{ role: "user", content: "Inspect the repository" }]);
    assert.equal(result.response.status, 502);
    const json = await result.response.json();
    assert.equal(json.error.code, "CHATGPT_EMPTY_RESPONSE");
    assert.equal(mock.conversationBodies.length, 2);
    assert.equal(mock.conversationBodies[0].conversation_id, null);
    assert.equal(mock.conversationBodies[1].conversation_id, null);
  } finally {
    mock.restore();
    __resetChatGptWebCachesForTesting();
  }
});

test("ChatGPT Web preserves parallel and empty tool outputs in one continuation", async () => {
  __resetChatGptWebCachesForTesting();
  const parallelToolText = [
    '"```json\n{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"cat server.ts\"}}\n```"',
    '"```json\n{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"cat config.ts\"}}\n```"',
  ].join("\n");
  const mock = installMockFetch([
    { conversationId: "conv-parallel", messageId: "msg-tools", text: parallelToolText },
    { conversationId: "conv-parallel", messageId: "msg-answer", text: "확인했습니다." },
  ]);

  try {
    const first = await executeBody([{ role: "user", content: "두 파일을 읽어줘" }]);
    const firstJson = await first.response.json();
    const toolCalls = firstJson.choices[0].message.tool_calls;
    assert.equal(toolCalls.length, 2);

    const second = await executeBody([
      { role: "user", content: "두 파일을 읽어줘" },
      { role: "assistant", content: null, tool_calls: toolCalls },
      { role: "tool", tool_call_id: toolCalls[0].id, content: "" },
      { role: "tool", tool_call_id: toolCalls[1].id, content: "config output" },
    ]);
    await second.response.json();

    const secondBody = mock.conversationBodies[1];
    assert.equal(secondBody.history_and_training_disabled, true);
    const messages = secondBody.messages as any[];
    assert.equal(messages.length, 3);
    assert.equal(messages[0].author.role, "system");
    assert.match(messages[1].content.parts[0], /Prior conversation turns \(structured JSON replay/);
    const continuationText = (messages[2].content.parts ?? [])[0];
    assert.equal((continuationText.match(/Tool result for `/g) ?? []).length, 2);
    assert.match(continuationText, /"name":"exec_command"/);
    assert.match(continuationText, /"output":""/);
    assert.match(continuationText, /config output/);
    assert.match(continuationText, /config output/);
  } finally {
    mock.restore();
    __resetChatGptWebCachesForTesting();
  }
});

test("ChatGPT Web appends new developer context without replaying prior system context", async () => {
  __resetChatGptWebCachesForTesting();
  const mock = installMockFetch([
    { conversationId: "conv-delta", messageId: "msg-first", text: "첫 응답" },
    { conversationId: "conv-delta", messageId: "msg-second", text: "둘째 응답" },
  ]);

  try {
    const first = await executeBody([
      { role: "system", content: "STABLE_CLIENT_SYSTEM" },
      { role: "user", content: "첫 요청" },
    ]);
    await first.response.json();

    const exactUserText = "둘째 요청";
    const second = await executeBody([
      { role: "system", content: "STABLE_CLIENT_SYSTEM" },
      { role: "user", content: "첫 요청" },
      { role: "assistant", content: "첫 응답" },
      { role: "developer", content: "NEW_TURN_DEVELOPER_CONTEXT" },
      { role: "user", content: exactUserText },
    ]);
    await second.response.json();

    const secondBody = mock.conversationBodies[1];
    assert.equal(secondBody.conversation_id, "conv-delta");
    assert.equal(secondBody.history_and_training_disabled, true);
    const messages = secondBody.messages as any[];
    assert.equal(messages.length, 3);
    assert.equal(messages[0].author.role, "system");
    const systemText = messages[0].content.parts[0];
    assert.match(systemText, /STABLE_CLIENT_SYSTEM/);
    assert.match(systemText, /NEW_TURN_DEVELOPER_CONTEXT/);
    assert.doesNotMatch(systemText, /Prior conversation turns \(structured JSON replay/);
    assert.match(messages[1].content.parts[0], /Prior conversation turns \(structured JSON replay/);
    assert.equal(messages[2].author.role, "user");
    assert.ok(messages[2].content.parts[0].startsWith(exactUserText));
    assert.match(
      messages[2].content.parts[0],
      /\[Host: if this request needs files, commands, or current data/
    );
  } finally {
    mock.restore();
    __resetChatGptWebCachesForTesting();
  }
});

test("ChatGPT Web starts fresh when client system or tool contract changes", async () => {
  __resetChatGptWebCachesForTesting();
  const mock = installMockFetch([
    { conversationId: "conv-contract", messageId: "msg-first", text: "첫 응답" },
    { conversationId: "conv-new", messageId: "msg-second", text: "둘째 응답" },
  ]);

  try {
    const first = await executeBody([
      { role: "system", content: "CLIENT_CONTRACT_A" },
      { role: "user", content: "첫 요청" },
    ]);
    await first.response.json();

    const second = await executeBody([
      { role: "system", content: "CLIENT_CONTRACT_B" },
      { role: "user", content: "둘째 요청" },
    ]);
    await second.response.json();

    assert.equal(mock.conversationBodies[0].conversation_id, null);
    assert.equal(mock.conversationBodies[1].conversation_id, null);
    assert.match(JSON.stringify(mock.conversationBodies[1]), /CLIENT_CONTRACT_B/);
    assert.doesNotMatch(JSON.stringify(mock.conversationBodies[1]), /CLIENT_CONTRACT_A/);
  } finally {
    mock.restore();
    __resetChatGptWebCachesForTesting();
  }
});

test("ChatGPT Web preserves native conversation continuity across multilingual tool turns", async () => {
  __resetChatGptWebCachesForTesting();
  const mock = installMockFetch([
    { conversationId: "conv-1", messageId: "msg-tool-1", text: TOOL_CALL_TEXT },
    { conversationId: "conv-1", messageId: "msg-answer-1", text: "파일을 읽었습니다." },
    { conversationId: "conv-1", messageId: "msg-answer-2", text: "다음 파일도 확인했습니다." },
  ]);

  try {
    const first = await executeBody(
      [{ role: "user", content: "dashboard/api/src/server.ts를 읽어줘" }],
      "rotating-cookie-a"
    );
    const firstJson = await first.response.json();
    const toolCall = firstJson.choices[0].message.tool_calls[0];
    assert.equal(toolCall.function.name, "exec_command");

    const second = await executeBody(
      [
        { role: "user", content: "dashboard/api/src/server.ts를 읽어줘" },
        {
          role: "assistant",
          content: null,
          tool_calls: [toolCall],
        },
        {
          role: "tool",
          tool_call_id: toolCall.id,
          content: "export function startServer() { return 3000; }",
        },
      ],
      "rotating-cookie-b"
    );
    await second.response.json();

    const third = await executeBody(
      [
        { role: "user", content: "dashboard/api/src/server.ts를 읽어줘" },
        {
          role: "assistant",
          content: null,
          tool_calls: [toolCall],
        },
        {
          role: "tool",
          tool_call_id: toolCall.id,
          content: "export function startServer() { return 3000; }",
        },
        { role: "assistant", content: "파일을 읽었습니다." },
        { role: "user", content: "좋아, 이제 같은 폴더의 routes.ts도 읽어줘" },
      ],
      "rotating-cookie-c"
    );
    await third.response.json();

    assert.equal(mock.conversationBodies.length, 3);

    const firstBody = mock.conversationBodies[0];
    assert.equal(firstBody.conversation_id, null);
    assert.equal(firstBody.history_and_training_disabled, true);

    const secondBody = mock.conversationBodies[1];
    assert.equal(secondBody.conversation_id, "conv-1");
    assert.equal(secondBody.parent_message_id, "msg-tool-1");
    assert.equal(secondBody.history_and_training_disabled, true);
    assert.equal((secondBody.messages as unknown[]).length, 3);
    const secondReplay = ((secondBody.messages as any[])[1].content.parts as string[])[0];
    assert.match(secondReplay, /Prior conversation turns \(structured JSON replay/);
    const secondText = ((secondBody.messages as any[])[2].content.parts as string[])[0];
    assert.match(secondText, /Tool result for `/);
    assert.match(secondText, /"name":"exec_command"/);
    assert.match(secondText, /exec_command/);
    assert.match(secondText, /startServer/);

    const thirdBody = mock.conversationBodies[2];
    assert.equal(thirdBody.conversation_id, "conv-1");
    assert.equal(thirdBody.parent_message_id, "msg-answer-1");
    assert.equal(thirdBody.history_and_training_disabled, true);
    assert.equal((thirdBody.messages as unknown[]).length, 3);
    const thirdText = ((thirdBody.messages as any[])[2].content.parts as string[])[0];
    assert.ok(thirdText.startsWith("좋아, 이제 같은 폴더의 routes.ts도 읽어줘"));
    assert.match(thirdText, /\[Host: if this request needs files, commands, or current data/);
  } finally {
    mock.restore();
    __resetChatGptWebCachesForTesting();
  }
});

test("ChatGPT Web isolates continuations by stored connection", async () => {
  __resetChatGptWebCachesForTesting();
  const mock = installMockFetch([
    { conversationId: "conv-connection-a", messageId: "msg-connection-a", text: "first" },
    { conversationId: "conv-connection-b", messageId: "msg-connection-b", text: "second" },
  ]);

  try {
    await executeBody([{ role: "user", content: "first request" }], "shared-cookie", "conn-a");
    await executeBody([{ role: "user", content: "second request" }], "shared-cookie", "conn-b");

    assert.equal(mock.conversationBodies.length, 2);
    assert.equal(mock.conversationBodies[0].conversation_id, null);
    assert.equal(mock.conversationBodies[1].conversation_id, null);
  } finally {
    mock.restore();
    __resetChatGptWebCachesForTesting();
  }
});

test("ChatGPT Web isolates continuations by authenticated downstream principal", async () => {
  __resetChatGptWebCachesForTesting();
  const mock = installMockFetch([
    { conversationId: "conv-principal-a", messageId: "msg-principal-a", text: "first" },
    { conversationId: "conv-principal-b", messageId: "msg-principal-b", text: "second" },
  ]);

  try {
    await executeBody(
      [{ role: "user", content: "first request" }],
      "shared-cookie",
      "conn-a",
      "api-key:a"
    );
    await executeBody(
      [{ role: "user", content: "second request" }],
      "shared-cookie",
      "conn-a",
      "api-key:b"
    );

    assert.equal(mock.conversationBodies.length, 2);
    assert.equal(mock.conversationBodies[0].conversation_id, null);
    assert.equal(mock.conversationBodies[1].conversation_id, null);
  } finally {
    mock.restore();
    __resetChatGptWebCachesForTesting();
  }
});

test("ChatGPT Web serializes concurrent continuations for one connection and thread", async () => {
  __resetChatGptWebCachesForTesting();
  let releaseFirstPost: (() => void) | undefined;
  const firstPostStarted = new Promise<void>((resolve) => {
    releaseFirstPost = resolve;
  });
  let unblockFirstPost: (() => void) | undefined;
  const allowFirstPost = new Promise<void>((resolve) => {
    unblockFirstPost = resolve;
  });
  let postCount = 0;
  const mock = installMockFetch(
    [
      { conversationId: "conv-serialized", messageId: "msg-first", text: "first" },
      { conversationId: "conv-serialized", messageId: "msg-second", text: "second" },
    ],
    {
      beforeConversationResponse: async () => {
        postCount += 1;
        if (postCount !== 1) return;
        releaseFirstPost?.();
        await allowFirstPost;
      },
    }
  );

  try {
    const first = executeBody(
      [{ role: "user", content: "first request" }],
      "shared-cookie",
      "conn-a"
    );
    await firstPostStarted;
    const second = executeBody(
      [{ role: "user", content: "second request" }],
      "shared-cookie",
      "conn-a"
    );

    await Promise.resolve();
    assert.equal(mock.maxConcurrentConversationPosts, 1);
    assert.equal(mock.conversationBodies.length, 1);

    unblockFirstPost?.();
    await Promise.all([first, second]);
    assert.equal(mock.maxConcurrentConversationPosts, 1);
    assert.equal(mock.conversationBodies[1].conversation_id, "conv-serialized");
  } finally {
    mock.restore();
    __resetChatGptWebCachesForTesting();
  }
});
