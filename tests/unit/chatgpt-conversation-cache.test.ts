import assert from "node:assert/strict";
import test from "node:test";

const cache = await import("../../open-sse/services/chatgptConversationCache.ts");

function withEnv(name: string, value: string, run: () => void): void {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

test("ChatGPT conversation cache enforces its byte budget", () => {
  cache.__resetChatGptConversationCacheForTesting();
  withEnv("OMNIROUTE_CGPT_WEB_CONVERSATION_MAX_ENTRY_BYTES", "32", () => {
    const stored = cache.setChatGptConversationContext("oversized", {
      conversationId: "conversation",
      parentMessageId: "parent",
      systemContext: "x".repeat(64),
    });
    assert.equal(stored, false);
    assert.equal(cache.__getChatGptConversationCacheBytesForTesting(), 0);
  });
  cache.__resetChatGptConversationCacheForTesting();
});

test("ChatGPT conversation cache evicts LRU entries to stay within its byte budget", () => {
  cache.__resetChatGptConversationCacheForTesting();
  withEnv("OMNIROUTE_CGPT_WEB_CONVERSATION_MAX_BYTES", "60", () => {
    assert.equal(
      cache.setChatGptConversationContext("first", {
        conversationId: "one",
        parentMessageId: "one",
        systemContext: "a".repeat(30),
      }),
      true
    );
    assert.equal(
      cache.setChatGptConversationContext("second", {
        conversationId: "two",
        parentMessageId: "two",
        systemContext: "b".repeat(30),
      }),
      true
    );
    assert.equal(cache.getChatGptConversationContext("first"), null);
    assert.ok(cache.getChatGptConversationContext("second"));
  });
  cache.__resetChatGptConversationCacheForTesting();
});

test("ChatGPT conversation cache serializes work for the same continuation key", async () => {
  const events: string[] = [];
  let unblockFirst: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => {
    unblockFirst = resolve;
  });
  let releaseFirst: (() => void) | undefined;
  const firstCanFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = (async () => {
    const release = await cache.acquireChatGptConversationLock("shared-key");
    try {
      events.push("first:start");
      unblockFirst?.();
      await firstCanFinish;
      events.push("first:end");
    } finally {
      release();
    }
  })();
  await firstStarted;
  const second = (async () => {
    const release = await cache.acquireChatGptConversationLock("shared-key");
    try {
      events.push("second:start");
    } finally {
      release();
    }
  })();

  await Promise.resolve();
  assert.deepEqual(events, ["first:start"]);
  releaseFirst?.();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start"]);
});
