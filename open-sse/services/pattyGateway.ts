import { sanitizeErrorMessage } from "../utils/error.ts";

export type PattyHarness = "claude" | "codex";
export type PattyTransport = "http" | "sse" | "websocket";

export interface PattyPreflightInput {
  requestId: string;
  turnId?: string;
  harness: PattyHarness;
  publicModel: string;
  endpoint: string;
  transport: PattyTransport;
  employeeCredential: string;
  accountId?: string;
  sourceAddress: string;
}

export interface PattyQuotaWindow {
  spend: number;
  limit: number;
  usedPercent: number;
  resetAt: number;
}

export interface PattyDecision {
  preflightRef: string;
  requestId: string;
  turnId: string;
  employeeId: string;
  deviceId: string;
  email: string | null;
  harness: PattyHarness;
  usageIdentity: string;
  routingGroup: string;
  publicModel: string;
  routedModel: string;
  priceMultiplier: number;
  quota: {
    fiveHour: PattyQuotaWindow;
    sevenDay: PattyQuotaWindow;
  };
}

export interface PattyTerminalUsage {
  provider?: string;
  connection?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  status: string;
  errorCode?: string;
  latencyMs?: number;
  requestMaterial?: unknown;
  responseMaterial?: unknown;
}

export interface PattySettlementRef {
  preflightRef: string;
  requestId: string;
  turnId: string;
  routedModel: string;
}

export interface PattyGatewayDeps {
  fetchImpl?: typeof fetch;
  env?: Partial<Record<"PATTY_GATEWAY_URL" | "PATTY_GATEWAY_TOKEN", string | undefined>>;
  timeoutMs?: number;
}

export class PattyGatewayError extends Error {
  status: number;
  code: string;
  quota?: { resetAt?: number };

  constructor(status: number, code: string, message: string, quota?: { resetAt?: number }) {
    super(sanitizeErrorMessage(message));
    this.name = "PattyGatewayError";
    this.status = status;
    this.code = code;
    this.quota = quota;
  }
}

const PREFLIGHT_PATH = "/patty-code/internal/gateway/preflight";
const SETTLE_PATH = "/patty-code/internal/gateway/settle";
const DEFAULT_TIMEOUT_MS = 3000;
const settlementAttempts = new WeakSet<PattyDecision>();

function gatewayConfig(deps: PattyGatewayDeps): { baseUrl: string; token: string } {
  const env = deps.env ?? process.env;
  const baseUrl = env.PATTY_GATEWAY_URL?.trim().replace(/\/$/, "") || "";
  const token = env.PATTY_GATEWAY_TOKEN?.trim() || "";
  if (!baseUrl || !token) {
    throw new PattyGatewayError(503, "patty_policy_unavailable", "Patty policy is unavailable");
  }
  return { baseUrl, token };
}

export function isPattyGatewayEnabled(
  env: Partial<
    Record<"PATTY_GATEWAY_URL" | "PATTY_GATEWAY_TOKEN", string | undefined>
  > = process.env
): boolean {
  return Boolean(env.PATTY_GATEWAY_URL?.trim() && env.PATTY_GATEWAY_TOKEN?.trim());
}

function gatewayRequestInit(
  token: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  sourceAddress?: string
): RequestInit {
  const headers = new Headers({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  });
  if (sourceAddress) headers.set("x-patty-client-ip", sourceAddress);
  return {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function responseJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return objectValue(await response.json());
  } catch {
    return null;
  }
}

function rejectionFromResponse(
  response: Response,
  body: Record<string, unknown> | null,
  fallbackCode: string,
  fallbackMessage: string
): PattyGatewayError {
  const error = objectValue(body?.error);
  const code = typeof error?.type === "string" && error.type ? error.type : fallbackCode;
  const message =
    typeof error?.message === "string" && error.message ? error.message : fallbackMessage;
  const resetsAt = body?.resets_at;
  const quota =
    typeof resetsAt === "number" && Number.isFinite(resetsAt) ? { resetAt: resetsAt } : undefined;
  return new PattyGatewayError(response.status, code, message, quota);
}

