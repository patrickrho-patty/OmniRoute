import { toRecord, type OpenAIToolCall, type RequestedToolName } from "./types.ts";

const TOOL_BLOCK_RE = /<tool>\s*([\s\S]*?)\s*<\/tool>/g;
const TOOL_CALL_TAG_RE = /<tool_call(?:\s+[^>]*)?\s*>\s*([\s\S]*?)\s*<\/tool_call>/g;
const OMNIROUTE_ACTION_TAG_RE =
  /<omniroute_action(?:\s+[^>]*)?\s*>\s*([\s\S]*?)\s*<\/omniroute_action>/g;
/** Fenced code blocks — ChatGPT's native envelope for JSON tool calls. Tolerates
 * uppercase language tags, CRLF, and a closing fence on the JSON line. */
const JSON_FENCE_RE = /```(?:json)?[^\S\n]*\r?\n([\s\S]*?)\r?\n?[^\S\n]*```/gi;

interface ToolParseCandidate {
  raw: string;
  start: number;
  end: number;
}

function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function getRequestedToolNames(tools: unknown): RequestedToolName[] {
  if (!Array.isArray(tools)) return [];
  const names: RequestedToolName[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    const toolRecord = toRecord(tool);
    if (toolRecord?.type !== "function") continue;
    const functionDefinition = toRecord(toolRecord?.function) ?? toolRecord;
    const name = typeof functionDefinition?.name === "string" ? functionDefinition.name.trim() : "";
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push({ original: name, normalized: normalizeToolName(name) });
  }
  return names;
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = Array<number>(b.length + 1);
  for (let index = 1; index <= a.length; index += 1) {
    current[0] = index;
    for (let otherIndex = 1; otherIndex <= b.length; otherIndex += 1) {
      const cost = a[index - 1] === b[otherIndex - 1] ? 0 : 1;
      current[otherIndex] = Math.min(
        current[otherIndex - 1] + 1,
        previous[otherIndex] + 1,
        previous[otherIndex - 1] + cost
      );
    }
    const temporary = previous;
    previous = current;
    current = temporary;
  }
  return previous[b.length];
}

/** Legacy provider adapters can opt into fuzzy name repair for malformed upstream output. */
export function resolveRequestedToolName(
  emitted: string,
  requestedTools: RequestedToolName[]
): string | null {
  if (requestedTools.length === 0) return emitted;
  const normalized = normalizeToolName(emitted);
  let best: { name: string; score: number } | null = null;
  let secondBest = 0;
  for (const requested of requestedTools) {
    const exact =
      emitted === requested.original ? 1 : normalized === requested.normalized ? 0.98 : 0;
    const distance =
      1 -
      levenshteinDistance(normalized, requested.normalized) /
        Math.max(normalized.length, requested.normalized.length, 1);
    const score = exact || (distance >= 0.72 ? distance : 0);
    if (!best || score > best.score) {
      secondBest = best?.score ?? 0;
      best = { name: requested.original, score };
    } else if (score > secondBest) {
      secondBest = score;
    }
  }
  if (!best || best.score < 0.72 || (best.score < 0.98 && best.score - secondBest < 0.08)) {
    return null;
  }
  return best.name;
}

