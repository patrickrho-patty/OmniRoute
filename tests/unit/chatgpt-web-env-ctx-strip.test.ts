// Tests for the Codex environment_context stripper in the ChatGPT Web executor.
//
// Codex CLI 0.142.5+ injects <cwd>, <workspace_roots> and <permission_profile>
// inside an <environment_context> block as an input_text item. On the chatgpt-web
// path that makes the model think it has a native workspace connector, so it stops
// emitting <tool> blocks and instead claims the filesystem is unavailable. These
// tests verify that the stripper removes whole env_ctx items and strips inline
// blocks from the remaining text.

import test from "node:test";
import assert from "node:assert/strict";

const { stripEnvironmentContext } = await import("../../open-sse/executors/chatgpt-web.ts");

const EXAMPLE_ENV_CTX = `<environment_context>
  <cwd>/tmp/project</cwd>
  <workspace_roots>
    <workspace_root>/tmp/project</workspace_root>
  </workspace_roots>
  <permission_profile>default</permission_profile>
</environment_context>`;

test("removes a standalone input_text item that is only environment_context", () => {
  const messages = [
    {
      role: "user",
      content: [
        { type: "input_text", text: EXAMPLE_ENV_CTX },
        { type: "input_text", text: "list the files" },
      ],
    },
  ];

  const cleaned = stripEnvironmentContext(messages);

  assert.equal(cleaned.length, 1);
  const items = cleaned[0].content as Array<Record<string, unknown>>;
  assert.equal(items.length, 1);
  assert.equal(items[0].text, "list the files");
});

test("strips environment_context embedded in a user message", () => {
  const messages = [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: `Context before\n${EXAMPLE_ENV_CTX}\n\nlist the files`,
        },
      ],
    },
  ];

  const cleaned = stripEnvironmentContext(messages);

  const items = cleaned[0].content as Array<Record<string, unknown>>;
  assert.equal(items.length, 1);
  const text = String(items[0].text);
  assert.ok(!text.includes("<environment_context>"));
  assert.ok(text.includes("list the files"));
  assert.ok(text.includes("Context before"));
});

test("strips multiple environment_context blocks from the same turn", () => {
  const messages = [
    {
      role: "user",
      content: [
        { type: "input_text", text: `<environment_context><cwd>/a</cwd></environment_context>` },
        { type: "input_text", text: "do something" },
        {
          type: "input_text",
          text: `<environment_context><workspace_roots><workspace_root>/b</workspace_root></workspace_roots></environment_context>`,
        },
      ],
    },
  ];

  const cleaned = stripEnvironmentContext(messages);

  const items = cleaned[0].content as Array<Record<string, unknown>>;
  assert.equal(items.length, 1);
  assert.equal(items[0].text, "do something");
});

test("leaves messages without environment_context unchanged", () => {
  const messages = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: [{ type: "input_text", text: "hello" }] },
  ];

  const cleaned = stripEnvironmentContext(messages);

  assert.equal(cleaned[0].content, "You are a helpful assistant.");
  const items = cleaned[1].content as Array<Record<string, unknown>>;
  assert.equal(items[0].text, "hello");
});

test("handles string content with an embedded environment_context block", () => {
  const messages = [
    {
      role: "user",
      content: `${EXAMPLE_ENV_CTX}\n\nhi`,
    },
  ];

  const cleaned = stripEnvironmentContext(messages);

  assert.equal(cleaned[0].content, "hi");
});

test("handles chat-completions-style text items", () => {
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: `<environment_context><cwd>/tmp</cwd></environment_context>` },
      ],
    },
  ];

  const cleaned = stripEnvironmentContext(messages);

  const items = cleaned[0].content as Array<Record<string, unknown>>;
  assert.equal(items.length, 0);
});
