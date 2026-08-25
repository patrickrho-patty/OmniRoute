/**
 * ChatGptWebExecutor — ChatGPT Web Session Provider
 *
 * Routes requests through chatgpt.com's internal SSE API using a Plus/Pro
 * subscription session cookie, translating between OpenAI chat completions
 * format and ChatGPT's internal protocol.
 *
 * Auth pipeline (per request):
 *   1. exchangeSession()          GET  /api/auth/session       cookie → JWT accessToken (cached ~5min)
 *   2. prepareChatRequirements()  POST /backend-api/sentinel/chat-requirements
 *                                                              → { proofofwork.seed, difficulty, persona }
 *   3. solveProofOfWork()         SHA3-512 hash loop           → "gAAAAAB…" sentinel proof token
 *   4. fetch /backend-api/conversation                         with Bearer + sentinel-proof-token + browser UA
 *
 * Response is the standard ChatGPT SSE format (cumulative `parts[0]` strings, not deltas).
 */

import { BaseExecutor, type ExecuteInput, type ProviderCredentials } from "./base.ts";
import { describeChatGptWebHttpError } from "./chatgptWebErrors.ts";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import {
  tlsFetchChatGpt,
  TlsClientUnavailableError,
  type TlsFetchResult,
} from "../services/chatgptTlsClient.ts";
import {
  shouldUseChatgptBrowserBacked,
  acquireFreshChatgptClearance,
  mergeCfClearance,
} from "../services/chatgptClearance.ts";
import {
  acquireChatGptConversationLock,
  getChatGptConversationContext,
  setChatGptConversationContext,
  deleteChatGptConversationContext,
  __resetChatGptConversationCacheForTesting,
  type ChatGptConversationContext,
} from "../services/chatgptConversationCache.ts";
import {
  storeChatGptImage,
  getChatGptImageConversationContext,
  __resetChatGptImageCacheForTesting,
  type ChatGptImageConversationContext,
} from "../services/chatgptImageCache.ts";
import {
  extractCurrentTurnImageUrls,
  uploadCurrentTurnImages,
  type UploadedChatGptImage,
  type ChatGptUploadAuthContext,
} from "../services/chatgptImageUpload.ts";
import { getHeader } from "../utils/headers.ts";
import {
  prepareWebToolRequest,
  decodeWebToolResponse,
} from "../services/webProvider/toolPipeline.ts";
import { CHATGPT_WEB_PROTOCOL_MARKER } from "../services/webProvider/toolContract.ts";
import { CODEX_PERSONA } from "../config/codexPersona.ts";
import {
  detectWebToolGuardViolation,
  type WebToolGuardMode,
} from "../services/webProvider/excuseGuard.ts";
import { buildWebToolContractFingerprint } from "../services/webProvider/toolFingerprint.ts";
import type { OpenAIToolCall, WebToolChoice } from "../services/webProvider/types.ts";

import {
  resolveChatGptModel,
  resolveChatGptSystemHints,
  type ChatGptThinkingEffort,
} from "./chatgpt-web/models.ts";
import { resumeChatGptHandoff, type FinalAssistantAnswer } from "./chatgpt-web/handoff.ts";

// ─── Constants ──────────────────────────────────────────────────────────────

const CHATGPT_BASE = "https://chatgpt.com";
const SESSION_URL = `${CHATGPT_BASE}/api/auth/session`;
const SENTINEL_PREPARE_URL = `${CHATGPT_BASE}/backend-api/sentinel/chat-requirements/prepare`;
const SENTINEL_CR_URL = `${CHATGPT_BASE}/backend-api/sentinel/chat-requirements`;
const CONV_URL = `${CHATGPT_BASE}/backend-api/f/conversation`;

const DEFAULT_PRO_POLL_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_PRO_POLL_INTERVAL_MS = 4_000;

const CHATGPT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:148.0) Gecko/20100101 Firefox/148.0";

// Captured from a real chatgpt.com browser session (April 2026).
const OAI_CLIENT_VERSION = "prod-81e0c5cdf6140e8c5db714d613337f4aeab94029";
const OAI_CLIENT_BUILD_NUMBER = "6128297";

// Per-cookie device ID. The browser stores a persistent `oai-did` cookie that
// uniquely identifies the device for OpenAI's risk model — we derive a stable
// UUID from a hash of the session cookie so that each account/connection gets
// its own device id, but it doesn't change between requests.
const deviceIdCache = new Map<string, string>();
function deviceIdFor(cookie: string): string {
  const key = cookieKey(cookie);
  let id = deviceIdCache.get(key);
  if (!id) {
    // Synthesize a UUID v4-shaped string from a SHA-256 of the cookie. Stable,
    // deterministic per cookie, no PII (the cookie's already secret).
    // Not a password hash — SHA-256 is used to derive a stable UUID from the
    // session cookie for device-id fingerprinting. The output is a cache key.
    const h = createHash("sha256").update(cookie).digest("hex"); // lgtm[js/insufficient-password-hash]
    id =
      `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-` +
      `${((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-` +
      h.slice(20, 32);
    if (deviceIdCache.size >= 200) {
      const first = deviceIdCache.keys().next().value;
      if (first) deviceIdCache.delete(first);
    }
    deviceIdCache.set(key, id);
  }
  return id;
}

// OmniRoute model IDs select a GPT-5.6 Sol performance lane. Captured browser
// requests use one of `gpt-5-6`, `gpt-5-6-thinking`, or `gpt-5-6-pro`.

// ─── Browser-like default headers ──────────────────────────────────────────

function browserHeaders(): Record<string, string> {
  return {
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    Origin: CHATGPT_BASE,
    Pragma: "no-cache",
    Referer: `${CHATGPT_BASE}/`,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "User-Agent": CHATGPT_USER_AGENT,
  };
}

/** Headers ChatGPT's web client sends on backend-api requests. */
function oaiHeaders(sessionId: string, deviceId: string): Record<string, string> {
  return {
    "OAI-Language": "en-US",
    "OAI-Device-Id": deviceId,
    "OAI-Client-Version": OAI_CLIENT_VERSION,
    "OAI-Client-Build-Number": OAI_CLIENT_BUILD_NUMBER,
    "OAI-Session-Id": sessionId,
  };
}

// ─── Session token cache ────────────────────────────────────────────────────

interface TokenEntry {
  accessToken: string;
  accountId: string | null;
  expiresAt: number;
  refreshedCookie?: string;
}

const TOKEN_TTL_MS = 5 * 60 * 1000; // 5min — accessTokens are short-lived
const tokenCache = new Map<string, TokenEntry>();

function cookieKey(cookie: string): string {
  // SHA-256 prefix (64 bits). Used as the Map key for tokenCache and
  // warmupCache; the previous 32-bit FNV-1a was small enough that a
  // birthday-paradox collision could surface one user's cached accessToken
  // to another's request. 64 bits is overkill for the 200-entry cache but
  // costs essentially nothing.
  // Not a password hash — SHA-256 is used to derive a short, collision-resistant
  // cache key from the session cookie. The output is a map lookup key.
  return createHash("sha256").update(cookie).digest("hex").slice(0, 16); // lgtm[js/insufficient-password-hash]
}

/**
 * Resolve the client thread identity for conversation continuity. Codex-specific
 * priority order: prompt_cache_key → client_metadata → session headers →
 * x-codex-turn-metadata. Related resolvers with different semantics:
 * normalizeCodexSessionId (config/codexClient.ts), extractExternalSessionId
 * (services/sessionManager.ts), getConversationCacheKey (services/taskAwareRouting.ts).
 */
function resolveConversationThreadId(
  body: Record<string, unknown>,
  clientHeaders: Record<string, string> | null | undefined
): string | null {
  const promptCacheKey = body.prompt_cache_key;
  if (typeof promptCacheKey === "string" && promptCacheKey.trim()) {
    return promptCacheKey.trim();
  }

  const clientMetadata = body.client_metadata;
  if (clientMetadata && typeof clientMetadata === "object" && !Array.isArray(clientMetadata)) {
    const metadata = clientMetadata as Record<string, unknown>;
    for (const key of ["thread_id", "session_id"]) {
      const value = metadata[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }

  for (const name of ["thread-id", "session-id", "x-codex-session-id", "x-session-id"]) {
    const value = getHeader(clientHeaders, name)?.trim();
    if (value) return value;
  }

  const rawTurnMetadata = getHeader(clientHeaders, "x-codex-turn-metadata")?.trim();
  if (rawTurnMetadata) {
    try {
      const metadata = JSON.parse(rawTurnMetadata) as Record<string, unknown>;
      for (const key of ["thread_id", "session_id"]) {
        const value = metadata[key];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
    } catch {
      // Ignore malformed optional client metadata.
    }
  }

  return null;
}

function buildConversationCacheKey(
  body: Record<string, unknown>,
  clientHeaders: Record<string, string> | null | undefined,
  accountIdentity: string,
  connectionId: string | undefined,
  model: string,
  callerIdentity: string | null | undefined
): string | null {
  const threadId = resolveConversationThreadId(body, clientHeaders);
  if (!threadId || !callerIdentity) return null;
  // A ChatGPT account can be connected by multiple OmniRoute principals. Scope
  // a client-selected thread id to its stored connection when available.
  const connectionScope = connectionId || accountIdentity;
  return createHash("sha256")
    .update(`${callerIdentity}:${connectionScope}:${accountIdentity}:${model}:${threadId}`)
    .digest("hex");
}

function tokenLookup(cookie: string): TokenEntry | null {
  const entry = tokenCache.get(cookieKey(cookie));
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    tokenCache.delete(cookieKey(cookie));
    return null;
  }
  return entry;
}

const TOKEN_CACHE_MAX = 200;

function tokenStore(cookie: string, entry: TokenEntry): void {
  // Bound the cache to TOKEN_CACHE_MAX entries (FIFO). Same shape as the
  // image cache and warmup cache — drop the oldest before inserting.
  if (tokenCache.size >= TOKEN_CACHE_MAX && !tokenCache.has(cookieKey(cookie))) {
    const firstKey = tokenCache.keys().next().value;
    if (firstKey) tokenCache.delete(firstKey);
  }
  tokenCache.set(cookieKey(cookie), entry);
}

// Conversation continuity is intentionally not cached. Open WebUI and most
// OpenAI-API-style clients re-send the full history each turn, so each
// request just starts a fresh conversation. Temporary Chat mode is the
// default; it gets disabled per-request only for image-gen prompts, since
// that mode rejects the image_gen tool.

// ─── /api/auth/session — exchange cookie for JWT ────────────────────────────

interface SessionResponse {
  accessToken?: string;
  expires?: string;
  user?: { id?: string };
}

// Session-token family — NextAuth uses one of these depending on token size:
//   __Secure-next-auth.session-token            (unchunked, < 4KB)
//   __Secure-next-auth.session-token.0          (chunked, first piece)
//   __Secure-next-auth.session-token.N          (chunked, additional pieces)
// Rotation can change the shape (unchunked → chunked or vice versa). When
// that happens, every old family member must be dropped — keeping the stale
// variant alongside the new one would send both, and depending on parser
// precedence the server could read the stale value and fail auth.
const SESSION_TOKEN_FAMILY_RE = /^__Secure-next-auth\.session-token(?:\.\d+)?$/;

/**
 * Merge any rotated session-token chunks from a Set-Cookie response into the
 * original cookie blob, preserving every other cookie the caller pasted
 * (cf_clearance, __cf_bm, _cfuvid, _puid, ...). Returns null if no rotation
 * occurred or the rotated chunks match what's already there.
 *
 * Returning only the matched session-token chunks here was a bug: when the
 * caller pastes a full DevTools Cookie line (the recommended form), the
 * Cloudflare cookies are required for subsequent requests, and dropping
 * them re-triggers `cf-mitigated: challenge`.
 */
function mergeRefreshedCookie(
  originalCookie: string,
  setCookieHeader: string | null
): string | null {
  if (!setCookieHeader) return null;
  const matches = Array.from(
    setCookieHeader.matchAll(/(__Secure-next-auth\.session-token(?:\.\d+)?)=([^;,\s]+)/g)
  );
  if (matches.length === 0) return null;

  const refreshed = new Map<string, string>();
  for (const m of matches) refreshed.set(m[1], m[2]);

  let blob = originalCookie.trim();
  if (/^cookie\s*:\s*/i.test(blob)) blob = blob.replace(/^cookie\s*:\s*/i, "");

  // Bare value (no `=`): the original was just the session-token contents.
  // Replace with the new chunked form.
  if (!/=/.test(blob)) {
    return Array.from(refreshed, ([k, v]) => `${k}=${v}`).join("; ");
  }

  const pairs = blob.split(/;\s*/).filter(Boolean);
  const result: string[] = [];
  let mutated = false;
  let droppedStale = false;
  for (const pair of pairs) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx < 0) {
      result.push(pair);
      continue;
    }
    const name = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1);
    // Drop ALL session-token-family members from the original — we'll
    // append the refreshed set below. This handles unchunked→chunked and
    // chunked→unchunked rotations, where keeping the old name would leave
    // the stale token visible alongside the new one.
    if (SESSION_TOKEN_FAMILY_RE.test(name)) {
      if (!refreshed.has(name) || refreshed.get(name) !== value) mutated = true;
      droppedStale = true;
      continue;
    }
    result.push(`${name}=${value}`);
  }
  // Append the full refreshed family.
  for (const [name, value] of refreshed) {
    result.push(`${name}=${value}`);
  }
  if (!droppedStale) mutated = true; // refreshed chunks were entirely new
  return mutated ? result.join("; ") : null;
}

/**
 * Build the Cookie header value from whatever the user pasted.
 *
 * Accepts:
 *   - A bare value:                       "eyJhbGc..."  →  prepended with __Secure-next-auth.session-token=
 *   - An unchunked cookie line:           "__Secure-next-auth.session-token=eyJ..."
 *   - A chunked cookie line:              "__Secure-next-auth.session-token.0=...; __Secure-next-auth.session-token.1=..."
 *   - The full DevTools cookie header:    "Cookie: __Secure-next-auth.session-token.0=...; cf_clearance=..."
 *
 * If the user pastes a chunked token, we pass the cookies through verbatim —
 * NextAuth's server reassembles them on its side.
 */
function buildSessionCookieHeader(rawInput: string): string {
  let s = rawInput.trim();
  if (/^cookie\s*:\s*/i.test(s)) s = s.replace(/^cookie\s*:\s*/i, "");
  if (/__Secure-next-auth\.session-token(?:\.\d+)?\s*=/.test(s)) {
    return s;
  }
  return `__Secure-next-auth.session-token=${s}`;
}

async function exchangeSession(
  cookie: string,
  signal: AbortSignal | null | undefined
): Promise<TokenEntry> {
  const cached = tokenLookup(cookie);
  if (cached) return cached;

  const headers: Record<string, string> = {
    ...browserHeaders(),
    Accept: "application/json",
    Cookie: buildSessionCookieHeader(cookie),
  };

  let response = await tlsFetchChatGpt(SESSION_URL, {
    method: "GET",
    headers,
    timeoutMs: 30_000,
    signal,
  });

  // Browser-backed cf_clearance refresh: if Cloudflare blocks (not an auth
  // failure), try acquiring a fresh cf_clearance from the server's IP via
  // the stealth browser pool, merge it into the cookie, and retry once.
  if (
    response.status === 403 &&
    shouldUseChatgptBrowserBacked() &&
    (response.headers.get("cf-mitigated") ||
      /just a moment|cloudflare|cf-chl|attention required/i.test(response.text || ""))
  ) {
    const freshClearance = await acquireFreshChatgptClearance(signal);
    if (freshClearance) {
      const refreshedCookie = mergeCfClearance(cookie, freshClearance);
      const retryResp = await tlsFetchChatGpt(SESSION_URL, {
        method: "GET",
        headers: { ...headers, Cookie: buildSessionCookieHeader(refreshedCookie) },
        timeoutMs: 30_000,
        signal,
      });
      if (retryResp.status < 400) {
        response = retryResp;
      }
    }
  }

  if (response.status === 401 || response.status === 403) {
    throw new SessionAuthError("Invalid session cookie");
  }
  if (response.status >= 400) {
    throw new Error(`Session exchange failed (HTTP ${response.status})`);
  }

  const refreshed = mergeRefreshedCookie(cookie, response.headers.get("set-cookie"));
  let data: SessionResponse = {};
  try {
    data = JSON.parse(response.text || "{}");
  } catch {
    console.warn("[chatgpt-web] session response JSON parse failed");
    /* empty body or non-JSON */
  }
  if (!data.accessToken) {
    throw new SessionAuthError("Session response missing accessToken — cookie likely expired");
  }

  const expiresAt = data.expires ? new Date(data.expires).getTime() : Date.now() + TOKEN_TTL_MS;
  const entry: TokenEntry = {
    accessToken: data.accessToken,
    accountId: data.user?.id ?? null,
    expiresAt: Math.min(expiresAt, Date.now() + TOKEN_TTL_MS),
    refreshedCookie: refreshed ?? undefined,
  };
  tokenStore(cookie, entry);
  return entry;
}

class SessionAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionAuthError";
  }
}

// ─── /backend-api/sentinel/chat-requirements ────────────────────────────────

