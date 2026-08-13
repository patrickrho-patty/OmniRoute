/**
 * Body Size Guard — E-1 Critical Fix
 *
 * Middleware helper that rejects oversized request bodies
 * before they are parsed, preventing OOM from malicious payloads.
 *
 * Usage:
 *   import { checkBodySize, MAX_BODY_BYTES } from "@/shared/middleware/bodySizeGuard";
 *
 *   const rejection = checkBodySize(request);
 *   if (rejection) return rejection;
 *
 * @module shared/middleware/bodySizeGuard
 */

import { buildErrorBody } from "@omniroute/open-sse/utils/error.ts";
import {
  normalizeRequestBodyLimitMb,
  parseRequestBodyLimitBytes,
  requestBodyLimitMbToBytes,
} from "../constants/bodySize";

/** Larger limit for backup/import routes: 100 MB */
export const MAX_BODY_BYTES_IMPORT = 100 * 1024 * 1024;

/** Larger limit for audio transcription uploads: 100 MB */
export const MAX_BODY_BYTES_AUDIO = 100 * 1024 * 1024;

/** Larger limit for file uploads: 500 MB */
export const MAX_BODY_BYTES_FILE = 500 * 1024 * 1024;

/** Larger limit for LLM request payloads: 50 MB */
export const MAX_BODY_BYTES_LLM_API = 50 * 1024 * 1024;

/** Allows one 20 MiB image as multipart or base64 JSON plus envelope overhead. */
export const MAX_BODY_BYTES_IMAGE_EDIT = 30 * 1024 * 1024;

/** Configured limit — reads from env or falls back to 10 MB */
export const MAX_BODY_BYTES = parseRequestBodyLimitBytes(process.env.MAX_BODY_SIZE_BYTES);
export const CLAUDE_MESSAGES_ROUTE = "/v1/messages";
const CLAUDE_MESSAGES_TOOL_HEAVY_MIN_TOOLS = 20;
export const CLAUDE_MESSAGES_TOOL_HEAVY_MAX_BYTES = 512 * 1024;
export const CLAUDE_MESSAGES_ABSOLUTE_MAX_BYTES = 1024 * 1024;

type BodySizeRule = { prefix: string; limit: number };
type HeaderReadableRequest = { headers?: { get?: (name: string) => string | null } };

const ROUTE_LIMITS: BodySizeRule[] = [
  { prefix: "/api/db-backups/import", limit: MAX_BODY_BYTES_IMPORT },
  { prefix: "/api/v1/chat/completions", limit: MAX_BODY_BYTES_LLM_API },
  { prefix: "/api/v1/responses", limit: MAX_BODY_BYTES_LLM_API },
  { prefix: "/api/v1/images/edits", limit: MAX_BODY_BYTES_IMAGE_EDIT },
  { prefix: "/api/v1/audio/transcriptions", limit: MAX_BODY_BYTES_AUDIO },
  { prefix: "/api/v1/files", limit: MAX_BODY_BYTES_FILE },
];

export function getConfiguredBodySizeLimitBytes(settings?: Record<string, unknown>): number {
  const configuredMb = normalizeRequestBodyLimitMb(settings?.maxBodySizeMb);
  return configuredMb === null ? MAX_BODY_BYTES : requestBodyLimitMbToBytes(configuredMb);
}

/**
 * Resolve the body size limit for a request path.
 */
export function getBodySizeLimit(pathname: string, settings?: Record<string, unknown>): number {
  const configuredLimit = getConfiguredBodySizeLimitBytes(settings);
  const customRule = ROUTE_LIMITS.find((rule) => pathname.startsWith(rule.prefix));
  return customRule ? Math.max(customRule.limit, configuredLimit) : configuredLimit;
}

/**
 * Parse the declared request Content-Length header.
 */
export function getDeclaredContentLengthBytes(request: HeaderReadableRequest): number | null {
  const contentLength = request.headers?.get?.("content-length");
  if (!contentLength) return null;
  const bytes = Number.parseInt(contentLength, 10);
  return Number.isNaN(bytes) || bytes <= 0 ? null : bytes;
}

export function isClaudeMessagesPath(pathname: string): boolean {
  return pathname === CLAUDE_MESSAGES_ROUTE || pathname === `/api${CLAUDE_MESSAGES_ROUTE}`;
}

function estimateJsonStringBytes(value: string): number {
  let bytes = 2;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x22 || code === 0x5c) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes += 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function* ownEnumerableKeys(source: Record<string, unknown>) {
  for (const key in source) {
    yield key;
  }
}

