# Codebase Summary

## Overview

Refactored TypeScript server (~1440 LOC total across src/, excluding node_modules). Dual-provider AI advisor (OpenAI + Gemini) with SQLite config, web dashboard, usage tracking, and MCP stdio interface.

## Core Files

### `src/index.ts` (~185 LOC)

**MCP entry point and main tool handler.**

**Key responsibilities:**
- Initialize MCP server ("chatgpt-bridge" v0.1.0).
- Register the `ask_chatgpt` tool with Zod input schema.
- Look up active provider from SQLite.
- Pick an API key via least-recently-used rotation (respecting cooldown on rate-limited keys).
- Dispatch to the appropriate provider (OpenAI or Gemini).
- Log usage and errors.
- Push to Telegram/Slack side-channel.
- Handle errors with user-friendly hints.
- Attach stdio transport and start server.

**Key functions:**
- `truncate(text, limit, label)` — Safely truncate strings with a note.
- `classifyErrorKind(status?)` — Map HTTP status to error kind (401, 429, 5xx, other).
- Tool handler `ask_chatgpt` — Validates inputs, coordinates provider dispatch, logs outcome, awaits notify.
- `main()` — Seeds SQLite, starts MCP server on stdio.

**Key constants:**
- `MAX_INPUT_CHARS = 60_000` (truncate context).
- `MAX_OUTPUT_CHARS = 20_000` (truncate answer).
- `COOLDOWN_MS_ON_429 = 60_000` (apply cooldown when rate-limited).

**System prompt:** Hardcoded Vietnamese 3-section format (via system-prompt.ts).

## Provider Layer

### `src/providers/provider-interface.ts` (~22 LOC)

**Abstract interface for dual-provider dispatch.**

```typescript
interface Provider {
  ask(params: AskParams): Promise<AskResult>;
}

interface AskParams {
  question: string;
  context: string;
  model: string;
  apiKey: string;
  baseURL?: string;
}

interface AskResult {
  text: string;
  usage: AskUsage;
}

interface AskUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}
```

### `src/providers/openai-provider.ts` (~34 LOC)

**OpenAI and OpenRouter implementation.**

**Exports:**
- `openaiProvider` — Provider instance.
- `DEFAULT_MODEL = "gpt-5"` — Hardcoded default for OpenAI. Overridden by per-key `model` config (dashboard-set) if present, which also overrides the tool call's `model` param.

**Behavior:**
- Uses OpenAI SDK (`openai.responses.create()`).
- If baseURL is provided, overrides the endpoint (OpenAI-only, rejected for Gemini).
- Extracts token counts from response metadata.
- Throws on API errors; index.ts catches and handles.

### `src/providers/gemini-provider.ts` (~28 LOC)

**Google Gemini implementation via @google/genai.**

**Exports:**
- `geminiProvider` — Provider instance.
- `DEFAULT_MODEL = "gemini-2.5-flash"` — Hardcoded default for Gemini. Overridden by per-key `model` config (dashboard-set) if present, which also overrides the tool call's `model` param.

**Key detail:** Not yet live-tested (no API key available at refactor completion). Code compiles and SDK field names verified against GitHub source, but production behavior unconfirmed.

**Behavior:**
- Uses Google's `@google/genai` SDK (`ai.models.generateContent()`).
- Reads API key from params (Gemini API keys are simpler than OpenAI; no base URL override supported, baseURL is rejected on Gemini keys).
- Extracts token counts from `response.usageMetadata`.
- Throws on API errors.

### `src/providers/system-prompt.ts` (~37 LOC)

**Shared Vietnamese 3-section system prompt.**

**Exports:**
- `SYSTEM_PROMPT` — Constant string used by both providers.
- Hardcoded Vietnamese format: "Câu hỏi: <recap> / Khuyến nghị: <recommendation> / Giải thích: <reasoning>".

## Configuration & Storage Layer

### `src/config/db.ts` (~58 LOC)

**SQLite database singleton with WAL mode.**

**Exports:**
- `db` — `better-sqlite3` Database instance.
- Auto-creates three tables on init:
  - `settings` (key-value store for Telegram/Slack/port).
  - `provider_keys` (API keys with labels, enabled flag, cooldown, last_used_at).
  - `usage_events` (read-only log of calls: provider, key_id, model, token counts, ok/error).
- Sets db file to mode 0o600 (readable/writable by owner only).
- Uses WAL journal mode to allow concurrent reads from web dashboard and MCP server.

### `src/config/key-store.ts` (~207 LOC)

**API key management and provider selection.**

**Key interfaces:**
- `ProviderKey` — In-memory representation after row conversion: `{id, provider, label, value, enabled, baseURL?, model?, cooldownUntil?, lastUsedAt}`.
- `MaskedKey` — Returned by `listKeysMasked()` for dashboard display: `{id, label, masked, enabled, baseURL?, model?}` (raw `value` never exposed in API).

