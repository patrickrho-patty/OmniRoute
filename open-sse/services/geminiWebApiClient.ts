/**
 * Gemini Web API Client — direct HTTP implementation (no Playwright).
 *
 * Replaces the Playwright browser automation with direct HTTP calls to
 * Gemini's batchexecute/StreamGenerate endpoints, matching how every other
 * web-cookie provider (ChatGPT, DeepSeek, etc.) works.
 *
 * Protocol (reverse-engineered from gemini.google.com web app):
 * 1. GET /app → extract `at` (SNlM0e), `bl` (cfb2h), `f.sid` (FdrFJe) from HTML
 * 2. POST StreamGenerate with the 69-element request envelope
 * 3. Parse the length-prefixed wrb.fr response frames
 *
 * Auth: __Secure-1PSID + __Secure-1PSIDTS cookies
 *
 * Reference: HanaokaYuzu/Gemini-API (Python), adapted for TypeScript.
 */

import { isCliCompatEnabled, CLI_FINGERPRINTS } from "../config/cliFingerprints.ts";
import tlsClient from "../utils/tlsClient.ts";

const GEMINI_BASE = "https://gemini.google.com";
const INIT_URL = `${GEMINI_BASE}/app`;
const BATCH_EXECUTE_URL = `${GEMINI_BASE}/_/BardChatUi/data/batchexecute`;

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

/** Token cache: cookie → { at, bl, fsid, expires } */
interface GeminiTokens {
  at: string;
  bl: string;
  fsid: string;
}
const tokenCache = new Map<string, { tokens: GeminiTokens; expires: number }>();
const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes

let _reqId = Math.floor(Math.random() * 90000) + 10000;
function nextReqId(): string {
  _reqId += 100000;
  return String(_reqId);
}

export function getGeminiWebUserAgent(): string {
  if (isCliCompatEnabled("gemini-web")) {
    const fp = CLI_FINGERPRINTS["gemini-web"];
    if (fp?.userAgent) {
      return typeof fp.userAgent === "function" ? fp.userAgent() : fp.userAgent;
    }
  }
  return DEFAULT_USER_AGENT;
}

/**
 * Build a Cookie header string from the raw credential cookie, ensuring
 * both __Secure-1PSID and __Secure-1PSIDTS are present.
 */
function buildCookieHeader(cookie: string): string {
  // The cookie string should already contain the name=value pairs.
  // parseCookies strips attributes — we just need the raw pairs.
  return cookie;
}

/**
 * Extract tokens (at, bl, fsid) from the Gemini /app HTML page.
 * These are embedded in script tags as WIZ_global_data / AF_initDataCallback.
 *
 * Note: Google removed SNlM0e (the `at` XSRF token) from the page in April 2026.
 * Confirmed by intercepting live browser traffic: batchexecute requests no
 * longer include the `at` form field at all. We extract bl and fsid only;
 * `at` is optional and will be empty string when not found.
 */
function extractTokens(html: string): GeminiTokens | null {
  // cfb2h = build label (REQUIRED — always present)
  const blMatch = html.match(/"cfb2h":"([^"]+)"/);
  // FdrFJe = session id (f.sid) — optional
  const fsidMatch = html.match(/"FdrFJe":"([^"]+)"/);
  // SNlM0e = XSRF access token (REMOVED by Google April 2026 — kept for compat)
  const atMatch = html.match(/"SNlM0e":"([^"]+)"/);

  if (!blMatch?.[1]) return null;

  return {
    at: atMatch?.[1] || "",
    bl: blMatch[1],
    fsid: fsidMatch?.[1] || "",
  };
}

/**
 * Fetch the /app page and extract auth tokens. Cached per-cookie for 10 min.
 *
 * Strategy:
 * 1. Try static HTML extraction (fast, no browser) via TLS-impersonated fetch.
 * 2. If SNlM0e is missing (Google moved it to JS-rendered content), use a
 *    one-time Playwright headless visit to execute JavaScript and extract
 *    the token from the live DOM. The token is cached so subsequent requests
 *    skip the browser entirely.
 */
