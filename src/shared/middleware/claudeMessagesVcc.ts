import {
  DEFAULT_CLAUDE_LARGE_MESSAGES_MAX_MB,
  DEFAULT_CLAUDE_LARGE_MESSAGES_MODE,
  DEFAULT_CLAUDE_LARGE_MESSAGES_TARGET_KB,
  DEFAULT_CLAUDE_LARGE_MESSAGES_THRESHOLD_KB,
  MAX_CLAUDE_LARGE_MESSAGES_MAX_MB,
  MAX_CLAUDE_LARGE_MESSAGES_TARGET_KB,
  MAX_CLAUDE_LARGE_MESSAGES_THRESHOLD_KB,
  MIN_CLAUDE_LARGE_MESSAGES_MAX_MB,
  MIN_CLAUDE_LARGE_MESSAGES_TARGET_KB,
  MIN_CLAUDE_LARGE_MESSAGES_THRESHOLD_KB,
  REQUEST_BODY_BYTES_PER_KB,
  REQUEST_BODY_BYTES_PER_MB,
  normalizeBoundedIntegerValue,
  normalizeClaudeLargeMessagesMode,
  type ClaudeLargeMessagesMode,
} from "@/shared/constants/bodySize";
import { parsePositiveInt } from "@/shared/utils/envParsing";
import {
  assessClaudeMessagesBodySize,
  createPayloadTooLargeResponse,
  estimateJsonBodyBytes,
  formatBytes,
  getDeclaredContentLengthBytes,
  isClaudeMessagesPath,
  type ClaudeMessagesBodySizeAssessment,
} from "./bodySizeGuard";

type JsonRecord = Record<string, unknown>;

type HeaderReadableRequest = { headers?: { get?: (name: string) => string | null } };

export interface ClaudeLargeMessagesConfig {
  mode: ClaudeLargeMessagesMode;
  /**
   * Trigger threshold in bytes. Requests at or below this size pass through
   * untouched; requests above it are rejected (`reject` mode) or compacted
   * (`vcc` mode). Exposed in Settings → Request Limits as `Threshold (KB)`.
   */
  thresholdBytes: number;
  targetBytes: number;
  maxBytes: number;
}

export interface ClaudeMessagesVccStats {
  originalBytes: number;
  compactedBytes: number;
  targetBytes: number;
  messagesBefore: number;
  messagesAfter: number;
  toolsBefore: number;
  toolsAfter: number;
  stagesApplied: string[];
}

export interface ClaudeMessagesVccResult<T = unknown> {
  body: T;
  compacted: boolean;
  stats: ClaudeMessagesVccStats;
}

export interface ClaudeLargeRequestModeResult<T = unknown> {
  body: T;
  rejection: Response | null;
  compacted: boolean;
  stats: ClaudeMessagesVccStats | null;
  assessment: ClaudeMessagesBodySizeAssessment | null;
  config: ClaudeLargeMessagesConfig;
}

const DEFAULT_TARGET_BYTES = DEFAULT_CLAUDE_LARGE_MESSAGES_TARGET_KB * REQUEST_BODY_BYTES_PER_KB;
const DEFAULT_MAX_BYTES = DEFAULT_CLAUDE_LARGE_MESSAGES_MAX_MB * REQUEST_BODY_BYTES_PER_MB;
const DEFAULT_THRESHOLD_BYTES =
  DEFAULT_CLAUDE_LARGE_MESSAGES_THRESHOLD_KB * REQUEST_BODY_BYTES_PER_KB;
const MIN_TARGET_BYTES = MIN_CLAUDE_LARGE_MESSAGES_TARGET_KB * REQUEST_BODY_BYTES_PER_KB;
const MIN_THRESHOLD_BYTES = MIN_CLAUDE_LARGE_MESSAGES_THRESHOLD_KB * REQUEST_BODY_BYTES_PER_KB;
const DESCRIPTION_DROP_KEYS = new Set(["$comment", "examples", "default", "title"]);
const TEXT_TRUNCATION_SUFFIX = "\n...[truncated]";