function quotaWindow(value: unknown): PattyQuotaWindow | null {
  const row = objectValue(value);
  if (!row) return null;
  const spend = row.spend;
  const limit = row.limit;
  const usedPercent = row.used_percent;
  const resetAt = row.reset_at;
  if (
    typeof spend !== "number" ||
    !Number.isFinite(spend) ||
    spend < 0 ||
    typeof limit !== "number" ||
    !Number.isFinite(limit) ||
    limit <= 0 ||
    typeof usedPercent !== "number" ||
    !Number.isFinite(usedPercent) ||
    usedPercent < 0 ||
    typeof resetAt !== "number" ||
    !Number.isFinite(resetAt)
  ) {
    return null;
  }
  return { spend, limit, usedPercent, resetAt };
}

function parseDecision(
  value: Record<string, unknown> | null,
  input: PattyPreflightInput
): PattyDecision {
  const route = objectValue(value?.route);
  const quota = objectValue(value?.quota);
  const fiveHour = quotaWindow(quota?.five_hour);
  const sevenDay = quotaWindow(quota?.seven_day);
  const turnId = input.turnId || "http";
  if (
    !value ||
    typeof value.preflight_ref !== "string" ||
    !value.preflight_ref ||
    value.request_id !== input.requestId ||
    value.turn_id !== turnId ||
    value.harness !== input.harness ||
    value.public_model !== input.publicModel ||
    typeof value.employee_id !== "string" ||
    !value.employee_id ||
    typeof value.device_id !== "string" ||
    !value.device_id ||
    typeof value.usage_identity !== "string" ||
    !value.usage_identity ||
    typeof value.routing_group !== "string" ||
    !value.routing_group ||
    typeof route?.target !== "string" ||
    !route.target ||
    typeof route.price_multiplier !== "number" ||
    !Number.isFinite(route.price_multiplier) ||
    route.price_multiplier <= 0 ||
    !fiveHour ||
    !sevenDay
  ) {
    throw new PattyGatewayError(
      503,
      "patty_policy_invalid",
      "Patty returned an invalid policy decision"
    );
  }
  return {
    preflightRef: value.preflight_ref,
    requestId: input.requestId,
    turnId,
    employeeId: value.employee_id,
    deviceId: value.device_id,
    email: typeof value.email === "string" ? value.email : null,
    harness: input.harness,
    usageIdentity: value.usage_identity,
    routingGroup: value.routing_group,
    publicModel: input.publicModel,
    routedModel: route.target,
    priceMultiplier: route.price_multiplier,
    quota: { fiveHour, sevenDay },
  };
}

export async function pattyPreflight(
  input: PattyPreflightInput,
  deps: PattyGatewayDeps = {}
): Promise<PattyDecision> {
  const { baseUrl, token } = gatewayConfig(deps);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const turnId = input.turnId || "http";
  try {
    const response = await fetchImpl(
      `${baseUrl}${PREFLIGHT_PATH}`,
      gatewayRequestInit(
        token,
        {
          request_id: input.requestId,
          turn_id: turnId,
          harness: input.harness,
          public_model: input.publicModel,
          endpoint: input.endpoint,
          transport: input.transport,
          credential: input.employeeCredential,
          ...(input.accountId ? { account_id: input.accountId } : {}),
        },
        deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        input.sourceAddress
      )
    );
    const body = await responseJson(response);
    if (!response.ok) {
      throw rejectionFromResponse(
        response,
        body,
        "patty_preflight_rejected",
        "Patty rejected this request"
      );
    }
    return parseDecision(body, input);
  } catch (error) {
    if (error instanceof PattyGatewayError) throw error;
    throw new PattyGatewayError(503, "patty_policy_unavailable", "Patty policy is unavailable");
  }
}

function usageValue(value: number | undefined): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

export async function pattySettle(
  decision: PattyDecision,
  terminal: PattyTerminalUsage,
  deps: PattyGatewayDeps = {}
): Promise<void> {
  settlementAttempts.add(decision);
  await pattySettleRef(decision, terminal, deps);
}

