/**
 * Regression tests for the chatgpt-web validator's browser-pool fallback.
 *
 * Before this change, the validator was a dead end: when Cloudflare returned
 * 403 with `cf-mitigated: 1`, the validator surfaced the failure to the UI
 * and stopped, leaving the user unable to save the credential. The fix
 * mirrors the executor's pattern — when the gate is on and Cloudflare
 * blocks the first stealth fetch, refresh cf_clearance via the browser pool
 * and retry the validator once.
 *
 * The mocking strategy uses the existing test-only hook in chatgptTlsClient.ts:
 *   __setTlsFetchOverrideForTesting(fn)  — replaces the real TLS client with
 *                                              a fake that returns scripted responses.
 *   __setChatgptClearanceAcquireOverrideForTesting(fn)  — replaces the real
 *                                              browser-acquire with a fake that returns
 *                                              a scripted cf_clearance.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  __setChatgptClearanceAcquireOverrideForTesting,
  shouldUseChatgptBrowserBacked,
} from "@omniroute/open-sse/services/chatgptClearance.ts";
import {
  __setTlsFetchOverrideForTesting,
  type TlsFetchOptions,
  type TlsFetchResult,
} from "@omniroute/open-sse/services/chatgptTlsClient.ts";

// Capture every call so the test can assert against the exact headers sent.
const calls: Array<{ url: string; headers: Record<string, string> }> = [];

type ScriptedResponse = {
  status: number;
  headers?: Record<string, string>;
  text?: string;
};

let queue: ScriptedResponse[] = [];

function installFakeResponses(responses: ScriptedResponse[]) {
  calls.length = 0;
  queue = [...responses];
  __setTlsFetchOverrideForTesting(
    async (url: string, options: TlsFetchOptions): Promise<TlsFetchResult> => {
      const response = queue.shift();
      if (!response) {
        throw new Error(`No more fake responses queued for ${url}`);
      }
      calls.push({ url, headers: (options.headers || {}) as Record<string, string> });
      return {
        status: response.status,
        headers: new Headers(response.headers || {}),
        text: response.text || null,
        body: null,
      };
    }
  );
}

function clearOverride() {
  __setTlsFetchOverrideForTesting(null);
  __setChatgptClearanceAcquireOverrideForTesting(null);
  queue = [];
  calls.length = 0;
}

async function setupValidator() {
  const { validateChatGptWebProvider } = await import(
    "../../src/lib/providers/validation/webProvidersA.ts"
  );
  return { validateChatGptWebProvider };
}

test.afterEach(() => {
  clearOverride();
  delete process.env.OMNIROUTE_BROWSER_POOL;
  delete process.env.WEB_COOKIE_USE_BROWSER;
});

// ── Gating ────────────────────────────────────────────────────────────────

test("validator: when browser pool is off, cf-mitigated 403 → Cloudflare error (no retry)", async () => {
  delete process.env.OMNIROUTE_BROWSER_POOL;
  delete process.env.WEB_COOKIE_USE_BROWSER;
  assert.strictEqual(shouldUseChatgptBrowserBacked(), false);

  installFakeResponses([
    {
      status: 403,
      headers: { "cf-mitigated": "1", "content-type": "text/html" },
      text: "<!DOCTYPE html><html>Just a moment...</html>",
    },
  ]);

  const { validateChatGptWebProvider } = await setupValidator();
  const result = await validateChatGptWebProvider({
    apiKey: "fake-session-token",
    providerSpecificData: {},
  });

  assert.equal(result.valid, false);
  assert.match(result.error ?? "", /Cloudflare blocked the validator/);
  assert.equal(calls.length, 1, "no browser-pool retry when the gate is off");
});

test("validator: when browser pool is on, cf-mitigated 403 → acquire cf_clearance + retry → success", async () => {
  process.env.OMNIROUTE_BROWSER_POOL = "on";
  __setChatgptClearanceAcquireOverrideForTesting(async () => "fresh-cf-clearance-from-pool");

  installFakeResponses([
    // First attempt: Cloudflare blocks with cf-mitigated
    {
      status: 403,
      headers: { "cf-mitigated": "1", "content-type": "text/html" },
      text: "<!DOCTYPE html><html>Just a moment...</html>",
    },
    // Retry: should succeed with 200 + JSON accessToken
    {
      status: 200,
      headers: { "content-type": "application/json" },
      text: JSON.stringify({ accessToken: "real-token", user: { id: "u-1" } }),
    },
  ]);

  const { validateChatGptWebProvider } = await setupValidator();
  const result = await validateChatGptWebProvider({
    apiKey: "fake-session-token",
    providerSpecificData: {},
  });

  assert.equal(result.valid, true, `expected valid, got error: ${result.error}`);
  assert.equal(result.error, null);
  assert.equal(calls.length, 2, "executed stealth fetch + browser-pool retry");
  // The retry must carry the fresh cf_clearance merged into the cookie header.
  const retryHeaders = calls[1].headers;
  const retryCookie = retryHeaders.Cookie ?? retryHeaders.cookie ?? "";
  assert.match(
    retryCookie,
    /cf_clearance=fresh-cf-clearance-from-pool/,
    "retry request must include the fresh cf_clearance"
  );
  assert.match(
    retryCookie,
    /__Secure-next-auth\.session-token=fake-session-token/,
    "retry must preserve the session-token"
  );
});

test("validator: when browser pool acquire fails, fall through to the original error", async () => {
  process.env.OMNIROUTE_BROWSER_POOL = "on";
  __setChatgptClearanceAcquireOverrideForTesting(async () => null); // simulate pool failure

  installFakeResponses([
    {
      status: 403,
      headers: { "cf-mitigated": "1", "content-type": "text/html" },
      text: "<!DOCTYPE html><html>Just a moment...</html>",
    },
  ]);

  const { validateChatGptWebProvider } = await setupValidator();
  const result = await validateChatGptWebProvider({
    apiKey: "fake-session-token",
    providerSpecificData: {},
  });

  assert.equal(result.valid, false);
  assert.match(result.error ?? "", /Cloudflare blocked the validator/);
  assert.equal(calls.length, 1, "no retry when acquire returns null");
});

test("validator: when browser pool retry STILL returns 403, surface the original error", async () => {
  process.env.OMNIROUTE_BROWSER_POOL = "on";
  __setChatgptClearanceAcquireOverrideForTesting(async () => "another-cf-clearance");

  installFakeResponses([
    {
      status: 403,
      headers: { "cf-mitigated": "1", "content-type": "text/html" },
      text: "<!DOCTYPE html><html>Just a moment...</html>",
    },
    // Retry still blocked
    {
      status: 403,
      headers: { "cf-mitigated": "1", "content-type": "text/html" },
      text: "<!DOCTYPE html><html>Just a moment...</html>",
    },
  ]);

  const { validateChatGptWebProvider } = await setupValidator();
  const result = await validateChatGptWebProvider({
    apiKey: "fake-session-token",
    providerSpecificData: {},
  });

  assert.equal(result.valid, false);
  assert.match(result.error ?? "", /Cloudflare blocked the validator/);
  assert.equal(calls.length, 2, "validator retried once then gave up");
});

test("validator: 403 without cf-mitigated and without 'Just a moment' body → invalid cookie (no retry)", async () => {
  process.env.OMNIROUTE_BROWSER_POOL = "on";
  __setChatgptClearanceAcquireOverrideForTesting(async () => "should-not-be-called");

  installFakeResponses([
    {
      status: 403,
      headers: { "content-type": "application/json" },
      text: JSON.stringify({ error: "invalid session token" }),
    },
  ]);

  const { validateChatGptWebProvider } = await setupValidator();
  const result = await validateChatGptWebProvider({
    apiKey: "fake-session-token",
    providerSpecificData: {},
  });

  assert.equal(result.valid, false);
  assert.match(result.error ?? "", /Invalid ChatGPT session cookie/);
  assert.equal(calls.length, 1, "no retry when the 403 is auth, not Cloudflare");
});

test("validator: 200 with missing accessToken → 'session expired' (no retry)", async () => {
  process.env.OMNIROUTE_BROWSER_POOL = "on";
  __setChatgptClearanceAcquireOverrideForTesting(async () => "should-not-be-called");

  installFakeResponses([
    {
      status: 200,
      headers: { "content-type": "application/json" },
      text: JSON.stringify({ user: { id: "u-1" } }),
    },
  ]);

  const { validateChatGptWebProvider } = await setupValidator();
  const result = await validateChatGptWebProvider({
    apiKey: "fake-session-token",
    providerSpecificData: {},
  });

  assert.equal(result.valid, false);
  assert.match(result.error ?? "", /session expired/);
  assert.equal(calls.length, 1, "no retry when upstream returned 200 cleanly");
});

test("validator: WEB_COOKIE_USE_BROWSER=1 also enables the browser fallback (not just OMNIROUTE_BROWSER_POOL)", async () => {
  delete process.env.OMNIROUTE_BROWSER_POOL;
  process.env.WEB_COOKIE_USE_BROWSER = "1";
  __setChatgptClearanceAcquireOverrideForTesting(async () => "fresh-cf-clearance-from-pool");

  installFakeResponses([
    {
      status: 403,
      headers: { "cf-mitigated": "1", "content-type": "text/html" },
      text: "<!DOCTYPE html><html>Just a moment...</html>",
    },
    {
      status: 200,
      headers: { "content-type": "application/json" },
      text: JSON.stringify({ accessToken: "real-token" }),
    },
  ]);

  const { validateChatGptWebProvider } = await setupValidator();
  const result = await validateChatGptWebProvider({
    apiKey: "fake-session-token",
    providerSpecificData: {},
  });

  assert.equal(result.valid, true, `expected valid, got error: ${result.error}`);
  assert.equal(calls.length, 2, "WEB_COOKIE_USE_BROWSER also triggers the retry");
});