**Key functions:**
- `getActiveProvider()` — Returns "openai" or "gemini" from settings table.
- `setActiveProvider(provider)` — Switches the active provider.
- `pickKeyForCall(provider)` — Returns the least-recently-used enabled key (excluding cooldown keys). Returns `null` if no eligible key.
- `recordCallOutcome(provider, keyId, outcome)` — `outcome` is `{success: true}` or `{success: false, cooldownUntil?}`. Always updates `last_used_at` (success or failure), pushing the key to the back of the LRU queue either way. `cooldownUntil` is only set by index.ts on a 429 — other error kinds (401/5xx/other) still rotate the key out via `last_used_at` but don't apply a cooldown.
- `listKeysMasked()` — Returns all keys with values masked to last 4 chars.
- `addKey(provider, label, value, opts?)` — CRUD: insert a new key, id via `crypto.randomUUID()`. `opts` optionally includes `baseURL` (OpenAI-only) and `model` (both providers).
- `updateKey(id, patch)` — CRUD: patch any of `{enabled?, label?, baseURL?, model?}`. Uses clear/leave/set semantics: omitted fields unchanged, empty string clears to NULL, non-empty sets value. `baseURL` validation rejects non-http/https schemes and rejects gemini keys.
- `deleteKey(id)` — CRUD: remove a key.
- `ensureMigrated()` — Idempotent: seeds a default `activeProvider=openai` setting if not already present.
- `mask(apiKey)` — Helper: returns "...xxxx" for display.

### `src/config/app-settings.ts` (~45 LOC)

**Generic settings management and legacy env bootstrap.**

**Key functions:**
- `getSetting(key)` — Read a setting from the settings table.
- `setSetting(key, value)` — Write a setting.
- `deleteSetting(key)` — Remove a setting.
- `migrateAppSettings()` — **One-time bootstrap:** Checks for optional env vars (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `SLACK_WEBHOOK_URL`, `WEB_CONFIG_PORT`). For each setting that doesn't already exist in the database, imports the env var value (if set). Uses SQL `INSERT OR IGNORE` to ensure idempotency. Called once at server startup; env vars are never consulted again after that.

## Usage Tracking Layer

### `src/usage/usage-logger.ts` (~30 LOC)

**Append-only usage event log.**

**Key functions:**
- `appendUsageEvent(event)` — takes a single `UsageEvent` object (`ts`, `provider`, `keyId`, `label`, `model`, token counts, `ok`, optional `errorKind`). Logs to `usage_events`. Never throws (fail-open).

### `src/usage/usage-aggregator.ts` (~41 LOC)

**Usage statistics and reporting.**

**Key functions:**
- `summarize(sinceIso?)` — Returns aggregated stats:
  - Total calls, tokens by provider, by key.
  - Optionally filtered to calls since a given ISO 8601 timestamp.
  - Uses indexed SQL aggregation for performance.

## Web Dashboard Layer

### `src/web/server.ts` (~239 LOC)

**Express server for dashboard and API.** No exports — a script that runs `ensureMigrated()`/`migrateAppSettings()` and `app.listen()` as side effects when executed via `npm run web` (or `node dist/web/server.js`). Binds `127.0.0.1:PORT` only, never configurable to another host, by design for single-user local use.

**Routes:**
- `GET /` — Serves `dashboard.html`.
- `GET /api/state` — Returns active provider, masked keys list, usage summary (all from SQLite).
- `POST /api/provider` — Sets active provider (req.body.provider).
- `POST /api/keys` — Adds a new key (req.body.{provider, label, value, baseURL?, model?}). `baseURL` is OpenAI-only (rejected for Gemini keys; must use http/https scheme). `model` is optional for both providers. Both are validated and stored in the database.
- `PATCH /api/keys/:id` — Updates a key (req.body.{enabled?, label?, baseURL?, model?}). Same validation as POST: `baseURL` is OpenAI-only, both fields support clear/leave/set semantics (omitted = unchanged, empty string = clear to NULL, non-empty = set).
- `DELETE /api/keys/:id` — Deletes a key.
- `GET /api/settings` — Returns masked notify secrets + current port setting.
- `PATCH /api/settings` — Updates settings (Telegram/Slack/port). Empty string clears a setting.

**CSRF-like protection:**
- Mutating routes (POST/PATCH/DELETE) check the request's Origin header and reject cross-origin requests (or requests with no Origin header). Same-origin requests are allowed.
- Designed for localhost-only use; not a substitute for proper auth if exposed to a network.

**Port binding:**
- Binds only to `127.0.0.1` (localhost). Never binds to 0.0.0.0 or another host.
- Default port: 4141 (configurable via dashboard, but requires server restart to take effect).

### `src/web/dashboard.html` (~465 LOC)

**Vanilla JavaScript SPA, no build step.**