interface ChatRequirements {
  /** Returned by /chat-requirements (the "real" chat requirements token). */
  token?: string;
  /** Returned by /chat-requirements/prepare (sent as a prerequisite header). */
  prepare_token?: string;
  persona?: string;
  proofofwork?: {
    required?: boolean;
    seed?: string;
    difficulty?: string;
  };
  turnstile?: {
    required?: boolean;
    dx?: string;
  };
}

// ─── Session warmup ────────────────────────────────────────────────────────
// Mimics chatgpt.com's page-load fetch sequence so Sentinel sees a "warm"
// browsing session. Cached per (cookie, access-token) pair for 60s to avoid
// hammering the warmup endpoints on every chat completion.

const warmupCache = new Map<string, number>();
const WARMUP_TTL_MS = 60_000;
const WARMUP_CACHE_MAX = 200;

async function runSessionWarmup(
  accessToken: string,
  accountId: string | null,
  sessionId: string,
  deviceId: string,
  cookie: string,
  signal: AbortSignal | null | undefined,
  log: { debug?: (tag: string, msg: string) => void } | null | undefined
): Promise<void> {
  const key = cookieKey(cookie) + ":" + accessToken.slice(-8);
  const now = Date.now();
  const last = warmupCache.get(key);
  if (last && now - last < WARMUP_TTL_MS) return;
  // Bound the cache: drop the oldest entry once we hit the cap. Map iteration
  // order is insertion order, so the first key is the oldest.
  if (warmupCache.size >= WARMUP_CACHE_MAX && !warmupCache.has(key)) {
    const first = warmupCache.keys().next().value;
    if (first) warmupCache.delete(first);
  }
  warmupCache.set(key, now);

  const headers: Record<string, string> = {
    ...browserHeaders(),
    ...oaiHeaders(sessionId, deviceId),
    Accept: "*/*",
    Authorization: `Bearer ${accessToken}`,
    Cookie: buildSessionCookieHeader(cookie),
    Priority: "u=1, i",
  };
  if (accountId) headers["chatgpt-account-id"] = accountId;

  const urls = [
    `${CHATGPT_BASE}/backend-api/me`,
    `${CHATGPT_BASE}/backend-api/conversations?offset=0&limit=28&order=updated`,
    `${CHATGPT_BASE}/backend-api/models?history_and_training_disabled=false`,
  ];

  for (const url of urls) {
    try {
      const r = await tlsFetchChatGpt(url, {
        method: "GET",
        headers,
        timeoutMs: 15_000,
        signal,
      });
      log?.debug?.("CGPT-WEB", `warmup ${url.split("/backend-api/")[1]} → ${r.status}`);
    } catch (err) {
      log?.debug?.(
        "CGPT-WEB",
        `warmup ${url} failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

function configuredProPollTimeoutMs(): number {
  const raw = Number(process.env.OMNIROUTE_CGPT_WEB_PRO_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_PRO_POLL_TIMEOUT_MS;
  return Math.floor(raw);
}

function configuredProPollIntervalMs(): number {
  const raw = Number(process.env.OMNIROUTE_CGPT_WEB_PRO_INTERVAL_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_PRO_POLL_INTERVAL_MS;
  return Math.floor(raw);
}

/** Map either a chatgpt.com-native value (`standard`/`extended`) or the
 * OpenAI Chat Completions `reasoning_effort` field to the value the
 * `user_last_used_model_config` endpoint expects.
 *
 *   minimal | low | medium | standard  → standard
 *   high    | xhigh | extended         → extended
 *
 * `medium` collapses to `standard` because chatgpt.com only has two levels —
 * there is no separate medium tier on the web product. Returns null for
 * absent/unknown inputs. */
async function prepareChatRequirements(
  accessToken: string,
  accountId: string | null,
  sessionId: string,
  deviceId: string,
  cookie: string,
  dplInfo: { dpl: string; scriptSrc: string },
  signal: AbortSignal | null | undefined,
  log?: { warn?: (tag: string, msg: string) => void } | null
): Promise<ChatRequirements> {
  const config = buildPrekeyConfig(CHATGPT_USER_AGENT, dplInfo.dpl, dplInfo.scriptSrc);
  const prekey = await buildPrepareToken(config, log);

  const headers: Record<string, string> = {
    ...browserHeaders(),
    ...oaiHeaders(sessionId, deviceId),
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    Cookie: buildSessionCookieHeader(cookie),
    Priority: "u=1, i",
  };
  if (accountId) headers["chatgpt-account-id"] = accountId;

  // Stage 1: POST /chat-requirements/prepare → { prepare_token, ... }
  const prepResp = await tlsFetchChatGpt(SENTINEL_PREPARE_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ p: prekey }),
    timeoutMs: 30_000,
    signal,
  });
  if (prepResp.status === 401 || prepResp.status === 403) {
    throw new SentinelBlockedError(`Sentinel /prepare blocked (HTTP ${prepResp.status})`);
  }
  if (prepResp.status >= 400) {
    throw new Error(`Sentinel /prepare failed (HTTP ${prepResp.status})`);
  }
  let prepData: ChatRequirements = {};
  try {
    prepData = JSON.parse(prepResp.text || "{}") as ChatRequirements;
  } catch {
    console.warn("[chatgpt-web] chat requirements prep JSON parse failed");
    /* keep empty */
  }
  // Stage 2: POST /chat-requirements with the prepare_token in the body. This
  // is the call that actually returns the chat-requirements-token used on the
  // conversation request.
  if (!prepData.prepare_token) {
    return prepData; // pass through whatever we got — caller handles missing fields
  }

  const crBody: Record<string, unknown> = { p: prekey, prepare_token: prepData.prepare_token };
  const crResp = await tlsFetchChatGpt(SENTINEL_CR_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(crBody),
    timeoutMs: 30_000,
    signal,
  });
  if (crResp.status === 401 || crResp.status === 403) {
    throw new SentinelBlockedError(`Sentinel /chat-requirements blocked (HTTP ${crResp.status})`);
  }
  if (crResp.status >= 400) {
    // Fall back to whatever /prepare returned — some accounts may not need stage 2.
    return prepData;
  }
  try {
    const crData = JSON.parse(crResp.text || "{}") as ChatRequirements;
    // Merge: prepare_token from stage 1, everything else from stage 2.
    return { ...crData, prepare_token: prepData.prepare_token };
  } catch {
    console.warn("[chatgpt-web] chat requirements response JSON parse failed");
    return prepData;
  }
}

class SentinelBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SentinelBlockedError";
  }
}

// ─── Proof-of-work solver ──────────────────────────────────────────────────
// Mimics the openai-sentinel / chat2api algorithm. The browser sends a base64-encoded
// JSON config string; the server combines it with a seed and expects a SHA3-512 hash
// whose hex-prefix is ≤ the difficulty target.
//
// Reference: github.com/leetanshaj/openai-sentinel, github.com/lanqian528/chat2api
// Returns "gAAAAAB" + base64 of the winning config (server-recognised prefix).

// ─── DPL / script-src cache (warmup) ────────────────────────────────────────
// Sentinel's prekey check inspects whether config[5]/config[6] reference a real
// chatgpt.com deployment (DPL hash + a script URL from the HTML). We GET / once
// per hour to scrape these — same trick chat2api uses.

interface DplInfo {
  dpl: string;
  scriptSrc: string;
  expiresAt: number;
}
let dplCache: DplInfo | null = null;
const DPL_TTL_MS = 60 * 60 * 1000;

async function fetchDpl(
  cookie: string,
  signal: AbortSignal | null | undefined
): Promise<{ dpl: string; scriptSrc: string }> {
  if (dplCache && Date.now() < dplCache.expiresAt) {
    return { dpl: dplCache.dpl, scriptSrc: dplCache.scriptSrc };
  }
  const headers: Record<string, string> = {
    ...browserHeaders(),
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    Cookie: buildSessionCookieHeader(cookie),
  };
  const response = await tlsFetchChatGpt(`${CHATGPT_BASE}/`, {
    method: "GET",
    headers,
    timeoutMs: 20_000,
    signal,
  });
  const html = response.text || "";
  const dplMatch = html.match(/data-build="([^"]+)"/);
  const dpl = dplMatch ? `dpl=${dplMatch[1]}` : `dpl=${OAI_CLIENT_VERSION.replace(/^prod-/, "")}`;
  const scriptMatch = html.match(/<script[^>]+src="(https?:\/\/[^"]*\.js[^"]*)"/);
  const scriptSrc =
    scriptMatch?.[1] ?? `${CHATGPT_BASE}/_next/static/chunks/webpack-${randomHex(16)}.js`;
  dplCache = { dpl, scriptSrc, expiresAt: Date.now() + DPL_TTL_MS };
  return { dpl, scriptSrc };
}

function randomHex(n: number): string {
  return randomBytes(Math.ceil(n / 2))
    .toString("hex")
    .slice(0, n);
}

// ─── Browser fingerprint key lists (used in prekey config[10..12]) ─────────
// Chosen to look like real navigator/document/window inspection. The unicode
// MINUS SIGN (U+2212) in the navigator strings matches what `Object.toString()`
// produces in real browsers — Sentinel checks for it.

const NAVIGATOR_KEYS = [
  "webdriver−false",
  "geolocation",
  "languages",
  "language",
  "platform",
  "userAgent",
  "vendor",
  "hardwareConcurrency",
  "deviceMemory",
  "permissions",
  "plugins",
  "mediaDevices",
];

const DOCUMENT_KEYS = [
  "_reactListeningkfj3eavmks",
  "_reactListeningo743lnnpvdg",
  "location",
  "scrollingElement",
  "documentElement",
];

const WINDOW_KEYS = [
  "webpackChunk_N_E",
  "__NEXT_DATA__",
  "chrome",
  "history",
  "screen",
  "navigation",
  "scrollX",
  "scrollY",
];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function buildPrekeyConfig(userAgent: string, dpl: string, scriptSrc: string): unknown[] {
  const screenSizes = [3000, 4000, 3120, 4160] as const;
  const cores = [8, 16, 24, 32] as const;
  const dateStr = new Date().toString();
  const perfNow = performance.now();
  const epochOffset = Date.now() - perfNow;

  return [
    pick(screenSizes),
    dateStr,
    4294705152,
    0, // mutated by solver
    userAgent,
    scriptSrc,
    dpl,
    "en-US",
    "en-US,en",
    0, // mutated by solver
    pick(NAVIGATOR_KEYS),
    pick(DOCUMENT_KEYS),
    pick(WINDOW_KEYS),
    perfNow,
    randomUUID(),
    "",
    pick(cores),
    epochOffset,
  ];
}

/**
 * Build the `p` (prekey) value sent in the chat-requirements POST body.
 *
 * Format: "<prefix>" + base64(JSON(config)), with a PoW solver loop mutating
 * config[3] to find a hash whose hex prefix is ≤ the target difficulty.
 * Mirrors chat2api / openai-sentinel.
 *   - prepare:      prefix="gAAAAAC", seed=""           (target "0fffff")
 *   - chat-requirements: prefix="gAAAAAB", seed=<server seed>  (target=difficulty)
 *
 * Submitting an unsolved token still works on low-friction accounts, so we
 * fall back to that after exhausting the iteration budget — but emit a warn
 * log so production can see when it happens.
 */
// PoW solvers run up to 100k–500k SHA3-512 hashes. To avoid blocking the
// Node event loop on a busy server, we yield with `setImmediate` every
// POW_YIELD_EVERY iterations — roughly every ~5ms of work — so concurrent
// requests and I/O still get scheduled. Wall time is approximately the same
// as the synchronous version; what changes is fairness, not throughput.
const POW_YIELD_EVERY = 1000;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface PowOptions {
  config: unknown[];
  seed: string;
  target: string;
  prefix: string;
  maxIter: number;
  label: string;
  log?: { warn?: (tag: string, msg: string) => void } | null;
}

async function solvePow(opts: PowOptions): Promise<string> {
  const cfg = [...opts.config];
  for (let i = 0; i < opts.maxIter; i++) {
    if (i > 0 && i % POW_YIELD_EVERY === 0) await yieldToEventLoop();
    cfg[3] = i;
    const json = JSON.stringify(cfg);
    const b64 = Buffer.from(json).toString("base64");
    const hash = createHash("sha3-512")
      .update(opts.seed + b64)
      .digest("hex");
    if (opts.target && hash.slice(0, opts.target.length) <= opts.target) {
      return `${opts.prefix}${b64}`;
    }
  }
  opts.log?.warn?.(
    "CGPT-WEB",
    `PoW (${opts.label}) exhausted ${opts.maxIter} iterations against target=${opts.target || "<empty>"}; submitting unsolved token (Sentinel may reject)`
  );
  const b64 = Buffer.from(JSON.stringify(cfg)).toString("base64");
  return `${opts.prefix}${b64}`;
}

async function buildPrepareToken(
  config: unknown[],
  log?: { warn?: (tag: string, msg: string) => void } | null
): Promise<string> {
  return solvePow({
    config,
    seed: "",
    target: "0fffff",
    prefix: "gAAAAAC",
    maxIter: 100_000,
    label: "prepare",
    log,
  });
}

async function solveProofOfWork(
  seed: string,
  difficulty: string,
  config: unknown[],
  log?: { warn?: (tag: string, msg: string) => void } | null
): Promise<string> {
  return solvePow({
    config,
    seed,
    target: (difficulty || "").toLowerCase(),
    prefix: "gAAAAAB",
    maxIter: 500_000,
    label: "conversation",
    log,
  });
}

// ─── OpenAI → ChatGPT message translation ───────────────────────────────────

type ParsedToolCall = OpenAIToolCall;

type ParsedHistoryItem =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: ParsedToolCall[] }
  | { role: "tool"; content: string; toolCallId: string; toolName: string };

interface ParsedMessages {
  systemMsg: string;
  history: ParsedHistoryItem[];
  currentInputs: ParsedHistoryItem[];
  currentInput: ParsedHistoryItem | null;
  currentMsg: string;
  latestImageContext: ChatGptImageConversationContext | null;
  hadToolActivityAfterLastUser: boolean;
}

/**
 * Strip embedded `data:image/...` URIs out of message content so prior
 * generated images don't get fed back into chatgpt.com on the next turn.
 *
 * Why: when image generation succeeds we emit `![image](data:image/png;base64,...)`
 * — frequently 2–4 MB. Chat clients (Open WebUI, OpenAI-style apps) replay
 * the full conversation history on the next request, so without this strip
 * we'd send megabytes of base64 back upstream. chatgpt.com responds with an
 * empty body when that happens (verified: 502 "ChatGPT returned empty
 * response body" on the very next turn after an image gen succeeds), and
 * even if it didn't, a single inlined image is well past the model's context
 * limit. Replacing with a short placeholder keeps semantic continuity
 * without the bytes.
 */
const DATA_URI_IMAGE_RE = /!\[([^\]]*)\]\(data:image\/[^)]+\)/g;
const CACHED_IMAGE_URL_RE = /\/v1\/chatgpt-web\/image\/([a-f0-9]{16,64})(?=[)\s"'<>]|$)/gi;

function stripInlinedImages(content: string): string {
  return content.replace(DATA_URI_IMAGE_RE, (_, alt) =>
    alt ? `[${alt}: generated image]` : "[generated image]"
  );
}

function findCachedImageContext(content: string): ChatGptImageConversationContext | null {
  let latest: ChatGptImageConversationContext | null = null;
  // String.prototype.matchAll consumes a fresh iterator and ignores the
  // regex's lastIndex, so no manual reset is required.
  for (const match of content.matchAll(CACHED_IMAGE_URL_RE)) {
    const id = match[1];
    const context = getChatGptImageConversationContext(id);
    if (context) latest = context;
  }
  return latest;
}

function parseOpenAIMessages(messages: Array<Record<string, unknown>>): ParsedMessages {
  let systemMsg = "";
  const history: ParsedHistoryItem[] = [];
  let latestImageContext: ChatGptImageConversationContext | null = null;
  // Track tool call id→name for labelling folded tool results (mirrors deepseek-web pattern)
  const callNameById = new Map<string, string>();
  // Track last actual user message — used as currentMsg even when the turn ends with tool results
  let lastUserContent = "";

  for (const msg of messages) {
    let role = String(msg.role || "user");
    if (role === "developer") role = "system";

    let content = "";
    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = (msg.content as Array<Record<string, unknown>>)
        .filter((c) => c["text"] !== "")
        .map((c) => String(c["text"] || ""))
        .join(" ");
    }

    content = stripInlinedImages(content);
    const imageContext = findCachedImageContext(content);
    if (imageContext) {
      latestImageContext = imageContext;
      content = content.trim();
      continue;
    }

    if (role === "system") {
      systemMsg += systemMsg ? "\n" + content : content;
    } else if (role === "assistant") {
      // Track tool_calls id→name so tool result messages can be labelled
      const rawToolCalls = (msg as Record<string, unknown>)["tool_calls"];
      const toolCalls = Array.isArray(rawToolCalls)
        ? (rawToolCalls as Array<{
            id?: string;
            function?: { name?: string; arguments?: unknown };
          }>)
        : [];
      const parsedToolCalls: ParsedToolCall[] = toolCalls.flatMap((call) => {
        const id = typeof call.id === "string" ? call.id : "";
        const name = typeof call.function?.name === "string" ? call.function.name : "";
        if (!id || !name) return [];
        const args =
          typeof call.function?.arguments === "string"
            ? call.function.arguments
            : JSON.stringify(call.function?.arguments ?? {});
        return [{ id, type: "function" as const, function: { name, arguments: args } }];
      });
      for (const c of toolCalls) {
        if (c?.id && typeof c.function?.name === "string") {
          callNameById.set(c.id, c.function.name);
        }
      }

      if (content.trim() || parsedToolCalls.length > 0) {
        history.push({
          role: "assistant",
          content: content.trim(),
          toolCalls: parsedToolCalls,
        });
      }
    } else if (role === "tool" || role === "function") {
      const toolCallId = String((msg as Record<string, unknown>)["tool_call_id"] ?? "");
      const toolName = callNameById.get(toolCallId) ?? (toolCallId || "tool");
      history.push({
        role: "tool",
        content: content.trim(),
        toolCallId,
        toolName,
      });
    } else if (role === "user") {
      history.push({ role: "user", content });
      if (content.trim()) {
        lastUserContent = content;
      }
    }
  }

  const currentInputs: ParsedHistoryItem[] = [];
  if (history.at(-1)?.role === "tool") {
    while (history.at(-1)?.role === "tool") {
      currentInputs.unshift(history.pop() as ParsedHistoryItem);
    }
  } else {
    for (let index = history.length - 1; index >= 0; index -= 1) {
      if (history[index].role === "user") {
        currentInputs.push(history[index]);
        history.splice(index, 1);
        break;
      }
    }
  }
  const currentInput = currentInputs.at(-1) ?? null;

  return {
    systemMsg: compressChatGptWebSystemContext(stripCdxInjectedMemory(systemMsg)),
    history,
    currentInputs,
    currentInput,
    currentMsg: lastUserContent,
    latestImageContext,
    hadToolActivityAfterLastUser: currentInput?.role === "tool",
  };
}

interface ChatGptImageAssetPointer {
  content_type: "image_asset_pointer";
  asset_pointer: string;
  size_bytes: number;
  width: number;
  height: number;
}

interface ChatGptMessage {
  id: string;
  author: { role: string };
  content:
    | { content_type: "text"; parts: string[] }
    | { content_type: "multimodal_text"; parts: Array<string | ChatGptImageAssetPointer> };
  metadata?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Cheap heuristic: does the last user turn look like an image-generation
 * request? Used to decide whether to disable Temporary Chat mode.
 *
 * Why a heuristic instead of always disabling Temporary Chat: when
 * `history_and_training_disabled: false`, every conversation gets saved to
 * the user's chatgpt.com history. For text-only chats that's noise — a
 * dozen "OmniRoute" entries clutter the sidebar and can interact with
 * ChatGPT's memory. We pay that cost only when the user actually wants an
 * image, since Temporary Chat refuses image_gen with the message
 * "I cannot generate images in this chat".
 *
 * False positives (text chat misclassified as image) → unnecessary history
 * entry. False negatives (image request misclassified as text) → ChatGPT
 * refuses image_gen and the user retries. Tuning leans toward false
 * positives (we'd rather pollute history than refuse image generation).
 */
const IMAGE_GEN_REGEXES: RegExp[] = [
  // verb + (anything within 40 chars) + image-noun
  /\b(?:generate|create|make|draw|paint|render|produce|design|sketch|illustrate|show me)\b[\s\S]{0,40}\b(?:image|picture|photo|photograph|drawing|illustration|sketch|painting|portrait|logo|icon|art|artwork|wallpaper|render|graphic)\b/i,
  // image-noun + "of" — "image of a kitten", "picture of mountains"
  /\b(?:image|picture|photo|photograph|illustration|drawing|painting|render)\s+of\b/i,
  // direct verb + a/an article — "draw a kitten", "paint an apple"
  /\b(?:draw|paint|sketch|render|illustrate)\s+(?:me\s+)?(?:a|an|some|the)\s+\w+/i,
  // explicit slash command users sometimes type — "/imagine ..."
  /^\s*\/(?:image|imagine|img|draw|paint)\b/im,
];

/**
 * Markers Open WebUI uses for its background tool prompts (follow-up
 * suggestions, title generation, tag categorization). These prompts embed
 * the prior conversation in `<chat_history>` blocks and frequently quote
 * the user's earlier "generate an image of..." request — which would
 * trip the image-gen regex below. Skip them so we don't unnecessarily
 * disable Temporary Chat and trigger image_gen on background tasks.
 *
 * Catching just one of these markers is enough; tool prompts always
 * include several together.
 */
const OPENWEBUI_TOOL_PROMPT_MARKERS = [
  /<chat_history>/i,
  /^### Task:/im,
  /\bJSON format:\s*\{/i,
  /\bfollow_?ups\b.*\barray of strings\b/i,
];

const OPENWEBUI_IMAGE_CONTEXT_MARKERS = [
  /<context>\s*The requested image has been (?:created|edited and created) by the system successfully/i,
  /<context>\s*The requested image has been edited and created and is now being shown to the user/i,
  /<context>\s*Image generation was attempted but failed/i,
];

function hasOpenWebUIImageContext(parsed: ParsedMessages): boolean {
  return OPENWEBUI_IMAGE_CONTEXT_MARKERS.some((re) => re.test(parsed.systemMsg));
}

function looksLikeImageGenRequest(parsed: ParsedMessages): boolean {
  // Inspect only the latest user turn — historical turns are irrelevant
  // (and could trigger false positives if the user mentioned an image
  // generated previously).
  const text = parsed.currentMsg.trim();
  if (!text) return false;
  if (OPENWEBUI_TOOL_PROMPT_MARKERS.some((re) => re.test(text))) return false;
  if (hasOpenWebUIImageContext(parsed)) return false;
  return IMAGE_GEN_REGEXES.some((re) => re.test(text));
}

const IMAGE_EDIT_REGEXES: RegExp[] = [
  /\b(?:edit|adjust|modify|change|update|alter|revise|retouch|fix)\b[\s\S]{0,120}\b(?:it|image|picture|photo|lighting|background|style|color|colour|composition|scene|time of day)\b/i,
  /\b(?:make|turn|set|switch)\s+(?:it|the\s+(?:image|picture|photo|scene))\b[\s\S]{0,120}\b/i,
  /\b(?:add|remove|replace)\b[\s\S]{0,120}\b(?:it|image|picture|photo|background|sky|person|object|text|logo)\b/i,
  /\b(?:brighter|darker|night|daytime|time of day|sunset|sunrise|morning|evening|lighting|relight|background|style)\b/i,
  /^\s*(?:now|then|also)\b[\s\S]{0,120}\b(?:make|turn|change|adjust|add|remove|replace|edit)\b/i,
];

function looksLikeImageEditRequest(parsed: ParsedMessages): boolean {
  if (!parsed.latestImageContext) return false;
  const text = parsed.currentMsg.trim();
  if (!text) return false;
  if (OPENWEBUI_TOOL_PROMPT_MARKERS.some((re) => re.test(text))) return false;
  if (hasOpenWebUIImageContext(parsed)) return false;
  return IMAGE_EDIT_REGEXES.some((re) => re.test(text));
}

/**
 * Rebuild the exact fenced-JSON tool call the model emitted upstream. History
 * replay must use the SAME envelope the contract instructs (and the few-shot
 * example demonstrates) — replaying OpenAI function_call JSON (a syntax the
 * model never wrote and cannot use upstream) teaches it to answer in prose on
 * later turns.
 */
function serializeActionRecord(call: ParsedToolCall): string {
  let args: unknown;
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    // The harness sent non-JSON arguments — the replay must still use the
    // contract's object form, so fall back to an empty object rather than
    // emit a string the model would learn to copy (and the decoder reject).
    args = {};
  }
  return `\`\`\`json\n${JSON.stringify({ name: call.function.name, arguments: args })}\n\`\`\``;
}

/** Host-side result wrapper — same shape for current-turn and replayed results. */
function serializeActionResult(item: Extract<ParsedHistoryItem, { role: "tool" }>): string {
  return [
    `Tool result for \`${item.toolName}\`:`,
    "```json",
    JSON.stringify({ type: "tool_result", name: item.toolName, output: item.content }),
    "```",
  ].join("\n");
}

function serializeHistoryItems(item: ParsedHistoryItem): Record<string, unknown>[] {
  if (item.role === "assistant") {
    const items: Record<string, unknown>[] = [];
    if (item.content) {
      items.push({ type: "message", role: "assistant", content: item.content });
    }
    for (const call of item.toolCalls) {
      items.push({ type: "message", role: "assistant", content: serializeActionRecord(call) });
    }
    return items;
  }
  if (item.role === "tool") {
    return [{ type: "message", role: "user", content: serializeActionResult(item) }];
  }
  return [{ type: "message", role: "user", content: item.content }];
}

function serializeToolResults(items: Extract<ParsedHistoryItem, { role: "tool" }>[]): string {
  return [
    ...items.map(serializeActionResult),
    "Continue the existing task from these tool results. Answer if they resolve the task; otherwise emit the next tool call as a fenced json block.",
  ].join("\n");
}

const MAX_REPLAY_HISTORY_ITEMS = 24;
const MAX_REPLAY_HISTORY_CHARS = 64 * 1024;

function estimateSerializedHistoryItem(item: ParsedHistoryItem): { items: number; chars: number } {
  if (item.role === "assistant") {
    return {
      items: (item.content ? 1 : 0) + item.toolCalls.length,
      chars:
        item.content.length +
        item.toolCalls.reduce(
          (total, call) =>
            total + call.id.length + call.function.name.length + call.function.arguments.length,
          96
        ),
    };
  }
  if (item.role === "tool") {
    return {
      items: 1,
      chars: item.toolCallId.length + item.toolName.length + item.content.length + 96,
    };
  }
  return { items: 1, chars: item.content.length + 64 };
}

function serializeBoundedHistory(history: ParsedHistoryItem[]): string {
  const selected: ParsedHistoryItem[][] = [];
  let itemCount = 0;
  let chars = 0;
  let end = history.length;
  while (end > 0) {
    let start = end - 1;
    while (start > 0 && history[start].role !== "user") start -= 1;
    const groupItems = history.slice(start, end);
    const estimate = groupItems.reduce(
      (total, item) => {
        const current = estimateSerializedHistoryItem(item);
        return { items: total.items + current.items, chars: total.chars + current.chars };
      },
      { items: 0, chars: 2 }
    );
    if (
      itemCount + estimate.items > MAX_REPLAY_HISTORY_ITEMS ||
      chars + estimate.chars > MAX_REPLAY_HISTORY_CHARS
    ) {
      break;
    }
    itemCount += estimate.items;
    chars += estimate.chars;
    selected.unshift(groupItems);
    end = start;
  }
  return JSON.stringify(selected.flatMap((group) => group.flatMap(serializeHistoryItems)));
}

// Codex CLI injects cross-session memory blocks (session_summary, bugfix,
// discovery, architecture, etc.) into the system message. These bias fresh
// user turns toward previous tasks even when the user starts a new session.
// Strip each memory bullet individually (bullet + its indented continuation
// lines) — a single span-to-marker regex previously destroyed legitimate
// instructions that happened to follow a memory bullet.
const CDX_MEMORY_SECTION_RE =
  /(?:\n|^)\s*-\s*\[(?:session_summary|bugfix|discovery|architecture|note|goal|instructions|discoveries)\][^\n]*(?:\n[ \t]+[^\n]*)*/gi;
export function stripCdxInjectedMemory(systemMsg: string): string {
  return systemMsg.replace(CDX_MEMORY_SECTION_RE, "").trim();
}

/**
 * Appended to the live user message on the single corrective retry after the
 * model answered with an excuse/confabulation instead of a tool call. Replaces
 * the default recency anchor for that attempt.
 */
const EXCUSE_RETRY_NUDGE =
  "\n\n[Host correction: your previous reply did not include a tool call. If this task needs files, commands, or current data, reply with ONLY the tool call as a fenced json block. Never describe errors, connectors, or results you have not actually received from the host.]";

/**
 * Codex CLI prepends large instruction blocks (Skills, Plugins, Engram memory
 * protocol) that are irrelevant to ChatGPT Web and bloat the payload. ChatGPT
 * Web rejects oversized payloads with an empty body, so strip these sections
 * while preserving the tool protocol and project AGENTS.md instructions.
 */
const CHATGPT_WEB_NOISE_XML_SECTIONS_RE =
  /<(skills_instructions|plugins_instructions)>[\s\S]*?<\/\1>/gi;
const ESCAPED_PROTOCOL_MARKER = CHATGPT_WEB_PROTOCOL_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const CHATGPT_WEB_NOISE_MARKDOWN_SECTIONS_RE = new RegExp(
  `(?:^|\\n)## (?:Engram Persistent Memory|Skills|Plugins)[\\s\\S]*?(?=\\n## |\\n${ESCAPED_PROTOCOL_MARKER}|$)`,
  "g"
);
function compressChatGptWebSystemContext(systemMsg: string): string {
  return systemMsg
    .replace(CHATGPT_WEB_NOISE_XML_SECTIONS_RE, "")
    .replace(CHATGPT_WEB_NOISE_MARKDOWN_SECTIONS_RE, "")
    .trim();
}

function getClientSystemContext(systemMsg: string): string {
  if (systemMsg.startsWith(CHATGPT_WEB_PROTOCOL_MARKER)) return "";
  const protocolIndex = systemMsg.lastIndexOf(`\n${CHATGPT_WEB_PROTOCOL_MARKER}`);
  return (protocolIndex >= 0 ? systemMsg.slice(0, protocolIndex) : systemMsg).trim();
}

function buildConversationBody(
  parsed: ParsedMessages,
  modelSlug: string,
  parentMessageId: string,
  // When true, send as a regular (non-temporary) chat so the image_gen tool
  // is available. When false (default), use Temporary Chat to keep chats
  // out of the user's chatgpt.com history.
  forImageGen: boolean,
  options: {
    continuation?: ChatGptConversationContext | null;
    continuationSystemDelta?: string;
    // Inbound images the user sent, already uploaded to chatgpt.com. When
    // present, the current user turn becomes a multimodal_text message that
    // references each uploaded file so GPT actually sees the images.
    uploadedImages?: UploadedChatGptImage[];
    hasTools?: boolean;
    // Appended to the live user message (corrective retry nudge). Replaces the
    // default recency anchor when present.
    userContentSuffix?: string;
    // Upstream #10077: native thinking_effort + system hints (replaces the
    // removed user-config PATCH handshake).
    thinkingEffort?: ChatGptThinkingEffort | null;
    systemHints?: readonly string[];
  } = {}
): Record<string, unknown> {
  const {
    continuation = null,
    continuationSystemDelta = "",
    uploadedImages = [],
    hasTools = false,
    userContentSuffix = "",
  } = options;
  // Temporary Chat conversations are stateless on the server side, so every
  // request must carry the full system context and prior history. Non-temporary
  // (image-gen) chats rely on upstream memory and only need the delta.
  const isTemporaryChat = !forImageGen;
  const systemParts: string[] = [];
  let historyReplay = "";
  // parseOpenAIMessages already ran the memory/noise strippers — use its output
  // verbatim instead of stripping the same large context twice per request.
  const sanitizedSystemMsg = parsed.systemMsg;
  // The curated Codex persona is always-on so the upstream model adopts Codex's
  // work style and persistence even when the harness instructions are thin; it
  // leads the system block, with the harness context + tool protocol following
  // so the protocol remains the closest instruction to the user turn.
  // Persona rides only on tool-harness turns (the Patty/Codex traffic it was
  // built for); plain single-shot messages keep the exact browser payload shape.
  if (hasTools && CODEX_PERSONA.trim()) systemParts.unshift(CODEX_PERSONA.trim());
  if ((!continuation || isTemporaryChat) && sanitizedSystemMsg.trim()) {
    systemParts.push(sanitizedSystemMsg.trim());
  } else if (continuation && continuationSystemDelta.trim()) {
    systemParts.push(continuationSystemDelta.trim());
  }
  if ((!continuation || isTemporaryChat) && parsed.history.length > 0) {
    historyReplay = [
      `Prior conversation turns (structured JSON replay; tool calls and results are fenced JSON blocks per the ${CHATGPT_WEB_PROTOCOL_MARKER}):`,
      serializeBoundedHistory(parsed.history),
    ].join("\n");
  }

  // Upstream #7357 lesson: never send prior turns as separate messages — the
  // web API treats them as in-progress turns and the model CONTINUES a prior
  // response. Fold the history replay into the system message instead.
  if (historyReplay) systemParts.push(historyReplay);
  const messages: ChatGptMessage[] = [];
  if (systemParts.length > 0) {
    messages.push({
      id: randomUUID(),
      author: { role: "system" },
      content: { content_type: "text", parts: [systemParts.join("\n\n")] },
    });
  }

  const currentToolResults = parsed.currentInputs.filter(
    (item): item is Extract<ParsedHistoryItem, { role: "tool" }> => item.role === "tool"
  );
  const isImageAck = hasOpenWebUIImageContext(parsed);
  let currentUserContent = isImageAck
    ? "Briefly acknowledge the image result described in the system context. Do not generate, edit, or request another image."
    : currentToolResults.length > 0
      ? serializeToolResults(currentToolResults)
      : parsed.currentInput?.role === "user"
        ? parsed.currentInput.content
        : parsed.currentMsg || "";

  const systemHints = options.systemHints ?? [];

  if (userContentSuffix.trim()) {
    currentUserContent = `${currentUserContent}${userContentSuffix}`;
  } else if (hasTools && currentToolResults.length === 0 && !isImageAck) {
    // Recency anchor: the tool contract sits at the very top of a large
    // replayed payload. Restate the one rule that matters right next to the
    // live user turn so it is the closest instruction the model sees.
    currentUserContent = `${currentUserContent}\n\n[Host: if this request needs files, commands, or current data, reply with ONLY the tool call as a fenced json block. Never describe results you have not received.]`;
  }

  if (uploadedImages.length > 0) {
    // Multimodal turn: text first, then one image_asset_pointer per uploaded
    // file, plus a metadata.attachments entry — exactly what chatgpt.com's
    // browser client sends when a user attaches images. Image-only turns have
    // empty text; give the model a minimal instruction so it responds to the
    // image instead of an empty prompt.
    const multimodalText = currentUserContent.trim()
      ? currentUserContent
      : "What is in this image?";
    const parts: Array<string | ChatGptImageAssetPointer> = [multimodalText];
    for (const img of uploadedImages) {
      parts.push({
        content_type: "image_asset_pointer",
        asset_pointer: `file-service://${img.fileId}`,
        size_bytes: img.sizeBytes,
        width: img.width,
        height: img.height,
      });
    }
    messages.push({
      id: randomUUID(),
      author: { role: "user" },
      content: { content_type: "multimodal_text", parts },
      metadata: {
        attachments: uploadedImages.map((img) => ({
          id: img.fileId,
          size: img.sizeBytes,
          name: img.name,
          mime_type: img.mimeType,
          width: img.width,
          height: img.height,
        })),
      },
    });
  } else {
    messages.push({
      id: randomUUID(),
      author: { role: "user" },
      content: { content_type: "text", parts: [currentUserContent] },
      ...(systemHints.length > 0 ? { metadata: { system_hints: [...systemHints] } } : {}),
    });
  }

  const body: Record<string, unknown> = {
    action: "next",
    messages,
    model: modelSlug,
    // Text-only API-style requests start fresh because clients replay full
    // history. Generated-image edits are the exception: ChatGPT needs the
    // original conversation node to adjust the actual image, not just a
    // markdown URL echoed back in a synthetic history block.
    conversation_id: continuation?.conversationId ?? null,
    parent_message_id: continuation?.parentMessageId ?? parentMessageId,
    timezone_offset_min: -new Date().getTimezoneOffset(),
    // Temporary Chat is the default. Disable it ONLY when the user is asking
    // for an image — that lets ChatGPT use its image_gen tool, at the cost of
    // saving the chat to the user's history. For text-only requests we keep
    // Temporary Chat on so the user's history stays clean, even for continuity-
    // keyed clients. The cached upstream conversation_id is enough to continue
    // a temporary chat across turns.
    history_and_training_disabled: !forImageGen,
    suggestions: [],
    websocket_request_id: randomUUID(),
    // Match the real chatgpt.com f/conversation payload shape. The
    // conversation_mode must be "primary_assistant"; the system_hints array is
    // the slot where the client can "interject" behavior hints to the backend.
    conversation_mode: { kind: "primary_assistant" },
    enable_message_followups: true,
    // The regular conversation endpoint accepts this coding-workflow hint while
    // retaining the normal ChatGPT Web usage path and payload shape.
    // Model-resolved hints ride along only when non-empty (upstream GPT-5.6
    // Sol/Luna lanes); absent otherwise to match captured browser payloads.
    supports_buffering: true,
    // supported_encodings: ["v1"],
    client_prepare_state: "none",
    paragen_cot_summary_display_override: "allow",
    force_parallel_switch: "auto",
    ...(systemHints.length > 0 ? { system_hints: [...systemHints] } : {}),
    ...(options.thinkingEffort ? { thinking_effort: options.thinkingEffort } : {}),
  };

  return body;
}

// ─── ChatGPT SSE parsing ────────────────────────────────────────────────────

interface ChatGptStreamEvent {
  message?: {
    id?: string;
    author?: { role?: string };
    content?: { content_type?: string; parts?: unknown[] };
    status?: string;
    metadata?: Record<string, unknown>;
  };
  conversation_id?: string;
  error?: string | { message?: string; code?: string };
  type?: string;
  v?: unknown;
}

/**
 * A part inside `content.parts` for a `multimodal_text` content_type.
 * ChatGPT puts image references in a part with content_type "image_asset_pointer"
 * and an asset_pointer like "file-service://file-XXXX" (final) or
 * "sediment://..." (in-progress preview).
 */
interface ImageAssetPart {
  content_type?: string;
  asset_pointer?: string;
  width?: number;
  height?: number;
  metadata?: Record<string, unknown>;
}

async function* readChatGptSseEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal | null
): AsyncGenerator<ChatGptStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let eventName: string | null = null;
  const cancelReader = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", cancelReader, { once: true });

  function flush(): ChatGptStreamEvent | null | "done" {
    if (dataLines.length === 0) return null;
    const payload = dataLines.join("\n");
    dataLines = [];
    const sseEventName = eventName;
    eventName = null;
    const trimmed = payload.trim();
    if (!trimmed || trimmed === "[DONE]") return "done";
    try {
      const parsed = JSON.parse(trimmed) as ChatGptStreamEvent;
      // Upstream #7578: typed frames (e.g. `event: stream_handoff`) carry their
      // kind on the SSE event line, not in the JSON body — surface it as .type.
      if (sseEventName && !parsed.type) parsed.type = sseEventName;
      return parsed;
    } catch {
      console.warn("[chatgpt-web] stream event JSON parse failed");
      return null;
    }
  }

  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) break;
        const rawLine = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

        if (line === "") {
          const parsed = flush();
          if (parsed === "done") return;
          if (parsed) yield parsed;
          continue;
        }
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
    }

    buffer += decoder.decode();
    if (buffer.trim().startsWith("data:")) {
      dataLines.push(buffer.trim().slice(5).trimStart());
    }
    const tail = flush();
    if (tail && tail !== "done") yield tail;
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
}

