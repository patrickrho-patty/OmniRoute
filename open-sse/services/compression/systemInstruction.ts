export interface SystemInstructionMessage {
  role: string;
  content?: string | unknown[];
  [key: string]: unknown;
}

export interface SystemInstructionBody {
  messages?: SystemInstructionMessage[];
  instructions?: string;
  input?: unknown;
  [key: string]: unknown;
}

export interface SystemInstructionResult {
  body: SystemInstructionBody;
  applied: boolean;
  skippedReason?: "already_applied" | "no_messages";
}

export function bodyHasSystemInstructionMarker(
  body: SystemInstructionBody,
  marker: string
): boolean {
  if (typeof body.instructions === "string" && body.instructions.includes(marker)) {
    return true;
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.some(
    (message) =>
      message.role === "system" &&
      typeof message.content === "string" &&
      message.content.includes(marker)
  );
}

export function injectSystemInstruction(
  body: SystemInstructionBody,
  instruction: string
): SystemInstructionResult {
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || messages.length === 0) {
    if (typeof body.instructions === "string") {
      const prefix = body.instructions.trim();
      return {
        body: { ...body, instructions: prefix ? `${prefix}\n\n${instruction}` : instruction },
        applied: true,
      };
    }
    if (typeof body.input === "string" || Array.isArray(body.input)) {
      return { body: { ...body, instructions: instruction }, applied: true };
    }
    return { body, applied: false, skippedReason: "no_messages" };
  }

  const nextMessages = [...messages];
  const first = nextMessages[0];
  if (first?.role === "system" && typeof first.content === "string") {
    nextMessages[0] = { ...first, content: `${first.content.trim()}\n\n${instruction}` };
  } else {
    nextMessages.unshift({ role: "system", content: instruction });
  }

  return { body: { ...body, messages: nextMessages }, applied: true };
}

export function injectSystemInstructionOnce(
  body: SystemInstructionBody,
  marker: string,
  instruction: string
): SystemInstructionResult {
  if (bodyHasSystemInstructionMarker(body, marker)) {
    return { body, applied: false, skippedReason: "already_applied" };
  }
  return injectSystemInstruction(body, instruction);
}
