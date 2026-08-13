import { SHARED_BOUNDARIES, shouldBypassCavemanOutputMode } from "../outputMode.ts";
import {
  bodyHasSystemInstructionMarker,
  injectSystemInstructionOnce,
  type SystemInstructionBody,
} from "../systemInstruction.ts";
import { OUTPUT_STYLE_IDS, outputStyleMeta } from "./catalog.ts";

export type OutputStyleLevel = "lite" | "full" | "ultra";

export interface OutputStyleSelectionEntry {
  id: string;
  level: OutputStyleLevel;
}

export interface OutputStylesResult {
  body: SystemInstructionBody;
  applied: boolean;
  skippedReason?: string;
  /** The styles actually injected (after unknown/locale filtering), in catalog order. */
  appliedStyles?: OutputStyleSelectionEntry[];
}

export interface OutputStylesOptions {
  marker?: string;
}

/** Single idempotency marker guarding the unified injection (D-A: one marker for all styles). */
export const OUTPUT_STYLE_MARKER = "[OmniRoute Output Styles]";

/**
 * Resolve the selection into the ordered, locale-gated, known styles in catalog order.
 * Pure: drops unknown ids and locale-mismatched styles; never throws (D-A6 forward-compat).
 */
function resolveStyles(
  selection: OutputStyleSelectionEntry[],
  language: string
): OutputStyleSelectionEntry[] {
  const byId = new Map(selection.map((entry) => [entry.id, entry]));
  const resolved: OutputStyleSelectionEntry[] = [];
  for (const id of OUTPUT_STYLE_IDS) {
    const entry = byId.get(id);
    if (!entry) continue;
    const meta = outputStyleMeta(id);
    if (!meta) continue;
    if (meta.locale && meta.locale !== language) continue;
    resolved.push({ id, level: entry.level });
  }
  return resolved;
}

/** Build the combined instruction body (no marker, no trailing boundary). Pure / deterministic. */
function buildStyleInstructions(resolved: OutputStyleSelectionEntry[], language: string): string {
  const parts: string[] = [];
  for (const { id, level } of resolved) {
    const meta = outputStyleMeta(id);
    const localized = meta.i18n?.[language];
    const levels = localized ?? meta.levels;
    // Strip the per-style boundary so SHARED_BOUNDARIES is appended exactly once below.
    parts.push(levels[level].replace(SHARED_BOUNDARIES, "").trim());
  }
  return parts.join("\n");
}

/**
 * Inject one or more output styles deterministically and front-loaded into the system prompt.
 * - Selection resolved in catalog order; unknown/locale-mismatched styles dropped.
 * - SHARED_BOUNDARIES applied once at the end (not per style).
 * - Single idempotency marker; re-applying is a no-op.
 * - Content bypass runs once across the whole turn (all-or-nothing); reason recorded.
 */
export function applyOutputStyles(
  body: SystemInstructionBody,
  selection: OutputStyleSelectionEntry[],
  language = "en",
  options: OutputStylesOptions = {}
): OutputStylesResult {
  const resolved = resolveStyles(selection ?? [], language);
  if (resolved.length === 0) {
    return { body, applied: false, skippedReason: "no_styles" };
  }

  // Single space before the shared boundary so a legacy single-style (terse-prose)
  // injection stays byte-identical to the old caveman output mode (D-A5 back-compat).
  const combined = `${buildStyleInstructions(resolved, language)} ${SHARED_BOUNDARIES}`;
  const marker = options.marker ?? OUTPUT_STYLE_MARKER;
  const instruction = `${marker}\n${combined}`;

  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (bodyHasSystemInstructionMarker(body, marker)) {
    return { body, applied: false, skippedReason: "already_applied" };
  }

  if (!messages || messages.length === 0) {
    const injected = injectSystemInstructionOnce(body, marker, instruction);
    return injected.applied
      ? { body: injected.body, applied: true, appliedStyles: resolved }
      : { body, applied: false, skippedReason: injected.skippedReason };
  }

  // Content bypass (all-or-nothing for the turn): reuse the existing rules verbatim.
  const bypass = shouldBypassCavemanOutputMode(messages);
  if (bypass) return { body, applied: false, skippedReason: bypass };

  const injected = injectSystemInstructionOnce(body, marker, instruction);
  return injected.applied
    ? { body: injected.body, applied: true, appliedStyles: resolved }
    : { body, applied: false, skippedReason: injected.skippedReason };
}
