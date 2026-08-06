import assert from "node:assert/strict";
import test from "node:test";
import { getDbInstance } from "../../../src/lib/db/core.ts";
import {
  ackPattySettlement,
  enqueuePattySettlement,
  getPendingPattySettlements,
  replayPattySettlements,
} from "../../../src/lib/db/pattySettlementOutbox.ts";

test.beforeEach(() => {
  getDbInstance().exec("DELETE FROM patty_settlement_outbox");
});

test("settlement outbox is idempotent and never persists credentials", () => {
  const record = {
    requestId: "req-1",
    turnId: "turn-1",
    preflightRef: "pf-1",
    routeTarget: "codex/gpt-5.5",
    terminalUsage: {
      provider: "codex",
      connection: "conn-1",
      model: "gpt-5.5",
      inputTokens: 12,
      outputTokens: 7,
      status: "success",
    },
  } as const;

  enqueuePattySettlement(record, { now: 1_000 });
  enqueuePattySettlement(record, { now: 2_000 });

  const rows = getPendingPattySettlements({ now: 2_000, includeFuture: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].requestId, "req-1");
  assert.equal(rows[0].turnId, "turn-1");
  assert.equal(rows[0].attempts, 0);
  assert.deepEqual(JSON.parse(rows[0].terminalUsageJson), record.terminalUsage);
  const persistedKeys = Object.keys(rows[0]).concat(
    Object.keys(JSON.parse(rows[0].terminalUsageJson) as Record<string, unknown>)
  );
  assert.equal(
    persistedKeys.some((key) =>
      ["authorization", "credential", "apiKey", "password", "accessToken"].includes(key)
    ),
    false
  );

  assert.equal(ackPattySettlement("req-1", "turn-1"), true);
  assert.equal(ackPattySettlement("req-1", "turn-1"), false);
});

test("replay backs off after failure and acknowledges a successful retry exactly once", async () => {
  enqueuePattySettlement(
    {
      requestId: "req-2",
      turnId: "turn-2",
      preflightRef: "pf-2",
      routeTarget: "codex/gpt-5.5",
      terminalUsage: { inputTokens: 3, outputTokens: 4, status: "success" },
    },
    { now: 10_000 }
  );

  let calls = 0;
  const first = await replayPattySettlements(
    async () => {
      calls += 1;
      throw new Error("Patty unavailable");
    },
    { now: 10_000, baseDelayMs: 500 }
  );
  assert.deepEqual(first, { attempted: 1, acknowledged: 0, failed: 1 });

  const [pending] = getPendingPattySettlements({ now: 10_000, includeFuture: true });
  assert.equal(pending.attempts, 1);
  assert.equal(pending.nextAttemptAt, 10_500);

  const tooEarly = await replayPattySettlements(
    async () => {
      calls += 1;
    },
    { now: 10_499, baseDelayMs: 500 }
  );
  assert.equal(tooEarly.attempted, 0);

  const second = await replayPattySettlements(
    async (record) => {
      calls += 1;
      assert.equal(record.preflightRef, "pf-2");
      assert.equal(record.routeTarget, "codex/gpt-5.5");
      assert.equal(record.terminalUsage.status, "success");
    },
    { now: 10_500, baseDelayMs: 500 }
  );
  assert.deepEqual(second, { attempted: 1, acknowledged: 1, failed: 0 });
  assert.equal(calls, 2);
  assert.equal(getPendingPattySettlements({ now: 20_000, includeFuture: true }).length, 0);

  const replayedAgain = await replayPattySettlements(
    async () => {
      calls += 1;
    },
    { now: 20_000 }
  );
  assert.equal(replayedAgain.attempted, 0);
  assert.equal(calls, 2);
});
