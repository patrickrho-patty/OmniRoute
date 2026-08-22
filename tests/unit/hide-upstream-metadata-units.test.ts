// tests/unit/hide-upstream-metadata-units.test.ts
//
// HIDE_UPSTREAM_METADATA — pure-function coverage for the redaction choke points:
//   1. buildOmniRouteResponseMetaHeaders / buildOmniRouteSseMetadataComment
//   2. sanitizeComboDiagnostics + errorResponseWithComboDiagnostics headers
//   3. applyCatalogPostFilters (/v1/models listing)
//
// The flag resolves DB-override > env > default. These tests never write a DB
// override, so the process env var drives every case deterministically.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate DATA_DIR BEFORE any module import touches the DB layer, so flag
// resolution reads an empty temp DB instead of the operator's real one.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-hide-meta-unit-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "hide-meta-unit-secret";
process.env.REQUIRE_API_KEY = "false";

const { isHideUpstreamMetadataEnabled } = await import("../../src/shared/utils/featureFlags.ts");
const { buildOmniRouteResponseMetaHeaders, buildOmniRouteSseMetadataComment } =
  await import("../../src/domain/omnirouteResponseMeta.ts");
const {
  sanitizeComboDiagnostics,
  errorResponseWithComboDiagnostics,
  providerCircuitOpenResponse,
  buildModelCooldownBody,
} = await import("../../open-sse/utils/error.ts");
const { applyCatalogPostFilters } = await import("../../src/app/api/v1/models/catalogResponse.ts");

test.after(async () => {
  delete process.env.HIDE_UPSTREAM_METADATA;
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function withFlag<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.HIDE_UPSTREAM_METADATA;
  if (value === undefined) delete process.env.HIDE_UPSTREAM_METADATA;
  else process.env.HIDE_UPSTREAM_METADATA = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.HIDE_UPSTREAM_METADATA;
    else process.env.HIDE_UPSTREAM_METADATA = prev;
  }
}

const META_ARGS = {
  cacheHit: false,
  costUsd: 0.001,
  latencyMs: 9,
  model: "opencode-go/deepseek-v4-pro",
  provider: "opencode-go",
  requestId: "req-1",
  strategy: "priority",
  usage: { prompt_tokens: 10, completion_tokens: 5 },
} as const;

test("flag helper follows the env var", () => {
  assert.equal(
    withFlag(undefined, () => isHideUpstreamMetadataEnabled()),
    false
  );
  assert.equal(
    withFlag("false", () => isHideUpstreamMetadataEnabled()),
    false
  );
  assert.equal(
    withFlag("true", () => isHideUpstreamMetadataEnabled()),
    true
  );
});

test("meta headers keep model/provider/decision when the flag is off (default behavior)", () => {
  const headers = withFlag(undefined, () => buildOmniRouteResponseMetaHeaders({ ...META_ARGS }));
  assert.equal(headers["X-OmniRoute-Model"], "opencode-go/deepseek-v4-pro");
  assert.equal(headers["X-OmniRoute-Provider"], "opencode-go");
  assert.ok(headers["X-OmniRoute-Decision"].includes("provider=opencode-go"));
  // Neutral telemetry survives either way.
  assert.ok(headers["X-OmniRoute-Version"]);
  assert.equal(headers["X-OmniRoute-Tokens-In"], "10");
});

test("meta headers omit model/provider/decision when the flag is on", () => {
  const headers = withFlag("true", () => buildOmniRouteResponseMetaHeaders({ ...META_ARGS }));
  assert.equal(headers["X-OmniRoute-Model"], undefined);
  assert.equal(headers["X-OmniRoute-Provider"], undefined);
  assert.equal(headers["X-OmniRoute-Decision"], undefined);
  assert.equal(headers["X-OmniRoute-Request-Id"], "req-1");
  assert.equal(headers["X-OmniRoute-Tokens-In"], "10");
  assert.equal(headers["X-OmniRoute-Latency-Ms"], "9");
});

test("SSE metadata comment lines drop upstream identities when the flag is on", () => {
  const comment = withFlag("true", () => buildOmniRouteSseMetadataComment({ ...META_ARGS }));
  assert.ok(!comment.includes("deepseek"), `comment must not name the upstream model: ${comment}`);
  assert.ok(!comment.includes("opencode-go"), `comment must not name the provider: ${comment}`);
  assert.ok(comment.includes("x-omniroute-tokens-in="), "neutral telemetry stays");

  const visible = withFlag(undefined, () => buildOmniRouteSseMetadataComment({ ...META_ARGS }));
  assert.ok(visible.includes("opencode-go/deepseek-v4-pro"));
});

const DIAG = {
  poolSize: 2,
  attempted: 2,
  excluded: [
    { provider: "opencode-go", model: "deepseek-v4-pro", reason: "exhausted" },
    { provider: "clinepass", model: "cline-pass/deepseek-v4-pro", reason: "rate_limited" },
  ],
  attemptOrder: [
    { provider: "opencode-go", model: "deepseek-v4-pro" },
    { provider: "clinepass", model: "cline-pass/deepseek-v4-pro" },
  ],
  terminalReason: "all_failed:opencode-go/deepseek-v4-pro",
};

test("combo diagnostics keep identities when the flag is off", () => {
  const safe = withFlag(undefined, () => sanitizeComboDiagnostics(DIAG));
  assert.equal(safe.excluded.length, 2);
  assert.equal(safe.attemptOrder.length, 2);
  assert.ok(safe.terminalReason.length > 0);
});

