/**
 * LLMLingua model store — thin path/config resolver.
 *
 * transformers.js owns the actual model download (from the HuggingFace Hub into
 * its `cacheDir`). This module only resolves the cache directory, maps config
 * model ids to registry entries, and configures a transformers.js `env` object
 * for either Hub download (default) or a local modelPath override.
 *
 * Deliberately does NOT import the native `@huggingface/transformers` dep — it
 * accepts a minimal structural `env` so the heavy runtime stays out of this path.
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  DEFAULT_LLMLINGUA_MODEL,
  LLMLINGUA_MODELS,
  type LlmlinguaModelEntry,
} from "./constants.ts";

/** A minimal structural type for the transformers.js `env` object (avoids importing the native dep here). */
export interface TransformersEnvLike {
  cacheDir?: string;
  localModelPath?: string;
  allowRemoteModels?: boolean;
  [key: string]: unknown;
}

/** Base data dir. Mirrors rtk's getDataDir() at engines/rtk/filterLoader.ts. */
function getDataDir(): string {
  return process.env.DATA_DIR || path.join(os.homedir(), ".omniroute");
}

/** Resolve (and ensure) the model cache dir: `${DATA_DIR}/models/llmlingua`. Mirrors rtk's getDataDir(). */
export function getLlmlinguaModelCacheDir(): string {
  const dir = path.join(getDataDir(), "models", "llmlingua");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Ignore mkdir errors — fail-open philosophy: transformers.js will surface a
    // clearer error if the dir is genuinely unusable, and callers fail-open anyway.
  }
  return dir;
}

/**
 * Find the bundled `models/llmlingua/` directory shipped in the repo.
 *
 * The repo contains pre-downloaded model files under
 * `models/llmlingua/<org>/<repo>/` (ONNX + tokenizer). transformers.js resolves
 * `localModelPath + hfRepo` to find the files, so the root to pass is the
 * `models/llmlingua/` directory.
 *
 * If `hfRepo` is provided, validates that `<root>/<hfRepo>/model.onnx` is a real
 * ONNX blob, not a Git LFS pointer. This avoids the production failure mode where
 * GitHub refused LFS uploads for a public fork and the VPS received only a 133-byte
 * pointer file.
 */
export function findBundledModelRoot(hfRepo?: string): string | undefined {
  const rel = path.join("models", "llmlingua");
  const anchors: string[] = [process.cwd()];
  const argv1 = process.argv[1];
  if (typeof argv1 === "string") {
    let d = path.dirname(argv1);
    for (let i = 0; i < 6; i++) {
      anchors.push(d);
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  for (const anchor of anchors) {
    const candidate = path.join(anchor, rel);
    if (!fs.existsSync(candidate)) continue;
    if (!hfRepo || hasRealOnnxModel(candidate, hfRepo)) return candidate;
  }
  return undefined;
}

/** True iff `<root>/<hfRepo>/model.onnx` is a real model blob, not an LFS pointer. */
function hasRealOnnxModel(root: string, hfRepo: string): boolean {
  const modelPath = path.join(root, ...hfRepo.split("/"), "model.onnx");
  try {
    const stat = fs.statSync(modelPath);
    // Git LFS pointer is ~133 bytes; the tinybert ONNX is ~57MB. Use a low floor so
    // future smaller ONNX models still pass, while pointers never do.
    if (!stat.isFile() || stat.size < 1_000_000) return false;
    const fd = fs.openSync(modelPath, "r");
    try {
      const buf = Buffer.alloc(64);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const head = buf.subarray(0, n).toString("utf8");
      return !head.startsWith("version https://git-lfs.github.com/spec/v1");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** Resolve a config model id to its registry entry; falls back to the default for unknown/empty ids. */
export function resolveLlmlinguaModel(modelId: string | undefined | null): LlmlinguaModelEntry {
  if (typeof modelId === "string" && modelId.length > 0 && LLMLINGUA_MODELS[modelId]) {
    return LLMLINGUA_MODELS[modelId];
  }
  return LLMLINGUA_MODELS[DEFAULT_LLMLINGUA_MODEL];
}

/**
 * Configure a transformers.js `env` for model loading.
 *
 * Priority order:
 *  1. Explicit `opts.modelPath` (admin override, no remote fetch).
 *  2. Bundled in-repo copy — `models/llmlingua/<org>/<repo>/model.onnx` present
 *     and validated as a real ONNX blob (not an LFS pointer). transformers.js
 *     receives `localModelPath = models/llmlingua/` and resolves `hfRepo`
 *     relative to it. No network required.
 *  3. Data-dir cache (`~/.omniroute/models/llmlingua/`) with HF download allowed
 *     so transformers.js fetches on first use when the file is absent.
 */
export function configureTransformersEnv(
  env: TransformersEnvLike,
  opts: { modelPath?: string; hfRepo?: string }
): void {
  const cacheDir = getLlmlinguaModelCacheDir();
  env.cacheDir = cacheDir;

  if (typeof opts.modelPath === "string" && opts.modelPath.length > 0) {
    // Explicit admin override — use as-is, no remote fetch.
    env.localModelPath = opts.modelPath;
    env.allowRemoteModels = false;
    return;
  }

  // Check for bundled model files shipped in the repo (Git LFS).
  const bundledRoot = findBundledModelRoot(opts.hfRepo);
  if (bundledRoot) {
    // localModelPath is the parent; transformers.js appends the hfRepo id to it.
    // e.g. bundledRoot = ".../models/llmlingua" → loads from
    // ".../models/llmlingua/atjsh/llmlingua-2-js-tinybert-meetingbank/model.onnx"
    env.localModelPath = bundledRoot + "/";
    env.allowRemoteModels = false;
    return;
  }

  // Fallback: data-dir cache. Allow remote so HF download works on first use.
  env.localModelPath = cacheDir + "/";
  env.allowRemoteModels = true;
}
