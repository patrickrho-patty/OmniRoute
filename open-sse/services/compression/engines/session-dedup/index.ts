/**
 * session-dedup compression engine (R11 / N2 / TO1)
 *
 * Content-addressed cross-turn deduplication, inspired by the TokenMizer
 * session-graph + line-dedup blueprint (arXiv 2606.06337) and sqz prior-art.
 *
 * Algorithm (two-pass, suffix-block content-addressed):
 *   Pass 1 — scan all non-system messages. For each message, enumerate suffix
 *             line blocks (lines[start..end-of-message]) that meet minBlockChars
 *             and minBlockLines. Hash each block. Record the first message that
 *             owns each hash.
 *   Pass 2 — for each non-system message (index i), find blocks whose hash was
 *             first seen in a STRICTLY EARLIER message (index j < i). Replace the
 *             LONGEST such block's text with `[dedup:ref sha=<8hex>]`.
 *             First occurrence is always kept intact.
 *
 * Greedy, longest-first replacement: sort duplicate blocks by length descending;
 * replace the longest block first so shorter overlapping candidates are skipped.
 *
 * Conservative guards:
 *   - Never touch `role: "system"`.
 *   - Never touch multipart content parts other than `type: "text"`.
 *   - Only dedup blocks ≥ minBlockChars (default 80 chars) AND ≥ MIN_BLOCK_LINES lines.
 *   - First occurrence is ALWAYS kept intact; only later identical occurrences are replaced.
 *   - Never rewrite the current turn (messages after the last assistant message): the
 *     model must see what it just read or was just sent. It is deduped on a later turn.
 *
 * Reconstruction:
 *   Replace every `[dedup:ref sha=XXXXXXXX]` marker with the original block text
 *   from the reverse map attached as `__sessionDedupMap__` on the body object.
 */

import crypto from "node:crypto";
import { createCompressionStats } from "../../stats.ts";
import { canonicalize } from "../../incremental/messageHash.ts";
import { runFuzzyPass } from "./fuzzy.ts";
import { dedupMessageTexts } from "./suffixDedup.ts";
import { memoKey } from "../../incremental/types.ts";
import type { IncrementalContext } from "../../incremental/types.ts";
import { callerSupportsCcrRetrieve } from "../ccr/protocolInstruction.ts";
import type {
  CompressionEngine,
  CompressionEngineApplyOptions,
  EngineConfigField,
  EngineValidationResult,
} from "../types.ts";
import type { CompressionResult } from "../../types.ts";

// ─── constants ────────────────────────────────────────────────────────────────

const ENGINE_ID = "session-dedup";
/** Minimum block character count to be a dedup candidate. */
const DEFAULT_MIN_BLOCK_CHARS = 80;
/**
 * Per-message key namespace for the dedup `msgIdx`: string content uses `i*MSG_KEY_STRIDE`,
 * multipart text part `p` uses `i*MSG_KEY_STRIDE + p + 1`. One stride per message keeps the
 * two shapes from colliding while preserving message ORDER (an earlier message always has a
 * strictly smaller key), which both the suffix index's owner comparison and
 * {@link currentTurnStartIndex} rely on. Recover the message index with
 * `Math.floor(key / MSG_KEY_STRIDE)`.
 */
const MSG_KEY_STRIDE = 100000;

/**
 * First message index that belongs to the CURRENT TURN — everything after the last assistant
 * message. Upstream rule: the current turn is never rewritten, because an agent that re-reads
 * a file it already read would get `[dedup:ref sha=...]` back, conclude the read was lost and
 * read it again. `0` means "no assistant turn in this body yet", so nothing lies outside the
 * current turn and no cross-message replacement may be applied — the intra-message pass above
 * is the only dedup such a body gets.
 */
function currentTurnStartIndex(messages: MessageLike[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return i + 1;
  }
  return 0;
}

/**
 * Drop the replacements that belong to the current turn (keys are `i*MSG_KEY_STRIDE(+p+1)`,
 * so the message index is `floor(key / MSG_KEY_STRIDE)`). Copy-on-write: the common case —
 * nothing in the current turn — returns the input map unchanged.
 */