// ─── Content extraction ─────────────────────────────────────────────────────
// ChatGPT SSE chunks contain CUMULATIVE content (full text so far in `parts[0]`),
// not deltas. Diff against the emitted length to produce incremental tokens —
// same pattern perplexity-web.ts uses for markdown blocks (lines 386-397).

interface ContentChunk {
  delta?: string;
  answer?: string;
  conversationId?: string;
  messageId?: string;
  error?: string;
  done?: boolean;
  /** Image asset pointers seen on the current message (e.g. file-service://file-abc). */
  imagePointers?: ImagePointerRef[];
  /**
   * True if the assistant invoked the async image_gen tool (we saw a task id
   * in metadata or `turn_use_case: "image gen"` in server_ste_metadata).
   * Set on the final `done: true` chunk so the caller can decide to poll the
   * conversation endpoint for the actual image.
   */
  imageGenAsync?: boolean;
  /** True when ChatGPT handed the turn off to a long-running worker. */
  handoff?: boolean;
  /** Short-lived conduit token used to resume a Temporary Chat handoff. */
  resumeToken?: string;
}

interface ImagePointerRef {
  pointer: string;
  messageId?: string;
}

/**
 * Pull image asset pointers out of a multimodal_text parts array.
 *
 * For text-only messages parts is `["text..."]` and this returns `[]`. For
 * `image_gen` tool output, parts looks like:
 *   [
 *     { content_type: "image_asset_pointer",
 *       asset_pointer: "file-service://file-abc..." or "sediment://..." }
 *   ]
 * We collect every asset_pointer seen so the caller can resolve them once
 * the stream terminates.
 */
