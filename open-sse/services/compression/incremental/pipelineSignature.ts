/**
 * Pipeline signature for the incremental compression cache.
 *
 * A cached compressed message is only valid for the exact compression configuration that
 * produced it. The signature folds everything that can change a message's compressed
 * output — the mode, the ordered engine pipeline, each step's engine id / intensity /
 * config, and the output-affecting top-level config fields — into one stable hash.
 *
 * Changing any compression setting changes the signature, so the cache is invalidated
 * automatically with no explicit busting. Conversely, two requests with identical
 * settings share cache entries.
 */

import crypto from "node:crypto";
import type { CompressionConfig, CompressionMode } from "../types.ts";
import { canonicalize } from "./messageHash.ts";

type PipelineStep = { engine: string; intensity?: string; config?: Record<string, unknown> };

/**
 * Output-affecting subset of CompressionConfig. Telemetry/UI-only fields (e.g. ids,
 * labels) are deliberately excluded so cosmetic settings don't needlessly bust the cache.
 */
function configFingerprint(config: CompressionConfig | undefined): Record<string, unknown> {
  if (!config) return {};
  return {
    preserveSystemPrompt: config.preserveSystemPrompt,
    stackedPipeline: normalizePipeline(config.stackedPipeline),
    rtkConfig: config.rtkConfig ?? null,
    cavemanConfig: config.cavemanConfig ?? null,
    aggressive: config.aggressive ?? null,
    ultra: config.ultra ?? null,
    ultraEngine: config.ultraEngine ?? null,
    languageConfig: config.languageConfig ?? null,
    fidelityGate: config.fidelityGate ?? null,
  };
}

function normalizePipeline(
  pipeline: Array<PipelineStep | string> | undefined
): PipelineStep[] | null {
  if (!pipeline || pipeline.length === 0) return null;
  return pipeline.map((step) =>
    typeof step === "string"
      ? { engine: step }
      : { engine: step.engine, intensity: step.intensity, config: step.config ?? {} }
  );
}

export function pipelineSignature(
  mode: CompressionMode,
  config: CompressionConfig | undefined
): string {
  // canonicalize() sorts object keys recursively so two semantically-identical configs that
  // differ only in key insertion order produce the SAME signature (no spurious cache resets).
  const payload = JSON.stringify(canonicalize({ v: 1, mode, config: configFingerprint(config) }));
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 32);
}
