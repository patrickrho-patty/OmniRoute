/**
 * Derive the live WebSocket path from `NEXT_PUBLIC_LIVE_WS_PUBLIC_URL`.
 *
 * Only `ws://` or `wss://` URLs are accepted (mirrors the scheme guard in
 * `getLivePublicUrl()`). The pathname is extracted and used as the WS upgrade
 * path; if the URL has no pathname (or is `/`), falls back to `/live-ws`.
 *
 * Used by:
 * - `src/app/api/v1/ws/route.ts` — handshake response `path` field
 * - `src/hooks/useLiveDashboard.ts` — build-time path constant + runtime discovery
 *
 * No env var is introduced — this reads the existing `NEXT_PUBLIC_LIVE_WS_PUBLIC_URL`.
 */
export function deriveLiveWsPath(publicUrl?: string): string {
  if (!publicUrl) return "/live-ws";
  if (!publicUrl.startsWith("ws://") && !publicUrl.startsWith("wss://")) return "/live-ws";
  try {
    const parsed = new URL(publicUrl);
    const pathname = parsed.pathname;
    return pathname && pathname !== "/" ? pathname : "/live-ws";
  } catch {
    return "/live-ws";
  }
}

/**
 * The operator-declared public WebSocket URL, resolved at RUNTIME.
 *
 * `NEXT_PUBLIC_*` is inlined into the client bundle at BUILD time, so a prebuilt
 * Docker or npm image can never carry an operator's value — which is exactly why
 * the server echoes this in `/api/v1/ws?handshake=1` for the client to discover.
 * Reading only the `NEXT_PUBLIC_`-prefixed name on the server made that echo
 * unreachable too: behind a reverse proxy the dashboard kept dialling
 * `wss://<host>:20132/live-ws` and reported "Live disabled" (#11331).
 *
 * `LIVE_WS_PUBLIC_URL` is the runtime name, alongside the existing runtime
 * `LIVE_WS_HOST` / `LIVE_WS_PORT`. The prefixed name still wins nothing and loses
 * nothing — it stays supported as the fallback so existing deployments that set it
 * (build-time or in the container) keep working.
 */
export function resolveLiveWsPublicUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [env.LIVE_WS_PUBLIC_URL, env.NEXT_PUBLIC_LIVE_WS_PUBLIC_URL];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) return trimmed;
  }
  return null;
}

/** Convenience: read the env var at call time and derive the path. */
export function getLiveWsPath(): string {
  return deriveLiveWsPath(resolveLiveWsPublicUrl() ?? undefined);
}

/**
 * Normalize a handshake-reported live-WS port. Returns `null` for anything
 * that is not a usable 1–65535 integer (number or numeric string), so callers
 * treat "no usable port" the same as "not reported" (#11331).
 */
export function sanitizeLiveWsPort(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) return null;
    if (value < 1 || value > 65535) return null;
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) return null;
    if (parsed < 1 || parsed > 65535) return null;
    return parsed;
  }
  return null;
}

/**
 * Compose the live-dashboard WebSocket URL (#11331).
 *
 * Precedence:
 *   1. `explicit`  — operator-configured wsUrl wins over everything.
 *   2. `handshakeUrl` — a complete URL from /api/v1/ws?handshake=1 beats a
 *      bare port override (it already encodes host+path+port coherently).
 *   3. `defaultUrl`  with the handshake's `handshakePort` / `handshakePath`
 *      applied on top — a prebuilt image learns the real LIVE_WS_PORT /
 *      custom path at runtime instead of the compiled-in default.
 * An unparseable default falls back to the raw string (the WebSocket
 * constructor will surface the error) rather than throwing here.
 */
export function resolveLiveWsUrl(options: {
  explicit?: string | null;
  handshakeUrl?: string | null;
  handshakePort?: number | null;
  handshakePath?: string | null;
  defaultUrl: string;
}): string {
  const { explicit, handshakeUrl, handshakePort, handshakePath, defaultUrl } = options;

  if (typeof explicit === "string" && explicit.trim() !== "") return explicit;
  if (typeof handshakeUrl === "string" && handshakeUrl.trim() !== "") return handshakeUrl;

  let parsed: URL;
  try {
    parsed = new URL(defaultUrl);
  } catch {
    return defaultUrl;
  }

  const port = sanitizeLiveWsPort(handshakePort);
  if (port !== null) {
    parsed.port = String(port);
  }
  if (typeof handshakePath === "string" && handshakePath.startsWith("/")) {
    parsed.pathname = handshakePath;
  }
  return parsed.toString();
}