function extractImagePointers(parts: unknown[]): string[] {
  const out: string[] = [];
  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    const obj = p as ImageAssetPart;
    if (obj.content_type === "image_asset_pointer" && typeof obj.asset_pointer === "string") {
      out.push(obj.asset_pointer);
    }
  }
  return out;
}

async function* extractContent(
  eventStream: ReadableStream<Uint8Array>,
  signal?: AbortSignal | null
): AsyncGenerator<ContentChunk> {
  // ChatGPT may echo prior assistant turns at the start of the stream with
  // status: "finished_successfully" and full content, before sending the new
  // generation. If we emit those bytes downstream, streaming consumers see
  // the previous answer prepended to the new one (visible in Open WebUI as
  // run-on output across turns). Strategy: only emit deltas after we've seen
  // status === "in_progress" for the current message id (i.e., it's being
  // generated live in this stream). Echoes always arrive already finished
  // and never transition through in_progress, so they get suppressed. An
  // end-of-stream fallback handles the rare case where a real turn arrives
  // as a single already-finished event (instant/cached responses).
  let conversationId: string | null = null;
  let currentId: string | null = null;
  let currentParts = "";
  let currentMetadata: Record<string, unknown> | undefined;
  let emittedLen = 0;
  let isLive = false;
  // Dedupe pointers across echoes / repeated events. Order-preserving Set.
  const imagePointers = new Map<string, ImagePointerRef>();
  // True if we observed signals the assistant kicked off the async image_gen
  // tool (see ContentChunk.imageGenAsync). The actual image arrives later via
  // WebSocket / polling — caller handles that.
  let imageGenAsync = false;
  let handoff = false;
  let resumeToken: string | null = null;

  for await (const event of readChatGptSseEvents(eventStream, signal)) {
    if (event.error) {
      const msg =
        typeof event.error === "string"
          ? event.error
          : event.error.message || "ChatGPT stream error";
      yield { error: msg, done: true };
      return;
    }

    if (event.conversation_id) conversationId = event.conversation_id;

    if (event.type === "resume_conversation_token") {
      if (typeof event.token === "string" && event.token) resumeToken = event.token;
      continue;
    }

    if (event.type === "stream_handoff") {
      handoff = true;
      yield {
        conversationId: conversationId ?? undefined,
        handoff: true,
        resumeToken: resumeToken ?? undefined,
      };
      continue;
    }

    // Detect image_gen on top-level "server_ste_metadata" events. These don't
    // have a `message` field so the post-message guard would skip them, but
    // they're the most reliable signal — `turn_use_case: "image gen"`.
    //
    // Originally we also accepted `meta.tool_invoked === true`, but ChatGPT
    // sets that flag for ANY internal tool the assistant uses (reasoning
    // chains, web search, calc, file_search, etc.). That made plain text
    // turns spuriously emit the "Generating image…" placeholder + 30s
    // WebSocket wait. Image gen has a more specific signal we can rely on:
    // either `turn_use_case === "image gen"` here, or an `image_gen_task_id`
    // on a tool-role message (handled below).
    if (event.type === "server_ste_metadata") {
      const meta = (event as Record<string, unknown>).metadata as
        Record<string, unknown> | undefined;
      if (meta && meta.turn_use_case === "image gen") {
        imageGenAsync = true;
      }
    }

    const m = event.message;
    if (!m) continue;

    // Tool messages with `image_gen_task_id` in metadata (the "Processing
    // image..." card) confirm the async image_gen flow. We don't surface the
    // tool message itself as text — it's just a placeholder — but we mark
    // imageGenAsync so the executor knows to poll for the final image.
    if (m.metadata && typeof m.metadata.image_gen_task_id === "string") {
      imageGenAsync = true;
    }

    if (m.author?.role !== "assistant") continue;

    const id = m.id ?? null;
    const status = m.status ?? "";

    if (id && id !== currentId) {
      currentId = id;
      currentParts = "";
      currentMetadata = undefined;
      emittedLen = 0;
      isLive = false;
    }

    if (m.metadata && typeof m.metadata === "object") {
      currentMetadata = m.metadata;
    }

    if (status === "in_progress") {
      isLive = true;
    }

    const parts = m.content?.parts ?? [];
    if (parts.length === 0) continue;

    // Image asset pointers: only collect once the message is finalized
    // (status === "finished_successfully"). The same pointer may also appear
    // on echoed prior turns at the head of the stream; that's fine — the Set
    // dedupes, and the resolver in the executor produces the same URL either
    // way. We could restrict to isLive-only to avoid resolving echoes, but
    // that makes single-event instant responses (no in_progress phase) lose
    // their image. Letting echoes through is harmless for correctness; the
    // executor resolves each unique pointer at most once.
    if (status === "finished_successfully" || status === "" || isLive) {
      for (const ptr of extractImagePointers(parts)) {
        const existing = imagePointers.get(ptr);
        imagePointers.set(
          ptr,
          existing?.messageId ? existing : { pointer: ptr, ...(id ? { messageId: id } : {}) }
        );
      }
    }

    const cumulative = parts.map((p) => (typeof p === "string" ? p : "")).join("");
    if (cumulative.length > currentParts.length) {
      currentParts = cumulative;
    }

    if (isLive && currentParts.length > emittedLen) {
      const delta = currentParts.slice(emittedLen);
      emittedLen = currentParts.length;
      yield {
        delta,
        answer: currentParts,
        conversationId: conversationId ?? undefined,
        messageId: currentId ?? undefined,
        metadata: currentMetadata,
      };
    }
  }

  // End-of-stream fallback: if we never observed status === "in_progress"
  // for the current id (single-event reply, cached/instant response), emit
  // the accumulated content now so the consumer doesn't get an empty stream.
  if (!isLive && currentParts.length > emittedLen) {
    yield {
      delta: currentParts.slice(emittedLen),
      answer: currentParts,
      conversationId: conversationId ?? undefined,
      messageId: currentId ?? undefined,
      metadata: currentMetadata,
    };
  }

  yield {
    delta: "",
    answer: currentParts,
    conversationId: conversationId ?? undefined,
    messageId: currentId ?? undefined,
    metadata: currentMetadata,
    imagePointers: imagePointers.size > 0 ? Array.from(imagePointers.values()) : undefined,
    imageGenAsync,
    handoff,
    resumeToken: resumeToken ?? undefined,
    done: true,
  };
}

// ─── Long-running Pro handoff polling ──────────────────────────────────────

interface ChatGptDetailMessage {
  id?: string;
  author?: { role?: string };
  content?: {
    content_type?: string;
    parts?: unknown[];
    text?: string;
  };
  status?: string;
  end_turn?: boolean;
  create_time?: number;
  update_time?: number;
  metadata?: Record<string, unknown>;
}

function textFromContentPart(part: unknown): string {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  const obj = part as Record<string, unknown>;
  for (const key of ["text", "content", "summary"]) {
    const value = obj[key];
    if (typeof value === "string") return value;
  }
  return "";
}

function detailMessageText(message: ChatGptDetailMessage): string {
  const content = message.content;
  if (!content) return "";
  if (typeof content.text === "string") return content.text;
  const parts = content.parts ?? [];
  return parts.map(textFromContentPart).join("");
}

function extractFinalAssistantAnswer(
  detail: ChatGptConversationDetail
): FinalAssistantAnswer | null {
  const nodes = Object.values(detail.mapping ?? {});
  let best: (FinalAssistantAnswer & { sort: number }) | null = null;

  for (const node of nodes) {
    const message = node.message;
    if (!message || message.author?.role !== "assistant") continue;
    if (message.metadata?.is_visually_hidden === true) continue;
    const contentType = message.content?.content_type ?? "";
    if (contentType.includes("thought") || contentType.includes("reasoning")) continue;

    const text = detailMessageText(message).trim();
    if (!text) continue;
    const finished = message.status === "finished_successfully" && message.end_turn !== false;
    const sort = message.update_time ?? message.create_time ?? 0;
    if (
      !best ||
      (finished && (!best.finished || sort >= best.sort)) ||
      (!finished && !best.finished && sort >= best.sort)
    ) {
      best = { text, messageId: message.id, metadata: message.metadata, finished, sort };
    }
  }

  if (!best) return null;
  return {
    text: best.text,
    messageId: best.messageId,
    metadata: best.metadata,
    finished: best.finished,
  };
}

