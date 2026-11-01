/**
 * session-dedup must not replace content in the current turn (the messages after
 * the last assistant message). An agent that re-reads a file it read earlier would
 * otherwise get `[dedup:ref ...]` back instead of the file, conclude the read was
 * lost, and read it again with another tool.
 * Run: node --import tsx/esm --test tests/unit/compression/session-dedup-current-turn.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { sessionDedupEngine } from "../../../open-sse/services/compression/engines/session-dedup/index.ts";

const FILE = Array.from(
  { length: 12 },
  (_, i) => `${i + 1}\tfinal line${i} = cart.items[${i}];`
).join("\n");

type Msg = { role: string; content: string | null; [key: string]: unknown };

function readCall(id: string): Msg {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      { id, type: "function", function: { name: "Read", arguments: '{"path":"cart.dart"}' } },
    ],
  };
}

function apply(messages: Msg[]) {
  const result = sessionDedupEngine.apply({ model: "gpt-4", messages });
  return { result, messages: result.body.messages as Msg[] };
}

describe("session-dedup current turn", () => {
  // FORK DIVERGENCE (FORK_NOTES.md, "v3.8.52 sync record"): the fork's DCP tool-result pass
  // keeps the LAST occurrence of a repeated tool result verbatim and rewrites the EARLIER one
  // with a reversible `[dedup:duplicate-tool-result …]` placeholder (fork commit `0a12e3a6d8`,
  // pinned by tests/unit/compression/session-dedup.test.ts, live in production). Upstream's
  // suffix core does the opposite for plain text blocks: first occurrence kept, later ones
  // marked `[dedup:ref sha=…]`, and anything inside the current turn (after the last assistant
  // message) is never rewritten. Only the second rule is shared; tool results follow the fork
  // policy, so the two cases below assert the fork's direction.
  it("keeps the newest re-read tool result intact and marks the older one", () => {
    const { messages } = apply([
      { role: "user", content: "animate the cart" },
      readCall("c1"),
      { role: "tool", tool_call_id: "c1", content: FILE },
      readCall("c2"),
      { role: "tool", tool_call_id: "c2", content: FILE },
    ]);
    assert.match(String(messages[2].content), /\[dedup:duplicate-tool-result /);
    assert.equal(messages[4].content, FILE, "newest duplicate result is kept verbatim");
  });

  it("keeps a repeated block in the newest user message intact", () => {
    const { result, messages } = apply([
      { role: "user", content: `Here is the code:\n${FILE}` },
      { role: "assistant", content: "I understand the code." },
      { role: "user", content: `Please review again:\n${FILE}` },
    ]);
    assert.equal(result.compressed, false);
    assert.ok(messages[2].content?.includes(FILE));
  });

  it("still dedups the re-read once a later assistant turn follows it", () => {
    const { messages } = apply([
      { role: "user", content: "animate the cart" },
      readCall("c1"),
      { role: "tool", tool_call_id: "c1", content: FILE },
      readCall("c2"),
      { role: "tool", tool_call_id: "c2", content: FILE },
      { role: "assistant", content: "Done." },
      { role: "user", content: "thanks" },
    ]);
    // FORK DIVERGENCE: same policy as above, unchanged once a later assistant turn follows —
    // the fork keeps the LAST occurrence and marks the earlier one (upstream would keep the
    // first and mark the later one).
    assert.match(String(messages[2].content), /\[dedup:duplicate-tool-result /);
    assert.equal(messages[4].content, FILE);
  });

  it("keeps repeated blocks in a sole current user message intact", () => {
    const content = `first:\n${FILE}\nsecond:\n${FILE}`;
    const { result, messages } = apply([{ role: "user", content }]);
    assert.equal(result.compressed, false);
    assert.equal(messages[0].content, content);
  });

  it("keeps repeated blocks in a sole current tool message intact", () => {
    const content = `first:\n${FILE}\nsecond:\n${FILE}`;
    const { result, messages } = apply([
      readCall("c1"),
      { role: "tool", tool_call_id: "c1", content },
    ]);
    assert.equal(result.compressed, false);
    assert.equal(messages[1].content, content);
  });

  it("does not rewrite a current-turn near-duplicate message with fuzzy dedup", () => {
    const textA =
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho";
    const textAprime = textA + " sigma";
    const body = {
      messages: [
        { role: "user", content: textA },
        { role: "assistant", content: "received" },
        { role: "user", content: textAprime },
      ],
      tools: [{ type: "function", function: { name: "omniroute_ccr_retrieve" } }],
    };
    const result = sessionDedupEngine.apply(body, {
      stepConfig: { fuzzy: { enabled: true } },
      principalId: "p1",
    });
    assert.equal(result.compressed, false);
    const msgs = result.body.messages as Array<{ content: string }>;
    assert.equal(msgs[2].content, textAprime);
  });

  it("preserves all messages in a chat without assistant messages", () => {
    const content1 = `first:\n${FILE}\nsecond:\n${FILE}`;
    const content2 = `third:\n${FILE}\nfourth:\n${FILE}`;
    const { result, messages } = apply([
      { role: "user", content: content1 },
      { role: "user", content: content2 },
    ]);
    assert.equal(result.compressed, false);
    assert.equal(messages[0].content, content1);
    assert.equal(messages[1].content, content2);
  });
});
