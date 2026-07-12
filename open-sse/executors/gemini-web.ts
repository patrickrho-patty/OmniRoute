/**
 * GeminiWebExecutor — Gemini Web Session Provider
 *
 * Routes requests through Google Gemini's web interface using browser
 * cookies + Playwright automation. Translates between OpenAI chat
 * completions format and Gemini's web UI.
 *
 * Auth: Cookie-based (__Secure-1PSID + __Secure-1PSIDTS from gemini.google.com)
 * Method: Playwright browser automation
 *
 * Note: Streaming is pseudo-streaming — waits for full Gemini response then
 * sends as single SSE chunk. Gemini's StreamGenerate endpoint returns complete
 * responses, not chunked streams.
 */

import { BaseExecutor, type ExecuteInput } from "./base.ts";
import { sanitizeErrorMessage } from "../utils/error.ts";
import { serializeToolsToPrompt, buildToolAwareResult } from "../translator/webTools.ts";
import { synthesizeWebToolCall, synthesizeWebFallbackToolCall } from "../translator/webToolSynthesis.ts";
import { isCliCompatEnabled, CLI_FINGERPRINTS } from "../config/cliFingerprints.ts";
import { generateViaApi } from "../services/geminiWebApiClient.ts";

// ─── Constants ──────────────────────────────────────────────────────────────

const GEMINI_URL = "https://gemini.google.com/app";

/**
 * Whether an error came from Playwright failing to launch because the browser binary is not
 * installed (`chromium.launch: Executable doesn't exist at ...`). This is a host/config
 * problem, not a transient upstream fault, so the executor must NOT surface it as a retryable
 * 500 (which marks the account unavailable and loops / trips the provider breaker). See #3516.
 */
export function isMissingBrowserExecutable(message: string): boolean {
  if (!message) return false;
  return /executable doesn't exist|executablenotfound|playwright install|chromium.*download/i.test(
    message
  );
}
const GEMINI_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

/**
 * Effective User-Agent for the Playwright browser context. When
 * CLI_COMPAT_GEMINI_WEB is enabled, uses Antigravity's UA so traffic looks
 * like a coding-agent client. Otherwise uses the default Chrome browser UA.
 */
function getEffectiveUserAgent(): string {
  if (isCliCompatEnabled("gemini-web")) {
    const fp = CLI_FINGERPRINTS["gemini-web"];
    if (fp?.userAgent) {
      return typeof fp.userAgent === "function" ? fp.userAgent() : fp.userAgent;
    }
  }
  return GEMINI_USER_AGENT;
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface GeminiMessage {
  role: string;
  content: string;
}

interface GeminiRequestBody {
  messages: GeminiMessage[];
  model?: string;
  stream?: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatChatCompletion(content: string, model: string, finishReason = "stop") {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function formatStreamChunk(content: string, model: string, finishReason: string | null = null) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }],
  };
}

/**
 * Parse cookie string, stripping attributes (Path, Domain, Expires, etc.)
 * Input: full browser cookie string or just "name=value; name2=value2"
 * Output: array of { name, value } pairs
 */
function parseCookies(raw: string): Array<{ name: string; value: string }> {
  return raw
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eqIdx = part.indexOf("=");
      if (eqIdx === -1) return null;
      const name = part.substring(0, eqIdx).trim();
      const value = part.substring(eqIdx + 1).trim();
      // Skip cookie attributes that aren't name=value pairs
      if (!name || !value) return null;
      const lowerName = name.toLowerCase();
      if (
        ["path", "domain", "expires", "max-age", "secure", "httponly", "samesite"].includes(
          lowerName
        )
      ) {
        return null;
      }
      return { name, value };
    })
    .filter(Boolean) as Array<{ name: string; value: string }>;
}

/**
 * Parse Gemini StreamGenerate response text.
 *
 * Response format:
 *   )]}'
 *   <length>
 *   [["wrb.fr", null, "<JSON string>"]]
 *   <length>
 *   [["wrb.fr", null, "<JSON string>"]]
 *
 * The JSON string contains nested array: inner[4][0][1] = ["text chunks"].
 * Gemini streams CUMULATIVE snapshots — each wrb.fr line repeats the full text
 * so far plus the new delta. Concatenating them duplicates the growing prefix
 * ("Hey!..." ×N). If the chunks are cumulative (each extends the previous),
 * return the longest (the final complete snapshot); otherwise (true fragments)
 * concatenate.
 */
