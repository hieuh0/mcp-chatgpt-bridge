# Deployment Guide — mcp-chatgpt-bridge

MCP server exposing one tool, `ask_chatgpt`, so Claude Code can consult an AI advisor (OpenAI or Gemini, configurable) for a second opinion. The advisor has no access to the repo or conversation — the caller must pass a self-contained `context` string. Every call also pushes the Q&A to Telegram/Slack (if configured) so the human can review it independently.

All configuration (API keys, active provider, web dashboard port, notify secrets) lives in a local SQLite database (`data.sqlite` at the repo root) and is managed exclusively via the web dashboard. **The `.env` file is not read by this project.**

## Build & Run

```bash
cd /Users/hieuho/Desktop/mcp
npm install
npm run build
npm run web          # Starts the dashboard on http://localhost:4141 (default port)
```

Open your browser to `http://localhost:4141` and:
1. Add API keys (OpenAI, Gemini, or both).
2. Select which provider is active.
3. (Optional) Configure Telegram and Slack notify secrets.
4. (Optional) Change the web dashboard port (requires restarting `npm run web`).

## Register with Claude Code

```bash
claude mcp add chatgpt-bridge -s user -- node /Users/hieuho/Desktop/mcp/dist/index.js
```

No `-e` flags needed — all config is managed by the dashboard and stored in SQLite.

`-s user` makes it available in every project on this machine.

Or add manually to Claude Code's MCP config (`~/.claude.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "chatgpt-bridge": {
      "command": "node",
      "args": ["/Users/hieuho/Desktop/mcp/dist/index.js"]
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
| `context` | yes | Self-contained background the AI needs — code, errors, constraints. It sees nothing else. |
| `model` | no | Optional: Override the active provider's default model for this call (e.g., use `gpt-4` instead of `gpt-5` for OpenAI, or `gemini-2.0-pro` instead of `gemini-2.5-flash` for Gemini) |

## API Keys & Providers

The dashboard supports multiple keys per provider. When a call is made:
1. The server picks the active provider (set in dashboard).
2. Among enabled keys for that provider, it picks the least-recently-used key that isn't in cooldown.
3. If a call gets rate-limited (429), that key enters a 60-second cooldown, and the next call tries another key.
4. Any failure (401, 5xx, other, not just 429) updates that key's `last_used_at`, pushing it to the back of the rotation so the next call tries a different key. Only 429 additionally applies the 60s cooldown — a real rate-limit signal, unlike a plain rotation nudge.

**OpenAI:** Supports both direct OpenAI keys (`sk-...`) and OpenRouter keys (`sk-or-...`). OpenRouter is auto-detected by the key prefix.

**Gemini:** Uses `@google/genai` SDK. Obtain API keys from Google AI Studio.

## Web Dashboard Features

| Feature | Details |
|---------|---------|
| **Add key** | Label, API key value, optional base URL (OpenAI-only, for compatible endpoints like OpenRouter), optional model (both providers; overrides tool param and DEFAULT_MODEL) |
| **Fetch models** | OpenAI-only button next to the Model field (Add-key form and row Edit mode) — calls the target endpoint's model-list API server-side and suggests results via a `<datalist>`; free-text entry still works if the fetch fails or isn't used. Includes SSRF/DNS-rebinding hardening (target IP pinning). |
| **Edit key** | Change label, base URL, or model on an existing key without deleting/recreating it |
| **Enable/disable key** | Toggle whether a key is eligible for rotation |
| **View masked keys** | Shows only the last 4 characters for security |
| **Active provider** | Switch between OpenAI and Gemini (affects all `ask_chatgpt` calls until changed) |
| **Usage stats** | Total calls, tokens, by provider and by key |
| **Activity log (today)** | View today's full activity log with timestamps, components, and message details. "Sync" button refreshes the log from the current file. Includes all API calls, HTTP requests, and errors. |
| **Notify secrets** | Set Telegram (bot token + chat ID) and Slack (webhook URL) — both optional |
| **Dashboard port** | Change the port (default 4141); requires restarting `npm run web` to take effect |

