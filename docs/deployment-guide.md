# Deployment Guide — mcp-chatgpt-bridge

MCP server exposing one tool, `ask_chatgpt`, so Claude Code can consult OpenAI's ChatGPT for a second opinion. ChatGPT has no access to the repo or conversation — the caller must pass a self-contained `context` string. Every call also pushes the Q&A to Telegram/Slack (if configured) so the human can review it independently.

## Setup

```bash
cd /Users/hieuho/Desktop/mcp
npm install
npm run build
```

Set the API key (never commit it):

```bash
export OPENAI_API_KEY=sk-...
export OPENAI_MODEL=gpt-5   # optional, this is the default
export OPENAI_BASE_URL=     # optional; auto-set to OpenRouter's endpoint if OPENAI_API_KEY starts with "sk-or-"

# Optional — enable one, both, or neither. Unset = that channel is skipped silently.
export TELEGRAM_BOT_TOKEN=...   # from @BotFather
export TELEGRAM_CHAT_ID=...     # your user/chat id — message @userinfobot to get it
export SLACK_WEBHOOK_URL=...    # Slack Incoming Webhook URL
```

## Register with Claude Code

```bash
claude mcp add chatgpt-bridge -- node /Users/hieuho/Desktop/mcp/dist/index.js
```

Or add manually to Claude Code's MCP config (`~/.claude.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "chatgpt-bridge": {
      "command": "node",
      "args": ["/Users/hieuho/Desktop/mcp/dist/index.js"],
      "env": {
        "OPENAI_API_KEY": "sk-...",
        "OPENAI_MODEL": "gpt-5",
        "TELEGRAM_BOT_TOKEN": "...",
        "TELEGRAM_CHAT_ID": "...",
        "SLACK_WEBHOOK_URL": "..."
      }
    }
  }
}
```

## Rebuilding after code changes

```bash
npm run build
```

Then restart Claude Code (or the MCP client) to pick up the new `dist/index.js`.

## Tool: ask_chatgpt

| Param | Required | Description |
|---|---|---|
| `question` | yes | The concrete question to ask |
| `context` | yes | Self-contained background ChatGPT needs — code, errors, constraints. It sees nothing else. |
| `model` | no | Overrides `OPENAI_MODEL` / default `gpt-5` for this call |

## Notes

- Auto-consult is enforced via a Claude Code Stop hook (`~/.claude/hooks/ask-chatgpt-gate.cjs`, global — not part of this repo), not by this server. It blocks Claude from ending a turn with a question (plain text ending in `?`, or an `AskUserQuestion` call) until it has called `ask_chatgpt` first. Capped at 2 consecutive blocks per session to avoid an infinite loop if the tool is unavailable/broken. Bypass: `CK_ASK_CHATGPT_GATE_DISABLED=1` env var.
- `OPENAI_API_KEY` starting with `sk-or-` (OpenRouter format) is auto-routed to `https://openrouter.ai/api/v1`; a plain OpenAI key uses OpenAI's default endpoint. Override with `OPENAI_BASE_URL` for any other OpenAI-compatible provider.
- Telegram/Slack push is unconditional: every `ask_chatgpt` call attempts both, regardless of whether Claude thought the question was important. A channel with no env vars set is skipped silently (not an error).

## Unresolved questions

- Chưa quyết định: có cần rate-limit/cost-cap phía server không nếu gọi ChatGPT quá nhiều lần trong 1 session?