function delayWithAbort(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function decodeUtf8DataUrl(text: string): string {
  const marker = ";base64,";
  if (!text.startsWith("data:") || !text.includes(marker)) return text;
  const base64 = text.slice(text.indexOf(marker) + marker.length);
  return new TextDecoder().decode(Buffer.from(base64, "base64"));
}

interface ConversationDetailFetchResult {
  detail: ChatGptConversationDetail | null;
  terminal: boolean;
}

async function fetchConversationDetail(
  conversationId: string,
  ctx: ResolverContext
): Promise<ConversationDetailFetchResult> {
  const url = `${CHATGPT_BASE}/backend-api/conversation/${encodeURIComponent(conversationId)}`;
  const headers: Record<string, string> = {
    ...browserHeaders(),
    ...oaiHeaders(ctx.sessionId, ctx.deviceId),
    Accept: "application/json",
    Authorization: `Bearer ${ctx.accessToken}`,
    Cookie: buildSessionCookieHeader(ctx.cookie),
  };
  if (ctx.accountId) headers["chatgpt-account-id"] = ctx.accountId;

  try {
    const response = await tlsFetchChatGpt(url, {
      method: "GET",
      headers,
      timeoutMs: 30_000,
      signal: ctx.signal,
      // The native tls-client text path can surface UTF-8 JSON as mojibake
      // (e.g. 👉 becomes ðŸ‘‰). Ask for raw bytes and decode as UTF-8 here so
      // the final answer appended after Pro stream_handoff preserves Unicode.
      byteResponse: true,
    });
    if (response.status >= 400) {
      ctx.log?.warn?.(
        "CGPT-WEB",
        `conversation poll ${response.status}: ${(response.text || "").slice(0, 300)}`
      );
      return { detail: null, terminal: [401, 403, 404].includes(response.status) };
    }
    if (!response.text) return { detail: null, terminal: false };
    return {
      detail: JSON.parse(decodeUtf8DataUrl(response.text)) as ChatGptConversationDetail,
      terminal: false,
    };
  } catch (err) {
    ctx.log?.warn?.(
      "CGPT-WEB",
      `conversation poll failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return { detail: null, terminal: false };
  }
}

async function pollForFinalAssistantAnswer(
  conversationId: string,
  ctx: ResolverContext
): Promise<FinalAssistantAnswer | null> {
  const started = Date.now();
  const timeoutMs = configuredProPollTimeoutMs();
  const intervalMs = configuredProPollIntervalMs();
  let last: FinalAssistantAnswer | null = null;
  let terminalPollFailure = false;

  while (!ctx.signal?.aborted && Date.now() - started < timeoutMs) {
    const { detail, terminal } = await fetchConversationDetail(conversationId, ctx);
    if (detail) {
      const answer = extractFinalAssistantAnswer(detail);
      if (answer) {
        last = answer;
        if (answer.finished) return answer;
      }
    }
    if (terminal) {
      terminalPollFailure = true;
      break;
    }
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) break;
    await delayWithAbort(Math.min(intervalMs, remaining), ctx.signal);
  }

  if (last) {
    ctx.log?.warn?.(
      "CGPT-WEB",
      terminalPollFailure
        ? `conversation poll stopped before finished_successfully; returning latest assistant text for ${conversationId}`
        : `conversation poll timed out before finished_successfully; returning latest assistant text for ${conversationId}`
    );
  } else {
    ctx.log?.warn?.(
      "CGPT-WEB",
      terminalPollFailure
        ? `conversation poll stopped without assistant text for ${conversationId}`
        : `conversation poll timed out without assistant text for ${conversationId}`
    );
  }
  return last;
}

// ─── OpenAI SSE format ──────────────────────────────────────────────────────

interface ChatGptConversationDetail {
  mapping?: Record<string, { message?: ChatGptDetailMessage | null }>;
}

function sseChunk(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/**
 * Resolves a ChatGPT asset_pointer to a downloadable URL, given the live
 * conversation_id (needed for sediment:// pointers). Returns null on failure
 * so the caller can decide whether to surface a placeholder or skip silently.
 */
type ImageResolver = (
  assetPointer: string,
  conversationId: string | null,
  parentMessageId?: string | null
) => Promise<string | null>;

/** Build the final markdown block for a list of resolved image URLs. */
function imageMarkdown(urls: string[]): string {
  if (urls.length === 0) return "";
  // Two leading newlines → ensure separation from any prior text the model
  // produced ("Here is your kitten:\n\n![image](...)"). One image per line.
  return "\n\n" + urls.map((u) => `![image](${u})`).join("\n\n");
}

async function resolveImagePointers(
  pointers: ImagePointerRef[] | undefined,
  conversationId: string | null,
  resolver: ImageResolver | null,
  log?: { warn?: (tag: string, msg: string) => void } | null,
  fallbackParentMessageId?: string | null
): Promise<string[]> {
  if (!pointers || pointers.length === 0 || !resolver) return [];
  const urls: string[] = [];
  for (const ref of pointers) {
    try {
      const url = await resolver(
        ref.pointer,
        conversationId,
        ref.messageId ?? fallbackParentMessageId
      );
      if (url) urls.push(url);
    } catch (err) {
      log?.warn?.(
        "CGPT-WEB",
        `Image resolve failed (${ref.pointer}): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return urls;
}

function buildStreamingResponse(
  eventStream: ReadableStream<Uint8Array>,
  model: string,
  cid: string,
  created: number,
  resolver: ImageResolver | null,
  // Optional poller for async image_gen — when ChatGPT processes the request
  // out-of-band ("Lots of people are creating images right now"), the SSE
  // stream finishes without an image_asset_pointer. The executor passes a
  // closure here that knows how to poll the conversation endpoint.
  pollAsyncImage: ((conversationId: string) => Promise<ImagePointerRef[]>) | null,
  resumeFinalAnswer:
    ((conversationId: string, resumeToken: string) => Promise<FinalAssistantAnswer | null>) | null,
  pollFinalAnswer: ((conversationId: string) => Promise<FinalAssistantAnswer | null>) | null,
  log: { warn?: (tag: string, msg: string) => void } | null,
  signal?: AbortSignal | null,
  onConversationContext?: (context: ChatGptConversationContext) => void,
  onFinalize?: () => void
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const cancellation = new AbortController();
  const effectiveSignal = signal
    ? AbortSignal.any([signal, cancellation.signal])
    : cancellation.signal;
  let finalized = false;
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    onFinalize?.();
  };

  return new ReadableStream(
    {
      async start(controller) {
        try {
          controller.enqueue(
            encoder.encode(
              sseChunk({
                id: cid,
                object: "chat.completion.chunk",
                created,
                model,
                system_fingerprint: null,
                choices: [
                  { index: 0, delta: { role: "assistant" }, finish_reason: null, logprobs: null },
                ],
              })
            )
          );

          let conversationId: string | null = null;
          let imagePointers: ImagePointerRef[] | undefined;
          let imageGenAsync = false;
          let parentCandidateMessageId: string | null = null;
          let streamFailed = false;
          let handoff = false;
          let resumeToken: string | null = null;

          for await (const chunk of extractContent(eventStream, effectiveSignal)) {
            if (chunk.conversationId) conversationId = chunk.conversationId;
            if (chunk.messageId) parentCandidateMessageId = chunk.messageId;
            if (chunk.error) {
              streamFailed = true;
              controller.enqueue(
                encoder.encode(
                  sseChunk({
                    id: cid,
                    object: "chat.completion.chunk",
                    created,
                    model,
                    system_fingerprint: null,
                    choices: [
                      {
                        index: 0,
                        delta: { content: `[Error: ${chunk.error}]` },
                        finish_reason: null,
                        logprobs: null,
                      },
                    ],
                  })
                )
              );
              break;
            }

            if (chunk.done) {
              imagePointers = chunk.imagePointers;
              imageGenAsync = chunk.imageGenAsync ?? false;
              handoff = chunk.handoff ?? false;
              resumeToken = chunk.resumeToken ?? null;
              if (chunk.messageId) parentCandidateMessageId = chunk.messageId;
              break;
            }

            if (chunk.delta) {
              const cleaned = cleanChatGptText(chunk.delta);
              if (cleaned) {
                controller.enqueue(
                  encoder.encode(
                    sseChunk({
                      id: cid,
                      object: "chat.completion.chunk",
                      created,
                      model,
                      system_fingerprint: null,
                      choices: [
                        {
                          index: 0,
                          delta: { content: cleaned },
                          finish_reason: null,
                          logprobs: null,
                        },
                      ],
                    })
                  )
                );
              }
            }
          }

          if (
            !streamFailed &&
            !effectiveSignal.aborted &&
            conversationId &&
            parentCandidateMessageId
          ) {
            onConversationContext?.({
              conversationId,
              parentMessageId: parentCandidateMessageId,
            });
          }

          // If the assistant kicked off the async image_gen tool, the SSE
          // stream ends with a "Processing image..." placeholder. Poll the
          // conversation endpoint in the background for the final pointer.
          // We only kick polling off if the in-stream pointers are empty —
          // sometimes the synchronous path also fires and we already have one.
          // Heartbeat helper: while we wait on long-running async work
          // (WebSocket for image-gen, /files/download → 2-3 MB image fetch),
          // the SSE stream goes quiet and Open WebUI's HTTP client times out
          // at ~30s. We saw this in production: `disconnect: ResponseAborted`
          // followed by "Controller is already closed".
          //
          // Layered traps to avoid:
          //   - SSE comments (`: ...`) are silently ignored by aiohttp's
          //     read-activity tracker.
          //   - Empty `delta:{}` chunks ARE emitted by us but get filtered
          //     out upstream by `hasValuableContent` in
          //     `open-sse/utils/streamHelpers.ts` (it requires content,
          //     role, or finish_reason on OpenAI chunks).
          //
          // So heartbeats are zero-width-space content deltas (`"​"`):
          // they pass the valuable-content filter (non-empty content), reach
          // the client as data events, and render as nothing visible.
          const startHeartbeat = (intervalMs = 5_000): (() => void) => {
            const heartbeatChunk = sseChunk({
              id: cid,
              object: "chat.completion.chunk",
              created,
              model,
              system_fingerprint: null,
              choices: [{ index: 0, delta: { content: "​" }, finish_reason: null, logprobs: null }],
            });
            const timer = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(heartbeatChunk));
              } catch {
                // Controller may already be closed if the client disconnected
                // — just stop firing.
                console.warn("[chatgpt-web] heartbeat enqueue failed - controller closed");
                clearInterval(timer);
              }
            }, intervalMs);
            return () => clearInterval(timer);
          };

          // Pro handoff (upstream #7357): stream ended with only interim
          // reasoning — resume via the conduit token (or poll the conversation)
          // and stream the final answer before closing.
          if (handoff && conversationId && !streamFailed) {
            const stopHb = startHeartbeat();
            try {
              let finalAnswer: {
                text: string;
                messageId?: string;
                metadata?: Record<string, unknown>;
              } | null = null;
              if (resumeFinalAnswer && resumeToken) {
                finalAnswer = await resumeFinalAnswer(conversationId, resumeToken);
              }
              if (!finalAnswer?.text && pollFinalAnswer) {
                finalAnswer = await pollFinalAnswer(conversationId);
              }
              if (finalAnswer?.text) {
                if (finalAnswer.messageId) parentCandidateMessageId = finalAnswer.messageId;
                const cleaned = cleanChatGptText(finalAnswer.text);
                if (cleaned) {
                  controller.enqueue(
                    encoder.encode(
                      sseChunk({
                        id: cid,
                        object: "chat.completion.chunk",
                        created,
                        model,
                        system_fingerprint: null,
                        choices: [
                          {
                            index: 0,
                            delta: { content: cleaned },
                            finish_reason: null,
                            logprobs: null,
                          },
                        ],
                      })
                    )
                  );
                }
              }
            } catch (err) {
              log?.warn?.(
                "CGPT-WEB",
                `Pro handoff resume failed: ${err instanceof Error ? err.message : String(err)}`
              );
            } finally {
              stopHb();
            }
          }

          if (
            imageGenAsync &&
            conversationId &&
            (!imagePointers || imagePointers.length === 0) &&
            pollAsyncImage
          ) {
            // Tell the user something is happening — long polls otherwise
            // look like a hang on the client side. The "..." plus a typing
            // cue renders nicely in Open WebUI.
            controller.enqueue(
              encoder.encode(
                sseChunk({
                  id: cid,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  system_fingerprint: null,
                  choices: [
                    {
                      index: 0,
                      delta: { content: "_Generating image…_\n\n" },
                      finish_reason: null,
                      logprobs: null,
                    },
                  ],
                })
              )
            );
            const stopHb = startHeartbeat();
            try {
              const polled = await pollAsyncImage(conversationId);
              if (polled.length > 0) imagePointers = polled;
            } catch (err) {
              log?.warn?.(
                "CGPT-WEB",
                `Async image poll failed: ${err instanceof Error ? err.message : String(err)}`
              );
            } finally {
              stopHb();
            }
          }

          // Resolve and append any image markdown after the text deltas finish
          // streaming. Downloading and caching the image bytes can take 1-3
          // seconds for big images, so keep the heartbeat running here too.
          const stopHb2 = startHeartbeat();
          let urls: string[] = [];
          try {
            urls = await resolveImagePointers(
              imagePointers,
              conversationId,
              resolver,
              log,
              parentCandidateMessageId
            );
          } finally {
            stopHb2();
          }
          // Bail out cleanly if the client disconnected during the wait —
          // any further enqueue throws "Invalid state: Controller is
          // already closed". Better to no-op than to surface that as a
          // server error.
          if (effectiveSignal.aborted) return;
          const mdBlock = imageMarkdown(urls);
          const safeEnqueue = (bytes: Uint8Array): boolean => {
            try {
              controller.enqueue(bytes);
              return true;
            } catch {
              console.warn("[chatgpt-web] controller enqueue failed");
              return false;
            }
          };
          // The image markdown is now a small URL (we cache the bytes in
          // memory and serve them at /v1/chatgpt-web/image/<id>), so a
          // single SSE chunk is fine — no aiohttp LineTooLong concerns
          // and the markdown renderer in Open WebUI sees the URL whole
          // and renders an `<img>` immediately.
          if (mdBlock) {
            if (
              !safeEnqueue(
                encoder.encode(
                  sseChunk({
                    id: cid,
                    object: "chat.completion.chunk",
                    created,
                    model,
                    system_fingerprint: null,
                    choices: [
                      {
                        index: 0,
                        delta: { content: mdBlock },
                        finish_reason: null,
                        logprobs: null,
                      },
                    ],
                  })
                )
              )
            )
              return;
          }

          if (
            !safeEnqueue(
              encoder.encode(
                sseChunk({
                  id: cid,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  system_fingerprint: null,
                  choices: [{ index: 0, delta: {}, finish_reason: "stop", logprobs: null }],
                })
              )
            )
          )
            return;
          safeEnqueue(encoder.encode("data: [DONE]\n\n"));
        } catch (err) {
          controller.enqueue(
            encoder.encode(
              sseChunk({
                id: cid,
                object: "chat.completion.chunk",
                created,
                model,
                system_fingerprint: null,
                choices: [
                  {
                    index: 0,
                    delta: {
                      content: `[Stream error: ${err instanceof Error ? err.message : String(err)}]`,
                    },
                    finish_reason: "stop",
                    logprobs: null,
                  },
                ],
              })
            )
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } finally {
          finalize();
          try {
            controller.close();
          } catch {}
        }
      },
      cancel(reason) {
        cancellation.abort(reason);
        finalize();
      },
    },
    { highWaterMark: 16384 }
  );
}

function emitToolAwareSseChunk(
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  cid: string,
  created: number,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null
): void {
  controller.enqueue(
    encoder.encode(
      `data: ${JSON.stringify({
        id: cid,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
      })}\n\n`
    )
  );
}

function buildToolAwareStreamingResponse(
  cid: string,
  created: number,
  model: string,
  content: string,
  toolCalls: OpenAIToolCall[] | null,
  finishReason: string
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      emitToolAwareSseChunk(controller, encoder, cid, created, model, { role: "assistant" }, null);
      if (content) {
        emitToolAwareSseChunk(controller, encoder, cid, created, model, { content }, null);
      }
      if (toolCalls?.length) {
        emitToolAwareSseChunk(
          controller,
          encoder,
          cid,
          created,
          model,
          {
            tool_calls: toolCalls.map((toolCall, index) => ({
              index,
              id: toolCall.id,
              type: "function",
              function: toolCall.function,
            })),
          },
          null
        );
      }
      emitToolAwareSseChunk(controller, encoder, cid, created, model, {}, finishReason);
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}