function stripCodeFence(value: string): string {
  return value
    .trim()
    .replace(/^```(?:json|javascript|js|python)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function convertSingleQuotedStrings(value: string): string {
  let result = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      result += character === '"' && inSingle ? '\\"' : character;
      escaped = false;
    } else if (character === "\\") {
      result += character;
      escaped = true;
    } else if (character === '"') {
      inDouble = !inSingle && !inDouble;
      result += inSingle ? '\\"' : character;
    } else if (character === "'" && !inDouble) {
      inSingle = !inSingle;
      result += '"';
    } else {
      result += character;
    }
  }
  return result;
}

function normalizeLooseJson(value: string): string {
  return convertSingleQuotedStrings(value)
    .replace(/\bTrue\b/g, "true")
    .replace(/\bFalse\b/g, "false")
    .replace(/\bNone\b/g, "null")
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)/g, '$1"$2"$3')
    .replace(/,\s*([}\]])/g, "$1");
}

export function parseLooseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = stripCodeFence(raw);
  try {
    return toRecord(JSON.parse(trimmed));
  } catch {
    // fall through to the normalized form
  }
  try {
    return toRecord(JSON.parse(normalizeLooseJson(trimmed)));
  } catch {
    return null;
  }
}

/**
 * Parse a candidate payload that may be a single call object or an array of
 * call objects. Returns the object records; non-object elements are dropped.
 * The loose-normalized form is only computed when the strict parse fails.
 */
function parseJsonCallRecords(raw: string): Array<Record<string, unknown>> {
  const trimmed = stripCodeFence(raw);
  const attempts: string[] = [trimmed];
  const pushRecords = (parsed: unknown): Array<Record<string, unknown>> => {
    if (Array.isArray(parsed)) {
      return parsed.flatMap((item) => {
        const record = toRecord(item);
        return record ? [record] : [];
      });
    }
    const record = toRecord(parsed);
    return record ? [record] : [];
  };
  for (let index = 0; index < attempts.length + 1; index += 1) {
    const source = index < attempts.length ? attempts[index] : normalizeLooseJson(trimmed);
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      continue;
    }
    const records = pushRecords(parsed);
    if (records.length > 0) return records;
  }
  return [];
}

export function stripRanges(text: string, ranges: Array<{ start: number; end: number }>): string {
  let content = text;
  for (const range of [...ranges].sort((a, b) => b.start - a.start)) {
    const lineStart = content.lastIndexOf("\n", range.start - 1) + 1;
    const nextLineBreak = content.indexOf("\n", range.end);
    const lineEnd = nextLineBreak === -1 ? content.length : nextLineBreak;
    const removeWholeLine =
      content.slice(lineStart, range.start).trim() === "" &&
      content.slice(range.end, lineEnd).trim() === "";
    const start = removeWholeLine ? lineStart : range.start;
    const end =
      removeWholeLine && nextLineBreak !== -1
        ? nextLineBreak + 1
        : removeWholeLine
          ? lineEnd
          : range.end;
    content = `${content.slice(0, start)}${content.slice(end)}`;
  }
  return content.replace(/\n{3,}/g, "\n\n").trim();
}

export function toArgumentsString(value: unknown): string {
  if (value === undefined) return "{}";
  if (typeof value === "string") {
    const parsed = parseLooseJsonObject(value);
    return parsed ? JSON.stringify(parsed) : "";
  }
  return toRecord(value) ? JSON.stringify(value) : "";
}

/**
 * Accept a parsed candidate payload as a tool call when it carries a usable
 * name (declared when a tool list is enforced) and parseable arguments.
 * Extra fields the model adds (type, call_id, ...) are ignored — EXCEPT the
 * tool_result envelope: that is host→model traffic taught by the contract
 * example and the replay, and a model echoing it back must not become a
 * phantom call with empty arguments.
 */
function acceptCallPayload(
  payload: Record<string, unknown>,
  declaredNames: Set<string>
): { name: string; arguments: string } | null {
  if (payload.type === "tool_result") return null;
  if (payload.arguments === undefined && payload.output !== undefined) return null;
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  const argumentsString = toArgumentsString(payload.arguments);
  if (!name || !argumentsString) return null;
  if (declaredNames.size > 0 && !declaredNames.has(name)) return null;
  return { name, arguments: argumentsString };
}

function collectTagCandidates(text: string): ToolParseCandidate[] {
  const candidates: ToolParseCandidate[] = [];
  for (const expression of [TOOL_BLOCK_RE, TOOL_CALL_TAG_RE, OMNIROUTE_ACTION_TAG_RE]) {
    expression.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = expression.exec(text)) !== null) {
      candidates.push({ raw: match[1].trim(), start: match.index, end: expression.lastIndex });
    }
  }
  return candidates;
}

function collectFenceCandidates(text: string): ToolParseCandidate[] {
  const candidates: ToolParseCandidate[] = [];
  JSON_FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = JSON_FENCE_RE.exec(text)) !== null) {
    candidates.push({ raw: match[1].trim(), start: match.index, end: JSON_FENCE_RE.lastIndex });
  }
  return candidates;
}

function decodeWholeBodyJson(
  text: string,
  declaredNames: Set<string>
): Array<{ name: string; arguments: string }> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[") && !trimmed.startsWith("```")) {
    return null;
  }
  const records = parseJsonCallRecords(trimmed);
  if (records.length === 0) return null;
  const calls = records.flatMap((record) => {
    const accepted = acceptCallPayload(record, declaredNames);
    return accepted ? [accepted] : [];
  });
  // All-or-nothing: a whole-body reply must consist solely of tool calls,
  // otherwise it is prose that merely contains JSON-shaped content.
  return calls.length === records.length && calls.length > 0 ? calls : null;
}

