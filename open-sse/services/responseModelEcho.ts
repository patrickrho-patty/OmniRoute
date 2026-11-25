/**
 * #1311: echo the client-requested model/alias name back in the response.
 *
 * When a request uses an alias or combo (e.g. `claude-sonnet-cx` → `cx/gpt-5.5`),
 * OmniRoute forwards the upstream model name (`gpt-5.5`) in the response `model`
 * field. Strict clients (e.g. Claude Desktop) validate that the response model
 * matches the request and reject the mismatch with a 401. This opt-in helper
 * rewrites the `model` field back to the name the client asked for.
 *
 * The behavior is gated by a global setting (`echoRequestedModelName`, default off),
 * so the default response stays byte-for-byte unchanged.
 *
 * Three payload shapes carry the model, and all three must be rewritten or a client
 * still sees the upstream id:
 *   - `{ model }`                  — Chat Completions JSON / OpenAI SSE chunks
 *   - `{ response: { model } }`     — Responses API events (#3697)
 *   - `{ message: { model } }`      — Anthropic Messages streaming `message_start`
 *     (and every later `message_*` event is model-less, so this is the only leak site)
 */

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Rewrite every known model location on one parsed payload in place.
 * Returns whether anything changed (the SSE path needs to know to re-serialize).
 */
function applyEchoToRecord(rec: JsonRecord, echoModel: string): boolean {
  let changed = false;

  if (typeof rec.model === "string") {
    rec.model = echoModel;
    changed = true;
  }

  // #3697: Responses API events nest the model under `response.model`.
  if (isRecord(rec.response) && typeof rec.response.model === "string") {
    rec.response.model = echoModel;
    changed = true;
  }

  // Anthropic Messages streaming: `message_start` nests the model under
  // `message.model` (`event: message_start` + `data: { type: "message_start", message:
  // { type: "message", model: "<upstream>" } }`). Rewriting only the top level left the
  // upstream id visible to every Claude Code / Claude Desktop stream. The guard keeps
  // unrelated payloads that happen to hold a `message.model` untouched.
  if (isRecord(rec.message)) {
    const isAnthropicMessage = rec.type === "message_start" || rec.message.type === "message";
    if (isAnthropicMessage && typeof rec.message.model === "string") {
      rec.message.model = echoModel;
      changed = true;
    }
  }

  return changed;
}

/**
 * Rewrite the `model` field of a parsed response object (Chat Completions JSON, an OpenAI
 * SSE chunk, a Responses API event, or an Anthropic `message_start`) to `echoModel`.
 * Mutates and returns `obj`. No-op when `echoModel` is falsy or no known model field is a
 * string.
 *
 * #3697: the Responses API nests `model` one level down — `{ type: "response.completed",
 * response: { model, ... } }` — so also rewrite `obj.response.model` when present. This is
 * what lets the Codex CLI compatibility shim echo the requested effort-suffixed model id
 * (e.g. `gpt-5.5-xhigh`) in `response.created`/`response.completed` payloads.
 */
export function echoModelInObject(obj: unknown, echoModel: string | null | undefined): unknown {
  if (!echoModel) return obj;
  if (isRecord(obj)) applyEchoToRecord(obj, echoModel);
  return obj;
}

/**
 * Rewrite the `model` field inside a single SSE line. Only `data: {json}` lines that
 * carry a string `model` are rewritten; `data: [DONE]`, comments, event lines, and
 * unparseable payloads pass through untouched.
 */
export function echoModelInSseLine(line: string, echoModel: string | null | undefined): string {
  if (!echoModel) return line;
  if (!line.startsWith("data:")) return line;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]" || payload[0] !== "{") return line;
  try {
    const parsed = JSON.parse(payload) as JsonRecord;
    // #3697 (Responses API `response.model`) and the Anthropic Messages
    // `message_start` `message.model` are both handled by the shared helper — see
    // echoModelInObject.
    if (!applyEchoToRecord(parsed, echoModel)) return line;
    return `data: ${JSON.stringify(parsed)}`;
  } catch {
    return line;
  }
}

/**
 * A TransformStream that rewrites the `model` field in every SSE `data:` chunk of a
 * UTF-8 byte stream to `echoModel`. Buffers across chunk boundaries so a `data:` frame
 * split across two reads is still rewritten correctly. Used as the final pipe stage of
 * the streaming response when the echo setting is on.
 */
export function createModelEchoTransform(echoModel: string | null | undefined): TransformStream {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      // Emit complete lines; keep the trailing partial line in the buffer.
      const lastNewline = buffer.lastIndexOf("\n");
      if (lastNewline === -1) return;
      const ready = buffer.slice(0, lastNewline + 1);
      buffer = buffer.slice(lastNewline + 1);
      const rewritten = ready
        .split("\n")
        .map((line) => echoModelInSseLine(line, echoModel))
        .join("\n");
      controller.enqueue(encoder.encode(rewritten));
    },
    flush(controller) {
      const tail = buffer + decoder.decode();
      if (tail) controller.enqueue(encoder.encode(echoModelInSseLine(tail, echoModel)));
    },
  });
}