function withoutCurrentTurnReplacements(
  deduped: Map<number, string>,
  currentTurnStart: number
): Map<number, string> {
  let filtered: Map<number, string> | null = null;
  for (const key of deduped.keys()) {
    if (Math.floor(key / MSG_KEY_STRIDE) >= currentTurnStart) {
      filtered ??= new Map(deduped);
      filtered.delete(key);
    }
  }
  return filtered ?? deduped;
}

// Cross-message suffix dedup is implemented in ./suffixDedup.ts (single-pass, O(n)).
// `dedupMessageTexts` preserves the exact external contract of the previous O(n²)
// implementation (longest-suffix match, first-occurrence kept, reversible markers).
//
// What is NOT in suffixDedup.ts: **intra-message** dedup (a block repeated inside ONE
// message). The suffix index can never see it — an intra-message repetition has no
// EARLIER owner — so it is handled by the literal-scan pass below, retained from upstream
// (#6467 + the literal-scan fix that replaced the `new RegExp(block)` calls). It is
// reached only for a single non-system text message; every multi-message body goes through
// the O(n) suffix core.

// ─── intra-message dedup: retained from upstream (#6467) ─────────────────────

/** Minimum number of lines a block must span to be a dedup candidate. */
const MIN_BLOCK_LINES = 3;
/**
 * O(n²) guard for {@link findSuffixBlocks} (OOM incident): a single message with
 * thousands of lines otherwise generates one full-length suffix string PER line,
 * all retained at once. A real agent conversation embedding a large
 * line-numbered file view (e.g. a tool result pasting a multi-thousand-line
 * file back into the chat) drove ~1.7GB of live suffix strings and OOM-killed
 * the 2GB heap (heap snapshot confirmed 6801 `{ block }` objects). These bound
 * both the number of suffix starts scanned
 * and the total bytes of retained blocks, so memory is O(budget) instead of O(n²).
 * Dedup is best-effort — skipping the tail only forgoes some compression, never
 * changes output correctness.
 */
const MAX_SUFFIX_STARTS = 2000;
const MAX_TOTAL_BLOCK_BYTES = 8 * 1024 * 1024;

// ─── hash helper (SHA-256 prefix, collision-resistant) ───────────────────────

function hashBlock(text: string): string {
  // 24 hex / 96 bits — collision-resistant (a 32-bit djb2 could collide and make a
  // dedup marker reference the WRONG block). Pass 2 additionally verifies block
  // equality before substituting, so a collision can never cause corruption.
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 24);
}

// ─── suffix-block extraction ──────────────────────────────────────────────────

/**
 * For each starting line position, emit the suffix block `lines[start..end]`
 * (i.e. from `start` to the end of the line array). This ensures that any
 * multiline sub-content that appears verbatim in multiple messages is discoverable
 * regardless of what text precedes it in each message.
 *
 * Only emits blocks that meet minBlockChars AND have at least MIN_BLOCK_LINES lines.
 * Uses a seen-set to deduplicate identical suffix blocks.
 */
function findSuffixBlocks(
  lines: string[],
  minBlockChars: number
): Array<{ block: string; startLine: number }> {
  const n = lines.length;
  const seen = new Set<string>();
  const results: Array<{ block: string; startLine: number }> = [];

  // O(n²) guard (#OOM): cap the number of suffix starts and the total retained
  // block bytes so a huge message can't materialize thousands of full-length
  // suffix strings at once. See MAX_SUFFIX_STARTS / MAX_TOTAL_BLOCK_BYTES.
  const maxStarts = Math.min(n, MAX_SUFFIX_STARTS);
  let totalBlockBytes = 0;
  for (let start = 0; start < maxStarts; start++) {
    const block = lines.slice(start).join("\n");
    const blockLines = n - start;
    if (blockLines >= MIN_BLOCK_LINES && block.length >= minBlockChars && !seen.has(block)) {
      seen.add(block);
      results.push({ block, startLine: start });
      totalBlockBytes += block.length;
      if (totalBlockBytes >= MAX_TOTAL_BLOCK_BYTES) break;
    }
  }
  return results;
}

/**
 * Deduplicates repeated lines within a single message (intra-message dedup).
 * Replaces repeated suffix blocks with markers.
 */
function countLiteralOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const idx = text.indexOf(needle, offset);
    if (idx === -1) return count;
    count++;
    offset = idx + needle.length;
  }
}

