#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const {
  applyClaudeMessagesLargeRequestMode,
  estimateClaudeMessagesBodyBytes,
  resolveClaudeLargeMessagesConfig,
} = await import("../../src/shared/middleware/claudeMessagesVcc.ts");

const fixturePath = resolve(process.argv[2] ?? ".data/claude-large-vcc-fixture.json");
const text = readFileSync(fixturePath, "utf8");
const body = JSON.parse(text);
const originalBytes = Buffer.byteLength(text, "utf8");
const configured = resolveClaudeLargeMessagesConfig();
const targetBytes = configured.targetBytes;
const maxBytes = configured.maxBytes;

function buildRequest() {
  return new Request("http://localhost/api/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(originalBytes),
    },
    body: text,
  });
}

const rejectMode = applyClaudeMessagesLargeRequestMode(buildRequest(), "/api/v1/messages", body, {
  config: { mode: "reject", targetBytes, maxBytes },
});
const vccMode = applyClaudeMessagesLargeRequestMode(buildRequest(), "/api/v1/messages", body, {
  config: { mode: "vcc", targetBytes, maxBytes },
});

const compactedBody = vccMode.body;
const compactedBytes = estimateClaudeMessagesBodyBytes(compactedBody);
const report = {
  fixturePath,
  originalBytes,
  mode: "vcc",
  targetBytes,
  maxBytes,
  defaultRejected: rejectMode.rejection?.status === 413,
  vccRejected: vccMode.rejection?.status ?? null,
  compacted: vccMode.compacted,
  compactedBytes,
  messagesBefore: Array.isArray(body.messages) ? body.messages.length : 0,
  messagesAfter:
    compactedBody && typeof compactedBody === "object" && Array.isArray(compactedBody.messages)
      ? compactedBody.messages.length
      : 0,
  toolsBefore: Array.isArray(body.tools) ? body.tools.length : 0,
  toolsAfter:
    compactedBody && typeof compactedBody === "object" && Array.isArray(compactedBody.tools)
      ? compactedBody.tools.length
      : 0,
  stagesApplied: vccMode.stats?.stagesApplied ?? [],
};

console.log(JSON.stringify(report, null, 2));

if (!report.defaultRejected) {
  console.error("Expected reject mode to reject the fixture.");
  process.exit(2);
}
if (report.vccRejected !== null) {
  console.error("Expected VCC mode to compact without rejection.");
  process.exit(3);
}
if (!report.compacted || report.compactedBytes > targetBytes) {
  console.error("Expected VCC mode to compact below target.");
  process.exit(4);
}
