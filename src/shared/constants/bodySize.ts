import {
  parseBoundedInteger,
  parseIntegerOrNull,
  parsePositiveInt,
} from "@/shared/utils/envParsing";

export const REQUEST_BODY_BYTES_PER_MB = 1024 * 1024;
export const REQUEST_BODY_BYTES_PER_KB = 1024;
export const DEFAULT_REQUEST_BODY_LIMIT_MB = 10;
export const MIN_REQUEST_BODY_LIMIT_MB = 1;
export const MAX_REQUEST_BODY_LIMIT_MB = 500;
export const DEFAULT_REQUEST_BODY_LIMIT_BYTES =
  DEFAULT_REQUEST_BODY_LIMIT_MB * REQUEST_BODY_BYTES_PER_MB;

export const CLAUDE_LARGE_MESSAGES_MODES = ["reject", "vcc"] as const;
export type ClaudeLargeMessagesMode = (typeof CLAUDE_LARGE_MESSAGES_MODES)[number];
export const DEFAULT_CLAUDE_LARGE_MESSAGES_MODE: ClaudeLargeMessagesMode = "reject";
export const DEFAULT_CLAUDE_LARGE_MESSAGES_TARGET_KB = 900;
export const MIN_CLAUDE_LARGE_MESSAGES_TARGET_KB = 64;
export const MAX_CLAUDE_LARGE_MESSAGES_TARGET_KB = 10 * 1024;
export const DEFAULT_CLAUDE_LARGE_MESSAGES_MAX_MB = 50;
export const MIN_CLAUDE_LARGE_MESSAGES_MAX_MB = 1;
export const MAX_CLAUDE_LARGE_MESSAGES_MAX_MB = MAX_REQUEST_BODY_LIMIT_MB;
// Threshold (KB) above which a Claude Messages request triggers reject/VCC.
// Default 1024 KB = 1 MB — the historical hardcoded value; now user-configurable
// so the actual trigger is visible in Settings → Request Limits.
export const DEFAULT_CLAUDE_LARGE_MESSAGES_THRESHOLD_KB = 1024;
export const MIN_CLAUDE_LARGE_MESSAGES_THRESHOLD_KB = 64;
export const MAX_CLAUDE_LARGE_MESSAGES_THRESHOLD_KB = 10 * 1024;

export function normalizeClaudeLargeMessagesMode(value: unknown): ClaudeLargeMessagesMode | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : undefined;
  if (normalized === "compact" || normalized === "compaction") return "vcc";
  return normalized && (CLAUDE_LARGE_MESSAGES_MODES as readonly string[]).includes(normalized)
    ? (normalized as ClaudeLargeMessagesMode)
    : null;
}

export function claudeLargeMessagesModeFromEnv(value: string | undefined): ClaudeLargeMessagesMode {
  return normalizeClaudeLargeMessagesMode(value) ?? DEFAULT_CLAUDE_LARGE_MESSAGES_MODE;
}

export function normalizeBoundedIntegerValue(
  value: unknown,
  min: number,
  max: number
): number | null {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? parseIntegerOrNull(value) : NaN;
  if (parsed === null || !Number.isFinite(parsed)) return null;

  const normalized = Math.floor(parsed);
  return normalized >= min && normalized <= max ? normalized : null;
}

export function claudeLargeMessagesThresholdKbFromEnv(value: string | undefined): number {
  const bytes = parseBoundedInteger(
    value,
    DEFAULT_CLAUDE_LARGE_MESSAGES_THRESHOLD_KB * REQUEST_BODY_BYTES_PER_KB,
    MIN_CLAUDE_LARGE_MESSAGES_THRESHOLD_KB * REQUEST_BODY_BYTES_PER_KB,
    MAX_CLAUDE_LARGE_MESSAGES_THRESHOLD_KB * REQUEST_BODY_BYTES_PER_KB
  );
  return Math.round(bytes / REQUEST_BODY_BYTES_PER_KB);
}

export function claudeLargeMessagesTargetKbFromEnv(value: string | undefined): number {
  const bytes = parseBoundedInteger(
    value,
    DEFAULT_CLAUDE_LARGE_MESSAGES_TARGET_KB * REQUEST_BODY_BYTES_PER_KB,
    MIN_CLAUDE_LARGE_MESSAGES_TARGET_KB * REQUEST_BODY_BYTES_PER_KB,
    MAX_CLAUDE_LARGE_MESSAGES_TARGET_KB * REQUEST_BODY_BYTES_PER_KB
  );
  return Math.round(bytes / REQUEST_BODY_BYTES_PER_KB);
}

export function claudeLargeMessagesMaxMbFromEnv(value: string | undefined): number {
  const bytes = parseBoundedInteger(
    value,
    DEFAULT_CLAUDE_LARGE_MESSAGES_MAX_MB * REQUEST_BODY_BYTES_PER_MB,
    MIN_CLAUDE_LARGE_MESSAGES_MAX_MB * REQUEST_BODY_BYTES_PER_MB,
    MAX_CLAUDE_LARGE_MESSAGES_MAX_MB * REQUEST_BODY_BYTES_PER_MB
  );
  return Math.round(bytes / REQUEST_BODY_BYTES_PER_MB);
}

export function normalizeRequestBodyLimitMb(value: unknown): number | null {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return null;

  const normalized = Math.floor(parsed);
  if (normalized < MIN_REQUEST_BODY_LIMIT_MB || normalized > MAX_REQUEST_BODY_LIMIT_MB) {
    return null;
  }

  return normalized;
}

export function requestBodyLimitMbToBytes(value: number): number {
  return value * REQUEST_BODY_BYTES_PER_MB;
}

export function parseRequestBodyLimitBytes(value: string | undefined): number {
  return parsePositiveInt(value, DEFAULT_REQUEST_BODY_LIMIT_BYTES);
}

export function requestBodyLimitBytesToMb(value: number): number {
  const configuredMb = Math.round(value / REQUEST_BODY_BYTES_PER_MB);
  return Math.min(MAX_REQUEST_BODY_LIMIT_MB, Math.max(MIN_REQUEST_BODY_LIMIT_MB, configuredMb));
}

export function requestBodyLimitMbFromEnv(value: string | undefined): number {
  return requestBodyLimitBytesToMb(parseRequestBodyLimitBytes(value));
}