export async function pattySettleRef(
  decision: PattySettlementRef,
  terminal: PattyTerminalUsage,
  deps: PattyGatewayDeps = {}
): Promise<void> {
  const { baseUrl, token } = gatewayConfig(deps);
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(
      `${baseUrl}${SETTLE_PATH}`,
      gatewayRequestInit(
        token,
        {
          preflight_ref: decision.preflightRef,
          request_id: decision.requestId,
          turn_id: decision.turnId,
          route_target: decision.routedModel,
          ...(terminal.provider ? { provider: terminal.provider } : {}),
          ...(terminal.connection ? { connection: terminal.connection } : {}),
          ...(terminal.model ? { model: terminal.model } : {}),
          input_tokens: usageValue(terminal.inputTokens),
          output_tokens: usageValue(terminal.outputTokens),
          cache_read_tokens: usageValue(terminal.cacheReadTokens),
          cache_write_tokens: usageValue(terminal.cacheWriteTokens),
          reasoning_tokens: usageValue(terminal.reasoningTokens),
          status: terminal.status,
          ...(terminal.errorCode ? { error_code: terminal.errorCode } : {}),
          ...(terminal.latencyMs !== undefined ? { latency_ms: terminal.latencyMs } : {}),
          ...(terminal.requestMaterial !== undefined
            ? { request_material: terminal.requestMaterial }
            : {}),
          ...(terminal.responseMaterial !== undefined
            ? { response_material: terminal.responseMaterial }
            : {}),
        },
        deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
      )
    );
    const body = await responseJson(response);
    if (!response.ok) {
      throw rejectionFromResponse(
        response,
        body,
        "patty_settlement_rejected",
        "Patty rejected this settlement"
      );
    }
    if (body?.settled !== true) {
      throw new PattyGatewayError(
        503,
        "patty_settlement_invalid",
        "Patty did not acknowledge this settlement"
      );
    }
  } catch (error) {
    if (error instanceof PattyGatewayError) throw error;
    throw new PattyGatewayError(
      503,
      "patty_settlement_unavailable",
      "Patty settlement is unavailable"
    );
  }
}

export function hasPattySettlementAttempted(decision: PattyDecision): boolean {
  return settlementAttempts.has(decision);
}

function numericHeader(value: number): string {
  return String(Number.isInteger(value) ? Math.trunc(value) : value);
}

export function pattyHeaders(decision: PattyDecision): Record<string, string> {
  const primary = decision.quota.fiveHour;
  const secondary = decision.quota.sevenDay;
  const representative =
    secondary.usedPercent > primary.usedPercent
      ? { window: secondary, claim: "seven_day" }
      : { window: primary, claim: "five_hour" };
  return {
    "x-codex-primary-used-percent": numericHeader(primary.usedPercent),
    "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-at": numericHeader(primary.resetAt),
    "anthropic-ratelimit-unified-5h-utilization": numericHeader(primary.usedPercent / 100),
    "anthropic-ratelimit-unified-5h-reset": numericHeader(primary.resetAt),
    "x-codex-secondary-used-percent": numericHeader(secondary.usedPercent),
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": numericHeader(secondary.resetAt),
    "anthropic-ratelimit-unified-7d-utilization": numericHeader(secondary.usedPercent / 100),
    "anthropic-ratelimit-unified-7d-reset": numericHeader(secondary.resetAt),
    "anthropic-ratelimit-unified-reset": numericHeader(representative.window.resetAt),
    "anthropic-ratelimit-unified-representative-claim": representative.claim,
  };
}

export function pattyCodexRateLimitsEvent(decision: PattyDecision): Record<string, unknown> {
  const primary = decision.quota.fiveHour;
  const secondary = decision.quota.sevenDay;
  return {
    type: "codex.rate_limits",
    plan_type: "enterprise",
    rate_limits: {
      allowed: primary.usedPercent < 100 && secondary.usedPercent < 100,
      limit_reached: primary.usedPercent >= 100 || secondary.usedPercent >= 100,
      primary: {
        used_percent: primary.usedPercent,
        window_minutes: 300,
        reset_at: primary.resetAt,
      },
      secondary: {
        used_percent: secondary.usedPercent,
        window_minutes: 10080,
        reset_at: secondary.resetAt,
      },
    },
    code_review_rate_limits: null,
    credits: null,
    promo: null,
  };
}

