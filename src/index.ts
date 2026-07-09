#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import OpenAI from "openai";
import { notifyChannels } from "./notify.js";

const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-5";
// Keep prompt + answer within a sane token budget so a single call can't blow up cost/latency.
const MAX_INPUT_CHARS = 60_000;
const MAX_OUTPUT_CHARS = 20_000;

function truncate(text: string, limit: number, label: string): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[...truncated, ${label} exceeded ${limit} chars...]`;
}

// OpenRouter issues keys with this prefix; auto-route to its endpoint so an
// OpenRouter key doesn't silently hit api.openai.com (wrong host = 401).
const OPENROUTER_KEY_PREFIX = "sk-or-";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

let client: OpenAI | undefined;
function getClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set. Set the OPENAI_API_KEY environment variable for this MCP server (see docs/deployment-guide.md), then retry."
    );
  }
  if (!client) {
    const baseURL =
      process.env.OPENAI_BASE_URL ||
      (apiKey.startsWith(OPENROUTER_KEY_PREFIX) ? OPENROUTER_BASE_URL : undefined);
    client = new OpenAI({ apiKey, baseURL });
  }
  return client;
}

const server = new McpServer({ name: "chatgpt-bridge", version: "0.1.0" });

server.registerTool(
  "ask_chatgpt",
  {
    title: "Ask ChatGPT",
    description:
      "Consult ChatGPT (OpenAI) for a second opinion on a question. " +
      "ChatGPT has NO access to this conversation, the repo, or any files — it only sees exactly what you " +
      "put in `context`. Before calling this tool, write `context` as a self-contained brief: the relevant " +
      "code/config snippets, error messages, prior decisions, and constraints needed to answer correctly. " +
      "A vague or missing context will produce a generic, unhelpful answer. " +
      "Use this for: getting an independent opinion, cross-checking a design decision, or comparing approaches. " +
      "Do not use this for: tasks requiring live access to this repo's current file state (ChatGPT can't read files itself).",
    inputSchema: {
      question: z
        .string()
        .min(1)
        .describe(
          "The specific question to ask ChatGPT. Be concrete, e.g. 'Which retry backoff strategy fits a rate-limited webhook consumer?' " +
            "If this comes from a multi-choice question (e.g. AskUserQuestion) with several options, include ALL of " +
            "them verbatim here — do not summarize or drop any option."
        ),
      context: z
        .string()
        .min(1)
        .describe(
          "Self-contained background ChatGPT needs to answer well: relevant code snippets, error text, " +
            "architecture constraints, what's already been tried. ChatGPT sees nothing beyond this text."
        ),
      model: z
        .string()
        .optional()
        .describe(`OpenAI model override. Defaults to "${DEFAULT_MODEL}" (env OPENAI_MODEL) if omitted.`),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ question, context, model }) => {
    try {
      const openai = getClient();
      const safeContext = truncate(context, MAX_INPUT_CHARS, "context");

      const response = await openai.responses.create({
        model: model || DEFAULT_MODEL,
        input: [
          {
            role: "system",
            content:
              "You are being consulted by another AI coding assistant (Claude Code) for a second opinion. " +
              "You have no access to their repo, files, or conversation beyond the context given below. " +
              "Base your answer only on that context; state explicitly if it's insufficient to answer " +
              "confidently instead of guessing.\n\n" +
              "Always reply in Vietnamese with correct diacritics (tiếng Việt có dấu), even if the question " +
              "or context is in English — translate as needed. Structure the reply as exactly these three " +
              "sections, each on its own line(s):\n" +
              "Câu hỏi: <nhắc lại đầy đủ câu hỏi bằng tiếng Việt, dịch nếu bản gốc là tiếng khác, giữ đủ mọi " +
              "lựa chọn nếu là câu hỏi nhiều lựa chọn>\n" +
              "Khuyến nghị: <đề xuất rõ ràng, ngắn gọn>\n" +
              "Giải thích: <lý do cho đề xuất đó>",
          },
          {
            role: "user",
            content: `Context:\n${safeContext}\n\nQuestion:\n${question}`,
          },
        ],
      });

      const answer = truncate(response.output_text || "(empty response)", MAX_OUTPUT_CHARS, "answer");
      // Best-effort — delivery failures are logged inside notifyChannels, never surfaced here.
      // `answer` already carries the Câu hỏi/Khuyến nghị/Giải thích structure in Vietnamese.
      await notifyChannels(`🤖 ChatGPT tư vấn\n\n${answer}`);
      return { content: [{ type: "text" as const, text: answer }] };
    } catch (err) {
      const apiErr = err as { status?: number; message?: string };
      let hint = apiErr.message || String(err);
      if (apiErr.status === 401) {
        hint = "OpenAI rejected the API key (401). Check OPENAI_API_KEY is valid and not expired.";
      } else if (apiErr.status === 429) {
        hint = "OpenAI rate-limited this request (429). Wait a few seconds and retry, or reduce call frequency.";
      } else if (apiErr.status && apiErr.status >= 500) {
        hint = `OpenAI service error (${apiErr.status}). Retry shortly; this is not a problem with the request.`;
      }
      return { content: [{ type: "text" as const, text: `ask_chatgpt failed: ${hint}` }], isError: true };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error starting mcp-chatgpt-bridge:", err);
  process.exit(1);
});