function replaceLiteralOccurrencesAfterFirst(
  text: string,
  needle: string,
  replacement: string
): string {
  if (!needle) return text;
  const first = text.indexOf(needle);
  if (first === -1) return text;

  let result = text.slice(0, first + needle.length);
  let offset = first + needle.length;

  while (true) {
    const idx = text.indexOf(needle, offset);
    if (idx === -1) {
      result += text.slice(offset);
      return result;
    }
    result += text.slice(offset, idx) + replacement;
    offset = idx + needle.length;
  }
}

function dedupeWithinMessage(
  text: string,
  minBlockChars: number
): { deduped: string; changed: boolean } {
  const lines = text.split("\n");
  const blocks = findSuffixBlocks(lines, minBlockChars);

  if (blocks.length < 2) return { deduped: text, changed: false };

  // Find the most common block (likely candidate for intra-message dedup).
  const blockFreq = new Map<string, number>();
  for (const { block } of blocks) {
    blockFreq.set(block, (blockFreq.get(block) || 0) + 1);
  }

  // Sort by frequency descending, then by length descending (prefer replacing more common, longer blocks first).
  const sortedBlocks = [...blocks].sort((a, b) => {
    const freqDiff = (blockFreq.get(b.block) || 0) - (blockFreq.get(a.block) || 0);
    return freqDiff !== 0 ? freqDiff : b.block.length - a.block.length;
  });

  let result = text;
  let changed = false;

  for (const { block } of sortedBlocks) {
    // Only dedup blocks that appear 2+ times in the text. Use literal indexOf
    // scanning instead of compiling the whole block into a RegExp: remembered
    // JSON/tool blobs can be hundreds of KB and V8 rejects such regex sources
    // with "Regular expression too large".
    const occurrences = countLiteralOccurrences(result, block);
    if (occurrences < 2) continue;

    const sha = hashBlock(block);
    const marker = `[dedup:ref sha=${sha}]`;
    // Replace ALL occurrences except the first (keep the original once).
    result = replaceLiteralOccurrencesAfterFirst(result, block, marker);
    changed = true;
  }

  return { deduped: result, changed };
}

// ─── end intra-message dedup (retained from upstream) ───────────────────────

// ─── message array processing ─────────────────────────────────────────────────

type MessageLike = {
  role?: string;
  content?: string | Array<Record<string, unknown>>;
  tool_call_id?: string;
  toolCallId?: string;
  toolName?: string;
  name?: string;
  tool_calls?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

type ToolResultLocation =
  | { kind: "openai"; msgIdx: number; toolCallId: string; toolName?: string }
  | { kind: "anthropic"; msgIdx: number; partIdx: number; toolCallId: string; toolName?: string }
  | { kind: "pi"; msgIdx: number; toolCallId: string; toolName?: string };

const DCP_PLACEHOLDER_PREFIX = "[dedup:duplicate-tool-result";
const DEFAULT_PROTECTED_TOOLS = new Set([
  "compress",
  "edit",
  "multi_edit",
  "write",
  "todo",
  "task",
  "skill",
]);

function stableToolArgs(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(canonicalize(JSON.parse(value)));
    } catch {
      return JSON.stringify(value);
    }
  }
  return JSON.stringify(canonicalize(value ?? {}));
}

function toolCallKey(name: string, input: unknown): string {
  return `${name}::${stableToolArgs(input)}`;
}

function protectedTools(stepConfig: Record<string, unknown>): Set<string> {
  const extra = Array.isArray(stepConfig["protectedTools"])
    ? (stepConfig["protectedTools"] as unknown[]).filter(
        (tool): tool is string => typeof tool === "string"
      )
    : [];
  return new Set([...DEFAULT_PROTECTED_TOOLS, ...extra]);
}

function extractToolNameFromOpenAiCall(call: Record<string, unknown>): string | undefined {
  const fn = call["function"];
  if (fn && typeof fn === "object" && typeof (fn as Record<string, unknown>)["name"] === "string") {
    return (fn as Record<string, unknown>)["name"] as string;
  }
  return typeof call["name"] === "string" ? (call["name"] as string) : undefined;
}

function extractToolArgsFromOpenAiCall(call: Record<string, unknown>): unknown {
  const fn = call["function"];
  if (fn && typeof fn === "object" && "arguments" in (fn as Record<string, unknown>)) {
    return (fn as Record<string, unknown>)["arguments"];
  }
  return call["input"] ?? call["arguments"] ?? {};
}