export function pattyTerminalUsageFromUsage(
  usage: unknown,
  context: Pick<
    PattyTerminalUsage,
    "status" | "provider" | "connection" | "model" | "errorCode" | "latencyMs"
  >
): PattyTerminalUsage {
  const row = objectValue(usage) ?? {};
  const details = objectValue(row.prompt_tokens_details) ?? objectValue(row.input_tokens_details);
  const cacheReadTokens = usageValue(
    (row.cache_read_input_tokens ?? row.cached_tokens ?? details?.cached_tokens) as
      number | undefined
  );
  const cacheWriteTokens = usageValue(
    (row.cache_creation_input_tokens ?? details?.cache_creation_tokens) as number | undefined
  );
  const totalInputTokens = usageValue(
    (row.prompt_tokens ?? row.input_tokens) as number | undefined
  );
  return {
    ...(context.provider ? { provider: context.provider } : {}),
    ...(context.connection ? { connection: context.connection } : {}),
    ...(context.model ? { model: context.model } : {}),
    inputTokens: Math.max(0, totalInputTokens - cacheReadTokens - cacheWriteTokens),
    outputTokens: usageValue((row.completion_tokens ?? row.output_tokens) as number | undefined),
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens: usageValue(
      (row.reasoning_tokens ?? objectValue(row.completion_tokens_details)?.reasoning_tokens) as
        number | undefined
    ),
    status: context.status,
    ...(context.errorCode ? { errorCode: context.errorCode } : {}),
    ...(context.latencyMs !== undefined ? { latencyMs: context.latencyMs } : {}),
  };
}

export function pattyNativeErrorResponse(
  harness: PattyHarness,
  error: PattyGatewayError
): Response {
  const body =
    harness === "claude"
      ? { type: "error", error: { type: error.code, message: error.message } }
      : {
          error: { type: error.code, message: error.message },
          plan_type: "enterprise",
          ...(error.quota?.resetAt !== undefined ? { resets_at: error.quota.resetAt } : {}),
        };
  return Response.json(body, { status: error.status });
}

