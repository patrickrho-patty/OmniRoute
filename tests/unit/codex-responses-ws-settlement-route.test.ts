import assert from "node:assert/strict";
import test from "node:test";
import { getDbInstance } from "../../src/lib/db/core.ts";
import { getPendingPattySettlements } from "../../src/lib/db/pattySettlementOutbox.ts";

const originalFetch = globalThis.fetch;
const originalEnv = {
  bridge: process.env.OMNIROUTE_WS_BRIDGE_SECRET,
  gatewayUrl: process.env.PATTY_GATEWAY_URL,
  gatewayToken: process.env.PATTY_GATEWAY_TOKEN,
};

test.before(async () => {
  process.env.OMNIROUTE_WS_BRIDGE_SECRET = "bridge-secret";
  process.env.PATTY_GATEWAY_URL = "http://patty-sidecar:4100";
  process.env.PATTY_GATEWAY_TOKEN = "gateway-secret";
});

test.after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    const name =
      key === "bridge"
        ? "OMNIROUTE_WS_BRIDGE_SECRET"
        : key === "gatewayUrl"
          ? "PATTY_GATEWAY_URL"
          : "PATTY_GATEWAY_TOKEN";
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test.beforeEach(() => {
  getDbInstance().exec("DELETE FROM patty_settlement_outbox");
});

function internalRequest(action: string, payload: Record<string, unknown>): Request {
  return new Request("http://omniroute.local/api/internal/codex-responses-ws", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-omniroute-ws-bridge-secret": "bridge-secret",
    },
    body: JSON.stringify({ action, ...payload }),
  });
}

test("settlement outage leaves one durable row and replay acknowledges it exactly once", async () => {
  const { POST } = await import("../../src/app/api/internal/codex-responses-ws/route.ts");
  let settleCalls = 0;
  globalThis.fetch = async () => {
    settleCalls += 1;
    if (settleCalls === 1) {
      return Response.json(
        { error: { type: "patty_settlement_unavailable", message: "Unavailable" } },
        { status: 503 }
      );
    }
    return Response.json({ settled: true });
  };

  const decision = {
    preflightRef: "pf-route",
    requestId: "req-route",
    turnId: "turn-route",
    harness: "codex",
    publicModel: "gpt-5.3-codex",
    routedModel: "codex/gpt-5.5",
    quota: {
      fiveHour: { spend: 1, limit: 10, usedPercent: 10, resetAt: 1_800_000_000 },
      sevenDay: { spend: 2, limit: 20, usedPercent: 10, resetAt: 1_800_100_000 },
    },
  };
  const response = await POST(
    internalRequest("settle", {
      decision,
      terminal: {
        usage: { input_tokens: 4, output_tokens: 5 },
        status: "success",
        provider: "codex",
        connection: "conn-1",
        model: "gpt-5.5",
      },
    })
  );
  assert.equal(response.status, 503);

  const [pending] = getPendingPattySettlements({ includeFuture: true });
  assert.equal(pending.requestId, "req-route");
  assert.equal(pending.turnId, "turn-route");
  assert.doesNotMatch(pending.terminalUsageJson, /gateway-secret|employee-secret/);

  const replay = await POST(internalRequest("replay", {}));
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), {
    ok: true,
    attempted: 1,
    acknowledged: 1,
    failed: 0,
  });
  assert.equal(settleCalls, 2);
  assert.equal(getPendingPattySettlements({ includeFuture: true }).length, 0);

  const replayAgain = await POST(internalRequest("replay", {}));
  assert.equal((await replayAgain.json()).attempted, 0);
  assert.equal(settleCalls, 2);
});
