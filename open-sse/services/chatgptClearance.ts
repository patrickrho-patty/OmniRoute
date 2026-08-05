/**
 * chatgptClearance.ts — gated browser-backed cf_clearance acquisition for
 * chatgpt-web.
 *
 * chatgpt.com sits behind Cloudflare, which pins `cf_clearance` to the
 * client's IP+TLS+UA fingerprint. Pure cookie-replay from `chatgptTlsClient.ts`
 * (TLS-impersonating fetch) cannot forge a fresh clearance from a datacenter
 * egress that Cloudflare may flag — only a real browser solving the challenge
 * natively can mint one bound to that egress's own fingerprint.
 *
 * This module reuses the EXISTING provider-agnostic browser pool
 * (`browserPool.ts`, already live for claude-web + grok-web + duckduckgo-web).
 *
 * Opt-in only: gated behind `OMNIROUTE_BROWSER_POOL` / `WEB_COOKIE_USE_BROWSER`
 * (the same env gate already used by claude-web.ts / grok-web.ts). With the gate
 * off, `acquireFreshChatgptClearance` is never called.
 */

import { acquireBrowserContext, type PooledContext } from "./browserPool.ts";

const CHATGPT_WARMUP_URL = "https://chatgpt.com/";
const CHATGPT_COOKIE_DOMAIN = ".chatgpt.com";
const CHATGPT_POOL_KEY = "chatgpt-web";

/**
 * Reads the same opt-in gate as claude-web/grok-web/duckduckgo-web
 * (`WEB_COOKIE_USE_BROWSER` or `OMNIROUTE_BROWSER_POOL`). Off by default.
 */
export function shouldUseChatgptBrowserBacked(): boolean {
  const flag = process.env.WEB_COOKIE_USE_BROWSER;
  if (flag === "1" || flag === "true" || flag === "on") return true;
  const poolFlag = process.env.OMNIROUTE_BROWSER_POOL;
  return poolFlag === "on" || poolFlag === "1" || poolFlag === "true";
}

type AcquireChatgptClearanceFn = (signal?: AbortSignal | null) => Promise<string | null>;

// Test-only injection point — mirrors grokClearance.ts's pattern so unit tests
// can prove the gating/wiring without launching a real browser.
let acquireOverride: AcquireChatgptClearanceFn | null = null;

export function __setChatgptClearanceAcquireOverrideForTesting(
  fn: AcquireChatgptClearanceFn | null
): void {
  acquireOverride = fn;
}

async function readCfClearanceFromContext(pooled: PooledContext): Promise<string | null> {
  const cookies = await pooled.context.cookies(CHATGPT_WARMUP_URL);
  const match = cookies.find((c) => c.name === "cf_clearance");
  return match?.value || null;
}

async function acquireViaPool(): Promise<string | null> {
  try {
    const pooled = await acquireBrowserContext(CHATGPT_POOL_KEY, {
      cookieDomain: CHATGPT_COOKIE_DOMAIN,
      cookieString: null,
      warmupUrl: CHATGPT_WARMUP_URL,
    });
    return await readCfClearanceFromContext(pooled);
  } catch {
    return null;
  }
}

/**
 * Acquire a fresh `.chatgpt.com` cf_clearance via the shared browser pool.
 * The browser navigates to chatgpt.com, solves the Cloudflare challenge natively
 * from the server's own IP, and the resulting cf_clearance is bound to that IP.
 * Never throws — resolves to `null` on any failure so callers can fall through
 * to the Cloudflare-challenge error rather than crash the request.
 */
export async function acquireFreshChatgptClearance(
  signal?: AbortSignal | null
): Promise<string | null> {
  if (acquireOverride) return acquireOverride(signal);
  try {
    return await acquireViaPool();
  } catch {
    return null;
  }
}

/**
 * Merge a fresh cf_clearance value into an existing Cookie header string.
 * If the header already contains cf_clearance, replace it; otherwise append.
 * Pure function — safe to unit-test without a browser.
 */
export function mergeCfClearance(cookieHeader: string, cfClearance: string): string {
  if (/cf_clearance=/.test(cookieHeader)) {
    return cookieHeader.replace(/cf_clearance=[^;]*/, `cf_clearance=${cfClearance}`);
  }
  // No existing cf_clearance — append it. Ensure proper separator.
  const separator = cookieHeader.endsWith(";") ? " " : "; ";
  return `${cookieHeader}${separator}cf_clearance=${cfClearance}`;
}