export function estimateJsonBodyBytes(
  value: unknown,
  stopAtBytes: number = Number.POSITIVE_INFINITY
): number {
  type Frame =
    | { kind: "value"; value: unknown; inArray?: boolean }
    | { kind: "array"; values: unknown[]; index: number }
    | { kind: "object"; source: Record<string, unknown>; iterator: IterableIterator<string> };

  let bytes = 0;
  const stack: Frame[] = [{ kind: "value", value }];
  const seen = new WeakSet<object>();
  const add = (count: number) => {
    bytes += count;
    return bytes > stopAtBytes;
  };

  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) continue;

    if (frame.kind === "array") {
      if (frame.index < frame.values.length) {
        stack.push({ kind: "array", values: frame.values, index: frame.index + 1 });
        stack.push({ kind: "value", value: frame.values[frame.index], inArray: true });
      }
      continue;
    }

    if (frame.kind === "object") {
      for (;;) {
        const next = frame.iterator.next();
        if (next.done) break;
        const key = next.value;
        if (!Object.prototype.hasOwnProperty.call(frame.source, key)) continue;
        const item = frame.source[key];
        if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
        if (add(estimateJsonStringBytes(key) + 2)) return bytes;
        stack.push(frame);
        stack.push({ kind: "value", value: item });
        break;
      }
      continue;
    }

    const current = frame.value;
    if (current === null || current === undefined) {
      if ((frame.inArray || current === null) && add(4)) return bytes;
      continue;
    }

    if (typeof current === "string") {
      if (add(estimateJsonStringBytes(current))) return bytes;
    } else if (typeof current === "number") {
      if (add(Number.isFinite(current) ? String(current).length : 4)) return bytes;
    } else if (typeof current === "boolean") {
      if (add(current ? 4 : 5)) return bytes;
    } else if (typeof current === "object") {
      if (seen.has(current)) continue;
      seen.add(current);

      if (Array.isArray(current)) {
        if (add(2 + Math.max(0, current.length - 1))) return bytes;
        stack.push({ kind: "array", values: current, index: 0 });
      } else {
        if (add(2)) return bytes;
        stack.push({
          kind: "object",
          source: current as Record<string, unknown>,
          iterator: ownEnumerableKeys(current as Record<string, unknown>),
        });
      }
    }
  }

  return bytes;
}

export function createPayloadTooLargeResponse(message: string): Response {
  return new Response(JSON.stringify(buildErrorBody(413, message)), {
    status: 413,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

/**
 * Check Content-Length header against the configured limit.
 * Returns a 413 Response if the body is too large, or null if OK.
 */
export function checkBodySize(request: Request, limit: number = MAX_BODY_BYTES): Response | null {
  const bytes = getDeclaredContentLengthBytes(request);
  if (bytes !== null && bytes > limit) {
    return createPayloadTooLargeResponse(
      `Request body too large. Maximum allowed: ${formatBytes(limit)}`
    );
  }

  return null;
}

/**
 * Claude Messages requests can be deceptively large after JSON parse when a client
 * sends giant tool schemas or prompt blocks without a declared Content-Length.
 * This post-parse guard protects the hot chat path before cloning/logging.
 */
export type ClaudeMessagesBodySizeReason = "absolute" | "tool-heavy";

export interface ClaudeMessagesBodySizeAssessment {
  oversized: boolean;
  reason: ClaudeMessagesBodySizeReason | null;
  toolCount: number;
  declaredBytes: number | null;
  bodyBytes: number;
  limitBytes: number | null;
  message: string | null;
}

export function assessClaudeMessagesBodySize(
  request: HeaderReadableRequest,
  pathname: string,
  body: unknown,
  absoluteMaxBytes: number = CLAUDE_MESSAGES_ABSOLUTE_MAX_BYTES
): ClaudeMessagesBodySizeAssessment | null {
  if (!isClaudeMessagesPath(pathname) || !body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }

  const toolCount = Array.isArray((body as { tools?: unknown }).tools)
    ? (body as { tools: unknown[] }).tools.length
    : 0;
  const toolHeavyBytes = Math.min(CLAUDE_MESSAGES_TOOL_HEAVY_MAX_BYTES, absoluteMaxBytes);
  const declaredBytes = getDeclaredContentLengthBytes(request);
  const estimateLimit =
    toolCount >= CLAUDE_MESSAGES_TOOL_HEAVY_MIN_TOOLS ? toolHeavyBytes + 1 : absoluteMaxBytes + 1;
  const bodyBytes = Math.max(declaredBytes ?? 0, estimateJsonBodyBytes(body, estimateLimit));

  if (bodyBytes > absoluteMaxBytes) {
    return {
      oversized: true,
      reason: "absolute",
      toolCount,
      declaredBytes,
      bodyBytes,
      limitBytes: absoluteMaxBytes,
      message: `Claude-format request too large. Maximum allowed: ${formatBytes(absoluteMaxBytes)}`,
    };
  }

  if (toolCount >= CLAUDE_MESSAGES_TOOL_HEAVY_MIN_TOOLS && bodyBytes > toolHeavyBytes) {
    return {
      oversized: true,
      reason: "tool-heavy",
      toolCount,
      declaredBytes,
      bodyBytes,
      limitBytes: toolHeavyBytes,
      message: `Claude-format tool-heavy request too large (${toolCount} tools). Reduce tools or keep the request at or below ${formatBytes(toolHeavyBytes)}.`,
    };
  }

  return {
    oversized: false,
    reason: null,
    toolCount,
    declaredBytes,
    bodyBytes,
    limitBytes: null,
    message: null,
  };
}

export function checkClaudeMessagesBodySize(
  request: HeaderReadableRequest,
  pathname: string,
  body: unknown,
  absoluteMaxBytes?: number
): Response | null {
  const assessment = assessClaudeMessagesBodySize(request, pathname, body, absoluteMaxBytes);
  if (!assessment || !assessment.oversized || !assessment.message) return null;
  return createPayloadTooLargeResponse(assessment.message);
}

export class RequestBodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`Request body exceeds ${formatBytes(limit)}`);
    this.name = "RequestBodyTooLargeError";
  }
}

/**
 * Read a request body while enforcing the actual streamed byte count. This closes the gap left by
 * Content-Length-only admission for chunked or deliberately mislabelled requests.
 */
export async function readRequestBodyWithLimit(
  request: Request,
  limit: number
): Promise<Uint8Array<ArrayBuffer>> {
  const declaredLength = Number.parseInt(request.headers.get("content-length") || "", 10);
  if (!Number.isNaN(declaredLength) && declaredLength > limit) {
    throw new RequestBodyTooLargeError(limit);
  }
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel("request body too large");
        throw new RequestBodyTooLargeError(limit);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/** Format bytes as human-readable string */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} bytes`;
}
