import { applyOutputStyles } from "../../outputStyles/apply.ts";
import { LESS_CODE_OUTPUT_STYLE_ID } from "../../outputStyles/catalog.ts";
import { createCompressionStats } from "../../stats.ts";
import type { CompressionResult, OutputStyleLevel } from "../../types.ts";
import type { CompressionEngine, EngineConfigField, EngineValidationResult } from "../types.ts";

export type PonytailLevel = OutputStyleLevel;

const PONYTAIL_MARKER = "[OmniRoute Ponytail]";
const PONYTAIL_LEVELS: PonytailLevel[] = ["lite", "full", "ultra"];
const PONYTAIL_TECHNIQUE = "ponytail-instruction";

const PONYTAIL_SCHEMA: EngineConfigField[] = [
  {
    key: "level",
    type: "select",
    label: "Level",
    description: "Ponytail instruction intensity injected into the endpoint system prompt.",
    defaultValue: "full",
    options: PONYTAIL_LEVELS.map((value) => ({ value, label: value })),
  },
];

function normalizeLevel(value: unknown): PonytailLevel {
  return PONYTAIL_LEVELS.includes(value as PonytailLevel) ? (value as PonytailLevel) : "full";
}

export function applyPonytailCompression(
  body: Record<string, unknown>,
  config: Record<string, unknown> = {}
): CompressionResult {
  const level = normalizeLevel(config.level ?? config.intensity);
  const styleResult = applyOutputStyles(body, [{ id: LESS_CODE_OUTPUT_STYLE_ID, level }], "en", {
    marker: PONYTAIL_MARKER,
  });
  if (!styleResult.applied) return { body, compressed: false, stats: null };

  const nextBody = styleResult.body as Record<string, unknown>;
  const stats = createCompressionStats(body, nextBody, "stacked", [PONYTAIL_TECHNIQUE], [level]);
  stats.engine = "ponytail";
  stats.augmentationTokens = Math.max(0, stats.compressedTokens - stats.originalTokens);
  stats.compressedTokens = stats.originalTokens;
  stats.savingsPercent = 0;

  return {
    body: nextBody,
    compressed: true,
    stats,
  };
}

export const ponytailEngine: CompressionEngine = {
  id: "ponytail",
  name: "Ponytail",
  description: "Injects lazy-senior-dev YAGNI discipline into endpoint prompts.",
  icon: "content_cut",
  targets: ["messages"],
  stackable: true,
  stackPriority: 25,
  metadata: {
    id: "ponytail",
    name: "Ponytail",
    description: "Lazy senior developer rules: reuse, stdlib/native first, minimum safe code.",
    inputScope: "messages",
    targetLatencyMs: 1,
    supportsPreview: true,
    stable: true,
  },
  apply(body, options) {
    return applyPonytailCompression(body, options?.stepConfig ?? {});
  },
  compress(body, config) {
    return applyPonytailCompression(body, config ?? {});
  },
  getConfigSchema() {
    return PONYTAIL_SCHEMA;
  },
  validateConfig(config): EngineValidationResult {
    const errors: string[] = [];
    if (config.level !== undefined && !PONYTAIL_LEVELS.includes(config.level as PonytailLevel)) {
      errors.push("level must be lite, full, or ultra");
    }
    if (
      config.intensity !== undefined &&
      !PONYTAIL_LEVELS.includes(config.intensity as PonytailLevel)
    ) {
      errors.push("intensity must be lite, full, or ultra");
    }
    return { valid: errors.length === 0, errors };
  },
};