function buildToolCallIndex(
  messages: MessageLike[],
  protectedNames: Set<string>
): Map<string, { key: string; name: string }> {
  const index = new Map<string, { key: string; name: string }>();

  for (const msg of messages) {
    if (msg.role !== "assistant") continue;

    if (Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        const id = typeof call["id"] === "string" ? (call["id"] as string) : undefined;
        const name = extractToolNameFromOpenAiCall(call);
        if (!id || !name || protectedNames.has(name)) continue;
        index.set(id, { key: toolCallKey(name, extractToolArgsFromOpenAiCall(call)), name });
      }
    }

    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part["type"] !== "tool_use") continue;
        const id = typeof part["id"] === "string" ? (part["id"] as string) : undefined;
        const name = typeof part["name"] === "string" ? (part["name"] as string) : undefined;
        if (!id || !name || protectedNames.has(name)) continue;
        index.set(id, { key: toolCallKey(name, part["input"] ?? {}), name });
      }
    }
  }

  return index;
}

function collectToolResultLocations(
  messages: MessageLike[],
  protectedNames: Set<string>
): ToolResultLocation[] {
  const locations: ToolResultLocation[] = [];

  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];
    if (msg.role === "tool") {
      const toolCallId = typeof msg.tool_call_id === "string" ? msg.tool_call_id : undefined;
      const toolName = typeof msg.name === "string" ? msg.name : undefined;
      if (toolCallId && !protectedNames.has(toolName ?? "")) {
        locations.push({ kind: "openai", msgIdx, toolCallId, toolName });
      }
      continue;
    }

    if (msg.role === "toolResult") {
      const toolCallId = typeof msg.toolCallId === "string" ? msg.toolCallId : undefined;
      const toolName = typeof msg.toolName === "string" ? msg.toolName : undefined;
      if (toolCallId && !protectedNames.has(toolName ?? "")) {
        locations.push({ kind: "pi", msgIdx, toolCallId, toolName });
      }
      continue;
    }

    if (Array.isArray(msg.content)) {
      for (let partIdx = 0; partIdx < msg.content.length; partIdx++) {
        const part = msg.content[partIdx];
        if (part["type"] !== "tool_result") continue;
        const toolCallId =
          typeof part["tool_use_id"] === "string"
            ? (part["tool_use_id"] as string)
            : typeof part["id"] === "string"
              ? (part["id"] as string)
              : undefined;
        if (toolCallId) locations.push({ kind: "anthropic", msgIdx, partIdx, toolCallId });
      }
    }
  }

  return locations;
}

function isPlaceholderText(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(DCP_PLACEHOLDER_PREFIX);
}

function cloneMessagesForToolDedup(messages: MessageLike[]): MessageLike[] {
  return messages.map((msg) => {
    if (Array.isArray(msg.content))
      return { ...msg, content: msg.content.map((part) => ({ ...part })) };
    return { ...msg };
  });
}

function replaceToolResult(
  messages: MessageLike[],
  location: ToolResultLocation,
  reason: string
): boolean {
  const placeholder = `${DCP_PLACEHOLDER_PREFIX} ${reason}]`;
  const msg = messages[location.msgIdx];
  if (!msg) return false;

  if (location.kind === "openai") {
    if (isPlaceholderText(msg.content)) return false;
    msg.content = placeholder;
    return true;
  }

  if (location.kind === "pi") {
    const content = msg.content;
    if (Array.isArray(content)) {
      const first = content[0];
      if (first && first["type"] === "text" && isPlaceholderText(first["text"])) return false;
      msg.content = [{ type: "text", text: placeholder }];
    } else {
      if (isPlaceholderText(content)) return false;
      msg.content = placeholder;
    }
    delete msg["details"];
    return true;
  }

  if (!Array.isArray(msg.content)) return false;
  const part = msg.content[location.partIdx];
  if (!part) return false;
  if (isPlaceholderText(part["content"])) return false;
  part["content"] = placeholder;
  return true;
}

/**
 * DCP-style agent/session dedup: repeated tool calls with the same stable
 * `tool name + canonical args` keep their newest result and placeholder older results.
 * Tool call/result structure is preserved so providers don't see orphaned calls.
 */
