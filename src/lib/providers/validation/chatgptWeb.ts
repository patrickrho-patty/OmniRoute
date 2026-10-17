import {
  chatGptWebStorageStateFromCookieHeader,
  normalizeChatGptWebStorageState,
} from "@omniroute/open-sse/utils/chatgptWebExecutorAdapter.ts";

export type ChatGptWebValidationResult = {
  valid: boolean;
  error: string | null;
  unsupported: false;
};

/** Validate the encrypted-at-rest browser storage-state credential without echoing it. */
export function validateChatGptWebProvider({
  apiKey,
}: {
  apiKey?: unknown;
}): ChatGptWebValidationResult {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return {
      valid: false,
      error: "ChatGPT Web storage-state JSON or Cookie header is required",
      unsupported: false,
    };
  }

  try {
    const parsed = JSON.parse(apiKey) as unknown;
    const state = normalizeChatGptWebStorageState(parsed);
    if (state.cookies.length === 0) {
      return {
        valid: false,
        error: "ChatGPT Web browser storage state must contain first-party cookies",
        unsupported: false,
      };
    }
    return { valid: true, error: null, unsupported: false };
  } catch (error) {
    if (error instanceof SyntaxError) {
      try {
        const state = chatGptWebStorageStateFromCookieHeader(apiKey);
        return state.cookies.length > 0
          ? { valid: true, error: null, unsupported: false }
          : {
              valid: false,
              error: "ChatGPT Web Cookie header must contain cookies",
              unsupported: false,
            };
      } catch (cookieError) {
        return {
          valid: false,
          // Same principle as below: name the real reason (e.g. the missing session cookie)
          // so the operator can fix it instead of guessing what the form wants.
          error:
            cookieError instanceof Error && cookieError.message
              ? cookieError.message
              : "ChatGPT Web storage state JSON or Cookie header is invalid",
          unsupported: false,
        };
      }
    }
    return {
      valid: false,
      // Propagate the specific reason (invalid cookie / foreign origin / missing field). The old
      // catch-all said "invalid or contains foreign origins" even when the real problem was a
      // cookie missing required fields, which sent the operator chasing the wrong thing.
      error:
        error instanceof Error && error.message
          ? error.message
          : "ChatGPT Web storage state JSON is invalid or contains foreign origins",
      unsupported: false,
    };
  }
}