## Notes on Configuration

- **No env vars for API keys.** All provider keys, active provider selection, and secrets are stored in SQLite and managed via the web dashboard. The project does not read `.env` files.
- **Legacy env bootstrap (one-time only).** On first startup, the server checks for these optional env vars and seeds them into the SQLite settings table only if that setting doesn't already exist:
  - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `SLACK_WEBHOOK_URL`, `WEB_CONFIG_PORT` — if set and the dashboard hasn't been used yet, these values are imported into the database. After that, all configuration goes through the dashboard; env vars are never consulted again for these settings.
- **OpenRouter auto-detection.** OpenAI keys starting with `sk-or-` (OpenRouter format) are automatically routed to `https://openrouter.ai/api/v1`. For custom OpenAI-compatible endpoints, use the dashboard's optional "base URL" field per key.
- **Per-key model configuration.** When set via the dashboard for a specific key, the `model` field overrides both the DEFAULT_MODEL and the `model` param passed to the `ask_chatgpt` tool call. Useful when a key is bound to a specific endpoint (like OpenRouter or a custom proxy) with its own model namespace. Omit to use DEFAULT_MODEL (gpt-5 for OpenAI, gemini-2.5-flash for Gemini) or the tool's `model` param.
- **Telegram/Slack push.** Every `ask_chatgpt` call attempts to push the Q&A to both channels (if secrets are configured). A missing secret skips that channel silently (not an error). Delivery failures are logged to the daily activity log file (`logs/YYYY-MM-DD.log`) but never block the tool result.

## Auto-Consult Hooks

Auto-consult is enforced by two Claude Code hooks, not by this server. Source lives in this repo under [`hooks/`](../hooks); `npm run install-hooks` installs them into `~/.claude/hooks/` and registers them in `~/.claude/settings.json` (idempotent — safe to re-run, and on a new machine this is the only manual step needed to restore the behavior). They're global in scope: once installed they affect every Claude Code project on the machine, not just this repo.

- `ask-chatgpt-pretool-gate.cjs` (PreToolUse, matcher `AskUserQuestion`) — **denies the tool call outright** if `ask_chatgpt` hasn't been called yet, so the question never reaches the user until Claude complies. This is the effective enforcement point; verified working end-to-end (2026-07-09).
- `ask-chatgpt-gate.cjs` (Stop) — nags Claude to call `ask_chatgpt` before ending a turn with plain text ending in `?` (no tool call exists there to hard-block, so this is best-effort only).
- Both cap at 2 consecutive blocks/denials per session, then let the turn through anyway, to avoid an infinite loop if the tool is unavailable/broken or the model just won't comply. So this is **not a 100% guarantee** — plain-text questions in particular can still slip through uncommented. Bypass: `CK_ASK_CHATGPT_GATE_DISABLED=1` env var, or `.ck.json` → `hooks."ask-chatgpt-gate": false` — run `npm run disable-ask-chatgpt-gate` to set the latter (creates `~/.claude/.ck.json` if it doesn't exist yet, merges the single key in otherwise; `--enable` flips it back, `--dry-run` previews).
- `hooks/lib/ck-config-utils.cjs` is a vendored snapshot of shared infra owned by a broader personal hook framework (12+ unrelated hooks depend on the live copy). `install-hooks.cjs` only writes it if missing at the destination, so it never clobbers a newer version other hooks rely on.

## Keeping the Dashboard Running

The web dashboard (`npm run web`) is a stateless Express server that reads/writes to SQLite. It runs on port 4141 by default (configurable via the dashboard itself, though port changes require restarting the server).

For long-term use, you may want to keep the dashboard always running. A process supervisor (e.g., `pm2`, macOS `launchd`, systemd on Linux) can restart it if it crashes, but this is optional — the MCP server itself works independently once configuration is set.

Example with pm2 (if installed):
```bash
pm2 start "npm run web" --name "mcp-chatgpt-dashboard"
pm2 save
pm2 startup   # generates a launchd/systemd script to auto-start on reboot
```

This project does not provide a built-in daemon mode.