function dedupToolResults(
  messages: MessageLike[],
  stepConfig: Record<string, unknown>
): { messages: MessageLike[]; dedupCount: number } {
  const protectedNames = protectedTools(stepConfig);
  const callIndex = buildToolCallIndex(messages, protectedNames);
  if (callIndex.size === 0) return { messages, dedupCount: 0 };

  const locations = collectToolResultLocations(messages, protectedNames);
  if (locations.length < 2) return { messages, dedupCount: 0 };

  let output: MessageLike[] | null = null;
  const seenKeys = new Set<string>();
  let dedupCount = 0;

  for (let i = locations.length - 1; i >= 0; i--) {
    const location = locations[i];
    const call = callIndex.get(location.toolCallId);
    if (!call) continue;
    if (!seenKeys.has(call.key)) {
      seenKeys.add(call.key);
      continue;
    }

    output ??= cloneMessagesForToolDedup(messages);
    if (replaceToolResult(output, location, `duplicate ${call.name} call`)) dedupCount++;
  }

  return { messages: output ?? messages, dedupCount };
}

/**
 * Process messages: collect text content, run the dedup passes, apply results. Cross-message
 * dedup is the single-pass O(n) suffix core (suffixDedup.ts); a body with one text message gets
 * the intra-message pass instead.
 */
function processMessages(
  messages: MessageLike[],
  minBlockChars: number
): { messages: MessageLike[]; dedupCount: number } {
  // Collect (msgIdx, text) for non-system content. Keys live in a per-message namespace of
  // MSG_KEY_STRIDE (100000) so string content (`i*MSG_KEY_STRIDE`) and multipart text parts
  // (`i*MSG_KEY_STRIDE + p + 1`) never collide across adjacent string/multipart messages,
  // while preserving message order (earlier messages keep strictly smaller keys, which the
  // dedup ordering relies on). The message index of a key is `floor(key / MSG_KEY_STRIDE)`.

  const msgTexts: Array<{ msgIdx: number; text: string }> = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "system") continue;
    if (typeof msg.content === "string") {
      msgTexts.push({ msgIdx: i * MSG_KEY_STRIDE, text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (let p = 0; p < msg.content.length; p++) {
        const part = msg.content[p];
        if (part["type"] === "text" && typeof part["text"] === "string") {
          msgTexts.push({ msgIdx: i * MSG_KEY_STRIDE + p + 1, text: part["text"] as string });
        }
      }
    }
  }

  if (msgTexts.length === 0) {
    return { messages, dedupCount: 0 };
  }

  // A single text message is the intra-message case: the only repetition it can contain is
  // inside itself, which the cross-message suffix index can never see. Upstream's literal-scan
  // pass handles it, and upstream's current-turn rule does not apply to it — the repetition is
  // inside the message the caller just sent, which is what the model must receive whole.
  if (msgTexts.length === 1) {
    const { msgIdx, text } = msgTexts[0];
    const intra = dedupeWithinMessage(text, minBlockChars);
    if (!intra.changed) return { messages, dedupCount: 0 };
    const single = new Map<number, string>([[msgIdx, intra.deduped]]);
    return {
      messages: messages.map((msg, i) => reassembleMessage(msg, i, single)),
      dedupCount: 1,
    };
  }

  // Cross-message dedup (single-pass O(n) suffix index — see suffixDedup.ts). Messages after
  // the last assistant message form the current turn: they are still FED to the index (their
  // blocks must become owners for a later turn) but the replacements proposed for them are
  // dropped. That is upstream's `messageIndex >= currentTurnStart` skip, expressed over the
  // fork's `i*MSG_KEY_STRIDE(+p+1)` key namespace instead of a second `messageIndex` field.
  const currentTurnStart = currentTurnStartIndex(messages);
  const { deduped: proposed } = dedupMessageTexts(msgTexts, minBlockChars);
  const deduped = withoutCurrentTurnReplacements(proposed, currentTurnStart);

  if (deduped.size === 0) {
    return { messages, dedupCount: 0 };
  }

  const result = messages.map((msg, i) => reassembleMessage(msg, i, deduped));

  return { messages: result, dedupCount: deduped.size };
}

