#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { notifyChannels } from "./notify.js";
import * as keyStore from "./config/key-store.js";
import { migrateAppSettings } from "./config/app-settings.js";
import { openaiProvider, DEFAULT_MODEL as OPENAI_DEFAULT_MODEL } from "./providers/openai-provider.js";
import { geminiProvider, DEFAULT_MODEL as GEMINI_DEFAULT_MODEL } from "./providers/gemini-provider.js";
import { appendUsageEvent } from "./usage/usage-logger.js";

// Keep prompt + answer within a sane token budget so a single call can't blow up cost/latency.
const MAX_INPUT_CHARS = 60_000;
const MAX_OUTPUT_CHARS = 20_000;
const COOLDOWN_MS_ON_429 = 60_000;

function truncate(text: string, limit: number, label: string): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[...truncated, ${label} exceeded ${limit} chars...]`;
}

function classifyErrorKind(status: number | undefined): string {
  if (status === 401) return "401";
  if (status === 429) return "429";
  if (status !== undefined && status >= 500) return "5xx";
  return "other";
}

const server = new McpServer({ name: "chatgpt-bridge", version: "0.1.0" });

server.registerTool(
  "ask_chatgpt",
  {
    title: "Ask ChatGPT",
    description:
      "Consult an AI advisor (OpenAI or Gemini, chosen server-side via the local web dashboard) " +
      "for a second opinion on a question. The advisor has NO access to this conversation, the repo, " +
      "or any files — it only sees exactly what you put in `context`. Before calling this tool, write " +
      "`context` as a self-contained brief: the relevant code/config snippets, error messages, prior " +
      "decisions, and constraints needed to answer correctly. A vague or missing context will produce " +
      "a generic, unhelpful answer. " +
      "Use this for: getting an independent opinion, cross-checking a design decision, or comparing approaches. " +
      "Do not use this for: tasks requiring live access to this repo's current file state (the advisor can't read files itself).",
    inputSchema: {
      question: z
        .string()
        .min(1)
        .describe(
          "The specific question to ask. Be concrete, e.g. 'Which retry backoff strategy fits a rate-limited webhook consumer?' " +
            "If this comes from a multi-choice question (e.g. AskUserQuestion) with several options, include ALL of " +
            "them verbatim here — do not summarize or drop any option."
        ),
      context: z
        .string()
        .min(1)
        .describe(
          "Self-contained background the advisor needs to answer well: relevant code snippets, error text, " +
            "architecture constraints, what's already been tried. The advisor sees nothing beyond this text."
        ),
      model: z
        .string()
        .optional()
        .describe(
          `Model override. Ignored if the API key picked for this call has its own configured model ` +
            `(set via the web dashboard) — that always wins. Otherwise defaults to the active provider's ` +
            `configured model ("${OPENAI_DEFAULT_MODEL}" for OpenAI, "${GEMINI_DEFAULT_MODEL}" for Gemini) if omitted.`
        ),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ question, context, model }) => {
    const provider = keyStore.getActiveProvider(); // reads fresh from disk, no held snapshot
    const picked = keyStore.pickKeyForCall(provider);
    if (!picked) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `ask_chatgpt failed: no enabled ${provider} key available. ` +
              "Add one via the local web dashboard (npm run web), see docs/deployment-guide.md.",
          },
        ],
        isError: true,
      };
    }

    // Resolved once, reused for both the actual call and the usage log — an omitted
    // `model` param must not send `model: undefined` to the SDK while the log claims a
    // different model was used.
    //
    // Precedence: the picked key's own configured model (dashboard-set) always wins over
    // this call's `model` param — a key pointed at a non-default endpoint (e.g. OpenRouter,
    // a self-hosted proxy) has a model namespace tied to that endpoint, so letting the
    // caller freely override risks sending a model string invalid for it.
    const modelToUse =
      picked.key.model || model || (provider === "openai" ? OPENAI_DEFAULT_MODEL : GEMINI_DEFAULT_MODEL);
    const impl = provider === "openai" ? openaiProvider : geminiProvider;
    const safeContext = truncate(context, MAX_INPUT_CHARS, "context");

    try {
      const result = await impl.ask({
        question,
        context: safeContext,
        model: modelToUse,
        apiKey: picked.key.value,
        baseURL: picked.key.baseURL,
      });
      const answer = truncate(result.text, MAX_OUTPUT_CHARS, "answer");

      // recordCallOutcome does its own fresh SQL statement — it does not reuse `picked` or
      // any config snapshot held across the `await` above, so a concurrent web-dashboard
      // edit made during the call is not clobbered.
      keyStore.recordCallOutcome(provider, picked.key.id, { success: true });
      appendUsageEvent({
        ts: new Date().toISOString(),
        provider,
        keyId: picked.key.id,
        label: picked.key.label,
        model: modelToUse,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        totalTokens: result.usage.totalTokens,
        ok: true,
      });

      // Best-effort — delivery failures are logged inside notifyChannels, never surfaced here.
      await notifyChannels(`🤖 ${provider} tư vấn\n\n${answer}`);
      return { content: [{ type: "text" as const, text: answer }] };
    } catch (err) {
      const apiErr = err as { status?: number; message?: string };
      const errorKind = classifyErrorKind(apiErr.status);
      let hint = apiErr.message || String(err);
      if (errorKind === "401") {
        hint = `${provider} rejected the API key (401). Check the key is valid and not expired in the web dashboard.`;
      } else if (errorKind === "429") {
        hint = `${provider} rate-limited this request (429). Wait a few seconds and retry, or reduce call frequency.`;
      } else if (errorKind === "5xx") {
        hint = `${provider} service error (${apiErr.status}). Retry shortly; this is not a problem with the request.`;
      }

      // Every failure updates last_used_at, pushing this key to the back of the LRU
      // rotation so the next call tries a different key instead of retrying the same
      // broken one indefinitely. Only 429 additionally sets a cooldown — a real rate-limit
      // signal worth pausing on, unlike a plain rotation nudge.
      keyStore.recordCallOutcome(provider, picked.key.id, {
        success: false,
        cooldownUntil:
          errorKind === "429" ? new Date(Date.now() + COOLDOWN_MS_ON_429).toISOString() : undefined,
      });

      appendUsageEvent({
        ts: new Date().toISOString(),
        provider,
        keyId: picked.key.id,
        label: picked.key.label,
        model: modelToUse,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        ok: false,
        errorKind,
      });

      return { content: [{ type: "text" as const, text: `ask_chatgpt failed: ${hint}` }], isError: true };
    }
  }
);

async function main() {
  keyStore.ensureMigrated();
  migrateAppSettings();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error starting mcp-chatgpt-bridge:", err);
  process.exit(1);
});