export function resolveClaudeLargeMessagesConfig(
  env: NodeJS.ProcessEnv = process.env,
  settings?: Record<string, unknown> | null
): ClaudeLargeMessagesConfig {
  const settingsMode = normalizeClaudeLargeMessagesMode(settings?.claudeLargeMessagesMode);
  const envMode = normalizeClaudeLargeMessagesMode(env.OMNIROUTE_CLAUDE_LARGE_MESSAGES_MODE);
  const settingsThresholdKb = normalizeBoundedIntegerValue(
    settings?.claudeLargeMessagesThresholdKb,
    MIN_CLAUDE_LARGE_MESSAGES_THRESHOLD_KB,
    MAX_CLAUDE_LARGE_MESSAGES_THRESHOLD_KB
  );
  const settingsTargetKb = normalizeBoundedIntegerValue(
    settings?.claudeLargeMessagesTargetKb,
    MIN_CLAUDE_LARGE_MESSAGES_TARGET_KB,
    MAX_CLAUDE_LARGE_MESSAGES_TARGET_KB
  );
  const settingsMaxMb = normalizeBoundedIntegerValue(
    settings?.claudeLargeMessagesMaxMb,
    MIN_CLAUDE_LARGE_MESSAGES_MAX_MB,
    MAX_CLAUDE_LARGE_MESSAGES_MAX_MB
  );

  const thresholdBytes =
    settingsThresholdKb !== null
      ? settingsThresholdKb * REQUEST_BODY_BYTES_PER_KB
      : Math.max(
          MIN_THRESHOLD_BYTES,
          parsePositiveInt(
            env.OMNIROUTE_CLAUDE_LARGE_MESSAGES_THRESHOLD_BYTES,
            DEFAULT_THRESHOLD_BYTES
          )
        );
  const targetBytes =
    settingsTargetKb !== null
      ? settingsTargetKb * REQUEST_BODY_BYTES_PER_KB
      : Math.max(
          MIN_TARGET_BYTES,
          parsePositiveInt(env.OMNIROUTE_CLAUDE_LARGE_MESSAGES_TARGET_BYTES, DEFAULT_TARGET_BYTES)
        );
  const maxBytes = Math.max(
    targetBytes,
    settingsMaxMb !== null
      ? settingsMaxMb * REQUEST_BODY_BYTES_PER_MB
      : parsePositiveInt(env.OMNIROUTE_CLAUDE_LARGE_MESSAGES_MAX_BYTES, DEFAULT_MAX_BYTES)
  );
  return {
    mode: settingsMode ?? envMode ?? DEFAULT_CLAUDE_LARGE_MESSAGES_MODE,
    thresholdBytes,
    targetBytes,
    maxBytes,
  };
}

export function estimateClaudeMessagesBodyBytes(value: unknown): number {
  return estimateJsonBodyBytes(value);
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function clipStringBytes(text: string, maxBytes: number, suffix = TEXT_TRUNCATION_SUFFIX): string {
  if (maxBytes <= 0) return "";
  if (byteLength(text) <= maxBytes) return text;

  const suffixBytes = byteLength(suffix);
  if (suffixBytes >= maxBytes) {
    return suffix.slice(0, Math.max(0, maxBytes));
  }

  const contentBudget = maxBytes - suffixBytes;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (byteLength(text.slice(0, mid)) <= contentBudget) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  let end = low;
  const wordBoundary = text.lastIndexOf(" ", end);
  if (wordBoundary > contentBudget * 0.5) end = wordBoundary;
  if (end > 0) {
    const code = text.charCodeAt(end - 1);
    if ((code >= 0xd800 && code <= 0xdbff) || (code >= 0xdc00 && code <= 0xdfff)) end--;
  }
  return text.slice(0, Math.max(0, end)).trimEnd() + suffix;
}

function pruneSchemaValue(value: unknown, descriptionBytes: number): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => pruneSchemaValue(item, descriptionBytes));
  }
  if (!isRecord(value)) return value;

  const next: JsonRecord = {};
  for (const [key, item] of Object.entries(value)) {
    if (DESCRIPTION_DROP_KEYS.has(key)) continue;
    if (key === "description" && typeof item === "string") {
      if (descriptionBytes > 0) {
        next[key] = clipStringBytes(item, descriptionBytes);
      }
      continue;
    }
    next[key] = pruneSchemaValue(item, descriptionBytes);
  }
  return next;
}

