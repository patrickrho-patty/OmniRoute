# chatgpt-web stabilization plan

Status: agreed 2026-08-13. The chatgpt-web connection is currently DISABLED on
the VPS (`is_active=0`) until the account flag expires. No live probing.

## Root cause (verified)

- chatgpt.com is browser impersonation, not API access: TLS impersonation +
  sentinel PoW + Cloudflare + "Unusual activity" abuse detector.
- One user request currently triggers up to 5 router retries x (1 session + 2
  sentinel + 1 conversation POST + up to 3 retry POSTs) = 15-21 upstream
  requests. `disableCooldownAwareRetry` at `src/sse/handlers/chat.ts:1353`
  excludes `claude-web` but NOT `chatgpt-web`.
- A flagged account returns 200 + EMPTY stream, which triggers the empty-turn
  retry (2 sentinel + 1 POST), which is also empty -> 502. This loop amplified
  the flag (55 chatgpt-web log lines in 5 min during the incident).
- The "Unusual activity" 403 is the detector punishing the retry patterns; the
  specific sub-trigger (token reuse vs rapid requests) is unverified. Direction
  of the fix is the same either way: FEWER requests.

## Plan items

1. **Router: exclude chatgpt-web from cooldown retries** — add
   `provider === "chatgpt-web"` to the disable list at
   `src/sse/handlers/chat.ts:1353` (same treatment as `claude-web`).
2. **Executor: remove the empty-turn retry entirely; gate the excuse retry
   OFF by default** (`CHATGPT_WEB_EXCUSE_RETRY=0`). One conversation POST per
   request. When the model answers without a tool call, pass the answer
   through to the client; the client agent has its own retry logic.
3. **Pacing: min-interval limiter per chatgpt-web connection** in
   `open-sse/services/rateLimitManager.ts` (~2-3s between conversation POSTs)
   so normal agent traffic cannot burst past the detector.
4. **Improve the tool contract** (`open-sse/services/webProvider/toolContract.ts`):
   shorter instruction block, tool list closer to the user message, better
   `tool_choice: "required"` handling instead of 502 "did not honor policy".
   Native tool calls are NOT a path — g4f (leading RE implementation) has zero
   tool_calls handling; nobody has cracked native function calling on
   chatgpt.com web.
5. **Make cloakbrowser actually usable**:
   - Dockerfile build step pre-downloads the patched Chromium into the image
     (with `CLOAKBROWSER_DOWNLOAD_URL` mirror option) so the binary is baked
     in instead of fetched at first request (GitHub rate-limit risk).
   - Fix `launchBrowser()` in `open-sse/services/browserPool.ts:225` to fall
     back to Playwright when cloakbrowser LAUNCH throws (currently only falls
     back when the import fails; `resolveCloakLaunch()` succeeds because the
     package is installed, so a missing binary kills the pool with no fallback).
   - Verify at runtime: `state.cloakLaunch !== null` + binary present.
6. **Restore the account**: after flag expiry (~20-60 min quiet), set
   `is_active=1` on the chatgpt-web connection, run exactly ONE test request,
   confirm normal behavior.

## Current cloakbrowser state (verified 2026-08-13)

- Package 0.5.7 installed and importable in the image
  (`/app/node_modules/cloakbrowser/dist/index.js`).
- NO Chromium binary in the container (no cache dir; lazy GitHub download on
  first launch).
- Browser pool has never launched (0 events in logs since 09:00) — the
  cf-mitigated condition never fires on a healthy session.
- Only actually-usable browser today: Playwright Chromium headless shell
  (`/home/node/.cache/ms-playwright/chromium_headless_shell-1234/...`, 197MB).
