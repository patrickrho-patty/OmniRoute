/**
 * Tests for chatgptClearance — gating, cookie merge, and acquire wiring.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  shouldUseChatgptBrowserBacked,
  mergeCfClearance,
  acquireFreshChatgptClearance,
  __setChatgptClearanceAcquireOverrideForTesting,
} from "@omniroute/open-sse/services/chatgptClearance.ts";

// ── Gating ──────────────────────────────────────────────────────────────

test("shouldUseChatgptBrowserBacked: off by default", () => {
  delete process.env.WEB_COOKIE_USE_BROWSER;
  delete process.env.OMNIROUTE_BROWSER_POOL;
  assert.strictEqual(shouldUseChatgptBrowserBacked(), false);
});

test("shouldUseChatgptBrowserBacked: on via OMNIROUTE_BROWSER_POOL", () => {
  process.env.OMNIROUTE_BROWSER_POOL = "on";
  delete process.env.WEB_COOKIE_USE_BROWSER;
  assert.strictEqual(shouldUseChatgptBrowserBacked(), true);
  delete process.env.OMNIROUTE_BROWSER_POOL;
});

test("shouldUseChatgptBrowserBacked: on via WEB_COOKIE_USE_BROWSER", () => {
  process.env.WEB_COOKIE_USE_BROWSER = "true";
  delete process.env.OMNIROUTE_BROWSER_POOL;
  assert.strictEqual(shouldUseChatgptBrowserBacked(), true);
  delete process.env.WEB_COOKIE_USE_BROWSER;
});

// ── mergeCfClearance ────────────────────────────────────────────────────

test("mergeCfClearance replaces existing cf_clearance in cookie header", () => {
  const cookie = "session-token=abc; cf_clearance=old_value; __cf_bm=xyz";
  const result = mergeCfClearance(cookie, "new_fresh_value");
  assert.ok(result.includes("cf_clearance=new_fresh_value"));
  assert.ok(!result.includes("old_value"));
  assert.ok(result.includes("session-token=abc"));
  assert.ok(result.includes("__cf_bm=xyz"));
});

test("mergeCfClearance appends when no existing cf_clearance", () => {
  const cookie = "session-token=abc; __cf_bm=xyz";
  const result = mergeCfClearance(cookie, "fresh_value");
  assert.ok(result.includes("cf_clearance=fresh_value"));
  assert.ok(result.includes("session-token=abc"));
});

test("mergeCfClearance handles cookie ending with semicolon", () => {
  const cookie = "session-token=abc;";
  const result = mergeCfClearance(cookie, "fresh");
  assert.ok(result.includes("cf_clearance=fresh"));
});

// ── acquireFreshChatgptClearance (via test override) ────────────────────

test("acquireFreshChatgptClearance uses the test override when set", async () => {
  __setChatgptClearanceAcquireOverrideForTesting(async () => "test_clearance_value");
  const result = await acquireFreshChatgptClearance();
  assert.strictEqual(result, "test_clearance_value");
  __setChatgptClearanceAcquireOverrideForTesting(null);
});

test("acquireFreshChatgptClearance returns null on override failure", async () => {
  __setChatgptClearanceAcquireOverrideForTesting(async () => null);
  const result = await acquireFreshChatgptClearance();
  assert.strictEqual(result, null);
  __setChatgptClearanceAcquireOverrideForTesting(null);
});
