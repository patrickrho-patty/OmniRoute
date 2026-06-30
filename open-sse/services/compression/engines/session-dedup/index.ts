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
 *
 * Reconstruction:
 *   Replace every `[dedup:ref sha=XXXXXXXX]` marker with the original block text
 *   from the reverse map attached as `__sessionDedupMap__` on the body object.
 */

import { createCompressionStats } from "../../stats.ts";
import { runFuzzyPass } from "./fuzzy.ts";
import { dedupMessageTexts } from "./suffixDedup.ts";
import { memoKey } from "../../incremental/types.ts";
import type { IncrementalContext } from "../../incremental/types.ts";
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

// Cross-message suffix dedup is implemented in ./suffixDedup.ts (single-pass, O(n)).
// `dedupMessageTexts` preserves the exact external contract of the previous O(n²)
// implementation (longest-suffix match, first-occurrence kept, reversible markers).

// ─── message array processing ─────────────────────────────────────────────────

type MessageLike = {
  role?: string;
  content?: string | Array<Record<string, unknown>>;
  [key: string]: unknown;
};

/**
 * Process messages: collect text content, run two-pass dedup, apply results.
 */
function processMessages(
  messages: MessageLike[],
  minBlockChars: number
): { messages: MessageLike[]; dedupCount: number } {
  // Collect (msgIdx, text) for non-system content. Keys live in a per-message namespace of
  // 100000 so string content (`i*100000`) and multipart text parts (`i*100000 + p + 1`)
  // never collide across adjacent string/multipart messages, while preserving message order
  // (earlier messages keep strictly smaller keys, which the dedup ordering relies on).
  const msgTexts: Array<{ msgIdx: number; text: string }> = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "system") continue;
    if (typeof msg.content === "string") {
      msgTexts.push({ msgIdx: i * 100000, text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (let p = 0; p < msg.content.length; p++) {
        const part = msg.content[p];
        if (part["type"] === "text" && typeof part["text"] === "string") {
          msgTexts.push({ msgIdx: i * 100000 + p + 1, text: part["text"] as string });
        }
      }
    }
  }

  if (msgTexts.length < 2) {
    return { messages, dedupCount: 0 };
  }

  const { deduped, dedupCount } = dedupMessageTexts(msgTexts, minBlockChars);

  if (dedupCount === 0) {
    return { messages, dedupCount: 0 };
  }

  const result = messages.map((msg, i) => reassembleMessage(msg, i, deduped));

  return { messages: result, dedupCount };
}

/**
 * Apply the deduped-text replacements for one message, keyed by its array index `i`
 * (string content → `i*100000`; multipart text part p → `i*100000 + p + 1`). Returns a
 * shallow-cloned message with markers substituted where present. Shared by the full and
 * incremental paths so they reassemble identically.
 */
function reassembleMessage(msg: MessageLike, i: number, deduped: Map<number, string>): MessageLike {
  if (msg.role === "system") return { ...msg };

  if (typeof msg.content === "string") {
    const replacement = deduped.get(i * 100000);
    return replacement !== undefined ? { ...msg, content: replacement } : { ...msg };
  }

  if (Array.isArray(msg.content)) {
    let changed = false;
    const newContent = msg.content.map((part, p) => {
      if (part["type"] !== "text" || typeof part["text"] !== "string") return part;
      const key = i * 100000 + p + 1;
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
      newMsgTexts.push({ msgIdx: i * 100000, text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (let p = 0; p < msg.content.length; p++) {
        const part = msg.content[p];
        if (part["type"] === "text" && typeof part["text"] === "string") {
          newMsgTexts.push({ msgIdx: i * 100000 + p + 1, text: part["text"] as string });
        }
      }
    }
  }

  // Dedup the new tail against the carried index (prefix blocks already registered there).
  const deduped =
    newMsgTexts.length > 0
      ? dedupMessageTexts(newMsgTexts, minBlockChars, ctx.dedupIndex).deduped
      : new Map<number, string>();

  let changedCount = 0;
  const result = messages.map((msg, i) => {
    if (msg.role === "system") return { ...msg };
    const h = cumulative[i];
    const key = h !== undefined ? memoKey(ENGINE_ID, h) : undefined;

    // Cached prefix message → reuse its stored output verbatim.
    if (key && ctx.memo.has(key)) {
      const cached = ctx.memo.get(key) as MessageLike;
      if (cached.content !== msg.content) changedCount++;
      return cached;
    }

    // New message → reassemble from this turn's dedup, then memoise for future turns.
    const out = reassembleMessage(msg, i, deduped);
    if (key) ctx.memo.set(key, out);
    if (out.content !== msg.content) changedCount++;
    return out;
  });

  return { messages: result, changedCount };
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
    // back to the full path (always correct).
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
    const { messages: exactMessages, dedupCount } = processMessages(
      messages as MessageLike[],
      minBlockChars
    );

    const { messages: finalMessages, fuzzyCount } = runFuzzyPass(
      exactMessages,
      stepConfig,
      minBlockChars,
      options?.principalId
    );

    if (dedupCount + fuzzyCount === 0) {
      return { body, compressed: false, stats: null };
    }

    const newBody: Record<string, unknown> = { ...body, messages: finalMessages };
    const durationMs = Math.round(performance.now() - start);
    const techniques = ["session-dedup"];
    if (fuzzyCount > 0) techniques.push("fuzzy-dedup");
    const rules: string[] = [];
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
