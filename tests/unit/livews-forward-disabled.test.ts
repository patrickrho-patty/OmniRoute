import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  forwardDashboardEventToLiveWs,
  __resetLiveWsForwardingState,
} from "../../open-sse/handlers/chatCore/telemetryHelpers.ts";

// Companion to #4604's lazy-backoff: when the operator explicitly disables the
// live-WS sidecar via OMNIROUTE_ENABLE_LIVE_WS=0, the forwarder should skip the
// fetch entirely (zero warnings), not rely on the backoff probe (which still
// emits one ECONNREFUSED warning per cooldown window). Mirrors the on/off
// semantics of src/server/ws/liveServer.ts::isLiveWsEnabled.

const ORIGINAL_ENABLE = process.env.OMNIROUTE_ENABLE_LIVE_WS;

beforeEach(() => {
  __resetLiveWsForwardingState();
  delete process.env.OMNIROUTE_ENABLE_LIVE_WS;
});

afterEach(() => {
  if (ORIGINAL_ENABLE === undefined) delete process.env.OMNIROUTE_ENABLE_LIVE_WS;
  else process.env.OMNIROUTE_ENABLE_LIVE_WS = ORIGINAL_ENABLE;
});

test('OMNIROUTE_ENABLE_LIVE_WS="0" → no fetch attempted (zero warnings)', async () => {
  process.env.OMNIROUTE_ENABLE_LIVE_WS = "0";
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response("ok");
  };
  for (let i = 0; i < 5; i++) {
    await forwardDashboardEventToLiveWs("compression.step", { a: i }, fetchImpl, () => 1000);
  }
  assert.equal(calls, 0, "fetch must not be called when forwarding is disabled");
});

test('OMNIROUTE_ENABLE_LIVE_WS="false" → no fetch attempted', async () => {
  process.env.OMNIROUTE_ENABLE_LIVE_WS = "false";
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response("ok");
  };
  await forwardDashboardEventToLiveWs("compression.completed", {}, fetchImpl, () => 1000);
  assert.equal(calls, 0);
});

test('OMNIROUTE_ENABLE_LIVE_WS="False" (mixed case) → no fetch attempted', async () => {
  process.env.OMNIROUTE_ENABLE_LIVE_WS = "False";
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response("ok");
  };
  await forwardDashboardEventToLiveWs("e", {}, fetchImpl, () => 1000);
  assert.equal(calls, 0);
});

test("undefined OMNIROUTE_ENABLE_LIVE_WS → default ON (fetch attempted)", async () => {
  delete process.env.OMNIROUTE_ENABLE_LIVE_WS;
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response("ok");
  };
  await forwardDashboardEventToLiveWs("e", {}, fetchImpl, () => 1000);
  assert.equal(calls, 1, "default behavior must be unchanged when the flag is absent");
});

test('OMNIROUTE_ENABLE_LIVE_WS="1" → ON (fetch attempted)', async () => {
  process.env.OMNIROUTE_ENABLE_LIVE_WS = "1";
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response("ok");
  };
  await forwardDashboardEventToLiveWs("e", {}, fetchImpl, () => 1000);
  assert.equal(calls, 1);
});

test('OMNIROUTE_ENABLE_LIVE_WS="true" (mixed case) → ON (fetch attempted)', async () => {
  process.env.OMNIROUTE_ENABLE_LIVE_WS = "TRUE";
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response("ok");
  };
  await forwardDashboardEventToLiveWs("e", {}, fetchImpl, () => 1000);
  assert.equal(calls, 1);
});
