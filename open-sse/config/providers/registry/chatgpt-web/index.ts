import type { RegistryEntry } from "../../shared.ts";

export const chatgpt_webProvider: RegistryEntry = {
  id: "chatgpt-web",
  alias: "cgpt-web",
  format: "openai",
  executor: "chatgpt-web",
  baseUrl: "https://chatgpt.com/backend-api/conversation",
  authType: "apikey",
  authHeader: "cookie",
  // All chatgpt.com web models accept native image input (the composer lets
  // you attach images to every model). supportsVision:true lets the vision
  // bridge SKIP describe-to-text and route images through the native upload
  // path in the chatgpt-web executor instead.
  models: [
    { id: "gpt-5.5-pro", name: "GPT-5.5 Pro", supportsVision: true }, //pro tier only
    { id: "gpt-5.5-thinking", name: "GPT-5.5 Thinking", supportsVision: true }, //plus, pro tier
    { id: "gpt-5.5", name: "GPT-5.5 Instant", supportsVision: true }, //free, plus, pro tier
    { id: "gpt-5.4-pro", name: "GPT-5.4 Pro", supportsVision: true }, //pro tier only
    { id: "gpt-5.4-thinking", name: "GPT-5.4 Thinking", supportsVision: true }, //plus, pro tier
    { id: "gpt-5.4-thinking-mini", name: "GPT-5.4 Thinking Mini", supportsVision: true }, //free-login only
    { id: "gpt-5.3", name: "GPT-5.3 Instant", supportsVision: true }, //free, free-login, plus, pro tier
    { id: "gpt-5.3-mini", name: "GPT-5.3 Mini", supportsVision: true }, //limit fallback
    { id: "gpt-5.2-pro", name: "GPT-5.2 Pro", supportsVision: true }, //pro tier only
    { id: "gpt-5.2-thinking", name: "GPT-5.2 Thinking", supportsVision: true }, //plus ~ tier
    { id: "gpt-5.2-instant", name: "GPT-5.2 Instant", supportsVision: true }, //plus ~ tier
    { id: "o3", name: "o3", supportsVision: true }, //plus ~ tier
    { id: "gpt-4-5", name: "GPT-4.5", supportsVision: true }, //pro tier only
  ],
};