function pattyStreamError(harness: PattyHarness, error: PattyGatewayError): string {
  if (harness === "claude") {
    return [
      `event: error\ndata: ${JSON.stringify({
        type: "error",
        error: { type: error.code, message: error.message },
      })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ].join("");
  }
  return `event: response.failed\ndata: ${JSON.stringify({
    type: "response.failed",
    response: {
      id: null,
      status: "failed",
      error: { type: error.code, code: error.code, message: error.message },
    },
  })}\n\n`;
}

function isPattyTerminalFrame(frame: string, harness: PattyHarness): boolean {
  return harness === "claude"
    ? /(?:event:\s*message_stop|"type"\s*:\s*"message_stop")/.test(frame)
    : /(?:event:\s*response\.completed|"type"\s*:\s*"response\.completed")/.test(frame);
}

function takeSseFrame(buffer: string): { frame: string; rest: string } | null {
  const match = /\r?\n\r?\n/.exec(buffer);
  if (!match || match.index === undefined) return null;
  const end = match.index + match[0].length;
  return { frame: buffer.slice(0, end), rest: buffer.slice(end) };
}

export function createPattySettlementTransform(
  harness: PattyHarness,
  awaitSettlement: () => Promise<void>
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let terminalFound = false;
  let held = "";

  const emitFrame = (controller: TransformStreamDefaultController<Uint8Array>, frame: string) => {
    if (terminalFound || isPattyTerminalFrame(frame, harness)) {
      terminalFound = true;
      held += frame;
      return;
    }
    controller.enqueue(encoder.encode(frame));
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let next = takeSseFrame(buffer); next; next = takeSseFrame(buffer)) {
        buffer = next.rest;
        emitFrame(controller, next.frame);
      }
    },
    async flush(controller) {
      buffer += decoder.decode();
      if (buffer) emitFrame(controller, buffer);
      try {
        await awaitSettlement();
        if (held) controller.enqueue(encoder.encode(held));
      } catch (error) {
        const gatewayError =
          error instanceof PattyGatewayError
            ? error
            : new PattyGatewayError(
                503,
                "patty_settlement_unavailable",
                "Patty settlement is unavailable"
              );
        controller.enqueue(encoder.encode(pattyStreamError(harness, gatewayError)));
      }
    },
  });
}

export function isPattyBillingEndpoint(endpoint: string): boolean {
  return endpoint === "/v1/messages" || endpoint === "/v1/responses";
}

function shouldPrepareWithPatty(deps: PattyGatewayDeps): boolean {
  const env = deps.env ?? process.env;
  const hasGatewayUrl = Boolean(env.PATTY_GATEWAY_URL?.trim());
  const hasGatewayToken = Boolean(env.PATTY_GATEWAY_TOKEN?.trim());
  if (!hasGatewayUrl && !hasGatewayToken) return false;
  if (!hasGatewayUrl || !hasGatewayToken) gatewayConfig(deps);
  return true;
}

function assertPattyHarness(request: Request, harness: PattyHarness): void {
  if (request.headers.get("x-patty-harness") !== harness) {
    throw new PattyGatewayError(
      403,
      "patty_harness_mismatch",
      "Patty harness does not match this endpoint"
    );
  }
}

function publicModelFromBody(body: Record<string, unknown>): string {
  const publicModel = typeof body.model === "string" ? body.model.trim() : "";
  if (!publicModel) {
    throw new PattyGatewayError(400, "invalid_request", "A model is required");
  }
  return publicModel;
}

function pattyIdentityFromRequest(request: Request) {
  return {
    employeeCredential: request.headers.get("x-patty-original-authorization") || "",
    accountId:
      request.headers.get("x-patty-account-id") ||
      request.headers.get("chatgpt-account-id") ||
      undefined,
    sourceAddress: request.headers.get("x-patty-client-ip") || "",
  };
}

export async function preparePattyWebSocketTurn<T extends Record<string, unknown>>(
  request: Request,
  body: T,
  requestId: string,
  turnId: string,
  deps: PattyGatewayDeps = {}
): Promise<{ body: T; decision: PattyDecision | null }> {
  if (!shouldPrepareWithPatty(deps)) return { body, decision: null };
  assertPattyHarness(request, "codex");
  const publicModel = publicModelFromBody(body);
  const decision = await pattyPreflight(
    {
      requestId,
      turnId,
      harness: "codex",
      publicModel,
      endpoint: "/v1/responses",
      transport: "websocket",
      ...pattyIdentityFromRequest(request),
    },
    deps
  );
  return { body: { ...body, model: decision.routedModel }, decision };
}

export async function preparePattyRequest<T extends Record<string, unknown>>(
  request: Request,
  body: T,
  requestId: string,
  deps: PattyGatewayDeps = {}
): Promise<{ body: T; decision: PattyDecision | null }> {
  const endpoint = new URL(request.url).pathname.replace(/\/$/, "");
  if (!isPattyBillingEndpoint(endpoint)) return { body, decision: null };

  if (!shouldPrepareWithPatty(deps)) return { body, decision: null };

  const harness: PattyHarness = endpoint === "/v1/messages" ? "claude" : "codex";
  assertPattyHarness(request, harness);
  const publicModel = publicModelFromBody(body);
  const acceptsSse = (request.headers.get("accept") || "")
    .toLowerCase()
    .includes("text/event-stream");
  const decision = await pattyPreflight(
    {
      requestId,
      turnId: "http",
      harness,
      publicModel,
      endpoint,
      transport: body.stream === true || acceptsSse ? "sse" : "http",
      ...pattyIdentityFromRequest(request),
    },
    deps
  );
  return { body: { ...body, model: decision.routedModel }, decision };
}