export function parseStreamResponse(raw: string): string {
  const lines = raw.split("\n");
  const textChunks: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line === ")]}'" || /^\d+$/.test(line)) continue;
    if (!line.includes("wrb.fr")) continue;
    try {
      const arr = JSON.parse(line);
      if (!Array.isArray(arr) || !Array.isArray(arr[0]) || arr[0][0] !== "wrb.fr") continue;
      const payload = arr[0]?.[2];
      if (typeof payload !== "string") continue;
      const inner = JSON.parse(payload);
      // Defensive: check each level before accessing
      const responseArray = inner?.[4]?.[0]?.[1];
      if (!Array.isArray(responseArray)) continue;
      const text = responseArray.filter((c: unknown) => typeof c === "string").join("");
      if (text) textChunks.push(text);
    } catch {
      // Skip unparseable lines
    }
  }
  if (textChunks.length === 0) return "";
  // Cumulative snapshots: each chunk is a prefix-superset of its predecessor.
  // Take the longest (the final, complete snapshot). Only concatenate when the
  // chunks are genuinely disjoint fragments.
  const isCumulative = textChunks.every((chunk, i) =>
    i === 0 || chunk.startsWith(textChunks[i - 1]) || textChunks[i - 1].startsWith(chunk)
  );
  if (isCumulative) {
    return textChunks.reduce((longest, chunk) => (chunk.length > longest.length ? chunk : longest));
  }
  return textChunks.join("");
}

function readCredentialString(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "";
}

function readProviderSpecificString(
  providerSpecificData: unknown,
  keys: readonly string[]
): string {
  if (
    !providerSpecificData ||
    typeof providerSpecificData !== "object" ||
    Array.isArray(providerSpecificData)
  ) {
    return "";
  }
  const data = providerSpecificData as Record<string, unknown>;
  for (const key of keys) {
    const value = readCredentialString(data[key]);
    if (value) return value;
  }
  return "";
}

function normalizeGeminiCookieInput(raw: string, cookieName = "__Secure-1PSID"): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed.includes("=") ? trimmed : `${cookieName}=${trimmed}`;
}

function resolveGeminiWebCookie(credentials: ExecuteInput["credentials"]): string {
  const directCookie =
    readCredentialString(credentials?.apiKey) ||
    readCredentialString((credentials as Record<string, unknown> | undefined)?.cookie);
  if (directCookie) return normalizeGeminiCookieInput(directCookie);

  const providerSpecificData = credentials?.providerSpecificData;
  const cookie = readProviderSpecificString(providerSpecificData, ["cookie"]);
  if (cookie) return normalizeGeminiCookieInput(cookie);

  const psid = readProviderSpecificString(providerSpecificData, ["__Secure-1PSID"]);
  const psidts = readProviderSpecificString(providerSpecificData, ["__Secure-1PSIDTS"]);
  return [
    psid ? normalizeGeminiCookieInput(psid, "__Secure-1PSID") : "",
    psidts ? normalizeGeminiCookieInput(psidts, "__Secure-1PSIDTS") : "",
  ]
    .filter(Boolean)
    .join("; ");
}

// ─── Executor ───────────────────────────────────────────────────────────────

export class GeminiWebExecutor extends BaseExecutor {
  constructor() {
    super("gemini-web", { id: "gemini-web", baseUrl: GEMINI_URL });
  }

