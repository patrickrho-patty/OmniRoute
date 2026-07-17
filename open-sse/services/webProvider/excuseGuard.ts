/**
 * Excuse / confabulation detection for web-cookie tool emulation.
 *
 * Web models sometimes answer with an excuse ("I can't access the filesystem"),
 * a fabricated failure ("the workspace connector returned an upstream error"),
 * or a bare intention ("I'll start by inspecting the repo") INSTEAD of emitting
 * the tool call the contract requires. Passing such prose to the harness ends
 * the turn as if the task were done — the model then teaches itself to keep
 * answering in prose on later turns.
 *
 * detectWebToolExcuse() flags these replies so the executor can retry once with
 * a corrective nudge instead of forwarding confabulation to the user. Patterns
 * ported from the deleted translator/webToolSynthesis.ts plus failures observed
 * in production sessions (2026-07).
 */

const EXCUSE_PATTERNS: RegExp[] = [
  // "X is unavailable / I can't access X" family (legacy isWebToolExcuse)
  /(filesystem|file system|repository|repo|workspace|project files|package\.json|tool|this chat|this environment|this runtime|this session).{0,200}(unavailable|not available|not exposed|not mounted|not present|not visible|can't|can’t|cannot|unable|don't see|don’t see|not seeing|sandbox|isn't available|not accessible|doesn't have access)/i,
  /\b(?:paste|provide|share|point me at)\b.{0,120}(package\.json|file|repo|repository|folder|tree|output|workspace)/i,
  /(package\.json|file|repo|repository|folder|tree|output|workspace).{0,120}\b(?:paste|provide|share|point me at)\b/i,
  /\b(couldn't read|couldn't open|couldn't access|could not read|could not open|could not access|can't read|can't open|can't access|cannot read|cannot open|cannot access|not able to read|not able to access|unable to read|unable to access|i tried to open|i tried to read|i tried to access|i tried to run|read attempt|does not exist at that path|not a tool|isn't available in this chat|can't call a .* tool|don't have access to .* file|don't have .* tool access|can't inspect live files|i cannot access|don't actually have access|can’t read|can’t open|can’t access|couldn’t read|couldn’t open|couldn’t access|don’t have access)\b/i,
  // Explicit claims of missing capability
  /\b(i (?:don't|do not|don’t) have (?:the )?(?:ability|capability|permission|tools) to|as an ai (?:language )?model)\b/i,
];

/**
 * Fabricated infrastructure failures — the model invents a connector/API error
 * to explain why IT could not act (observed: "the workspace connector returned
 * an upstream error (502)"). These only fire alongside a first-person pronoun,
 * which is what separates confabulation ("I tried… but the connector failed")
 * from grounded third-person reports ("The gateway returned the route list").
 */
const FIRST_PERSON_FABRICATION_PATTERNS: RegExp[] = [
  /(workspace\s+)?connector.{0,60}(returned|returning|failed|fails|error)/i,
  /\b(host|bridge)\b.{0,40}(returned|returning|failed|fails|error)/i,
  /(returned|responded with|got|received)\s+(an\s+)?upstream\s+(error|failure)/i,
  /upstream error \(\d{3}\)/i,
];

const FIRST_PERSON_RE = /\b(?:i|me|my)\b/i;

/**
 * Plan-narration patterns: the reply promises future work ("I'll create…",
 * "Let me write…", "Next I will…") instead of performing it. Kept separate
 * from the excuse patterns because these are safe to apply even on grounded
 * tool-result continuations — a reply that merely announces work is never a
 * completed turn, regardless of what the results contained.
 */
const PLAN_NARRATION_PATTERNS: RegExp[] = [
  /^(?:i['’]ll|i will|let me)\s+(?:now\s+)?(?:continue|proceed|move on|go ahead)\b/i,
  /^(?:i['’]ll|i will|let me)\s+(?:now\s+)?(?:create|write|add|update|generate|prepare|draft|build|make|edit|modify|produce|save)\b/i,
  /^(?:next[,:]?\s+)?(?:i['’]ll|i will)\s+(?:now\s+)?(?:create|write|generate|prepare|draft)\b/i,
  /\b(?:i['’]ll|i will|let me)\s+(?:create|write|add|update|generate|prepare|draft|build|edit|modify|save)\s+[\w./\\-]+\.(?:md|markdown|ts|tsx|js|jsx|mjs|json|ya?ml|toml|py|go|rs|txt|sh|sql|html|css)\b/i,
];

/** Guard strictness by turn kind. "plan" is the narrow, high-precision set. */
export type WebToolGuardMode = "off" | "plan" | "full";

/**
 * True when the reply is essentially a plan/intention with no delivered work.
 * Safe on every turn kind: grounded answers report what WAS done (past tense)
 * rather than announcing what WILL be done.
 */
export function detectPlanNarration(content: string): boolean {
  if (!content || typeof content !== "string") return false;
  const text = content.trim();
  if (!text || text.length > 2000) return false;
  return PLAN_NARRATION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Intention-without-action at the START of the reply. Verbs are restricted to
 * tool-requiring actions (inspect/read/run/execute) and list/search/open only
 * with filesystem-shaped objects, so figurative uses ("let me compare the
 * options", "let me open with a summary", "I'll check the math") pass.
 */
const INTENTION_PATTERN =
  /^(?:i['’]ll|i will|let me)\s+(?:start by\s+)?(?:inspect(?:ing)?|read(?:ing)?|run(?:ning)?|execut(?:e|ing)|list(?:ing)?\s+(?:the\s+)?(?:files?|folders?|directories|directory|repos?|contents)|search(?:ing)?\s+(?:the\s+)?(?:files?|repo|codebase|folder|directory)|open(?:ing)?\s+(?:the|a|that|this|\/))/i;

/**
 * True when the assistant reply looks like an excuse/confabulation/bare-intention
 * that should have been a tool call. Only meaningful when the same reply decoded
 * zero tool calls — a reply that already contains a call never needs the guard.
 */
export function detectWebToolExcuse(content: string): boolean {
  if (!content || typeof content !== "string") return false;
  const text = content.trim();
  if (!text) return false;
  if (EXCUSE_PATTERNS.some((pattern) => pattern.test(text))) return true;
  if (
    FIRST_PERSON_RE.test(text) &&
    FIRST_PERSON_FABRICATION_PATTERNS.some((pattern) => pattern.test(text))
  ) {
    return true;
  }
  // Bare intention statements only count when they ARE essentially the whole
  // reply — "I'll summarize: ..." followed by a substantive answer is fine.
  return text.length < 800 && INTENTION_PATTERN.test(text);
}

/** Tiered guard: full excuse detection, or the narrow plan-narration set only. */
export function detectWebToolGuardViolation(content: string, mode: WebToolGuardMode): boolean {
  if (mode === "off") return false;
  if (mode === "plan") return detectPlanNarration(content);
  return detectWebToolExcuse(content) || detectPlanNarration(content);
}