/**
 * Apply the deduped-text replacements for one message, keyed by its array index `i`
 * (string content → `i*MSG_KEY_STRIDE`; multipart text part p → `i*MSG_KEY_STRIDE + p + 1`).
 * Returns a shallow-cloned message with markers substituted where present. Shared by the full
 * and incremental paths so they reassemble identically.
 */
function reassembleMessage(msg: MessageLike, i: number, deduped: Map<number, string>): MessageLike {
  if (msg.role === "system") return { ...msg };

  if (typeof msg.content === "string") {
    const replacement = deduped.get(i * MSG_KEY_STRIDE);
    return replacement !== undefined ? { ...msg, content: replacement } : { ...msg };
  }

  if (Array.isArray(msg.content)) {
    let changed = false;
    const newContent = msg.content.map((part, p) => {
      if (part["type"] !== "text" || typeof part["text"] !== "string") return part;
      const key = i * MSG_KEY_STRIDE + p + 1;
      const replacement = deduped.get(key);
      if (replacement !== undefined) {
        changed = true;
        return { ...part, text: replacement };
      }
      return part;
    });
    return changed ? { ...msg, content: newContent } : { ...msg };
  }

  return { ...msg };
}

/** A session-dedup memo entry: the message's compressed output + whether dedup changed it. */
type MemoizedMessage = { msg: MessageLike; changed: boolean };

/**
 * Whether the dedup substituted a marker for any text span of message `i` this turn — the
 * content-level "did this message change" signal (string key `i*MSG_KEY_STRIDE`; multipart
 * text part p key `i*MSG_KEY_STRIDE + p + 1`). Mirrors the keys reassembleMessage consumes.
 */
function messageWasDeduped(msg: MessageLike, i: number, deduped: Map<number, string>): boolean {
  if (typeof msg.content === "string") return deduped.has(i * MSG_KEY_STRIDE);
  if (Array.isArray(msg.content)) {
    return msg.content.some(
      (part, p) =>
        part["type"] === "text" &&
        typeof part["text"] === "string" &&
        deduped.has(i * MSG_KEY_STRIDE + p + 1)
    );
  }
  return false;
}

/**
 * Incremental dedup: process only messages not yet in the session memo (the new tail),
 * deduping them against the persistent cross-turn index (which already holds the prefix's
 * first-seen blocks). Cached prefix messages are pulled from the memo verbatim — their dedup
 * output is invariant because dedup only ever references EARLIER messages, and the prefix is
 * immutable. Output is byte-identical to a full run (enforced by the equivalence property test).
 */
function processMessagesIncremental(
  messages: MessageLike[],
  minBlockChars: number,
  ctx: IncrementalContext
): { messages: MessageLike[]; changedCount: number } {
  const cumulative = ctx.cumulativeByIndex;

  // Current-turn rule (upstream), shared with the full path: the messages after the last
  // assistant message are never rewritten. Their replacements are dropped below and their
  // memo entries are withheld — a current-turn message may become eligible next turn, so its
  // output is not yet a stable prefix value (the memo is only valid for an immutable prefix).
  const currentTurnStart = currentTurnStartIndex(messages);

  // Collect (msgIdx, text) ONLY for messages we haven't compressed before. Array index is the
  // msgIdx namespace base, identical across turns (append-only) so it matches the persistent
  // index's existing ownership.
  const newMsgTexts: Array<{ msgIdx: number; text: string }> = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "system") continue;
    const h = cumulative[i];
    if (h !== undefined && ctx.memo.has(memoKey(ENGINE_ID, h))) continue; // cached prefix
    if (typeof msg.content === "string") {
      newMsgTexts.push({ msgIdx: i * MSG_KEY_STRIDE, text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (let p = 0; p < msg.content.length; p++) {
        const part = msg.content[p];
        if (part["type"] === "text" && typeof part["text"] === "string") {
          newMsgTexts.push({ msgIdx: i * MSG_KEY_STRIDE + p + 1, text: part["text"] as string });
        }
      }
    }
  }

  // Dedup the new tail against the carried index (prefix blocks already registered there).
  // The index is fed EVERY new message (so current-turn blocks still become owners for a
  // later turn); only the current turn's replacements are dropped.
  const proposed =
    newMsgTexts.length > 0
      ? dedupMessageTexts(newMsgTexts, minBlockChars, ctx.dedupIndex).deduped
      : new Map<number, string>();
  const deduped = withoutCurrentTurnReplacements(proposed, currentTurnStart);

  let changedCount = 0;
  const result = messages.map((msg, i) => {
    if (msg.role === "system") return { ...msg };
    const h = cumulative[i];
    const key = h !== undefined ? memoKey(ENGINE_ID, h) : undefined;

    // Cached prefix message → reuse its stored output AND its real change flag.
    const cached = key ? (ctx.memo.get(key) as MemoizedMessage | undefined) : undefined;
    if (cached) {
      if (cached.changed) changedCount++;
      return cached.msg;
    }

    // New message → "changed" iff the dedup actually substituted a marker for it (a content-
    // level fact, not a cross-turn object-reference compare which is always true for multipart).
    const changed = messageWasDeduped(msg, i, deduped);
    const out = reassembleMessage(msg, i, deduped);
    // Only a message OUTSIDE the current turn has a position-stable output; memoizing a
    // current-turn message would freeze its un-replaced text forever (next turn it can no longer
    // be re-processed, so it could never pick up the replacement a full run would apply).
    if (key && i < currentTurnStart) ctx.memo.set(key, { msg: out, changed });
    if (changed) changedCount++;
    return out;
  });

  return { messages: result, changedCount };
}

