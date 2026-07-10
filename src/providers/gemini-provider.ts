import { GoogleGenAI } from "@google/genai";
import type { AskParams, AskResult, Provider } from "./provider-interface.js";
import { ADVISOR_SYSTEM_PROMPT } from "./system-prompt.js";

export const DEFAULT_MODEL = "gemini-2.5-flash";

export const geminiProvider: Provider = {
  // `baseURL` is unused here — unlike the OpenAI SDK, the Gemini SDK has no
  // OpenRouter-style proxy base URL to route through.
  async ask({ question, context, model, apiKey }: AskParams): Promise<AskResult> {
    const ai = new GoogleGenAI({ apiKey });

    const response = await ai.models.generateContent({
      model,
      contents: `Context:\n${context}\n\nQuestion:\n${question}`,
      config: { systemInstruction: ADVISOR_SYSTEM_PROMPT },
    });

    return {
      text: response.text || "(empty response)",
      usage: {
        promptTokens: response.usageMetadata?.promptTokenCount ?? 0,
        completionTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
        totalTokens: response.usageMetadata?.totalTokenCount ?? 0,
      },
    };
  },
};
