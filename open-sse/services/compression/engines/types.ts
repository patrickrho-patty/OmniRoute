import type { CompressionConfig, CompressionResult } from "../types.ts";
import type { IncrementalContext } from "../incremental/types.ts";

export type CompressionEngineTarget = "messages" | "tool_results" | "code_blocks";

/** Protocol shape and pipeline stage used by format-sensitive engines. */
export type CompressionWireFormat = "claude" | "openai" | "openai-responses" | string;

export type CompressionStage = "pre-translation" | "post-translation";

/** Whether an upstream route preserves OmniGlyph PNG bytes and dimensions. */
export type ImageTransportFidelity = "byte-preserving" | "resizes" | "unknown";

export interface EngineConfigField {
  key: string;
  type: "boolean" | "number" | "string" | "select" | "multiselect";
  label: string;
  i18nKey?: string;
  description?: string;
  defaultValue: unknown;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
}

export interface EngineValidationResult {
  valid: boolean;
  errors: string[];
}

export interface CompressionEngineMetadata {
  id: string;
  name: string;
  description: string;
  inputScope: "messages" | "tool-results" | "mixed";
  targetLatencyMs: number;
  supportsPreview: boolean;
  stable: boolean;
  /**
   * True when this engine's output for message i depends ONLY on message i (no
   * cross-message context). Such engines are safely memoised per-message by the
   * incremental compressor: a message's compressed form is cached by its semantic
   * hash and reused across turns. Cross-message engines (session-dedup, ccr) and
   * context-dependent ones (rtk needs an earlier tool_use to read a tool_result)
   * leave this false and implement their own incremental mode via `options.incremental`.
   */
  perMessageDeterministic?: boolean;
  /**
   * True when this engine produces output for a given message that is STABLE across
   * turns — i.e. it never rewrites earlier content based on later content or total
   * token budget. Stable engines keep the provider's prompt cache alive (the cached
   * prefix stays byte-identical turn to turn). Budget-driven engines (headroom, ultra,
   * aggressive) drop DIFFERENT content as the conversation grows, mutating the prefix
   * and busting the provider cache — they are NOT cacheSafe. In a caching context the
   * pipeline drops `cacheSafe === false` engines (unless `overflowCritical`), because
   * the provider's ~10x cache discount far outweighs local compression savings.
   */
  cacheSafe?: boolean;
  /**
   * True for an engine that must keep running even in a caching context because it
   * prevents context-window OVERFLOW (a hard upstream failure), not just opportunistic
   * compression. Only `headroom`. Such an engine is exempt from the cacheSafe gate; the
   * proper long-term fix is to make it tail-aware (compress only past the cache boundary).
   */
  overflowCritical?: boolean;
  /** Stages at which this engine can receive a request body. Omitted means pre-translation. */
  executionStages?: CompressionStage[];
}

export interface CompressionEngineApplyOptions {
  model?: string;
  supportsVision?: boolean | null;
  /** Como o request chega ao provider: rota direta oficial ('direct') vs
   *  agregador que pode reprocessar imagens ('aggregator'). O engine omniglyph
   *  exige 'direct' — medição 2026-07-06: agregadores redimensionam as páginas
   *  e destroem a legibilidade. A política de produção também informa
   *  imageTransportFidelity; chamadas legadas sem esse campo mantêm o gate direct. */
  providerTransport?: "direct" | "aggregator";
  /** Independent image-fidelity gate; direct HTTP does not imply byte preservation. */
  imageTransportFidelity?: ImageTransportFidelity;
  /** Protocol shape before the current compression stage. */
  sourceFormat?: CompressionWireFormat;
  /** Protocol shape expected by the upstream provider. */
  targetFormat?: CompressionWireFormat;
  /** Whether the body is still client-shaped or already provider-shaped. */
  compressionStage?: CompressionStage;
  config?: CompressionConfig;
  compressionComboId?: string | null;
  stepConfig?: Record<string, unknown>;
  /** Authenticated principal (API key id) making the request. Used by CCR to scope its store. */
  principalId?: string;
  /**
   * Per-session incremental state, present only when the incremental compressor drives the
   * pipeline. An engine MAY use it to do O(new-messages) work instead of O(all-messages) by
   * carrying cross-turn state (e.g. session-dedup's persistent index, a cumulative tool-call
   * lookup) — and MUST produce output byte-identical to a full run when it does (enforced by
   * the equivalence property test). Engines that ignore it run normally and stay correct.
   */
  incremental?: IncrementalContext;
  /** Provider resolvido do alvo. A contabilidade do omniglyph depende dele:
   *  Anthropic reporta input/cache em buckets disjuntos, OpenAI/xAI reportam
   *  cached como subconjunto do input. Ausente => `unknown` (falha fechado). */
  provider?: string;
}

export interface CompressionEngine {
  id: string;
  name: string;
  description: string;
  icon: string;
  targets: CompressionEngineTarget[];
  stackable: boolean;
  stackPriority: number;
  /**
   * Marks an intentionally-lossy sampling engine (e.g. ionizer). The fidelity gate SKIPS such
   * engines: their drop is deliberate and recoverable via CCR, not accidental corruption.
   */
  sampling?: boolean;
  metadata: CompressionEngineMetadata;
  apply(body: Record<string, unknown>, options?: CompressionEngineApplyOptions): CompressionResult;
  /**
   * Optional async variant (H10). Engines whose real work is asynchronous
   * (e.g. a worker-thread model like LLMLingua-2) implement this. The stacked
   * pipeline awaits `applyAsync` when present and falls back to the synchronous
   * `apply` otherwise, so async-only engines MUST keep `apply` as a safe
   * synchronous pass-through. Sync engines never need to implement this.
   */
  applyAsync?(
    body: Record<string, unknown>,
    options?: CompressionEngineApplyOptions
  ): Promise<CompressionResult>;
  compress(body: Record<string, unknown>, config?: Record<string, unknown>): CompressionResult;
  getConfigSchema(): EngineConfigField[];
  validateConfig(config: Record<string, unknown>): EngineValidationResult;
}

export interface EngineRegistryEntry {
  engine: CompressionEngine;
  enabled: boolean;
  config: Record<string, unknown>;
}
