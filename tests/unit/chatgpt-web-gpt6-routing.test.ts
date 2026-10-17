import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { prepareChatGptWebBrowserRequest } from "../../open-sse/utils/chatgptWebExecutorAdapter.ts";
import { directModel } from "../../open-sse/utils/chatgptWebFirstParty.ts";

import type { ChatGptWebUiSelection } from "../../open-sse/utils/chatgptWebFirstParty.ts";

/**
 * GPT-6 routes for ChatGPT Web (fork addition, 2026-10-17).
 *
 * The web path resolves a registry model id to a UI picker label plus an effort index, and the
 * label is then mapped to the `model` string chatgpt.com's backend receives. Both halves are
 * pure functions, so they are pinned here — the only thing a unit test cannot prove is whether
 * a given account's chatgpt.com actually offers GPT-6.
 */

const BODY = { messages: [{ role: "user", content: "hi" }] };

function selectionFor(model: string, body: Record<string, unknown> = BODY): ChatGptWebUiSelection {
  return prepareChatGptWebBrowserRequest(model, body).selection;
}

describe("chatgpt-web GPT-6 routing", () => {
  it("resolves the GPT-6 ids to the GPT-6 picker label", () => {
    for (const model of ["gpt-6", "chatgpt-web/gpt-6", "cgpt-web/gpt-6"]) {
      assert.deepEqual(selectionFor(model), {
        kind: "picker",
        modelLabel: "GPT-6 Sol",
        effortIndex: 0,
      });
    }
  });

  it("maps GPT-6 thinking to an effort index from the request", () => {
    for (const [effort, expected] of [
      ["low", 0],
      ["medium", 1],
      ["high", 2],
      ["xhigh", 3],
      ["max", 3],
    ] as const) {
      assert.equal(
        selectionFor("gpt-6-thinking", { ...BODY, reasoning_effort: effort }).effortIndex,
        expected
      );
      // Nested reasoning.effort is the other accepted shape.
      assert.equal(
        selectionFor("gpt-6-sol", { ...BODY, reasoning: { effort } }).effortIndex,
        expected
      );
    }
  });

  it("defaults GPT-6 thinking to medium when no effort is supplied", () => {
    assert.equal(selectionFor("gpt-6-thinking").effortIndex, 1);
  });

  it("maps GPT-6 pro to the pro effort index", () => {
    assert.deepEqual(selectionFor("gpt-6-pro"), {
      kind: "picker",
      modelLabel: "GPT-6 Sol",
      effortIndex: 4,
    });
  });

  it("sends the GPT-6 upstream model id, with -pro only for the pro route", () => {
    assert.deepEqual(directModel(selectionFor("gpt-6")), { model: "gpt-6", reason: false });
    assert.deepEqual(directModel(selectionFor("gpt-6-pro")), { model: "gpt-6-pro", reason: false });
    assert.deepEqual(
      directModel(selectionFor("gpt-6-thinking", { ...BODY, reasoning_effort: "high" })),
      {
        model: "gpt-6",
        reason: true,
      }
    );
  });

  it("leaves the existing 5.6 and 5.5 routes untouched", () => {
    assert.deepEqual(directModel(selectionFor("gpt-5-6")), { model: "gpt-5-6", reason: false });
    assert.deepEqual(directModel(selectionFor("gpt-5-6-pro")), {
      model: "gpt-5-6-pro",
      reason: false,
    });
    assert.deepEqual(directModel(selectionFor("gpt-5-5-thinking")), {
      model: "gpt-5-5",
      reason: true,
    });
    assert.deepEqual(selectionFor("gpt-5.6-luna-free"), { kind: "free", thinkEnabled: false });
  });

  it("fails loudly instead of silently sending the wrong model for an unmapped label", () => {
    const unmapped = { kind: "picker", modelLabel: "GPT-9" } as unknown as ChatGptWebUiSelection;
    assert.throws(() => directModel(unmapped), /no upstream model id mapped/);
  });

  it("still rejects a model the adapter does not know", () => {
    assert.throws(() => selectionFor("gpt-7-imaginary"), /unsupported model/);
  });
});