/**
 * Number of non-system text entries in a body (string content, or `type: "text"` parts).
 * Fewer than 2 means the only dedup possible is INTRA-message, which lives in the full path.
 */
function countNonSystemTextEntries(messages: MessageLike[]): number {
  let count = 0;
  for (const msg of messages) {
    if (msg.role === "system") continue;
    if (typeof msg.content === "string") {
      count++;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part["type"] === "text" && typeof part["text"] === "string") count++;
      }
    }
  }
  return count;
}

// ─── schema & validation ──────────────────────────────────────────────────────

const SESSION_DEDUP_SCHEMA: EngineConfigField[] = [
  {
    key: "enabled",
    type: "boolean",
    label: "Enabled",
    defaultValue: true,
  },
  {
    key: "minBlockChars",
    type: "number",
    label: "Minimum block characters",
    description: "Minimum character count for a suffix block to be a dedup candidate.",
    defaultValue: DEFAULT_MIN_BLOCK_CHARS,
    min: 1,
    max: 100000,
  },
  {
    key: "fuzzy",
    type: "boolean",
    label: "Fuzzy near-duplicate dedup",
    description:
      "Opt-in: replace whole messages ~85%+ similar to an earlier one with a recoverable CCR marker.",
    defaultValue: false,
  },
];

function validateSessionDedupConfig(config: Record<string, unknown>): EngineValidationResult {
  const errors: string[] = [];
  if (config["enabled"] !== undefined && typeof config["enabled"] !== "boolean") {
    errors.push("enabled must be a boolean");
  }
  if (config["minBlockChars"] !== undefined) {
    const v = config["minBlockChars"];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 1) {
      errors.push("minBlockChars must be a positive number");
    }
  }
  if (config["fuzzy"] !== undefined) {
    const f = config["fuzzy"];
    if (typeof f === "object" && f !== null) {
      const fe = (f as Record<string, unknown>)["enabled"];
      if (fe !== undefined && typeof fe !== "boolean")
        errors.push("fuzzy.enabled must be a boolean");
    } else if (typeof f !== "boolean") {
      errors.push("fuzzy must be an object { enabled } or a boolean");
    }
  }
  return { valid: errors.length === 0, errors };
}

// ─── engine export ────────────────────────────────────────────────────────────

