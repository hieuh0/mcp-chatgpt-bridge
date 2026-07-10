import OpenAI from "openai";
import type { AskParams, AskResult, Provider } from "./provider-interface.js";
import { ADVISOR_SYSTEM_PROMPT } from "./system-prompt.js";

export const DEFAULT_MODEL = "gpt-5";

// OpenRouter issues keys with this prefix; auto-route to its endpoint so an
// OpenRouter key doesn't silently hit api.openai.com (wrong host = 401).
const OPENROUTER_KEY_PREFIX = "sk-or-";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

// `undefined` here (not a concrete default string) is deliberate: the OpenAI SDK only
// consults the `OPENAI_BASE_URL` env var when `baseURL` is omitted from its constructor.
// Forcing a concrete string — even one equal to the SDK's own default — would silently
// disable that fallback for anyone relying on it without a per-key baseURL set.
export function resolveOpenAIBaseURL(apiKey: string, baseURL?: string): string | undefined {
  return baseURL ?? (apiKey.startsWith(OPENROUTER_KEY_PREFIX) ? OPENROUTER_BASE_URL : undefined);
}

export const openaiProvider: Provider = {
  async ask({ question, context, model, apiKey, baseURL }: AskParams): Promise<AskResult> {
    const client = new OpenAI({ apiKey, baseURL: resolveOpenAIBaseURL(apiKey, baseURL) });

    const response = await client.responses.create({
      model,
      input: [
        { role: "system", content: ADVISOR_SYSTEM_PROMPT },
        { role: "user", content: `Context:\n${context}\n\nQuestion:\n${question}` },
      ],
    });

    return {
      text: response.output_text || "(empty response)",
      usage: {
        promptTokens: response.usage?.input_tokens ?? 0,
        completionTokens: response.usage?.output_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
      },
    };
  },
};