  async execute(input: ExecuteInput) {
    const { model, body, stream, credentials, signal } = input;
    const requestBody = body as GeminiRequestBody;

    const cookie = resolveGeminiWebCookie(credentials);
    if (!cookie) {
      return {
        response: new Response(JSON.stringify({ error: "Missing Gemini cookies" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    }

    const messages = requestBody.messages || [];
    const lastUserMsg = messages.filter((m) => m.role === "user").pop();
    // Content may be a plain string OR an array of parts (e.g.
    // [{type:"text",text:"..."}, ...] from /v1/responses or multimodal clients).
    // keyboard.type() requires a string, so flatten to text only — gemini-web
    // drives a browser via the keyboard and cannot type non-text parts.
    const rawContent = lastUserMsg?.content;
    const userPromptText =
      typeof rawContent === "string"
        ? rawContent
        : Array.isArray(rawContent)
          ? rawContent
              .map((part: any) => (typeof part === "string" ? part : part?.text ?? ""))
              .join("")
          : "";

    // Tool-call support: serialize the OpenAI `tools` array into a system-prompt
    // contract (the Gemini web UI has no native function-calling). The model is
    // asked to emit <tool>{"name":...,"arguments":{...}}</tool> blocks, which are
    // parsed back into OpenAI tool_calls on the response side. Mirrors the
    // chatgpt-web / qwen-web / deepseek-web wiring via shared webTools.
    //
    // FRAMING: the contract is wrapped in <system> tags and the user's actual
    // request in <task> tags so Gemini treats them as distinct (instructions vs.
    // the thing to do). A final action-forcing directive prevents the model from
    // acknowledging the protocol without acting ("I am ready…").
    const tools = requestBody.tools;
    const hasTools = Array.isArray(tools) && tools.length > 0;
    const toolContract = hasTools ? serializeToolsToPrompt(tools) : "";
    const prompt = hasTools && toolContract
      ? `<system>\n${toolContract}\n</system>\n\n<task>\n${userPromptText}\n</task>\n\nYou MUST act on the task above NOW using the TOOL USE PROTOCOL. Do NOT say "I am ready" or ask for the task — the task is already given. If a tool is needed, emit ONLY the <tool> block immediately.`
      : userPromptText;

    if (!prompt) {
      return {
        response: new Response(JSON.stringify({ error: "No user message found" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    }

    // ─── Pre-provider tool-call synthesis ────────────────────────────────
    // Intercept filesystem/git/package.json requests BEFORE sending to Gemini,
    // so the model never gets a chance to confabulate file contents or claim
    // the filesystem is unavailable. Same logic as chatgpt-web.
    if (hasTools) {
      const synthHistory = messages.map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : "" }));
      const preSynth = synthesizeWebToolCall({
        currentMsg: userPromptText,
        history: synthHistory,
        requestedTools: tools,
      });
      if (preSynth) {
        const modelId = model || "gemini-2.5-pro";
        const message: Record<string, unknown> = { role: "assistant", content: null };
        message.tool_calls = preSynth;
        return {
          response: new Response(
            JSON.stringify({
              id: `chatcmpl-${Date.now()}`,
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: modelId,
              choices: [{ index: 0, message, finish_reason: "tool_calls" }],
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          ),
          url: GEMINI_URL,
          headers: {},
          transformedBody: body,
        };
      }
    }

    let browser: any = null;
    let abortBrowser: (() => void) | null = null;
    let responseText = "";
    try {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Request aborted");
      }

      // ─── API-first path (no Playwright) ────────────────────────────────
      // Try the direct HTTP StreamGenerate endpoint first. This is faster,
      // lighter, and matches how all other web-cookie providers work.
      // Fall back to Playwright if the API path fails (token extraction
      // may fail if Gemini changes their HTML — Playwright executes JS
      // and handles dynamic token delivery).
      try {
        const apiResult = await generateViaApi(prompt, cookie, model, signal);
        if (apiResult.text) {
          responseText = apiResult.text;
        }
        // If API fails (no text), fall through to Playwright fallback below.
      } catch (apiErr) {
        // API path errored — fall through to Playwright fallback.
      }

      // ─── Playwright fallback (browser automation) ──────────────────────
      if (!responseText) {
      const { chromium } = await import("playwright");
      browser = await chromium.launch({ headless: true });
      abortBrowser = () => {
        void browser?.close().catch(() => {});
      };
      signal?.addEventListener("abort", abortBrowser, { once: true });

      const context = await browser.newContext({ userAgent: getEffectiveUserAgent() });

      // Parse cookies — strips attributes like Path, Domain, Expires
      const cookiePairs = parseCookies(cookie);
      await context.addCookies(
        cookiePairs.map(({ name, value }) => ({
          name,
          value,
          domain: ".google.com",
          path: "/",
          secure: true,
        }))
      );

      const page = await context.newPage();

      // Capture first StreamGenerate response
      let captured = false;
      const responsePromise = new Promise<void>((resolve) => {
        page.on("response", async (resp: any) => {
          if (captured || !resp.url().includes("StreamGenerate")) return;
          captured = true;
          try {
            const raw = await resp.text();
            responseText = parseStreamResponse(raw);
          } catch {
            /* ignore */
          }
          resolve();
        });
      });

      await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded", timeout: 20000 });
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Request aborted");
      }
      await page.waitForTimeout(3000);

      // Type and send message
      const inputEl = await page.waitForSelector(".ql-editor, [contenteditable='true']", {
        timeout: 10000,
      });
      await inputEl.click();
      // Set the prompt via execCommand('insertText') — keyboard.type drops
      // can't keep up with rapid key events, truncating the message. Gemini then
      // sees only the first few chars ("system tag without any text").
      // execCommand inserts the full text atomically + triggers Quill's input
      // listener reliably.
      await page.evaluate((text) => {
        const editor = document.querySelector('.ql-editor, [contenteditable="true"]');
        if (editor) {
          editor.focus();
          document.execCommand("selectAll");
          document.execCommand("insertText", false, text);
        }
      }, prompt);
      await page.waitForTimeout(300);
      await page.keyboard.press("Enter");

      // Wait for response or timeout
      await Promise.race([responsePromise, page.waitForTimeout(30000)]);
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Request aborted");
      }
      } // end Playwright fallback

      if (!responseText) {
        return {
          response: new Response(JSON.stringify({ error: "No response from Gemini" }), {
            status: 502,
            headers: { "Content-Type": "application/json" },
          }),
          url: GEMINI_URL,
          headers: {},
          transformedBody: body,
        };
      }

      const modelId = model || "gemini-2.5-pro";

      // Tool-call response: parse <tool>{...}</tool> blocks from the raw model
      // output into OpenAI tool_calls (the web UI has no native function-calling).
      if (hasTools) {
        let { content, toolCalls, finishReason } = buildToolAwareResult(
          responseText,
          tools,
          "gemini-web"
        );

        // Post-response fallback: if the model didn't emit a <tool> block but
        // replied with an excuse ("I can't access files"), synthesize the tool
        // call it should have made. Same logic as chatgpt-web.
        if (!toolCalls) {
          const fallback = synthesizeWebFallbackToolCall(content, userPromptText, tools);
          if (fallback) {
            toolCalls = fallback;
            content = null;
            finishReason = "tool_calls";
          }
        }

        const message: Record<string, unknown> = { role: "assistant", content: content || null };
        if (toolCalls) message.tool_calls = toolCalls;

        if (stream) {
          const encoder = new TextEncoder();
          const readable = new ReadableStream(
            {
              start(controller) {
                if (content) {
                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify(formatStreamChunk(content, modelId))}\n\n`
                    )
                  );
                }
                if (toolCalls) {
                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({ id: `chatcmpl-${Date.now()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: modelId, choices: [{ index: 0, delta: { role: "assistant", tool_calls: toolCalls }, finish_reason: null }] })}\n\n`
                    )
                  );
                }
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify(formatStreamChunk("", modelId, finishReason))}\n\n`
                  )
                );
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
              },
            },
            { highWaterMark: 16384 }
          );
          return {
            response: new Response(readable, {
              status: 200,
              headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
            }),
            url: GEMINI_URL,
            headers: {},
            transformedBody: body,
          };
        }

        const completion = {
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: modelId,
          choices: [{ index: 0, message, finish_reason: finishReason }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
        return {
          response: new Response(JSON.stringify(completion), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
          url: GEMINI_URL,
          headers: {},
          transformedBody: body,
        };
      }

      if (stream) {
        // Pseudo-streaming: send complete response as single SSE chunk
        // Gemini's StreamGenerate returns complete responses, not chunked streams
        const encoder = new TextEncoder();
        const readable = new ReadableStream(
          {
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify(formatStreamChunk(responseText, modelId))}\n\n`
                )
              );
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify(formatStreamChunk("", modelId, "stop"))}\n\n`
                )
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          },
          { highWaterMark: 16384 }
        );
        return {
          response: new Response(readable, {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          }),
          url: GEMINI_URL,
          headers: {},
          transformedBody: body,
        };
      }

      return {
        response: new Response(JSON.stringify(formatChatCompletion(responseText, modelId)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : "Unknown error";
      // #3516: a missing Playwright browser is a host/config problem, not a transient upstream
      // fault. Surface an actionable error and tag it with the connection-cooldown hint so
      // accountFallback skips the provider circuit breaker and applies a short, non-exponential
      // cooldown instead of looping on a retryable 500.
      if (isMissingBrowserExecutable(rawMessage)) {
        return {
          response: new Response(
            JSON.stringify({
              error:
                "Gemini Web requires the Playwright Chromium browser, which is not installed. " +
                "Run `npx playwright install chromium` on the host (or rebuild the Docker image with browsers).",
            }),
            {
              status: 503,
              headers: {
                "Content-Type": "application/json",
                "X-Omni-Fallback-Hint": "connection_cooldown",
              },
            }
          ),
          url: GEMINI_URL,
          headers: {},
          transformedBody: body,
        };
      }
      return {
        response: new Response(
          JSON.stringify({
            error: sanitizeErrorMessage(rawMessage),
          }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        ),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    } finally {
      if (abortBrowser) signal?.removeEventListener("abort", abortBrowser);
      // Always close browser to prevent resource leaks
      if (browser) {
        try {
          await browser.close();
        } catch {
          /* ignore close errors */
        }
      }
    }
  }
}