async function fetchTokens(
  cookie: string,
  signal?: AbortSignal,
  allowBrowserExtraction = true
): Promise<GeminiTokens | null> {
  const cacheKey = cookie.slice(0, 64); // first 64 chars as cache key
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return cached.tokens;
  }

  // Strategy 1: static HTML extraction (fast path)
  const ua = getGeminiWebUserAgent();
  const fetchFn = tlsClient.available ? tlsClient.fetch.bind(tlsClient) : fetch;
  try {
    const resp = await fetchFn(INIT_URL, {
      method: "GET",
      headers: {
        Cookie: buildCookieHeader(cookie),
        "User-Agent": ua,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal,
    });
    if (resp.ok) {
      const html = await resp.text();
      const tokens = extractTokens(html);
      if (tokens) {
        tokenCache.set(cacheKey, { tokens, expires: Date.now() + TOKEN_TTL_MS });
        if (tokenCache.size > 50) {
          const first = tokenCache.keys().next().value;
          if (first) tokenCache.delete(first);
        }
        return tokens;
      }
    }
  } catch {
    // Static fetch failed — try browser extraction below
  }

  if (!allowBrowserExtraction) return null;

  // Strategy 2: Playwright one-time extraction (SNlM0e is JS-rendered)
  // Google moved SNlM0e out of static HTML in April 2026 — only a real
  // browser executing the page's JavaScript can access it via WIZ_global_data.
  try {
    const tokens = await extractTokensViaBrowser(cookie, ua, signal);
    if (tokens) {
      tokenCache.set(cacheKey, { tokens, expires: Date.now() + TOKEN_TTL_MS });
      if (tokenCache.size > 50) {
        const first = tokenCache.keys().next().value;
        if (first) tokenCache.delete(first);
      }
      return tokens;
    }
  } catch {
    // Browser extraction failed
  }

  return null;
}

/**
 * Extract auth tokens using a headless browser (executes JavaScript).
 * The SNlM0e token is loaded dynamically by Gemini's frontend and is only
 * accessible from the live DOM, not the static HTML.
 */
async function extractTokensViaBrowser(
  cookie: string,
  userAgent: string,
  _signal?: AbortSignal
): Promise<GeminiTokens | null> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ userAgent });
    const cookiePairs = cookie
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const eqIdx = part.indexOf("=");
        if (eqIdx === -1) return null;
        const name = part.substring(0, eqIdx).trim();
        const value = part.substring(eqIdx + 1).trim();
        if (!name || !value) return null;
        const lowerName = name.toLowerCase();
        if (
          ["path", "domain", "expires", "max-age", "secure", "httponly", "samesite"].includes(
            lowerName
          )
        ) {
          return null;
        }
        return { name, value };
      })
      .filter(Boolean) as Array<{ name: string; value: string }>;

    await context.addCookies(
      cookiePairs.map(({ name, value }) => ({
        name,
        value,
        domain: ".google.com",
        path: "/",
        secure: true,
      }))
    );

    const page = await context.newPage();
    await page.goto(INIT_URL, { waitUntil: "domcontentloaded", timeout: 20000 });
    // Wait for WIZ_global_data to be populated by JavaScript
    await page.waitForTimeout(2000);

    // Extract tokens from the live DOM (JavaScript-executed)
    const tokens = await page.evaluate(() => {
      const wiz = (window as unknown as Record<string, unknown>).WIZ_global_data as
        Record<string, unknown> | undefined;
      if (!wiz) return null;
      const at = typeof wiz.SNlM0e === "string" ? wiz.SNlM0e : "";
      const bl = typeof wiz.cfb2h === "string" ? wiz.cfb2h : "";
      const fsid = typeof wiz["FdrFJe"] === "string" ? wiz["FdrFJe"] : "";
      if (!at || !bl) return null;
      return { at, bl, fsid };
    });

    return tokens;
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Build the StreamGenerate request body (69-element inner array).
 *
 * Based on the Gemini web app's request format. The inner array is
 * JSON-stringified, then wrapped as [null, "<stringified>"].
 */
function buildStreamGenerateBody(prompt: string, _model?: string): string {
  const metadata = ["", "", "", null, null, null, null, null, null, ""];

  // message_content = [prompt, 0, None, req_file_data, None, None, 0]
  const messageContent = [prompt, 0, null, null, null, null, 0];

  // 69-element array with known indices populated
  const inner: unknown[] = new Array(69).fill(null);
  inner[0] = messageContent;
  inner[1] = ["en"]; // language
  inner[2] = metadata;
  inner[6] = [1];
  inner[7] = 1; // streaming flag
  inner[10] = 1;
  inner[17] = [[0]];
  inner[27] = 1;
  inner[30] = [4];
  inner[41] = [1];
  inner[53] = 0;
  inner[59] = crypto.randomUUID().toUpperCase();
  inner[68] = 2;

  // f.req = [null, JSON.stringify(inner)]
  const freq = JSON.stringify([null, JSON.stringify(inner)]);
  return freq;
}

