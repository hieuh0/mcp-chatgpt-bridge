# mcp-chatgpt-bridge

MCP server that lets Claude Code consult ChatGPT (OpenAI) for a second opinion mid-task, with explicit context passed by the caller.

## What it does

When Claude Code is stuck on a design decision, needs a cross-check, or wants an independent opinion, it can call the `ask_chatgpt` tool to consult OpenAI's ChatGPT. ChatGPT sees only the context you provide — it has no access to your repo, files, or conversation history.

Every consultation is automatically pushed to Telegram/Slack (if configured) so you can review the advice independently later.

## Quickstart

See [Deployment Guide](./docs/deployment-guide.md) for full setup instructions.

TL;DR:
```bash
npm install && npm run build
export OPENAI_API_KEY=sk-...
claude mcp add chatgpt-bridge -- node /Users/hieuho/Desktop/mcp/dist/index.js
```

## The `ask_chatgpt` tool

```
ask_chatgpt({
  question: string,    // The specific question to ask
  context: string,     // Self-contained background ChatGPT needs
  model?: string       // Optional model override (defaults to "gpt-5")
})
```

ChatGPT responds in Vietnamese with three sections: Câu hỏi (question recap), Khuyến nghị (recommendation), Giải thích (reasoning).

## Architecture

Claude Code calls the `ask_chatgpt` MCP tool via stdio. The server forwards to OpenAI's API (or OpenRouter if you use an `sk-or-` key). The answer is returned to Claude Code and simultaneously pushed to Telegram/Slack as a side-channel for offline review.

A global Claude Code hook enforces auto-consult: Claude cannot end a turn with a question until it has called this tool first.

See [System Architecture](./docs/system-architecture.md) for a detailed diagram.

## Project Status

- **Maturity:** Demo / personal use (0.1.0)
- **Test suite:** None yet
- **CI/CD:** None yet
- **Known gap:** No rate-limit or cost-cap enforcement on `ask_chatgpt` calls

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
