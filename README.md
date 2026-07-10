# mcp-chatgpt-bridge

MCP server that lets Claude Code consult an AI advisor (OpenAI or Gemini, configurable via web dashboard) for a second opinion mid-task, with explicit context passed by the caller.

## What it does

When Claude Code is stuck on a design decision, needs a cross-check, or wants an independent opinion, it can call the `ask_chatgpt` tool to consult an AI advisor. The advisor sees only the context you provide — it has no access to your repo, files, or conversation history.

Every consultation is automatically pushed to Telegram/Slack (if configured) so you can review the advice independently later.

All configuration (API keys, active provider, web port, notify secrets) lives in a local SQLite database, managed via `npm run web` — no `.env` file needed.

## Quickstart

See [Deployment Guide](./docs/deployment-guide.md) for full setup instructions.

TL;DR:
```bash
npm install && npm run build
npm run web                         # Start the web dashboard (port 4141)
# Open http://localhost:4141, add your API key, select provider (OpenAI or Gemini)
npm run install-hooks               # restores the ask-chatgpt-gate hooks into ~/.claude (see below)
claude mcp add chatgpt-bridge -s user -- node "$(pwd)/dist/index.js"
# No -e flags needed — all config lives in the dashboard
```

## The `ask_chatgpt` tool

```
ask_chatgpt({
  question: string,    // The specific question to ask
  context: string,     // Self-contained background the AI needs
  model?: string       // Optional: override the provider's default model
})
```

The AI responds in Vietnamese with three sections: Câu hỏi (question recap), Khuyến nghị (recommendation), Giải thích (reasoning). Which provider (OpenAI or Gemini) is used is determined by the selection in the web dashboard — the tool itself always consults whoever is active.

Model precedence: if the API key picked for this call has its own model configured (set via the web dashboard — useful when a key points at a non-default endpoint like OpenRouter, whose model namespace differs from OpenAI's own), that always wins over the `model` param above. Otherwise `model` overrides the provider's default; if both are omitted, the provider's hardcoded default model is used.

## Architecture

Claude Code calls the `ask_chatgpt` MCP tool via stdio. The server:
1. Looks up the active provider (OpenAI or Gemini) from the SQLite config database.
2. Picks an enabled API key for that provider (rotating among keys, respecting cooldown periods on rate-limited keys).
3. Dispatches the call to the selected provider's implementation.
4. Logs the call outcome to the usage_events table.
5. Pushes the answer to Telegram/Slack (if configured, as a best-effort side-channel).
6. Returns the answer to Claude Code.

All API keys, settings (web port, notify secrets), and usage records live in a local SQLite database. Configuration is done via the web dashboard (`npm run web`) — no env vars or dotenv files.

Two Claude Code hooks push Claude to auto-consult: one hard-denies the `AskUserQuestion` tool call until `ask_chatgpt` has been called (the effective enforcement point), the other nags on plain-text questions ending in `?` (best-effort — no tool call to hard-block there). Both give up after 2 tries per session to avoid infinite loops, so this is a strong nudge, not a 100% guarantee.

The hook scripts live in [`hooks/`](./hooks) and are global in scope (they affect every Claude Code project on the machine, not just this repo) — `npm run install-hooks` copies them into `~/.claude/hooks` and registers them in `~/.claude/settings.json`, merging idempotently so it's safe to re-run. `hooks/lib/ck-config-utils.cjs` is a vendored snapshot of shared infra owned by a broader personal hook framework; the installer only writes it if that file doesn't already exist, so it never clobbers the live copy other unrelated hooks depend on.

See [System Architecture](./docs/system-architecture.md) for a detailed diagram.

## Project Status

- **Maturity:** Demo / personal use (0.1.0)
- **Test suite:** None yet
- **CI/CD:** None yet
- **Known gaps:** 
  - Gemini path not yet live-tested (no API key available at time of refactor completion)
  - No dashboard authentication (bare SQLite CRUD, suitable only for local single-user use)
  - usage_events table unbounded growth (no retention policy yet)

See [Project Roadmap](./docs/project-roadmap.md) for details.

## Documentation

- [Project Overview & PDR](./docs/project-overview-pdr.md) — Purpose, scope, non-goals
- [Codebase Summary](./docs/codebase-summary.md) — File-by-file breakdown and data flow
- [Code Standards](./docs/code-standards.md) — Conventions observed in this codebase
- [System Architecture](./docs/system-architecture.md) — Architecture diagram and component details
- [Deployment Guide](./docs/deployment-guide.md) — Setup, registration, environment variables
- [Project Roadmap](./docs/project-roadmap.md) — Current state and open items

## License

See LICENSE file if present.