/**
 * Parse the StreamGenerate response.
 *
 * Response format (length-prefixed frames):
 *   )]}'
 *   <utf16_length>
 *   [["wrb.fr", "<rpcid>", "<JSON string>", null, null, ...]]
 *   ...
 *
 * The JSON string at index [2] is itself JSON — parse it again to get the
 * nested response data. Text chunks are at inner[4][0][1].
 *
 * Each frame is a cumulative snapshot (repeats full text so far). We take
 * the longest (final complete snapshot).
 */
export function parseStreamGenerateResponse(raw: string): string {
  const textChunks: string[] = [];
  const lines = raw.split("\n");

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line === ")]}'" || /^\d+$/.test(line)) continue;
    if (!line.includes("wrb.fr")) continue;
    try {
      const arr = JSON.parse(line);
      if (!Array.isArray(arr) || !Array.isArray(arr[0]) || arr[0][0] !== "wrb.fr") continue;
      const payload = arr[0]?.[2];
      if (typeof payload !== "string") continue;
      const inner = JSON.parse(payload);
      const responseArray = inner?.[4]?.[0]?.[1];
      if (!Array.isArray(responseArray)) continue;
      const text = responseArray.filter((c: unknown) => typeof c === "string").join("");
      if (text) textChunks.push(text);
    } catch {
      // Skip unparseable lines
    }
  }

  if (textChunks.length === 0) return "";

  // Cumulative snapshots: take the longest (the final, complete snapshot)
  const isCumulative = textChunks.every(
    (chunk, i) =>
      i === 0 || chunk.startsWith(textChunks[i - 1]) || textChunks[i - 1].startsWith(chunk)
  );
  if (isCumulative) {
    return textChunks.reduce((longest, chunk) => (chunk.length > longest.length ? chunk : longest));
  }
  return textChunks.join("");
}

/**
 * Send a prompt to Gemini Web via direct HTTP (no Playwright).
 *
 * @returns The response text, or null if the request failed.
 */
export async function generateViaApi(
  prompt: string,
  cookie: string,
  model?: string,
  signal?: AbortSignal,
  options: { allowBrowserTokenExtraction?: boolean } = {}
): Promise<{ text: string; error?: string; status?: number }> {
  try {
    const tokens = await fetchTokens(cookie, signal, options.allowBrowserTokenExtraction !== false);
    if (!tokens) {
      return {
        text: "",
        error: "Could not extract auth tokens from Gemini — cookies may be expired",
        status: 401,
      };
    }

    const ua = getGeminiWebUserAgent();
    const reqId = nextReqId();
    const freq = buildStreamGenerateBody(prompt, model);

    // Build query params
    const params = new URLSearchParams({
      bl: tokens.bl,
      _reqid: reqId,
      rt: "c",
      hl: "en",
    });
    if (tokens.fsid) params.set("f.sid", tokens.fsid);

    // Form body: Google removed the `at` (XSRF) requirement in April 2026.
    // Live browser traffic confirms batchexecute no longer sends it.
    // We send it only if we happened to find it (backward compat).
    const formData = new URLSearchParams();
    if (tokens.at) formData.set("at", tokens.at);
    formData.set("f.req", freq);

    const fetchFn = tlsClient.available ? tlsClient.fetch.bind(tlsClient) : fetch;
    const resp = await fetchFn(`${BATCH_EXECUTE_URL}?${params}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
        Cookie: buildCookieHeader(cookie),
        "User-Agent": ua,
        Origin: GEMINI_BASE,
        Referer: `${GEMINI_BASE}/`,
        "X-Same-Domain": "1",
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
      },
      body: formData.toString(),
      signal,
    });

    if (!resp.ok) {
      return {
        text: "",
        error: `Gemini API returned HTTP ${resp.status}`,
        status: resp.status,
      };
    }

    const raw = await resp.text();
    const text = parseStreamGenerateResponse(raw);
    if (!text) {
      return {
        text: "",
        error: "No response text from Gemini StreamGenerate",
        status: 502,
      };
    }

    return { text };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw err;
    }
    return {
      text: "",
      error: sanitizeErrMessage(err),
      status: 502,
    };
  }
}

function sanitizeErrMessage(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 200);
  return "Unknown error";
}
