/**
 * LLMLingua real-engine constants — pure data + types.
 *
 * NO imports of native deps (transformers.js, onnxruntime, etc). This module is
 * safe to import from anywhere (main thread, worker, tests) without pulling in
 * the heavy ONNX runtime.
 *
 * The real backend uses `@atjsh/llmlingua-2` (ONNX via `@huggingface/transformers`),
 * which downloads models from the HuggingFace Hub into a cache dir. Only the two
 * models PROVEN to work end-to-end are registered here.
 */

export type LlmlinguaFactory = "WithBERTMultilingual" | "WithXLMRoBERTa";

export interface LlmlinguaModelEntry {
  /** config value, e.g. "tinybert" */
  id: string;
  /** HuggingFace Hub repo id */
  hfRepo: string;
  factory: LlmlinguaFactory;
  dtype: "fp32";
  /** transformers.js subfolder option; "" for both proven models */
  subfolder: string;
  sizeMB: number;
  label: string;
}

// tinybert (57MB) is the default: public (no HF auth), fast (~7ms warm inference),
// and pre-downloadable. Switch to "bert-base" or "bert-base-ms" for higher quality.
export const DEFAULT_LLMLINGUA_MODEL = "tinybert";

/** Registry keyed by config `model` value. */
export const LLMLINGUA_MODELS: Record<string, LlmlinguaModelEntry> = {
  "bert-base-ms": {
    id: "bert-base-ms",
    hfRepo: "microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank",
    factory: "WithBERTMultilingual",
    dtype: "fp32",
    subfolder: "",
    sizeMB: 710,
    label: "BERT-base multilingual (Microsoft, 710MB — default)",
  },
  tinybert: {
    id: "tinybert",
    hfRepo: "atjsh/llmlingua-2-js-tinybert-meetingbank",
    factory: "WithBERTMultilingual",
    dtype: "fp32",
    subfolder: "",
    sizeMB: 57,
    label: "TinyBERT (57MB, fast — public, no HF auth required)",
  },
  "bert-base": {
    id: "bert-base",
    hfRepo: "Arcoldd/llmlingua4j-bert-base-onnx",
    factory: "WithBERTMultilingual",
    dtype: "fp32",
    subfolder: "",
    sizeMB: 710,
    label: "BERT-base (710MB, Arcoldd mirror)",
  },
};

/** Per-call worker reply timeout → fail-open. First call downloads the model
 *  (~710MB for bert-base-ms), so the timeout must accommodate that. */
export const LLMLINGUA_WORKER_TIMEOUT_MS = 120_000;
/** Terminate the idle worker after this long to free model RAM. 0 = never unload. */
export const LLMLINGUA_WORKER_IDLE_MS = 0;