**Features:**
- Provider switch (segmented pill buttons: OpenAI / Gemini).
- Add/enable/disable/delete API keys.
- View masked keys and usage stats (refreshed on page load, not live-updating).
- Set Telegram/Slack notify secrets.
- Change dashboard port.
- Dark mode via `prefers-color-scheme`.
- XSS-safe: all user text rendered via `textContent`, never `innerHTML`.
- No external dependencies (pure HTML/CSS/JS).

## Notification Layer

### `src/notify.ts` (~48 LOC)

**Best-effort side-channel push to Telegram and Slack.**

**Key functions:**
- `notifyTelegram(text)` — POST to Telegram Bot API.
- `notifySlack(text)` — POST to Slack Webhook.
- `notifyChannels(text)` — single pre-formatted message string (index.ts composes it as `🤖 ${provider} tư vấn\n\n${answer}`). Attempts both channels in parallel (via `Promise.allSettled()`). Logs errors, never throws.

**Behavior:**
- Secrets are read from SQLite (settings table) instead of env vars.
- Truncates to platform limits (Telegram 3500, Slack 8000).
- Failures are logged but don't block the MCP result.
- Awaited by index.ts before returning to Claude Code.

## Hooks & Installation

### `hooks/` (vendored)

Source of global Claude Code hooks that enforce auto-consult behavior. Not part of MCP server runtime; copied by `scripts/install-hooks.cjs` to `~/.claude/hooks/`.

- `ask-chatgpt-gate.cjs` — Stop hook, nags on plain-text `?` questions.
- `ask-chatgpt-pretool-gate.cjs` — PreToolUse hook, hard-denies AskUserQuestion until `ask_chatgpt` is called.
- `lib/ask-chatgpt-gate-shared.cjs` — Transcript analysis shared by both hooks above.
- `lib/ck-config-utils.cjs` — Vendored snapshot of shared infra owned by a broader personal hook framework (only installed if missing at the destination, never clobbers a newer copy other unrelated hooks depend on).

### `scripts/install-hooks.cjs`

Copies `hooks/` into `~/.claude/hooks/` and merges the two hook registrations into `~/.claude/settings.json`. Idempotent (safe to re-run). Run via `npm run install-hooks` (add `--dry-run` to preview without writing).

## Build & Runtime

- **Build:** `npm run build` → TypeScript compiles to CommonJS in `dist/`.
- **Runtime (MCP):** `node dist/index.js` starts the server on stdio.
- **Runtime (Dashboard):** `node dist/web/server.js` (or `npm run web`) starts the web server.
- **Database:** `data.sqlite` at repo root, auto-created by db.ts, mode 0o600.
- **No dotenv:** The project doesn't use dotenv; all config is SQLite + web dashboard.

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@modelcontextprotocol/sdk` | ^1.13.0 | MCP server & stdio transport |
| `@google/genai` | ^1.0.0 | Gemini AI client |
| `openai` | ^5.10.0 | OpenAI & OpenRouter client |
| `better-sqlite3` | ^11.0.0 | Synchronous SQLite driver |
| `express` | ^4.21.0 | Web server for dashboard |
| `zod` | ^3.24.0 | Input validation & schema |
| `@types/better-sqlite3` | ^7.6.0 | Type definitions (dev) |
| `@types/express` | ^4.17.0 | Type definitions (dev) |
| `@types/node` | ^22.10.0 | Node.js types (dev) |
| `typescript` | ^5.7.0 | Compiler (dev) |

## Data Flow Summary

1. **Claude Code** → `ask_chatgpt` tool call via MCP stdio.
2. **index.ts:** Validates input, picks active provider & key, dispatches to provider.
3. **Provider:** Calls OpenAI/Gemini API, returns answer + token counts.
4. **usage-logger:** Appends call record (timestamp, tokens, ok/error).
5. **notify.ts:** Posts Q&A to Telegram/Slack in parallel (best-effort, awaited before returning).
6. **MCP result:** Returned to Claude Code.
7. **Web dashboard:** Independently reads SQLite to display state, stats, and provides UI for key/setting changes.

All configuration persists in SQLite; no env vars after initial bootstrap.

## Key Design Decisions

- **Fail-open notifications:** Telegram/Slack failures never block the tool result. The human may not see the push, but Claude Code always gets the answer.
- **Stateless:** No session state, conversation history, or caching. Each call is independent.
- **Context-explicit:** Caller must provide all context; the advisor sees nothing else.
- **Truncation guards:** Input and output limits prevent token runaway and cost surprises.
- **Vietnamese only:** System prompt is hardcoded to Vietnamese with fixed structure. Not configurable per-call.
- **OpenRouter auto-detect:** API key format determines endpoint automatically; no manual config needed for OpenRouter.
- **Fresh client per call:** Each provider constructs its SDK client inside `.ask()` per call (not a cached singleton) — simpler given keys can change between calls via the dashboard.