test("combo diagnostics reduce to opaque counts when the flag is on", () => {
  const safe = withFlag("true", () => sanitizeComboDiagnostics(DIAG));
  assert.equal(safe.poolSize, 2);
  assert.equal(safe.attempted, 2);
  assert.deepEqual(safe.excluded, []);
  assert.deepEqual(safe.attemptOrder, []);
  assert.equal(safe.terminalReason, "");
});

test("combo failure response omits identity headers when the flag is on", async () => {
  const res = withFlag("true", () =>
    errorResponseWithComboDiagnostics(503, "Service temporarily unavailable", DIAG, {
      code: "ALL_ACCOUNTS_INACTIVE",
    })
  );
  assert.equal(res.headers.get("x-omniroute-combo-pool-size"), "2");
  assert.equal(res.headers.get("x-omniroute-combo-attempted"), "2");
  assert.equal(res.headers.get("x-omniroute-combo-excluded"), null);
  assert.equal(res.headers.get("x-omniroute-combo-terminal-reason"), null);
  const body = await res.json();
  assert.deepEqual(body.diagnostics.excluded, []);
  assert.ok(!JSON.stringify(body).includes("deepseek"), "body must not name the upstream");
});

test("provider circuit-open body carries no provider identity under the flag", async () => {
  const res = withFlag("true", () => providerCircuitOpenResponse("opencode-go", 30));
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error.code, "provider_circuit_open");
  assert.equal(body.error.provider, undefined);
  assert.ok(!JSON.stringify(body).includes("opencode-go"), "must not name the provider");

  const visible = withFlag(undefined, () => providerCircuitOpenResponse("opencode-go", 30));
  const visibleBody = await visible.json();
  assert.equal(visibleBody.error.provider, "opencode-go");
});

test("model-cooldown body carries no upstream model identity under the flag", () => {
  const hidden = withFlag("true", () =>
    buildModelCooldownBody({ model: "opencode-go/deepseek-v4-pro", retryAfterSec: 30 })
  );
  assert.equal(hidden.error.model, undefined);
  assert.ok(!hidden.error.message.includes("deepseek"));
  assert.equal(hidden.error.code, "model_cooldown");
  assert.equal(hidden.error.reset_seconds, 30);

  const visible = withFlag(undefined, () =>
    buildModelCooldownBody({ model: "opencode-go/deepseek-v4-pro", retryAfterSec: 30 })
  );
  assert.equal(visible.error.model, "opencode-go/deepseek-v4-pro");
});

test("/v1/models post-filter strips provider-prefixed ids when the flag is on", () => {
  const request = new Request("http://localhost/v1/models");
  const ctx = { connections: [], prefixMode: "dual", aliasToProviderId: {} };
  const models = [
    { id: "claude-fable-5", owned_by: "combo" }, // bare combo name — public surface
    { id: "opencode-go/deepseek-v4-pro" }, // upstream id — must go
    { id: "cc/claude-fable-5" }, // provider-prefixed — must go
    { id: "auto/smart" }, // OmniRoute router namespace — stays
    { id: "qtSd/quick" }, // OmniRoute router namespace — stays
  ];

  const hidden = withFlag("true", () => applyCatalogPostFilters(request, [...models], ctx));
  const hiddenIds = hidden.map((m) => m.id);
  assert.deepEqual([...hiddenIds].sort(), ["auto/smart", "claude-fable-5", "qtSd/quick"]);

  const visible = withFlag(undefined, () => applyCatalogPostFilters(request, [...models], ctx));
  const visibleIds = visible.map((m) => m.id);
  for (const original of models) {
    assert.ok(visibleIds.includes(original.id), `default listing keeps ${original.id}`);
  }
});

// Architectural guard (HIDE_UPSTREAM_METADATA): every writer of the three
// identity-bearing X-OmniRoute-* response headers must go through
// buildOmniRouteResponseMetaHeaders — the single flag-gated choke point. A new
// emitter writing the header directly would silently bypass the redaction.
test("no direct writers of identity-bearing meta headers outside the gated builder", async () => {
  const { execFileSync } = await import("node:child_process");
  const root = new URL("../..", import.meta.url).pathname;
  const grep = execFileSync(
    "grep",
    [
      "-rn",
      "-E",
      "OMNIROUTE_RESPONSE_HEADERS\\.(model|provider|decision)",
      "src/",
      "open-sse/",
      "--include=*.ts",
      "--include=*.tsx",
    ],
    { encoding: "utf8", cwd: root }
  );
  const offenders = grep
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .filter((line) => !/\.test\.[jt]sx?:/.test(line))
    // The gated builder itself + the shared constants file + doc comments referencing it.
    .filter((line) => !/omnirouteResponseMeta\.ts:/.test(line))
    .filter((line) => !/shared\/constants\/headers\.ts:/.test(line))
    .filter((line) => !/textCompletionTransform\.ts:/.test(line)) // doc comments only
    .filter((line) => !/completions\/route\.ts:/.test(line)); // doc comments only
  assert.deepEqual(
    offenders,
    [],
    "Direct writes to X-OmniRoute-Model/Provider/Decision found — route them through buildOmniRouteResponseMetaHeaders so HIDE_UPSTREAM_METADATA stays airtight"
  );
});
