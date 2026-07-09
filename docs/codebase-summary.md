# Codebase Summary

## Overview

Two TypeScript source files, ~190 lines of code total, compiled to CommonJS in `dist/`.

## Files

### `src/index.ts` (~141 LOC)

Entry point and MCP server registration.

**Key responsibilities:**
- Initialize MCP server ("chatgpt-bridge" v0.1.0).
- Register the `ask_chatgpt` tool with Zod input schema.
- Lazy-init OpenAI client with auto-routing logic.
- Truncate input/output to prevent token runaway (60K char input, 20K output).
- Call OpenAI API and handle errors with user-friendly hints.
- Push results to side-channel notification (Telegram/Slack).
- Attach stdio transport and start server.

**Key functions:**
- `truncate(text, limit, label)` — Truncate strings safely with a note.
- `getClient()` — Lazy singleton for OpenAI client, auto-routes to OpenRouter if key starts with `sk-or-`.
- Tool handler `ask_chatgpt` — Validates inputs, calls OpenAI, returns answer or error.
- `main()` — Starts MCP server on stdio.

**Key constants:**
- `DEFAULT_MODEL = "gpt-5"` (env OPENAI_MODEL, hardcoded fallback).
- `MAX_INPUT_CHARS = 60_000` (truncate context if it exceeds this).
- `MAX_OUTPUT_CHARS = 20_000` (truncate ChatGPT reply if it exceeds this).
- `OPENROUTER_KEY_PREFIX = "sk-or-"` (auto-detection for OpenRouter keys).
- `OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"`.

**Error mapping:**
- 401 → "Invalid or expired API key."
- 429 → "Rate limited; wait or reduce frequency."
- 5xx → "OpenAI backend error, not your problem, retry later."
- Other → Raw error message.

**System prompt (hardcoded Vietnamese):**
```
Always reply in Vietnamese with correct diacritics (tiếng Việt có dấu).
Structure: Câu hỏi: <recap question> / Khuyến nghị: <recommendation> / Giải thích: <reasoning>
```

### `src/notify.ts` (~46 LOC)

Best-effort side-channel push to Telegram and Slack.

**Key responsibilities:**
- Check env vars for Telegram (token + chat ID) and Slack (webhook URL).
- Truncate messages to platform limits.
- POST to Telegram Bot API and Slack Webhook URL.
- Log failures, never throw.

**Key functions:**
- `notifyTelegram(text)` — POST to `https://api.telegram.org/bot{token}/sendMessage`.
- `notifySlack(text)` — POST to webhook URL with `{text: ...}` JSON body.
- `notifyChannels(text)` — Parallel attempt both, collect errors, log any failures.

**Key constants:**
- `TELEGRAM_MESSAGE_LIMIT = 3500` (Telegram hard cap is 4096).
- `SLACK_MESSAGE_LIMIT = 8000`.

**Behavior:**
- Both channels are optional (skipped silently if env vars not set).
- Uses `Promise.allSettled()` to avoid one channel's failure blocking the other.
- Logged errors do not surface to the tool caller.

## Data Flow

1. **Claude Code** calls MCP tool `ask_chatgpt` with `{question, context, model?}`.
2. **index.ts handler** validates inputs (Zod), truncates context.
3. **OpenAI client** sends request to OpenAI API (or OpenRouter if `sk-or-` key).
4. **OpenAI API** returns answer in Vietnamese (forced by system prompt).
5. **index.ts handler** truncates answer (if needed) and invokes `notifyChannels()`.
6. **notify.ts** posts Q&A to Telegram and Slack in parallel (best-effort, no blocking).
7. **index.ts handler** returns answer to Claude Code immediately (notification is async).
8. **Claude Code** displays the tool result to the user.

## Build & Runtime

- **Build:** `npm run build` → TypeScript compiles to `dist/index.js` (ES2022 → CommonJS).
- **Runtime:** `node dist/index.js` starts the MCP server on stdio.
- **Environment vars:** Passed via `claude mcp add ... -e VAR=value` flags or `.mcp.json` env section.
- **No dotenv:** The MCP server does not load `.env` files automatically; env vars must be provided by the MCP client (Claude Code).

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@modelcontextprotocol/sdk` | ^1.13.0 | MCP server, stdio transport |
| `openai` | ^5.10.0 | OpenAI API client |
| `zod` | ^3.24.0 | Input schema validation |
| `@types/node` | ^22.10.0 | Node.js type definitions (dev) |
| `typescript` | ^5.7.0 | TypeScript compiler (dev) |

## Key Design Decisions

- **Fail-open notifications:** Telegram/Slack failures never block the tool result. The human may not see the push, but Claude Code always gets the answer.
- **Stateless:** No session state, conversation history, or caching. Each call is independent.
- **Context-explicit:** Caller must provide all context; ChatGPT sees nothing else.
- **Truncation guards:** Input and output limits prevent token runaway and cost surprises.
- **Vietnamese only:** System prompt is hardcoded to Vietnamese with fixed structure. Not configurable per-call.
- **OpenRouter auto-detect:** API key format determines endpoint automatically; no manual config needed for OpenRouter.
- **Lazy client init:** OpenAI client is created on first use, not at startup.
