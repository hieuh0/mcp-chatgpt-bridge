# Project Overview & PDR — mcp-chatgpt-bridge

## Purpose

Expose a ChatGPT consultation tool to Claude Code so it can ask for a second opinion mid-task on design decisions, cross-checks, or approach validation. The tool is designed to complement Claude Code's reasoning by providing an independent perspective without requiring the consulting AI to have access to your repository or conversation history.

## Problem Solved

When Claude Code is deep in a coding task, it may encounter a choice point where an independent perspective would reduce risk or improve quality: "Should I use pattern A or B here?" or "Is this error approach correct?" Consulting another LLM is faster than asking the human user, but only if:

1. The consulting AI sees exactly the right context (not the whole repo or conversation).
2. The human still has a record of what was asked and what was recommended.
3. The tool doesn't interfere with Claude Code's primary workflow.

This server solves that by providing a focused, context-explicit tool that pushes results to a side-channel (Telegram/Slack) for async human review.

## In Scope

- Single tool: `ask_chatgpt(question, context, model?)` exposed over MCP stdio transport.
- Auto-routing to OpenAI or OpenRouter based on API key format.
- Truncation guards to prevent runaway token costs (60K char input limit, 20K output limit).
- Vietnamese-language replies structured as Câu hỏi / Khuyến nghị / Giải thích (question recap / recommendation / reasoning).
- Best-effort push of every consultation to Telegram and/or Slack for offline human review.
- Error mapping for common API failures (401, 429, 5xx) with user-friendly hints.
- TypeScript with Zod validation and strict type checking.

## Out of Scope

- Multiple choice models or providers (OpenAI-compatible only for now).
- Rate-limiting or cost-cap enforcement (known gap, see [Project Roadmap](./project-roadmap.md)).
- Chat/conversation history (stateless, each call is independent).
- File system access (context must be provided explicitly by caller).
- Custom system prompts (Vietnamese structure is hardcoded).
- Slack/Telegram scheduling, threading, or formatting controls.
- Persistent logging or audit trail beyond console errors.

## Success Criteria

- Tool is registered with Claude Code and callable mid-task.
- No silent API failures; errors are logged and returned clearly.
- Telegram/Slack notifications are best-effort (don't block the tool's primary response).
- Vietnamese output is consistent and readable.
- Truncation prevents accidental cost/latency spikes.

## Non-Functional Requirements

- **Latency:** Sub-second overhead for tool registration; API call latency depends on OpenAI/OpenRouter backend.
- **Reliability:** Tool can be unavailable without crashing Claude Code (MCP errors are caught and reported).
- **Portability:** Runs on Node 18+, no OS-specific dependencies.
- **Security:** API keys are passed via environment variables, never hardcoded or logged.
- **Observability:** Telegram/Slack delivery failures are logged; tool result is always returned (notification is informational).
