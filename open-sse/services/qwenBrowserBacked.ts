/**
 * qwenBrowserBacked.ts — browser-backed completion fallback for qwen-web.
 *
 * chat.qwen.ai's completions endpoint is protected by Alibaba "baxia"
 * per-request attestation: the SPA's own fetch/XHR wrapper (um.js + APLUS)
 * computes runtime headers (bx-umidtoken et al.) at send time. Static replay
 * cannot satisfy it — proven empirically (2026-08 live probes from the VPS
 * container): home-IP SOCKS egress + the user's full cookie jar + Chrome TLS
 * fingerprint (chrome_146) + cookies enriched by a real warmup page all still
 * get the RGV587_ERROR punish JSON on /api/v2/chat/completions, while the
 * browser UI works. The only passing path is the SPA's own send.
 *
 * So this adapter drives the REAL UI through the shared, provider-agnostic
 * browser pool (browserBackedChat — same engine claude-web/duckduckgo-web
 * use): navigate the conversation page, type the prompt, submit, and capture
 * the SPA's attested completions response from the network layer.
 *
 * Model fidelity without picker automation: the executor creates the chat via
 * HTTP first (/api/v2/chats/new is not attested and succeeds with the
 * requested model); navigating to /c/<chatId> opens a conversation already
 * bound to that model, so the browser send uses the right one.
 *
 * Opt-in only: same gate as claude-web/grok-web/duckduckgo-web
 * (OMNIROUTE_BROWSER_POOL / WEB_COOKIE_USE_BROWSER). The browser context is
 * pool-keyed "qwen-web", so browserPool resolves the provider-scoped proxy
 * from the registry — e.g. routing egress through the home tunnel.
 */

import { browserBackedChat, type BrowserBackedChatResult } from "./browserBackedChat.ts";

const QWEN_PAGE_URL = "https://chat.qwen.ai";
const QWEN_CHAT_URL = `${QWEN_PAGE_URL}/api/v2/chat/completions`;
const QWEN_COOKIE_DOMAIN = ".chat.qwen.ai";
const QWEN_POOL_KEY = "qwen-web";
// Keep in sync with the executor's UA (Chrome-on-macOS desktop).
const QWEN_BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
// Qwen Studio composer (0.2.x): a contenteditable rich-text box; some builds
// use a plain textarea. Playwright's comma-separated selector list + .first()
// (browserBackedChat does .first()) covers both. Submit falls back to Enter.
const QWEN_INPUT_SELECTOR = '#chat-input, div[contenteditable="true"], textarea';

/**
 * Reads the same opt-in gate as claude-web/grok-web/duckduckgo-web
 * (`WEB_COOKIE_USE_BROWSER` or `OMNIROUTE_BROWSER_POOL`). Off by default.
 */
export function shouldUseQwenBrowserBacked(): boolean {
  const flag = process.env.WEB_COOKIE_USE_BROWSER;
  if (flag === "1" || flag === "true" || flag === "on") return true;
  const poolFlag = process.env.OMNIROUTE_BROWSER_POOL;
  return poolFlag === "on" || poolFlag === "1" || poolFlag === "true";
}

type QwenBrowserCompletionFn = (params: {
  chatId: string;
  prompt: string;
  cookieHeader: string;
  signal?: AbortSignal | null;
}) => Promise<Response | null>;

// Test-only injection point — mirrors grokClearance.ts so unit tests prove the
// gating/wiring without launching a real browser (no Chromium in CI).
let completionOverride: QwenBrowserCompletionFn | null = null;

export function __setQwenBrowserCompletionOverrideForTesting(
  fn: QwenBrowserCompletionFn | null
): void {
  completionOverride = fn;
}

/**
 * Drive the qwen-web conversation UI and capture the attested completions
 * response. Returns a Response whose body is the captured upstream SSE (phase
 * format) — feed it into the executor's normal stream machinery — or null on
 * any failure so the caller falls through to the honest 429 punish error.
 * Never throws.
 */
export async function qwenBrowserBackedCompletion(params: {
  chatId: string;
  prompt: string;
  cookieHeader: string;
  signal?: AbortSignal | null;
}): Promise<Response | null> {
  if (completionOverride) return completionOverride(params);
  console.info(
    `[QWEN_BROWSER] starting SPA fallback chat=${params.chatId.slice(0, 8)} promptChars=${params.prompt.length}`
  );
  try {
    const result: BrowserBackedChatResult = await browserBackedChat({
      poolKey: QWEN_POOL_KEY,
      chatUrl: QWEN_CHAT_URL,
      chatPageUrl: `${QWEN_PAGE_URL}/c/${params.chatId}`,
      userMessage: params.prompt,
      cookieString: params.cookieHeader,
      cookieDomain: QWEN_COOKIE_DOMAIN,
      chatUrlMatchDomain: "chat.qwen.ai",
      userAgent: QWEN_BROWSER_UA,
      inputSelector: QWEN_INPUT_SELECTOR,
      submitButtonSelector: 'button[aria-label="Send"]',
      postSubmitWaitMs: 15_000,
      signal: params.signal ?? null,
    });
    console.info(
      `[QWEN_BROWSER] captured response status=${result.status} contentType=${result.contentType || "unknown"} bytes=${result.body.length} totalMs=${result.timing.totalMs}`
    );
    if (result.status < 200 || result.status >= 400 || result.body.length === 0) {
      return null;
    }
    return new Response(result.body, {
      status: result.status,
      headers: {
        "content-type": result.contentType || "text/event-stream",
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240);
    console.warn(`[QWEN_BROWSER] SPA fallback failed: ${message}`);
    return null;
  }
}