function compactTools(body: JsonRecord, descriptionBytes: number): JsonRecord {
  if (!Array.isArray(body.tools)) return body;
  const tools = body.tools.map((tool) => {
    if (!isRecord(tool)) return tool;
    const next: JsonRecord = { ...tool };
    if (typeof next.description === "string") {
      if (descriptionBytes > 0) {
        next.description = clipStringBytes(next.description, descriptionBytes);
      } else {
        delete next.description;
      }
    }
    if (next.input_schema !== undefined) {
      next.input_schema = pruneSchemaValue(next.input_schema, descriptionBytes);
    }
    return next;
  });
  return { ...body, tools };
}

function clipTextPart(part: JsonRecord, key: "text" | "content", limitBytes: number): JsonRecord {
  const value = part[key];
  if (typeof value !== "string") return part;
  return { ...part, [key]: clipStringBytes(value, limitBytes) };
}

function compactMessageContent(
  content: unknown,
  textLimitBytes: number,
  toolResultLimitBytes: number
): unknown {
  if (typeof content === "string") {
    return clipStringBytes(content, textLimitBytes);
  }
  if (!Array.isArray(content)) return content;

  return content.map((part) => {
    if (!isRecord(part)) return part;
    if (part.type === "text") return clipTextPart(part, "text", textLimitBytes);
    if (part.type === "tool_result") return clipTextPart(part, "content", toolResultLimitBytes);
    return part;
  });
}

function compactMessages(
  body: JsonRecord,
  oldTextLimitBytes: number,
  latestTextLimitBytes: number,
  oldToolResultLimitBytes: number
): JsonRecord {
  if (!Array.isArray(body.messages)) return body;
  const latestUserIndex = findLatestUserMessageIndex(body.messages);
  const messages = body.messages.map((message, index) => {
    if (!isRecord(message)) return message;
    const isLatestUser = index === latestUserIndex;
    return {
      ...message,
      content: compactMessageContent(
        message.content,
        isLatestUser ? latestTextLimitBytes : oldTextLimitBytes,
        isLatestUser ? latestTextLimitBytes : oldToolResultLimitBytes
      ),
    };
  });
  return { ...body, messages };
}

function hasToolResultContent(message: unknown): boolean {
  if (!isRecord(message) || !Array.isArray(message.content)) return false;
  return message.content.some((part) => isRecord(part) && part.type === "tool_result");
}

function isSafeUserTailStart(message: unknown): boolean {
  return isRecord(message) && message.role === "user" && !hasToolResultContent(message);
}

function findLatestUserMessageIndex(messages: unknown[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (isRecord(message) && message.role === "user") return index;
  }
  return messages.length - 1;
}

function findLatestSafeUserMessageIndex(messages: unknown[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (isSafeUserTailStart(messages[index])) return index;
  }
  return findLatestUserMessageIndex(messages);
}

function keepLatestUserOnly(body: JsonRecord, latestTextLimitBytes: number): JsonRecord {
  if (!Array.isArray(body.messages) || body.messages.length === 0) return body;
  const latestUserIndex = findLatestSafeUserMessageIndex(body.messages);
  const latest = body.messages[latestUserIndex];
  if (!isRecord(latest)) return body;
  return {
    ...body,
    messages: [
      {
        role: "user",
        content: compactMessageContent(latest.content, latestTextLimitBytes, latestTextLimitBytes),
      },
    ],
  };
}

function compactOneTailMessage(
  message: unknown,
  isLatestUser: boolean,
  oldTextLimitBytes: number,
  latestTextLimitBytes: number,
  oldToolResultLimitBytes: number
): unknown {
  if (!isRecord(message)) return message;
  return {
    ...message,
    content: compactMessageContent(
      message.content,
      isLatestUser ? latestTextLimitBytes : oldTextLimitBytes,
      isLatestUser ? latestTextLimitBytes : oldToolResultLimitBytes
    ),
  };
}