export function decodeExplicitWebToolCalls(
  text: string,
  idSeed = "call",
  requestedTools?: unknown,
  options: { fences?: boolean } = {}
): { content: string; toolCalls: OpenAIToolCall[] | null } {
  if (typeof text !== "string" || !text.trim()) {
    return { content: text ?? "", toolCalls: null };
  }
  // Fenced/bare JSON decoding is enabled only for providers whose contract
  // teaches that envelope (chatgpt-web). Tag-contract providers must not have
  // an incidental ```json example in prose upgraded into an executed call.
  const decodeJson = options.fences === true;
  const declaredNames = new Set(getRequestedToolNames(requestedTools).map((tool) => tool.original));

  // Pass 1 — tag-delimited blocks (legacy providers) +, when enabled, fenced
  // JSON blocks (ChatGPT's native envelope). Both carry explicit ranges.
  const candidates = [
    ...collectTagCandidates(text),
    ...(decodeJson ? collectFenceCandidates(text) : []),
  ];
  candidates.sort((a, b) => a.start - b.start);

  const toolCalls: OpenAIToolCall[] = [];
  const acceptedRanges: Array<{ start: number; end: number }> = [];
  for (const candidate of candidates) {
    // Skip candidates contained in an already-accepted range (e.g. a fence
    // nested inside a <tool> tag) so one emission can never decode twice.
    if (
      acceptedRanges.some((range) => candidate.start >= range.start && candidate.end <= range.end)
    ) {
      continue;
    }
    const records = parseJsonCallRecords(candidate.raw);
    // All-or-nothing per candidate: a wrapper holding several records is only
    // consumed when EVERY record is an acceptable call — partial acceptance
    // would silently delete undeclared records from the user-visible content.
    if (records.length === 0) continue;
    const accepted = records.flatMap((record) => {
      const call = acceptCallPayload(record, declaredNames);
      return call ? [call] : [];
    });
    if (accepted.length !== records.length) continue;
    for (const call of accepted) {
      toolCalls.push({
        id: `${idSeed}_${toolCalls.length}`,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      });
    }
    acceptedRanges.push({ start: candidate.start, end: candidate.end });
  }
  if (toolCalls.length > 0) {
    return { content: stripRanges(text, acceptedRanges), toolCalls };
  }

  if (!decodeJson) {
    return { content: text, toolCalls: null };
  }

  // Pass 2 (JSON providers only) — the entire reply is bare JSON: a single
  // call, an array of calls, or one call object per line.
  const wholeBodyCalls = decodeWholeBodyJson(text, declaredNames);
  if (wholeBodyCalls) {
    return {
      content: "",
      toolCalls: wholeBodyCalls.map((call, index) => ({
        id: `${idSeed}_${index}`,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  const lines = trimmedLines(text);
  if (lines.length > 1 && lines.every((line) => line.startsWith("{"))) {
    const perLine = lines.flatMap((line) => parseJsonCallRecords(line));
    if (perLine.length === lines.length) {
      const calls = perLine.flatMap((record) => {
        const accepted = acceptCallPayload(record, declaredNames);
        return accepted ? [accepted] : [];
      });
      if (calls.length === perLine.length && calls.length > 0) {
        return {
          content: "",
          toolCalls: calls.map((call, index) => ({
            id: `${idSeed}_${index}`,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          })),
        };
      }
    }
  }

  return { content: text, toolCalls: null };
}

function trimmedLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