export const sessionDedupEngine: CompressionEngine = {
  id: ENGINE_ID,
  name: "Session Dedup",
  description:
    "Content-addressed cross-turn deduplication: replaces repeated multi-line blocks " +
    "with short reference markers (R11/N2/TO1, TokenMizer blueprint).",
  icon: "content_copy",
  targets: ["messages"],
  stackable: true,
  // stackPriority 3 = runs BEFORE lite (5), caveman (20), aggressive (30), ultra (40).
  // Dedup first so downstream engines operate on already-deduplicated content.
  stackPriority: 3,
  metadata: {
    id: ENGINE_ID,
    name: "Session Dedup",
    description:
      "Content-addressed cross-turn deduplication: replaces repeated multi-line blocks with short reference markers.",
    inputScope: "messages",
    targetLatencyMs: 1,
    supportsPreview: true,
    stable: true,
  },

  apply(body: Record<string, unknown>, options?: CompressionEngineApplyOptions): CompressionResult {
    const stepConfig = options?.stepConfig ?? {};

    if (stepConfig["enabled"] === false) {
      return { body, compressed: false, stats: null };
    }

    const minBlockChars =
      typeof stepConfig["minBlockChars"] === "number"
        ? (stepConfig["minBlockChars"] as number)
        : DEFAULT_MIN_BLOCK_CHARS;

    const messages = body["messages"];
    if (!Array.isArray(messages) || messages.length === 0) {
      return { body, compressed: false, stats: null };
    }

    // ── Incremental path ──────────────────────────────────────────────────────
    // When the incremental compressor supplies a per-session context (and fuzzy is off),
    // process only the new tail against the persistent index and reuse cached prefix output.
    // The length guard ensures the cumulative keys line up with this body 1:1; otherwise fall
    // back to the full path (always correct). A body with a single non-system text entry is the
    // intra-message case, which the incremental path does not implement — it always takes the
    // full path, so "incremental output ≡ full output" holds for that shape too.
    const ctx = options?.incremental;
    const fuzzyRaw = stepConfig["fuzzy"];
    const fuzzyOn =
      fuzzyRaw === true ||
      (typeof fuzzyRaw === "object" &&
        fuzzyRaw !== null &&
        (fuzzyRaw as Record<string, unknown>)["enabled"] === true);
    if (
      ctx &&
      !fuzzyOn &&
      Array.isArray(messages) &&
      countNonSystemTextEntries(messages as MessageLike[]) >= 2 &&
      Array.isArray(ctx.cumulativeByIndex) &&
      ctx.cumulativeByIndex.length === messages.length
    ) {
      const startInc = performance.now();
      const { messages: incMessages, changedCount } = processMessagesIncremental(
        messages as MessageLike[],
        minBlockChars,
        ctx
      );
      if (changedCount === 0) {
        return { body, compressed: false, stats: null };
      }
      const incBody: Record<string, unknown> = { ...body, messages: incMessages };
      const durationMs = Math.round(performance.now() - startInc);
      const stats = createCompressionStats(
        body,
        incBody,
        "stacked",
        ["session-dedup"],
        [`deduplicated-${changedCount}-blocks`],
        durationMs
      );
      return { body: incBody, compressed: true, stats };
    }

    const start = performance.now();
    const { messages: toolDedupMessages, dedupCount: toolResultDedupCount } = dedupToolResults(
      messages as MessageLike[],
      stepConfig
    );
    const { messages: exactMessages, dedupCount } = processMessages(
      toolDedupMessages,
      minBlockChars
    );

    const { messages: finalMessages, fuzzyCount } = runFuzzyPass(
      exactMessages,
      stepConfig,
      minBlockChars,
      options?.principalId,
      callerSupportsCcrRetrieve(body)
    );

    if (toolResultDedupCount + dedupCount + fuzzyCount === 0) {
      return { body, compressed: false, stats: null };
    }

    const newBody: Record<string, unknown> = { ...body, messages: finalMessages };
    const durationMs = Math.round(performance.now() - start);
    const techniques = ["session-dedup"];
    if (fuzzyCount > 0) techniques.push("fuzzy-dedup");
    const rules: string[] = [];
    if (toolResultDedupCount > 0) rules.push(`tool-deduplicated-${toolResultDedupCount}-results`);
    if (dedupCount > 0) rules.push(`deduplicated-${dedupCount}-blocks`);
    if (fuzzyCount > 0) rules.push(`fuzzy-${fuzzyCount}-blocks`);
    const stats = createCompressionStats(body, newBody, "stacked", techniques, rules, durationMs);
    return { body: newBody, compressed: true, stats };
  },

  compress(body: Record<string, unknown>, config?: Record<string, unknown>): CompressionResult {
    return this.apply(body, { stepConfig: config ?? {} });
  },

  getConfigSchema(): EngineConfigField[] {
    return SESSION_DEDUP_SCHEMA;
  },

  validateConfig(config: Record<string, unknown>): EngineValidationResult {
    return validateSessionDedupConfig(config);
  },
};