function keepRecentMessagesWithinBudget(
  body: JsonRecord,
  targetBytes: number,
  oldTextLimitBytes: number,
  latestTextLimitBytes: number,
  oldToolResultLimitBytes: number
): JsonRecord {
  if (!Array.isArray(body.messages) || body.messages.length === 0) return body;

  const latestUserIndex = findLatestUserMessageIndex(body.messages);
  const base = { ...body, messages: [] };
  const baseBytes = estimateClaudeMessagesBodyBytes(base);
  const kept: unknown[] = [];
  let usedBytes = baseBytes;

  for (let index = body.messages.length - 1; index >= 0; index--) {
    const message = compactOneTailMessage(
      body.messages[index],
      index === latestUserIndex,
      oldTextLimitBytes,
      latestTextLimitBytes,
      oldToolResultLimitBytes
    );
    const messageBytes = estimateClaudeMessagesBodyBytes(message) + (kept.length > 0 ? 1 : 0);
    if (usedBytes + messageBytes > targetBytes) break;
    kept.unshift(message);
    usedBytes += messageBytes;
  }

  while (kept.length > 1 && !isSafeUserTailStart(kept[0])) {
    kept.shift();
  }

  if (kept.length === 0 || !isSafeUserTailStart(kept[0])) {
    return keepLatestUserOnly(body, latestTextLimitBytes);
  }
  return { ...body, messages: kept };
}