async function buildToolAwareChatGptResponse(
  eventStream: ReadableStream<Uint8Array>,
  model: string,
  cid: string,
  created: number,
  currentMsg: string,
  requestedTools: unknown,
  toolChoice: WebToolChoice,
  stream: boolean,
  signal?: AbortSignal | null,
  onConversationContext?: (context: ChatGptConversationContext) => void,
  // When not "off", an excuse/confabulation/plan-narration reply with zero
  // decoded tool calls throws ChatGptExcuseResponseError for a corrective retry.
  guardMode: WebToolGuardMode = "off"
): Promise<Response> {
  let fullAnswer = "";
  let conversationId: string | null = null;
  let parentMessageId: string | null = null;

  for await (const chunk of extractContent(eventStream, signal)) {
    if (chunk.conversationId) conversationId = chunk.conversationId;
    if (chunk.messageId) parentMessageId = chunk.messageId;
    if (chunk.error) {
      return new Response(
        JSON.stringify({
          error: { message: chunk.error, type: "upstream_error", code: "CHATGPT_ERROR" },
        }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }
    if (chunk.done) {
      fullAnswer = chunk.answer || fullAnswer;
      break;
    }
    if (chunk.answer) fullAnswer = chunk.answer;
  }

  const { content, toolCalls, finishReason, policyViolation } = decodeWebToolResponse(
    cleanChatGptText(fullAnswer),
    requestedTools,
    "cgpt",
    toolChoice,
    { fences: true }
  );
  if (!content.trim() && !toolCalls?.length) {
    throw new ChatGptEmptyResponseError();
  }
  if (
    !toolCalls?.length &&
    toolChoice !== "none" &&
    detectWebToolGuardViolation(content, guardMode)
  ) {
    throw new ChatGptExcuseResponseError();
  }
  if (policyViolation) {
    return errorResponse(
      502,
      "ChatGPT Web did not honor the requested tool policy.",
      "TOOL_POLICY"
    );
  }
  if (conversationId && parentMessageId) {
    onConversationContext?.({ conversationId, parentMessageId });
  }

  if (stream) {
    return buildToolAwareStreamingResponse(cid, created, model, content, toolCalls, finishReason);
  }

  const message: Record<string, unknown> = { role: "assistant", content };
  if (toolCalls?.length) {
    message.tool_calls = toolCalls;
    if (!content) message.content = null;
  }
  const promptTokens = Math.ceil(currentMsg.length / 4);
  const completionTokens = Math.ceil(content.length / 4);

  return new Response(
    JSON.stringify({
      id: cid,
      object: "chat.completion",
      created,
      model,
      system_fingerprint: null,
      choices: [
        {
          index: 0,
          message,
          finish_reason: finishReason,
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

class ChatGptEmptyResponseError extends Error {
  constructor() {
    super("ChatGPT returned an empty assistant turn");
    this.name = "ChatGptEmptyResponseError";
  }
}

class ChatGptExcuseResponseError extends Error {
  constructor() {
    super("ChatGPT answered with an excuse instead of a tool call");
    this.name = "ChatGptExcuseResponseError";
  }
}

async function buildNonStreamingResponse(
  eventStream: ReadableStream<Uint8Array>,
  model: string,
  cid: string,
  created: number,
  currentMsg: string,
  resolver: ImageResolver | null,
  pollAsyncImage: ((conversationId: string) => Promise<ImagePointerRef[]>) | null,
  resumeFinalAnswer:
    ((conversationId: string, resumeToken: string) => Promise<FinalAssistantAnswer | null>) | null,
  pollFinalAnswer: ((conversationId: string) => Promise<FinalAssistantAnswer | null>) | null,
  log: { warn?: (tag: string, msg: string) => void } | null,
  signal?: AbortSignal | null,
  onConversationContext?: (context: ChatGptConversationContext) => void
): Promise<Response> {
  let fullAnswer = "";
  let conversationId: string | null = null;
  let handoff = false;
  let resumeToken: string | null = null;
  let imagePointers: ImagePointerRef[] | undefined;
  let imageGenAsync = false;
  let parentCandidateMessageId: string | null = null;

  for await (const chunk of extractContent(eventStream, signal)) {
    if (chunk.conversationId) conversationId = chunk.conversationId;
    if (chunk.messageId) parentCandidateMessageId = chunk.messageId;
    if (chunk.error) {
      return new Response(
        JSON.stringify({
          error: { message: chunk.error, type: "upstream_error", code: "CHATGPT_ERROR" },
        }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }
    if (chunk.done) {
      fullAnswer = chunk.answer || fullAnswer;
      imagePointers = chunk.imagePointers;
      imageGenAsync = chunk.imageGenAsync ?? false;
      handoff = chunk.handoff ?? false;
      resumeToken = chunk.resumeToken ?? null;
      if (chunk.messageId) parentCandidateMessageId = chunk.messageId;
      break;
    }
    if (chunk.answer) fullAnswer = chunk.answer;
  }

  if (conversationId && parentCandidateMessageId) {
    onConversationContext?.({
      conversationId,
      parentMessageId: parentCandidateMessageId,
    });
  }

  // Pro handoff (upstream #7357): the SSE ended with only interim reasoning —
  // resume via the conduit token, else poll the conversation for the final answer.
  if (handoff && conversationId) {
    let finalAnswer: {
      text: string;
      messageId?: string;
      metadata?: Record<string, unknown>;
    } | null = null;
    try {
      if (resumeFinalAnswer && resumeToken) {
        finalAnswer = await resumeFinalAnswer(conversationId, resumeToken);
      }
      if (!finalAnswer?.text && pollFinalAnswer) {
        finalAnswer = await pollFinalAnswer(conversationId);
      }
    } catch (err) {
      log?.warn?.(
        "CGPT-WEB",
        `Pro handoff resume failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (finalAnswer?.text) {
      fullAnswer = finalAnswer.text;
      if (finalAnswer.messageId) parentCandidateMessageId = finalAnswer.messageId;
    }
  }

  fullAnswer = cleanChatGptText(fullAnswer);

  // Async image gen: SSE ended with "Processing image..." — poll for the
  // final pointer the same way the streaming path does.
  if (
    imageGenAsync &&
    conversationId &&
    (!imagePointers || imagePointers.length === 0) &&
    pollAsyncImage
  ) {
    try {
      const polled = await pollAsyncImage(conversationId);
      if (polled.length > 0) imagePointers = polled;
    } catch (err) {
      log?.warn?.(
        "CGPT-WEB",
        `Async image poll failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const urls = await resolveImagePointers(
    imagePointers,
    conversationId,
    resolver,
    log,
    parentCandidateMessageId
  );
  fullAnswer += imageMarkdown(urls);
  const promptTokens = Math.ceil(currentMsg.length / 4);
  const completionTokens = Math.ceil(fullAnswer.length / 4);

  return new Response(
    JSON.stringify({
      id: cid,
      object: "chat.completion",
      created,
      model,
      system_fingerprint: null,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: fullAnswer },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

// ─── Error response helpers ─────────────────────────────────────────────────

function errorResponse(status: number, message: string, code?: string): Response {
  return new Response(
    JSON.stringify({ error: { message, type: "upstream_error", ...(code ? { code } : {}) } }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

function normalizePublicBaseUrl(value?: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

function firstForwardedValue(value?: string | null): string | null {
  const first = value?.split(",")[0]?.trim();
  return first || null;
}

function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";
  } catch {
    console.warn("[chatgpt-web] URL parse failed, falling back to regex");
    return /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)\b/i.test(baseUrl);
  }
}

function deriveHeaderBaseUrl(clientHeaders?: Record<string, string> | null): string | null {
  const headers = clientHeaders ?? {};
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;

  const forwardedHost = firstForwardedValue(lower["x-forwarded-host"]);
  const forwardedProto = firstForwardedValue(lower["x-forwarded-proto"]);
  const host = forwardedHost || firstForwardedValue(lower["host"]);
  if (!host) return null;

  // Default to http for IPs, localhost, and explicit host:port values where
  // TLS is not a safe assumption. Reverse proxies can override via
  // x-forwarded-proto, and deployments can force the exact value with
  // OMNIROUTE_PUBLIC_BASE_URL.
  const isPlain =
    host.includes("localhost") ||
    /^\d+\.\d+\.\d+\.\d+(:\d+)?$/.test(host) ||
    host.endsWith(".local") ||
    host.includes(":");
  const proto = forwardedProto || (isPlain ? "http" : "https");
  return `${proto}://${host}`;
}

/**
 * Build the absolute base URL the client should use to fetch our cached
 * images at /v1/chatgpt-web/image/<id>. The most reliable value is an
 * explicit browser-facing origin because relay clients such as Open WebUI
 * often reach OmniRoute from a container while the user's browser needs a
 * LAN, tunnel, or reverse-proxy URL.
 */
function derivePublicBaseUrl(
  clientHeaders?: Record<string, string> | null,
  log?: { debug?: (tag: string, msg: string) => void }
): string {
  const explicitPublicBase = normalizePublicBaseUrl(process.env.OMNIROUTE_PUBLIC_BASE_URL);
  if (explicitPublicBase) {
    log?.debug?.("CGPT-WEB", `derivePublicBaseUrl: using OMNIROUTE_PUBLIC_BASE_URL`);
    return explicitPublicBase;
  }

  const headerBase = deriveHeaderBaseUrl(clientHeaders);
  const configuredBase =
    normalizePublicBaseUrl(process.env.OMNIROUTE_BASE_URL) ||
    normalizePublicBaseUrl(process.env.NEXT_PUBLIC_BASE_URL);

  log?.debug?.(
    "CGPT-WEB",
    `derivePublicBaseUrl: configured=${configuredBase ?? "-"} header=${headerBase ?? "-"}`
  );

  if (configuredBase && (!headerBase || !isLocalBaseUrl(configuredBase))) return configuredBase;
  if (headerBase) return headerBase;
  if (configuredBase) return configuredBase;

  return `http://localhost:${process.env.PORT || 20128}`;
}

// ─── Image asset resolution ────────────────────────────────────────────────
// ChatGPT's image_gen tool emits `image_asset_pointer` parts whose
// `asset_pointer` is one of:
//
//   file-service://file-XXXX        → resolved via /backend-api/files/{id}/download
//   sediment://file-XXXX            → resolved via /backend-api/conversation/{conv_id}/attachment/{id}/download
//
// Both endpoints return JSON `{ download_url: "<azure-blob-sas-url>", ... }`.
// The signed URL has a limited lifetime (typically a few hours), but that's
// usually sufficient for the user to view the image in their UI right after
// generation. Persistent storage can be layered on later if needed.

const FILE_SERVICE_PREFIX = "file-service://";
const SEDIMENT_PREFIX = "sediment://";

interface ResolverContext {
  accessToken: string;
  accountId: string | null;
  sessionId: string;
  deviceId: string;
  cookie: string;
  signal?: AbortSignal | null;
  log?: Partial<Record<"debug" | "info" | "warn", (tag: string, msg: string) => void>>;
  /**
   * Absolute base URL that downstream clients should use to fetch cached
   * images served by /v1/chatgpt-web/image/<id>. Derived from the inbound
   * request host so the URL is reachable from whatever network the client
   * came in on (localhost, Tailscale, cloudflared tunnel, etc.).
   */
  publicBaseUrl: string;
}

async function fetchDownloadUrl(endpoint: string, ctx: ResolverContext): Promise<string | null> {
  const headers: Record<string, string> = {
    ...browserHeaders(),
    ...oaiHeaders(ctx.sessionId, ctx.deviceId),
    Accept: "application/json",
    Authorization: `Bearer ${ctx.accessToken}`,
    Cookie: buildSessionCookieHeader(ctx.cookie),
  };
  if (ctx.accountId) headers["chatgpt-account-id"] = ctx.accountId;

  const response = await tlsFetchChatGpt(endpoint, {
    method: "GET",
    headers,
    timeoutMs: 30_000,
    signal: ctx.signal,
  });
  if (response.status !== 200) {
    ctx.log?.warn?.(
      "CGPT-WEB",
      `Image download URL fetch failed (${response.status}) for ${endpoint}`
    );
    return null;
  }
  let parsed: { download_url?: string } = {};
  try {
    parsed = JSON.parse(response.text || "{}");
  } catch {
    console.warn("[chatgpt-web] image download URL parse failed");
    return null;
  }
  return parsed.download_url ?? null;
}

/**
 * Download a chatgpt.com signed image URL and re-serve it from OmniRoute's
 * short-lived image cache. The URLs returned by /files/<id>/download and
 * /conversation/<cid>/attachment/<fid>/download point at chatgpt.com's
 * estuary endpoint, which 403s for any request without the user's session
 * cookie. Downstream clients (Open WebUI, OpenAI-compatible apps) won't
 * have those cookies, so we download once via the authenticated TLS client
 * and return a browser-fetchable OmniRoute URL.
 */
const IMAGE_DOWNLOAD_MAX_BYTES = 8 * 1024 * 1024;

async function imageUrlToCachedImageUrl(
  signedUrl: string,
  ctx: ResolverContext,
  imageContext?: ChatGptImageConversationContext
): Promise<string | null> {
  const headers: Record<string, string> = {
    ...browserHeaders(),
    Accept: "image/*,*/*;q=0.8",
    Authorization: `Bearer ${ctx.accessToken}`,
    Cookie: buildSessionCookieHeader(ctx.cookie),
  };
  if (ctx.accountId) headers["chatgpt-account-id"] = ctx.accountId;

  let response: TlsFetchResult;
  try {
    response = await tlsFetchChatGpt(signedUrl, {
      method: "GET",
      headers,
      timeoutMs: 60_000,
      signal: ctx.signal,
      // Required for binary payloads — the underlying tls-client returns
      // bytes as a `data:<mime>;base64,...` string when this is true.
      // Without it, raw image bytes get mangled by UTF-8 decoding.
      byteResponse: true,
    });
  } catch (err) {
    ctx.log?.warn?.(
      "CGPT-WEB",
      `Image fetch failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }

  if (response.status !== 200) {
    ctx.log?.warn?.(
      "CGPT-WEB",
      `Image fetch returned HTTP ${response.status} (${(response.text || "").slice(0, 120)})`
    );
    return null;
  }

  if (response.text == null || response.text.length === 0) return null;

  // tls-client-node already returns binary bodies as a "data:<mime>;base64,..."
  // string (see node_modules/tls-client-node/dist/response.js — its bytes()
  // method splits on the comma to extract base64). Decode back into bytes
  // so we can hand them to the cache.
  let bytes: Buffer;
  let mime: string;
  if (/^data:[^;]{1,256};base64,/.test(response.text)) {
    const commaIdx = response.text.indexOf(",");
    const header = response.text.slice(5, commaIdx); // strip "data:"
    mime = header.split(";")[0] || "image/png";
    bytes = Buffer.from(response.text.slice(commaIdx + 1), "base64");
  } else {
    // Plain-text body (shouldn't happen for binary downloads with
    // byteResponse:true, but handle defensively).
    bytes = Buffer.from(response.text, "binary");
    mime = response.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
  }
  if (bytes.length === 0 || bytes.length > IMAGE_DOWNLOAD_MAX_BYTES) {
    if (bytes.length > IMAGE_DOWNLOAD_MAX_BYTES) {
      ctx.log?.warn?.(
        "CGPT-WEB",
        `Image too large to cache (${bytes.length} bytes > ${IMAGE_DOWNLOAD_MAX_BYTES}); skipping`
      );
    }
    return null;
  }
  // Cache the image and return a stable HTTP URL pointing at our own
  // /v1/chatgpt-web/image/<id> route. Streaming the raw base64 back via
  // SSE deltas works but Open WebUI's progressive markdown renderer shows
  // each chunk as plain text mid-stream — the user sees megabytes of
  // base64 scroll past before the image renders. URL-based delivery
  // produces a small markdown delta and renders instantly when the
  // browser fetches the URL.
  const id = storeChatGptImage(bytes, mime, undefined, imageContext);
  return `${ctx.publicBaseUrl}/v1/chatgpt-web/image/${id}`;
}

/**
 * Resolve the async image_gen result by registering a WebSocket with
 * chatgpt.com and listening for the image_asset_pointer.
 *
 * Background: when chatgpt.com is busy ("Lots of people are creating images
 * right now") the image_gen tool defers — the initial SSE finishes with a
 * "Processing image..." placeholder and the real image arrives over a
 * WebSocket pubsub. (We checked: the conversation tree at
 * `/backend-api/conversation/{id}` is NOT updated when the image lands, so
 * polling that endpoint does nothing.)
 *
 * Flow:
 *   1. POST /backend-api/register-websocket → { wss_url, expires_at, ... }
 *   2. Open the wss_url with the standard WebSocket client.
 *      Auth lives in the URL (signed access token), so we don't need the
 *      TLS-impersonation transport here.
 *   3. Each WS message is JSON like { type: "wss-message", data: { ...
 *      conversation event ... } }. The conversation event has the same
 *      shape as the SSE events from /backend-api/f/conversation.
 *   4. Watch for assistant messages with multimodal_text + image_asset_pointer
 *      OR a `message_stream_complete` for the conversation. Resolve when
 *      either pointer arrives or the timeout fires.
 */
async function registerWebSocket(ctx: ResolverContext): Promise<string | null> {
  // chatgpt.com migrated from POST /backend-api/register-websocket to a
  // GET-only endpoint under /backend-api/celsius/ws/user. The response shape
  // also changed from `{ wss_url }` → `{ websocket_url }`. Newer codebases
  // (g4f, etc.) all hit the celsius path; the legacy path now 404s.
  // Keep the legacy path as a fallback for older deployments.
  const candidates = [
    { url: `${CHATGPT_BASE}/backend-api/celsius/ws/user`, method: "GET" as const },
    { url: `${CHATGPT_BASE}/backend-api/register-websocket`, method: "POST" as const },
  ];
  const headers: Record<string, string> = {
    ...browserHeaders(),
    ...oaiHeaders(ctx.sessionId, ctx.deviceId),
    Accept: "application/json",
    Authorization: `Bearer ${ctx.accessToken}`,
    Cookie: buildSessionCookieHeader(ctx.cookie),
  };
  if (ctx.accountId) headers["chatgpt-account-id"] = ctx.accountId;

  for (const { url, method } of candidates) {
    let r: TlsFetchResult;
    try {
      r = await tlsFetchChatGpt(url, {
        method,
        headers,
        body: method === "POST" ? "" : undefined,
        timeoutMs: 30_000,
        signal: ctx.signal,
      });
    } catch (err) {
      ctx.log?.warn?.(
        "CGPT-WEB",
        `register-websocket fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }
    if (r.status === 200) {
      try {
        const data = JSON.parse(r.text || "{}") as {
          websocket_url?: string;
          wss_url?: string;
        };
        const ws = data.websocket_url ?? data.wss_url;
        if (ws) {
          ctx.log?.debug?.("CGPT-WEB", `Got WebSocket URL via ${url}`);
          return ws;
        }
      } catch {
        console.warn("[chatgpt-web] WebSocket URL parse failed, falling through");
        /* fall through */
      }
    }
    ctx.log?.warn?.(
      "CGPT-WEB",
      `register-websocket via ${url} → ${r.status}: ${(r.text || "").slice(0, 200)}`
    );
  }
  return null;
}

interface WsWaitOutcome {
  pointers: ImagePointerRef[];
  /** True if the connection emitted an error event. Used by the retry layer
   *  to decide whether a transport blip is worth a second attempt. */
  errored: boolean;
  /** True if any frame (message or open) was actually received from the
   *  server. A retry is most valuable when the connection died before
   *  exchanging any data. */
  gotAnyMessage: boolean;
}

async function waitForImageViaWebSocket(
  wssUrl: string,
  conversationId: string,
  timeoutMs: number,
  ctx: ResolverContext
): Promise<WsWaitOutcome> {
  return new Promise((resolve) => {
    const found = new Map<string, ImagePointerRef>();
    let resolved = false;
    let errored = false;
    let gotAnyMessage = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      try {
        ws.close();
      } catch {
        console.warn("[chatgpt-web] ws.close failed");
        /* ignore */
      }
      resolve({
        pointers: Array.from(found.values()),
        errored,
        gotAnyMessage,
      });
    };
    const ws = new WebSocket(wssUrl);
    const timer = setTimeout(() => {
      ctx.log?.warn?.("CGPT-WEB", `WebSocket image wait timed out after ${timeoutMs}ms`);
      finish();
    }, timeoutMs);
    const onAbort = () => {
      ctx.log?.debug?.("CGPT-WEB", "WebSocket aborted by client");
      finish();
    };
    ctx.signal?.addEventListener?.("abort", onAbort);
    ws.onopen = () => {
      gotAnyMessage = true;
      ctx.log?.debug?.("CGPT-WEB", "WebSocket open — waiting for image events");
    };
    ws.onerror = (e) => {
      errored = true;
      ctx.log?.warn?.("CGPT-WEB", `WebSocket error: ${(e as ErrorEvent).message ?? "unknown"}`);
    };
    ws.onclose = () => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener?.("abort", onAbort);
      finish();
    };
    ws.onmessage = (event) => {
      gotAnyMessage = true;
      let payload: unknown;
      const raw = typeof event.data === "string" ? event.data : event.data.toString();
      try {
        payload = JSON.parse(raw);
      } catch {
        console.warn("[chatgpt-web] WebSocket event JSON parse failed");
        return;
      }
      // chatgpt.com's celsius WS frames look like:
      //   { type: "conversation-update",
      //     payload: { conversation_id: "...",
      //                update_content: { message: { ... }, ... } } }
      // Older deployments wrapped the conversation event directly as { data }.
      const obj = payload as Record<string, unknown>;
      const candidates: ChatGptStreamEvent[] = [];
      const innerPayload = obj.payload as Record<string, unknown> | undefined;
      const updateContent = innerPayload?.update_content as Record<string, unknown> | undefined;
      if (updateContent?.message) {
        candidates.push({
          message: updateContent.message as ChatGptStreamEvent["message"],
          conversation_id: innerPayload?.conversation_id as string | undefined,
        });
      }
      if (innerPayload?.message) {
        candidates.push({
          message: innerPayload.message as ChatGptStreamEvent["message"],
          conversation_id: innerPayload.conversation_id as string | undefined,
        });
      }
      if ((obj.data as { message?: unknown } | undefined)?.message) {
        candidates.push(obj.data as ChatGptStreamEvent);
      }

      for (const data of candidates) {
        if (data?.conversation_id && data.conversation_id !== conversationId) continue;
        const m = data?.message;
        // The async image_gen result arrives as a TOOL-role message
        // ({"author":{"role":"tool","name":"t2uay3k.sj1i4kz"}}), so we
        // accept tool messages here too — extractImagePointers does the
        // actual content_type filtering.
        if (Array.isArray(m?.content?.parts)) {
          for (const ptr of extractImagePointers(m.content?.parts ?? [])) {
            const existing = found.get(ptr);
            found.set(
              ptr,
              existing?.messageId
                ? existing
                : { pointer: ptr, ...(m?.id ? { messageId: m.id } : {}) }
            );
          }
        }
        if (m?.metadata && typeof m.metadata === "object") {
          const md = m.metadata as Record<string, unknown>;
          const ptr = (md.asset_pointer ?? md.image_asset_pointer) as string | undefined;
          if (typeof ptr === "string") {
            const existing = found.get(ptr);
            found.set(
              ptr,
              existing?.messageId
                ? existing
                : { pointer: ptr, ...(m?.id ? { messageId: m.id } : {}) }
            );
          }
        }
      }
      if (found.size > 0) finish();
    };
  });
}

// Default 3-minute wait for the async image_gen tool to produce an image
// pointer over the celsius WebSocket. Tunable so deployments can stretch
// during chatgpt.com queue-deep windows ("Lots of people are creating
// images right now") without code changes.
const DEFAULT_ASYNC_IMAGE_TIMEOUT_MS = 180_000;

function configuredAsyncImageTimeoutMs(): number {
  const raw = Number(process.env.OMNIROUTE_CGPT_WEB_IMAGE_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_ASYNC_IMAGE_TIMEOUT_MS;
  return Math.floor(raw);
}

async function pollForAsyncImage(
  conversationId: string,
  ctx: ResolverContext,
  opts: { timeoutMs?: number } = {}
): Promise<ImagePointerRef[]> {
  const totalTimeoutMs = opts.timeoutMs ?? configuredAsyncImageTimeoutMs();
  const deadline = Date.now() + totalTimeoutMs;

  // One reconnect attempt on transport error: the WS endpoint is signed and
  // short-lived, and a network blip during the long wait would otherwise
  // lose the image entirely. The deadline is shared across attempts so we
  // never exceed the caller's budget.
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const wssUrl = await registerWebSocket(ctx);
    if (!wssUrl) {
      ctx.log?.warn?.(
        "CGPT-WEB",
        attempt === 0
          ? "Could not register WebSocket — async image gen not retrievable"
          : `WebSocket re-registration failed on retry attempt ${attempt + 1}`
      );
      if (attempt === 0) continue; // try again — registration can be flaky
      return [];
    }
    ctx.log?.debug?.(
      "CGPT-WEB",
      `Registered WebSocket for async image (attempt ${attempt + 1}, ${remaining}ms remaining)`
    );
    const outcome = await waitForImageViaWebSocket(wssUrl, conversationId, remaining, ctx);
    if (outcome.pointers.length > 0) return outcome.pointers;
    if (ctx.signal?.aborted) return [];
    // Only retry when the connection died before producing anything useful.
    // A clean close with no pointers (e.g., upstream cancellation) shouldn't
    // burn a second attempt — the result would be the same.
    if (!outcome.errored || outcome.gotAnyMessage) return [];
    ctx.log?.warn?.(
      "CGPT-WEB",
      `WebSocket attempt ${attempt + 1} ended in transport error before any frame; retrying`
    );
  }

  // Fallback: the async image websocket is unreliable in some environments —
  // register-websocket is Cloudflare-sensitive and the plain WebSocket lacks the
  // browser TLS fingerprint the HTTP client uses, so it can error or receive no
  // frames even though the image was generated. The image still lands in the
  // conversation, so poll it over the same authenticated HTTP path used
  // everywhere else and read the image_asset_pointer directly. This is the
  // durable fallback recommended in #7357.
  const pollDeadline = Math.max(deadline, Date.now() + 60_000);
  while (Date.now() < pollDeadline && !ctx.signal?.aborted) {
    const { detail } = await fetchConversationDetail(conversationId, ctx);
    const mapping = detail?.mapping;
    if (mapping) {
      // Prefer the newest message carrying image pointers, so a reused
      // conversation doesn't surface a stale image from an earlier turn.
      let newest: { pointers: ImagePointerRef[]; at: number } | null = null;
      for (const node of Object.values(mapping)) {
        const message = node?.message;
        const parts = message?.content?.parts;
        if (!Array.isArray(parts)) continue;
        const pointers = extractImagePointers(parts).map((pointer) => ({
          pointer,
          messageId: message?.id,
        }));
        if (pointers.length === 0) continue;
        const at = message?.create_time ?? 0;
        if (!newest || at >= newest.at) newest = { pointers, at };
      }
      if (newest) {
        ctx.log?.info?.(
          "CGPT-WEB",
          `Recovered ${newest.pointers.length} image pointer(s) via conversation poll (websocket yielded none)`
        );
        return newest.pointers;
      }
    }
    await delayWithAbort(3_000, ctx.signal);
  }
  return [];
}

function makeImageResolver(ctx: ResolverContext): ImageResolver {
  // Cache resolutions across the same request — the same pointer can show up
  // on multiple SSE events (in-progress + finished_successfully). One HTTP
  // round-trip per unique pointer is enough.
  const cache = new Map<string, string | null>();

  return async (assetPointer, conversationId, parentMessageId) => {
    if (cache.has(assetPointer)) return cache.get(assetPointer) ?? null;

    let fileId: string | null = null;
    if (assetPointer.startsWith(FILE_SERVICE_PREFIX)) {
      fileId = assetPointer.slice(FILE_SERVICE_PREFIX.length);
    } else if (assetPointer.startsWith(SEDIMENT_PREFIX)) {
      fileId = assetPointer.slice(SEDIMENT_PREFIX.length);
    } else {
      ctx.log?.warn?.("CGPT-WEB", `Unknown asset_pointer scheme: ${assetPointer}`);
    }

    let signedUrl: string | null = null;
    if (fileId) {
      // Both endpoints return a chatgpt.com estuary URL signed for the
      // user's current session — that URL 403s without the cookie, so
      // downstream clients can't fetch it directly. We download once via
      // the authenticated TLS client and expose the bytes through
      // OmniRoute's short-lived image cache.
      //
      // /files/{id}/download is the historical path. It works for
      // chat-uploaded files and the older image_gen output format
      // (`file-XXXX`). Newer image-edit results from continued
      // conversations land with a `file_00000000XXXX` shape that 422s on
      // /files/{id}/download — they're conversation-scoped attachments
      // and only resolve through /conversation/{cid}/attachment/{fid}/
      // download. We try /files first because it's cheaper and works for
      // the common case, then fall through.
      signedUrl = await fetchDownloadUrl(
        `${CHATGPT_BASE}/backend-api/files/${encodeURIComponent(fileId)}/download`,
        ctx
      );
      if (!signedUrl && conversationId) {
        signedUrl = await fetchDownloadUrl(
          `${CHATGPT_BASE}/backend-api/conversation/${encodeURIComponent(conversationId)}/attachment/${encodeURIComponent(fileId)}/download`,
          ctx
        );
      }
    }

    let finalUrl: string | null = null;
    if (signedUrl) {
      // chatgpt.com signed URLs require the user's session cookie to fetch,
      // so we materialize the bytes into our own cache and emit an OmniRoute
      // URL. If that fails (oversize, network error, etc.) we return null —
      // never the signed URL — because handing it back would emit broken
      // markdown that 403s for the client. Better to drop the image silently
      // than render a broken link.
      finalUrl = await imageUrlToCachedImageUrl(
        signedUrl,
        ctx,
        conversationId && parentMessageId ? { conversationId, parentMessageId } : undefined
      );
    }
    cache.set(assetPointer, finalUrl);
    if (finalUrl) {
      const preview = finalUrl.startsWith("data:")
        ? `data:... (${finalUrl.length} chars)`
        : finalUrl.slice(0, 80) + "...";
      ctx.log?.debug?.("CGPT-WEB", `Resolved ${assetPointer} → ${preview}`);
    }
    return finalUrl;
  };
}

// ─── Executor ───────────────────────────────────────────────────────────────

export class ChatGptWebExecutor extends BaseExecutor {
  constructor() {
    super("chatgpt-web", { id: "chatgpt-web", baseUrl: CONV_URL });
  }

  async execute({
    model,
    body,
    stream,
    credentials,
    signal,
    log,
    onCredentialsRefreshed,
    clientHeaders,
    callerIdentity,
  }: ExecuteInput) {
    const bodyObj = (body as Record<string, unknown> | null) ?? {};
    const messages = bodyObj.messages as Array<Record<string, unknown>> | undefined;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return {
        response: errorResponse(400, "Missing or empty messages array"),
        url: CONV_URL,
        headers: {},
        transformedBody: body,
      };
    }

    // Upstream #10077: resolve model/slug/effort up front — the slug feeds the
    // conversation body and native thinking_effort travels with it.
    const resolvedModel = resolveChatGptModel(model, body, credentials.providerSpecificData);
    const modelSlug = resolvedModel.slug;

    if (!credentials.apiKey) {
      return {
        response: errorResponse(
          401,
          "ChatGPT auth failed — paste your __Secure-next-auth.session-token cookie value."
        ),
        url: CONV_URL,
        headers: {},
        transformedBody: body,
      };
    }

    // Pass the user's pasted cookie blob through to exchangeSession; the helper
    // accepts bare values, unchunked cookies, chunked (.0/.1) cookies, and full
    // "Cookie: ..." DevTools lines.
    const cookie = credentials.apiKey;

    // 1. Token exchange
    let tokenEntry: TokenEntry;
    try {
      tokenEntry = await exchangeSession(cookie, signal);
    } catch (err) {
      if (err instanceof SessionAuthError) {
        log?.warn?.("CGPT-WEB", err.message);
        return {
          response: errorResponse(
            401,
            "ChatGPT auth failed — re-paste your __Secure-next-auth.session-token cookie from chatgpt.com.",
            "HTTP_401"
          ),
          url: SESSION_URL,
          headers: {},
          transformedBody: body,
        };
      }
      log?.error?.(
        "CGPT-WEB",
        `Session exchange failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return {
        response: errorResponse(
          502,
          `ChatGPT session exchange failed: ${err instanceof Error ? err.message : String(err)}`
        ),
        url: SESSION_URL,
        headers: {},
        transformedBody: body,
      };
    }

    // Surface any rotated cookie back to the caller so the DB credential is refreshed.
    if (tokenEntry.refreshedCookie && tokenEntry.refreshedCookie !== cookie) {
      const updated: ProviderCredentials = { ...credentials, apiKey: tokenEntry.refreshedCookie };
      try {
        await onCredentialsRefreshed?.(updated);
      } catch (err) {
        log?.warn?.(
          "CGPT-WEB",
          `Failed to persist refreshed cookie: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // 2a. Warmup — GET / to scrape DPL + script src so the prekey looks legit.
    let dplInfo: { dpl: string; scriptSrc: string };
    try {
      dplInfo = await fetchDpl(cookie, signal);
    } catch (err) {
      log?.warn?.(
        "CGPT-WEB",
        `DPL warmup failed (continuing with fallback): ${err instanceof Error ? err.message : String(err)}`
      );
      dplInfo = {
        dpl: `dpl=${OAI_CLIENT_VERSION.replace(/^prod-/, "")}`,
        scriptSrc: `${CHATGPT_BASE}/_next/static/chunks/webpack-${randomHex(16)}.js`,
      };
    }

    // 2a'. Browser-like session warmup. Sentinel scores the session by whether
    // the client recently hit /me, /conversations, /models — same as a real
    // browser does on page load. Failures here are non-fatal; the worst case
    // is Sentinel still escalates to Turnstile.
    const sessionId = randomUUID();
    const deviceId = deviceIdFor(cookie);
    await runSessionWarmup(
      tokenEntry.accessToken,
      tokenEntry.accountId,
      sessionId,
      deviceId,
      cookie,
      signal,
      log
    );

    // 2b. Build the ChatGPT message plan and upload inbound images BEFORE
    // Sentinel/PoW. Chat requirements/proof tokens are short-lived; doing
    // network image fetches + blob uploads after minting them increases stale
    // token / 403 risk before the actual conversation call.
    let toolPrep: ReturnType<typeof prepareWebToolRequest>;
    try {
      toolPrep = prepareWebToolRequest(
        bodyObj,
        messages as Array<{ role: string; content: unknown }>,
        { promptStyle: "chatgpt-web" }
      );
    } catch (err) {
      // Client-side tool_choice mistakes (undeclared forced tool, required
      // with zero functions) are 400s, not upstream failures.
      return {
        response: errorResponse(
          400,
          err instanceof Error ? err.message : String(err),
          "TOOL_POLICY"
        ),
        url: CONV_URL,
        headers: {},
        transformedBody: body,
      };
    }
    const { hasTools, requestedTools, toolChoice, effectiveMessages } = toolPrep;
    const parsed = parseOpenAIMessages(effectiveMessages as Array<Record<string, unknown>>);
    const clientSystemContext = getClientSystemContext(parsed.systemMsg);
    // Use stable account identity rather than the session-cookie value. ChatGPT
    // can rotate that cookie during session exchange; credential-value keys
    // would miss on the very next tool-result request and start a new chat.
    const accountIdentity = tokenEntry.accountId ?? cookieKey(cookie);
    let conversationCacheKey = buildConversationCacheKey(
      bodyObj,
      clientHeaders,
      accountIdentity,
      credentials.connectionId,
      model,
      callerIdentity
    );
    // Only consumed for continuity bookkeeping — skip the stringify+sha256 of
    // the full tools array for non-continuity clients.
    const toolFingerprint = conversationCacheKey
      ? buildWebToolContractFingerprint(requestedTools, toolChoice)
      : "";
    const releaseConversationLock = conversationCacheKey
      ? await acquireChatGptConversationLock(conversationCacheKey)
      : null;
    let releaseConversationLockFromStream = false;
    try {
      let cachedConversation = conversationCacheKey
        ? getChatGptConversationContext(conversationCacheKey)
        : null;
      let continuationSystemDelta = "";
      if (conversationCacheKey && cachedConversation) {
        const cachedSystemContext = cachedConversation.systemContext ?? "";
        const systemContextUnchanged = clientSystemContext === cachedSystemContext;
        const systemContextAppended =
          cachedSystemContext.length > 0 &&
          clientSystemContext.startsWith(`${cachedSystemContext}\n`);
        if (cachedConversation.toolFingerprint !== toolFingerprint) {
          deleteChatGptConversationContext(conversationCacheKey, cachedConversation);
          cachedConversation = null;
        } else if (systemContextAppended) {
          continuationSystemDelta = clientSystemContext.slice(cachedSystemContext.length + 1);
        } else if (!systemContextUnchanged) {
          deleteChatGptConversationContext(conversationCacheKey, cachedConversation);
          cachedConversation = null;
        }
      }
      let expectedConversationForWrite = cachedConversation;
      const rememberConversation = conversationCacheKey
        ? (context: ChatGptConversationContext) =>
            setChatGptConversationContext(
              conversationCacheKey,
              {
                ...context,
                toolFingerprint,
                systemContext: clientSystemContext,
              },
              expectedConversationForWrite
            )
        : undefined;
      const inboundImageUrls = extractCurrentTurnImageUrls(
        messages as Array<Record<string, unknown>>
      );
      if (
        !parsed.currentMsg.trim() &&
        parsed.history.length === 0 &&
        inboundImageUrls.length === 0
      ) {
        return {
          response: errorResponse(400, "Empty user message"),
          url: CONV_URL,
          headers: {},
          transformedBody: body,
        };
      }

      const imageEdit = looksLikeImageEditRequest(parsed);
      const continuation = imageEdit ? parsed.latestImageContext : cachedConversation;
      const forImageGen = looksLikeImageGenRequest(parsed) || imageEdit;
      if (forImageGen) {
        log?.debug?.(
          "CGPT-WEB",
          continuation
            ? "Image edit intent detected — continuing saved image conversation"
            : "Image-gen intent detected — disabling Temporary Chat for this turn"
        );
      }

      let uploadedImages: UploadedChatGptImage[] = [];
      if (inboundImageUrls.length > 0) {
        log?.info?.(
          "CGPT-WEB",
          `Detected ${inboundImageUrls.length} inbound image(s) — uploading to chatgpt.com`
        );
        const uploadCtx: ChatGptUploadAuthContext = {
          accessToken: tokenEntry.accessToken,
          accountId: tokenEntry.accountId ?? null,
          sessionId,
          deviceId,
          baseHeaders: {
            ...browserHeaders(),
            ...oaiHeaders(sessionId, deviceId),
            Cookie: buildSessionCookieHeader(cookie),
          },
          signal,
          log,
        };
        uploadedImages = await uploadCurrentTurnImages(inboundImageUrls, uploadCtx);
        if (uploadedImages.length !== inboundImageUrls.length) {
          log?.warn?.(
            "CGPT-WEB",
            `Inbound image upload failed (${uploadedImages.length}/${inboundImageUrls.length}); returning non-OK so combo fallback can try the next target`
          );
          return {
            response: errorResponse(
              502,
              "ChatGPT Web could not upload the attached image(s); falling back to the next combo target if available.",
              "CGPT_IMAGE_UPLOAD_FAILED"
            ),
            url: `${CHATGPT_BASE}/backend-api/files`,
            headers: {},
            transformedBody: body,
          };
        }
      }

      // 2c. Sentinel chat-requirements
      let reqs: ChatRequirements;
      try {
        reqs = await prepareChatRequirements(
          tokenEntry.accessToken,
          tokenEntry.accountId,
          sessionId,
          deviceId,
          cookie,
          dplInfo,
          signal,
          log
        );
      } catch (err) {
        if (err instanceof SentinelBlockedError) {
          log?.warn?.("CGPT-WEB", err.message);
          return {
            response: errorResponse(
              403,
              "ChatGPT blocked the request (Sentinel/Turnstile required). Try again later or open chatgpt.com in a browser to refresh state.",
              "SENTINEL_BLOCKED"
            ),
            url: SENTINEL_PREPARE_URL,
            headers: {},
            transformedBody: body,
          };
        }
        log?.error?.(
          "CGPT-WEB",
          `Sentinel failed: ${err instanceof Error ? err.message : String(err)}`
        );
        return {
          response: errorResponse(
            502,
            `ChatGPT sentinel failed: ${err instanceof Error ? err.message : String(err)}`
          ),
          url: SENTINEL_PREPARE_URL,
          headers: {},
          transformedBody: body,
        };
      }

      log?.debug?.(
        "CGPT-WEB",
        `sentinel: token=${reqs.token ? "y" : "n"} pow=${reqs.proofofwork?.required ? "y" : "n"} turnstile=${reqs.turnstile?.required ? "y" : "n"}`
      );

      // Optional: if a turnstile token was supplied via providerSpecificData,
      // pass it through. Otherwise, send the request anyway — sometimes Sentinel
      // reports turnstile.required even when the conversation endpoint accepts
      // requests without it.
      const turnstileToken =
        typeof credentials.providerSpecificData?.turnstileToken === "string"
          ? credentials.providerSpecificData.turnstileToken
          : null;

      // 3. Solve PoW (if required) — reuses the same browser-fingerprint config
      // shape as the prekey, just with the server-provided seed + difficulty.
      let proofToken: string | null = null;
      if (reqs.proofofwork?.required && reqs.proofofwork.seed && reqs.proofofwork.difficulty) {
        const powConfig = buildPrekeyConfig(CHATGPT_USER_AGENT, dplInfo.dpl, dplInfo.scriptSrc);
        proofToken = await solveProofOfWork(
          reqs.proofofwork.seed,
          reqs.proofofwork.difficulty,
          powConfig,
          log
        );
      }

      // 4. Build conversation request
      const parentMessageId = continuation?.parentMessageId ?? randomUUID();
      let cgptBody = buildConversationBody(parsed, modelSlug, parentMessageId, forImageGen, {
        thinkingEffort: resolvedModel.effort,
        systemHints: resolveChatGptSystemHints(model),
        continuation,
        // A delta computed against the conversation cache is only valid when
        // the continuation actually came from that cache (not an image edit).
        continuationSystemDelta: continuation === cachedConversation ? continuationSystemDelta : "",
        uploadedImages,
        hasTools,
      });

      const headers: Record<string, string> = {
        ...browserHeaders(),
        ...oaiHeaders(sessionId, deviceId),
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${tokenEntry.accessToken}`,
        Cookie: buildSessionCookieHeader(cookie),
      };
      if (tokenEntry.accountId) headers["chatgpt-account-id"] = tokenEntry.accountId;
      if (reqs.token) headers["openai-sentinel-chat-requirements-token"] = reqs.token;
      if (reqs.prepare_token)
        headers["openai-sentinel-chat-requirements-prepare-token"] = reqs.prepare_token;
      if (proofToken) headers["openai-sentinel-proof-token"] = proofToken;
      if (turnstileToken) headers["openai-sentinel-turnstile-token"] = turnstileToken;

      log?.info?.("CGPT-WEB", `Conversation request → ${modelSlug} (pow=${!!proofToken})`);

      const postConversation = (requestBody: Record<string, unknown>) =>
        tlsFetchChatGpt(CONV_URL, {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody),
          timeoutMs: 120_000, // generations can take a while
          signal,
          // For real-time streaming, ask the TLS client to write the body to
          // a temp file and surface it as a ReadableStream as it arrives —
          // otherwise long generations buffer entirely before the client sees
          // anything (and the downstream HTTP request can time out).
          stream,
        });
      const connectionFailure = (err: unknown) => {
        log?.error?.(
          "CGPT-WEB",
          `Fetch failed: ${err instanceof Error ? err.message : String(err)}`
        );
        const code = err instanceof TlsClientUnavailableError ? "TLS_UNAVAILABLE" : undefined;
        return {
          response: errorResponse(
            502,
            `ChatGPT connection failed: ${err instanceof Error ? err.message : String(err)}`,
            code
          ),
          url: CONV_URL,
          headers,
          transformedBody: cgptBody,
        };
      };

      let response: TlsFetchResult;
      try {
        response = await postConversation(cgptBody);
      } catch (err) {
        return connectionFailure(err);
      }

      const usedCachedContinuation =
        cachedConversation !== null &&
        continuation?.conversationId === cachedConversation.conversationId;
      const staleContinuationError =
        response.status === 404 ||
        (response.status === 400 &&
          /(?:conversation|parent).*(?:invalid|not found|stale)|(?:invalid|not found|stale).*(?:conversation|parent)/i.test(
            response.text || ""
          ));
      if (staleContinuationError && usedCachedContinuation) {
        if (conversationCacheKey && cachedConversation) {
          deleteChatGptConversationContext(conversationCacheKey, cachedConversation);
          expectedConversationForWrite = null;
        }
        log?.warn?.(
          "CGPT-WEB",
          `Cached conversation was rejected (${response.status}); retrying once with typed replay`
        );
        cgptBody = buildConversationBody(parsed, modelSlug, randomUUID(), forImageGen, {
          uploadedImages,
          hasTools,
        });
        try {
          response = await postConversation(cgptBody);
        } catch (err) {
          return connectionFailure(err);
        }
      }

      if (response.status >= 400) {
        const status = response.status;
        // Log the upstream body on 4xx/5xx — error responses are small and the
        // upstream message is much more useful than our wrapper. Goes through
        // the executor logger so it respects the application's log config.
        log?.warn?.("CGPT-WEB", `conv ${status}: ${(response.text || "").slice(0, 400)}`);
        const errMsg = describeChatGptWebHttpError(status);
        if (status === 401 || status === 403) {
          tokenCache.delete(cookieKey(cookie));
        }
        log?.warn?.("CGPT-WEB", errMsg);
        return {
          response: errorResponse(status, errMsg, `HTTP_${status}`),
          url: CONV_URL,
          headers,
          transformedBody: cgptBody,
        };
      }

      // For streaming requests the TLS client returns a ReadableStream that
      // tails the temp file as it's written. For non-streaming requests, it
      // returns the full body as text — wrap that in a one-shot stream so the
      // existing SSE parser can consume it uniformly.
      let bodyStream: ReadableStream<Uint8Array>;
      if (response.body) {
        bodyStream = response.body;
      } else if (response.text) {
        bodyStream = stringToStream(response.text);
      } else {
        return {
          response: errorResponse(502, "ChatGPT returned empty response body"),
          url: CONV_URL,
          headers,
          transformedBody: cgptBody,
        };
      }

      const cid = `chatcmpl-cgpt-${crypto.randomUUID().slice(0, 12)}`;
      const created = Math.floor(Date.now() / 1000);

      const resolverCtx: ResolverContext = {
        accessToken: tokenEntry.accessToken,
        accountId: tokenEntry.accountId,
        sessionId,
        deviceId,
        cookie,
        signal,
        log,
        publicBaseUrl: derivePublicBaseUrl(clientHeaders, log),
      };
      const imageResolver = makeImageResolver(resolverCtx);
      const pollAsyncImage = (conversationId: string) =>
        pollForAsyncImage(conversationId, resolverCtx);
      const resumeFinalAnswer = (conversationId: string, resumeToken: string) =>
        resumeChatGptHandoff({
          conversationId,
          resumeToken,
          headers,
          timeoutMs: configuredProPollTimeoutMs(),
          signal,
          log,
          readContent: extractContent,
        });
      const pollFinalAnswer = resolvedModel.isPro
        ? (conversationId: string) => pollForFinalAssistantAnswer(conversationId, resolverCtx)
        : null;

      // Shared stateless-retry path for the two tool-turn failure modes
      // (excuse answer / empty turn). Temporary Chat upstreams are stateless,
      // so a retry must rebuild the full-replay body — a delta continuation
      // would contradict the protocol's own statelessness.
      const runStatelessToolRetry = async (options: {
        logMessage: string;
        userContentSuffix?: string;
        invalidateCachedConversation?: boolean;
        emptyFailureMessage: string;
      }): Promise<{
        response: Response;
        url: string;
        headers: Record<string, string>;
        transformedBody: Record<string, unknown>;
      }> => {
        if (options.invalidateCachedConversation && conversationCacheKey && cachedConversation) {
          deleteChatGptConversationContext(conversationCacheKey, cachedConversation);
          expectedConversationForWrite = null;
        }
        log?.warn?.("CGPT-WEB", options.logMessage);
        cgptBody = buildConversationBody(parsed, modelSlug, randomUUID(), forImageGen, {
          uploadedImages,
          hasTools,
          thinkingEffort: resolvedModel.effort,
          systemHints: resolveChatGptSystemHints(model),
          userContentSuffix: options.userContentSuffix,
        });
        let retryResponse: TlsFetchResult;
        try {
          retryResponse = await postConversation(cgptBody);
        } catch (retryErr) {
          return connectionFailure(retryErr);
        }
        if (retryResponse.status >= 400) {
          const status = retryResponse.status;
          const errMsg = describeChatGptWebHttpError(status);
          if (status === 401 || status === 403) tokenCache.delete(cookieKey(cookie));
          log?.warn?.(
            "CGPT-WEB",
            `tool-turn retry ${status}: ${(retryResponse.text || "").slice(0, 400)}`
          );
          return {
            response: errorResponse(status, errMsg, `HTTP_${status}`),
            url: CONV_URL,
            headers,
            transformedBody: cgptBody,
          };
        }
        let retryStream: ReadableStream<Uint8Array>;
        if (retryResponse.body) {
          retryStream = retryResponse.body;
        } else if (retryResponse.text) {
          retryStream = stringToStream(retryResponse.text);
        } else {
          return {
            response: errorResponse(
              502,
              "ChatGPT returned an empty response after stateless retry.",
              "CHATGPT_EMPTY_RESPONSE"
            ),
            url: CONV_URL,
            headers,
            transformedBody: cgptBody,
          };
        }
        try {
          // The retry always decodes with the excuse guard disabled — a
          // second-strike excuse passes through instead of looping.
          const retried = await buildToolAwareChatGptResponse(
            retryStream,
            model,
            cid,
            created,
            parsed.currentMsg,
            requestedTools,
            toolChoice,
            stream !== false,
            signal,
            rememberConversation,
            "off"
          );
          return { response: retried, url: CONV_URL, headers, transformedBody: cgptBody };
        } catch (retryErr) {
          if (!(retryErr instanceof ChatGptEmptyResponseError)) throw retryErr;
          return {
            response: errorResponse(502, options.emptyFailureMessage, "CHATGPT_EMPTY_RESPONSE"),
            url: CONV_URL,
            headers,
            transformedBody: cgptBody,
          };
        }
      };

      let finalResponse: Response;
      if (hasTools) {
        // Full excuse detection on fresh user turns; the narrow plan-narration
        // set on tool-result continuations (grounded answers stay exempt).
        const guardMode: WebToolGuardMode = parsed.currentInput?.role === "tool" ? "plan" : "full";
        try {
          finalResponse = await buildToolAwareChatGptResponse(
            bodyStream,
            model,
            cid,
            created,
            parsed.currentMsg,
            requestedTools,
            toolChoice,
            stream !== false,
            signal,
            rememberConversation,
            guardMode
          );
        } catch (err) {
          if (err instanceof ChatGptExcuseResponseError) {
            // The model answered with an excuse/confabulation instead of a
            // tool call — retry once with a corrective nudge on the user turn.
            return runStatelessToolRetry({
              logMessage:
                "ChatGPT answered with an excuse instead of a tool call; retrying once with a corrective nudge",
              userContentSuffix: EXCUSE_RETRY_NUDGE,
              emptyFailureMessage:
                "ChatGPT returned an empty assistant turn after corrective retry.",
            });
          }
          if (!(err instanceof ChatGptEmptyResponseError)) throw err;
          return runStatelessToolRetry({
            logMessage:
              "ChatGPT returned an empty tool-aware turn; retrying once with typed stateless replay",
            invalidateCachedConversation: true,
            emptyFailureMessage: "ChatGPT returned an empty assistant turn after stateless replay.",
          });
        }
      } else if (stream) {
        const sseStream = buildStreamingResponse(
          bodyStream,
          model,
          cid,
          created,
          imageResolver,
          pollAsyncImage,
          resumeFinalAnswer,
          pollFinalAnswer,
          log,
          signal,
          rememberConversation,
          releaseConversationLock ?? undefined
        );
        releaseConversationLockFromStream = Boolean(releaseConversationLock);
        finalResponse = new Response(sseStream, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
          },
        });
      } else {
        finalResponse = await buildNonStreamingResponse(
          bodyStream,
          model,
          cid,
          created,
          parsed.currentMsg,
          imageResolver,
          pollAsyncImage,
          resumeFinalAnswer,
          pollFinalAnswer,
          log,
          signal,
          rememberConversation
        );
      }

      return { response: finalResponse, url: CONV_URL, headers, transformedBody: cgptBody };
    } finally {
      if (!releaseConversationLockFromStream) releaseConversationLock?.();
    }
  }
}

// Strip ChatGPT's internal entity markup. The browser renders these as proper
// inline citations / chips via JS; for a plain text completion we just want
// the human-readable form.
//   entity["city","Paris","capital of France"]  →  Paris
//   entity["…","value", …]                       →  value
const ENTITY_RE = /entity\["[^"]*","([^"]*)"[^\]]*\]/g;

function cleanChatGptText(text: string): string {
  return text.replace(ENTITY_RE, "$1");
}

function stringToStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

// Test-only: clear caches between tests
export function __resetChatGptWebCachesForTesting(): void {
  tokenCache.clear();
  warmupCache.clear();
  deviceIdCache.clear();
  __resetChatGptConversationCacheForTesting();
  __resetChatGptImageCacheForTesting();
  dplCache = null;
}

export const __derivePublicBaseUrlForTesting = derivePublicBaseUrl;
