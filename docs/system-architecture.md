# System Architecture

## Overview

mcp-chatgpt-bridge is a lightweight MCP server that bridges Claude Code and OpenAI, with a side-channel to Telegram/Slack for human review.

## Component Diagram

```
┌─────────────────────┐
│   Claude Code       │
│  (MCP Client)       │
└──────────┬──────────┘
           │
           │ (MCP call: ask_chatgpt)
           │ stdio transport
           ▼
┌──────────────────────────────┐
│  mcp-chatgpt-bridge Server   │
│                              │
│  ┌──────────────────────┐    │
│  │  index.ts            │    │
│  │  - Tool registration │    │
│  │  - Input validation  │    │
│  │  - Truncation guards │    │
│  │  - Error mapping     │    │
│  └──────────┬───────────┘    │
│             │                 │
│  ┌──────────▼───────────┐    │
│  │  notify.ts           │    │
│  │  - Telegram push     │    │
│  │  - Slack push        │    │
│  │  - Best-effort retry │    │
│  └──────────────────────┘    │
└──────────┬────────────────────┘
           │
           │ (MCP result)
           │ (stdio)
           │
     ┌─────┴──────┐
     │            │
     ▼            ▼
Claude Code  → Telegram
(answer)     (Q&A,
             async)
             │
             └──→ Slack
                  (Q&A,
                   async)
```

Additional (external, global):

```
┌────────────────────────────────────────────────┐
│  Claude Code Global Hooks                      │
│  (~/.claude/hooks/ask-chatgpt-gate.cjs)        │
│  (~/.claude/hooks/ask-chatgpt-pretool-gate.cjs)│
│                                                │
│  Enforces: Claude MUST call ask_chatgpt       │
│  before ending a turn with a question.        │
│  (Plain-text ?-ending or AskUserQuestion tool)│
│  Capped at 2 blocks per session to avoid loop.│
└────────────────────────────────────────────────┘
```

## Data Flow: ask_chatgpt Call

### Sequence

1. **Claude Code** decides to consult ChatGPT.
2. **Claude Code** calls MCP tool `ask_chatgpt(question, context, model?)` over stdio.
3. **MCP Server** receives call on stdin.
4. **index.ts handler:**
   - Validates `question` and `context` with Zod.
   - Truncates `context` to 60K chars (note: input limit is generous).
   - Fetches or creates OpenAI client:
     - If env `OPENAI_API_KEY` starts with `sk-or-`, auto-route to `https://openrouter.ai/api/v1`.
     - Otherwise, use OpenAI's default endpoint (or override with `OPENAI_BASE_URL`).
   - Calls `openai.responses.create()` with system prompt (Vietnamese, fixed structure).
   - **Error path (if API call fails):**
     - Catches exception.
     - Maps HTTP status to user-friendly hint (401 → key invalid, 429 → rate limited, 5xx → backend error).
     - Returns error result to Claude Code immediately.
   - **Success path:**
     - Receives answer from OpenAI.
     - Truncates answer to 20K chars.
     - **Fire-and-forget:** Calls `notifyChannels(answer)` asynchronously.
     - Returns result to Claude Code (does not wait for notification).
5. **notify.ts (in parallel):**
   - Checks env vars for Telegram (token + chat ID) and Slack (webhook URL).
   - Attempts `notifyTelegram()` and `notifySlack()` in parallel using `Promise.allSettled()`.
   - Each POST:
     - Truncates to platform limit (Telegram 3500, Slack 8000).
     - POSTs to platform API.
     - If response is not OK, logs error to console.
   - Resolves (never throws).
6. **Claude Code** receives answer on stdout and displays to user.
7. **Human** (asynchronously) reviews notification in Telegram/Slack if available.

### Error Handling

- **Missing `OPENAI_API_KEY`:** Tool throws error at first call; user must set env var and restart MCP server.
- **Invalid API key (401):** Error returned to Claude Code with hint.
- **Rate limited (429):** Error returned with hint to wait and retry.
- **OpenAI backend error (5xx):** Error returned with hint that it's not the client's fault.
- **Telegram/Slack delivery fails:** Error logged to console (server-side); tool result is unaffected.
- **Network timeout:** Depends on OpenAI SDK default; may appear as generic error.

## Key Design Decisions

### Why Truncation Guards?

Prevents accidental token runaway. If a user passes a 200MB context by mistake, the tool truncates at 60K and notes the truncation in the output. This avoids surprise API calls that would cost thousands of tokens.

### Why Best-Effort Notifications?

Telegram and Slack are informational side-channels. If they fail, Claude Code's response is already cached and returned; delaying or failing the primary response would be worse. Failures are logged for debugging but never surfaced to the MCP client.

### Why Vietnamese Output?

System prompt hardcodes Vietnamese replies with a structured format (Câu hỏi / Khuyến nghị / Giải thích). This is a deliberate product decision for a Vietnamese-speaking user. Not configurable per-call.

### Why Auto-routing for OpenRouter?

OpenRouter and OpenAI both expose OpenAI-compatible APIs but use different endpoints. Detecting the key format (`sk-or-` prefix) and auto-routing eliminates manual config, reducing user error.

### Why Lazy Client Init?

If the OpenAI API is temporarily unavailable, the MCP server can still start. The error only surfaces when the tool is actually called. This allows Claude Code to start and use other MCP servers even if ChatGPT is down.

### Why Stdio Transport?

MCP requires a transport. Stdio is simple, works in all environments, and integrates seamlessly with Claude Code's MCP client.

## Statelessness

The server maintains no conversation history, session state, or caching. Each `ask_chatgpt` call is independent:

- No memory of previous questions.
- No session token or conversation ID.
- All context must be provided by the caller.

This simplifies the implementation and prevents accidental data leaks across unrelated asks.

## Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `OPENAI_API_KEY` | Yes | None | OpenAI/OpenRouter API key |
| `OPENAI_MODEL` | No | `gpt-5` | Model to use (can be overridden per-call) |
| `OPENAI_BASE_URL` | No | Detected or OpenAI | API endpoint (auto-set for `sk-or-` keys) |
| `TELEGRAM_BOT_TOKEN` | No | Unset (skip) | Telegram bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | No | Unset (skip) | Telegram chat/user ID (message @userinfobot) |
| `SLACK_WEBHOOK_URL` | No | Unset (skip) | Slack Incoming Webhook URL |

## Integration with Claude Code

The MCP server is registered via `claude mcp add` or manually in `.mcp.json`:

```json
{
  "mcpServers": {
    "chatgpt-bridge": {
      "command": "node",
      "args": ["/path/to/dist/index.js"],
      "env": { "OPENAI_API_KEY": "sk-...", ... }
    }
  }
}
```

Claude Code then:
1. Spawns the server process.
2. Communicates via stdio.
3. Calls `ask_chatgpt` tool when needed (or via the global gate hook).

## Global Hook Enforcement

The auto-consult behavior is *not* built into this server. Instead, a global Claude Code hook (`~/.claude/hooks/ask-chatgpt-gate.cjs`) enforces that Claude cannot end a turn with a question unless it has called this tool first.

This separation of concerns keeps the MCP server simple and allows the hook to be updated independently.

See your Claude Code settings (`~/.claude/settings.json`) for hook status and `CK_ASK_CHATGPT_GATE_DISABLED` env var to disable.