function countArray(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function buildStats(
  original: JsonRecord,
  current: JsonRecord,
  originalBytes: number,
  targetBytes: number,
  stagesApplied: string[]
): ClaudeMessagesVccStats {
  return {
    originalBytes,
    compactedBytes: estimateClaudeMessagesBodyBytes(current),
    targetBytes,
    messagesBefore: countArray(original.messages),
    messagesAfter: countArray(current.messages),
    toolsBefore: countArray(original.tools),
    toolsAfter: countArray(current.tools),
    stagesApplied,
  };
}

export function compactClaudeMessagesBody<T = unknown>(
  body: T,
  options: { targetBytes?: number } = {}
): ClaudeMessagesVccResult<T | JsonRecord> {
  const targetBytes = Math.max(MIN_TARGET_BYTES, options.targetBytes ?? DEFAULT_TARGET_BYTES);
  if (!isRecord(body)) {
    return {
      body,
      compacted: false,
      stats: {
        originalBytes: estimateClaudeMessagesBodyBytes(body),
        compactedBytes: estimateClaudeMessagesBodyBytes(body),
        targetBytes,
        messagesBefore: 0,
        messagesAfter: 0,
        toolsBefore: 0,
        toolsAfter: 0,
        stagesApplied: [],
      },
    };
  }

  const original = body;
  const originalBytes = estimateClaudeMessagesBodyBytes(original);
  let current: JsonRecord = original;
  const stagesApplied: string[] = [];
  const underBudget = () => estimateClaudeMessagesBodyBytes(current) <= targetBytes;

  if (underBudget()) {
    return {
      body: current,
      compacted: false,
      stats: buildStats(original, current, originalBytes, targetBytes, []),
    };
  }

  const applyStage = (name: string, next: JsonRecord): boolean => {
    current = next;
    stagesApplied.push(name);
    return underBudget();
  };

  if (applyStage("tool-schema-prune-512", compactTools(current, 512))) {
    return {
      body: current,
      compacted: true,
      stats: buildStats(original, current, originalBytes, targetBytes, stagesApplied),
    };
  }
  if (applyStage("old-context-8k", compactMessages(current, 8 * 1024, 64 * 1024, 8 * 1024))) {
    return {
      body: current,
      compacted: true,
      stats: buildStats(original, current, originalBytes, targetBytes, stagesApplied),
    };
  }
  if (applyStage("tool-schema-prune-160", compactTools(current, 160))) {
    return {
      body: current,
      compacted: true,
      stats: buildStats(original, current, originalBytes, targetBytes, stagesApplied),
    };
  }
  if (applyStage("old-context-2k", compactMessages(current, 2 * 1024, 32 * 1024, 2 * 1024))) {
    return {
      body: current,
      compacted: true,
      stats: buildStats(original, current, originalBytes, targetBytes, stagesApplied),
    };
  }
  if (applyStage("tool-schema-drop-descriptions", compactTools(current, 0))) {
    return {
      body: current,
      compacted: true,
      stats: buildStats(original, current, originalBytes, targetBytes, stagesApplied),
    };
  }
  if (applyStage("old-context-512", compactMessages(current, 512, 16 * 1024, 512))) {
    return {
      body: current,
      compacted: true,
      stats: buildStats(original, current, originalBytes, targetBytes, stagesApplied),
    };
  }
  if (
    applyStage(
      "recent-tail-fit",
      keepRecentMessagesWithinBudget(current, targetBytes, 512, 16 * 1024, 512)
    )
  ) {
    return {
      body: current,
      compacted: true,
      stats: buildStats(original, current, originalBytes, targetBytes, stagesApplied),
    };
  }
  if (applyStage("latest-user-only", keepLatestUserOnly(current, 8 * 1024))) {
    return {
      body: current,
      compacted: true,
      stats: buildStats(original, current, originalBytes, targetBytes, stagesApplied),
    };
  }

  return {
    body: current,
    compacted: current !== original,
    stats: buildStats(original, current, originalBytes, targetBytes, stagesApplied),
  };
}

export function applyClaudeMessagesLargeRequestMode<T = unknown>(
  request: HeaderReadableRequest,
  pathname: string,
  body: T,
  options: { config?: ClaudeLargeMessagesConfig; settings?: Record<string, unknown> | null } = {}
): ClaudeLargeRequestModeResult<T | JsonRecord> {
  const config = options.config ?? resolveClaudeLargeMessagesConfig(process.env, options.settings);
  if (!isClaudeMessagesPath(pathname)) {
    return { body, rejection: null, compacted: false, stats: null, assessment: null, config };
  }

  const declaredBytes = getDeclaredContentLengthBytes(request);
  if (config.mode === "vcc" && declaredBytes !== null && declaredBytes > config.maxBytes) {
    return {
      body,
      rejection: createPayloadTooLargeResponse(
        `Claude-format request too large for VCC mode. Maximum allowed: ${formatBytes(config.maxBytes)}`
      ),
      compacted: false,
      stats: null,
      assessment: null,
      config,
    };
  }

  const assessment = assessClaudeMessagesBodySize(request, pathname, body, config.thresholdBytes);
  if (!assessment?.oversized) {
    return { body, rejection: null, compacted: false, stats: null, assessment, config };
  }

  if (config.mode !== "vcc") {
    return {
      body,
      rejection: createPayloadTooLargeResponse(
        assessment.message ?? "Claude-format request too large"
      ),
      compacted: false,
      stats: null,
      assessment,
      config,
    };
  }

  const result = compactClaudeMessagesBody(body, { targetBytes: config.targetBytes });
  if (result.stats.compactedBytes > config.maxBytes) {
    return {
      body: result.body,
      rejection: createPayloadTooLargeResponse(
        `Claude-format request remains too large after VCC compaction. Maximum allowed: ${formatBytes(config.maxBytes)}`
      ),
      compacted: result.compacted,
      stats: result.stats,
      assessment,
      config,
    };
  }
  if (result.stats.compactedBytes > config.targetBytes) {
    return {
      body: result.body,
      rejection: createPayloadTooLargeResponse(
        `Claude-format request could not be compacted below the VCC target (${formatBytes(config.targetBytes)}).`
      ),
      compacted: result.compacted,
      stats: result.stats,
      assessment,
      config,
    };
  }

  return {
    body: result.body,
    rejection: null,
    compacted: result.compacted,
    stats: result.stats,
    assessment,
    config,
  };
}
