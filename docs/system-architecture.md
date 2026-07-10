# System Architecture

## Overview

mcp-chatgpt-bridge is a lightweight MCP server that bridges Claude Code to dual-provider AI advisors (OpenAI + Gemini, server-side selectable), with SQLite-backed configuration, usage tracking, and a web dashboard for local management. A side-channel to Telegram/Slack enables human review of all consultations.

## Component Diagram

```
┌─────────────────────┐
│   Claude Code       │
│  (MCP Client)       │
└──────────┬──────────┘
           │
           │ (MPC call: ask_chatgpt)
           │ stdio transport
           ▼
┌─────────────────────────────────────────────────────┐
│         mcp-chatgpt-bridge MCP Server               │
│                                                     │
│  ┌─────────────────────────────────────────────┐   │
│  │ index.ts                                    │   │
│  │ - Tool registration & validation            │   │
│  │ - Active provider lookup (key-store)        │   │
│  │ - Key rotation (LRU, respecting cooldown)   │   │
│  │ - Provider dispatch (OpenAI / Gemini)       │   │
│  │ - Result logging (usage-logger)             │   │
│  │ - Notify push (telegram/slack)              │   │
│  │ - Error mapping & truncation                │   │
│  └────────────────┬────────────────────────────┘   │
│                   │                                 │
│  ┌────────────────▼──────────────┐                 │
│  │ Dual-Provider Dispatch        │                 │
│  │                               │                 │
│  │  ┌──────────────────────┐     │                 │
│  │  │ openai-provider.ts   │◄─┐  │                 │
│  │  │ (OpenAI/OpenRouter)  │  │  │                 │
│  │  └──────────────────────┘  │  │                 │
│  │                            │  │                 │
│  │  ┌──────────────────────┐  │  │                 │
│  │  │ gemini-provider.ts   │◄─┤  │                 │
│  │  │ (@google/genai)      │  │  │                 │
│  │  └──────────────────────┘  │  │                 │
│  │                            │  │                 │
│  │  ┌──────────────────────┐  │  │                 │
│  │  │ system-prompt.ts     │──┘  │ (shared)       │
│  │  │ (Vietnamese 3-part)  │     │                 │
│  │  └──────────────────────┘     │                 │
│  └────────────────┬──────────────┘                 │
│                   │                                 │
│  ┌────────────────▼──────────────────────────────┐ │
│  │ Notification & Logging                        │ │
│  │                                               │ │
│  │  ┌──────────────┐  ┌───────────────┐         │ │
│  │  │ notify.ts    │  │ usage-logger  │         │ │
│  │  │ (Tg/Slack)   │  │ (append event)│         │ │
│  │  └──────────────┘  └───────────────┘         │ │
│  └────────────────┬──────────────────────────────┘ │
│                   │                                 │
│  ┌────────────────▼──────────────────────────────┐ │
│  │ SQLite Config Database (data.sqlite)          │ │
│  │                                               │ │
│  │  ┌──────────────┐ ┌────────────────┐         │ │
│  │  │ settings     │ │ provider_keys  │         │ │
│  │  │ (key-value)  │ │ (keys, labels, │         │ │
│  │  │              │ │  cooldown,     │         │ │
│  │  │              │ │  last_used_at) │         │ │
│  │  └──────────────┘ └────────────────┘         │ │
│  │                                               │ │
│  │  ┌─────────────────────────────────────────┐ │ │
│  │  │ usage_events (call log with tokens)     │ │ │
│  │  └─────────────────────────────────────────┘ │ │
│  └───────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
           │                 ▲
           │                 │ SQLite reads/writes
           ▼                 │
┌─────────────────────────────────────┐
│   Web Dashboard (Express server)     │
│   http://localhost:4141             │
│                                     │
│  - Add/enable/disable API keys      │
│  - View masked keys & usage stats   │
│  - Switch active provider           │
│  - Configure Telegram/Slack secrets │
│  - Change dashboard port            │
│                                     │
│  (Reads/writes same SQLite DB)      │
└─────────────────────────────────────┘

Async flow within MCP server:
┌─────────────────────────────────────────┐
│ await notifyChannels (Telegram + Slack) │ ◄── happens before MCP result
│ both POSTs in parallel, errors logged   │     is sent back
└─────────────────────────────────────────┘
```

Additional (external, global):

```
┌────────────────────────────────────────────────┐
│  Claude Code Global Hooks                      │
│  (~/.claude/hooks/ask-chatgpt-gate.cjs)        │
│  (~/.claude/hooks/ask-chatgpt-pretool-gate.cjs)│
│                                                │
│  Pushes Claude to call ask_chatgpt before      │
│  ending a turn with a question:               │
│  - AskUserQuestion → hard-denied (real block)  │
│  - plain-text "?" → nagged only (best-effort) │
│  Capped at 2 blocks/session, not a guarantee. │
└────────────────────────────────────────────────┘
```

## Data Flow: ask_chatgpt Call

### Sequence

1. **Claude Code** decides to consult an AI advisor.
2. **Claude Code** calls MCP tool `ask_chatgpt(question, context, model?)` over stdio.
3. **MCP Server** receives call on stdin. **index.ts handler:**
   - Validates `question` and `context` with Zod.
   - Truncates `context` to 60K chars.
   - Looks up the active provider from SQLite settings table (OpenAI or Gemini).
   - Calls `keyStore.pickKeyForCall(provider)` to get an enabled key:
     - Returns the least-recently-used key among enabled keys that aren't in cooldown.
     - If all keys for the provider are disabled or all in cooldown, returns null (error).
   - Resolves the model to use: `picked.key.model || model (tool param) || DEFAULT_MODEL (hardcoded per provider)`. A key's own configured model (set via the dashboard) always wins over the tool call's `model` param — relevant when a key's `baseURL` (also dashboard-editable per key) points at a non-default endpoint (e.g. OpenRouter) with its own model namespace.
   - Dispatches to the selected provider's `.ask()` method (openai-provider or gemini-provider), passing the resolved model and the key's `baseURL` (OpenAI only; ignored for Gemini, whose SDK has no proxy base URL concept).
   - **Error path (if API call fails):**
     - Catches exception and classifies error kind (401, 429, 5xx, or other).
     - If 429 (rate limit): calls `recordCallOutcome(provider, keyId, { success: false, cooldownUntil })`, which sets a 60-second cooldown on that key.
     - Other errors: `recordCallOutcome()` is called with the error kind, but no cooldown is applied (auto-retry/failover is out of scope).
     - Returns error result to Claude Code immediately.
   - **Success path:**
     - Receives answer and usage metadata from provider.
     - Truncates answer to 20K chars.
     - Calls `recordCallOutcome(provider, keyId, { success: true })`, which updates `last_used_at` for that key.
     - Calls `appendUsageEvent()` to log the call (timestamp, provider, key ID, model, token counts, ok/error status).
     - **Awaits** `notifyChannels(text)` (a single pre-formatted message string) — the tool call does not return until this settles (it just never throws on failure).
     - Returns result to Claude Code only after that await resolves.
4. **notify.ts (awaited by index.ts, Telegram/Slack POSTs run in parallel with each other):**
   - Checks SQLite settings for Telegram (token + chat ID) and Slack (webhook URL).
   - Attempts `notifyTelegram()` and `notifySlack()` in parallel using `Promise.allSettled()`.
   - Each POST:
     - Truncates to platform limit (Telegram 3500, Slack 8000).
     - POSTs to platform API.
     - If response is not OK, logs error to console.
   - Resolves (never throws).
5. **Claude Code** receives answer on stdout and displays to user.
6. **Human** (asynchronously, if desired) reviews notification in Telegram/Slack.

### Error Handling

- **No enabled keys for active provider:** Tool throws error; user must add keys via dashboard.
- **Invalid API key (401):** Error returned to Claude Code with hint; key is NOT auto-disabled (manual action via dashboard).
- **Rate limited (429):** Key enters 60-second cooldown; if another key is available, next call uses it. If no other key available, error is returned.
- **Provider backend error (5xx) or other non-429 error (including 401):** Error returned to Claude Code; `last_used_at` IS updated (pushing this key to the back of the LRU queue) even though no cooldown is applied, so the next call tries a different enabled key for that provider rather than retrying the same broken one.
- **Telegram/Slack delivery fails:** Error logged to console (server-side); tool result is unaffected.
- **Network timeout:** Depends on provider SDK default; may appear as generic error with the provider's error kind classification.

## Key Design Decisions

### Why SQLite + Web Dashboard Instead of Env Vars?

Environment variables are static at server startup. With multiple keys and providers, management becomes complex. SQLite + a simple web dashboard allows runtime configuration changes:
- Add/remove keys without restarting the MCP server.
- Switch providers or enable/disable keys dynamically.
- View usage statistics and key rotation state.
- Manage notify secrets (Telegram/Slack) without exposing them in shell history.

### Why Key Rotation (Least-Recently-Used + Cooldown)?

When deploying multiple API keys for high-volume or multi-provider setups:
- **LRU rotation** distributes load across keys and avoids quota exhaustion on a single key.
- **Cooldown on 429** prevents hammering a rate-limited key; the server automatically tries other keys instead.
- Explicit error classification (401, 429, 5xx) allows intelligent fallback without blind retry.

### Why Separate Provider Implementations?

OpenAI and Gemini expose different SDKs with different field names and response structures. Abstracting each behind a common `Provider` interface keeps the core logic (index.ts) clean and makes it easy to add more providers later (Claude, Llama, etc.).

### Why Truncation Guards?

Prevents accidental token runaway. If a user passes a 200MB context by mistake, the tool truncates at 60K and notes the truncation in the output. This avoids surprise API calls that would cost thousands of tokens.

### Why Best-Effort Notifications?

Telegram and Slack are informational side-channels. The tool call awaits the notification attempt (adds their latency to the call), but a delivery failure never throws or blocks the primary response — Claude Code still gets the answer either way. Failures are logged for debugging but never surfaced to the MCP client.

### Why Vietnamese Output?

System prompt hardcodes Vietnamese replies with a structured format (Câu hỏi / Khuyến nghị / Giải thích). This is a deliberate product decision for a Vietnamese-speaking user. Not configurable per-call.

### Why Auto-routing for OpenRouter?

OpenRouter and OpenAI both expose OpenAI-compatible APIs but use different endpoints. Detecting the key format (`sk-or-` prefix) in the openai-provider implementation and auto-routing eliminates manual config, reducing user error.

### Why Usage Logging to SQLite?

Keeping a log of every call (tokens used, provider, key, timestamp, outcome) enables:
- Usage aggregation via dashboard (total tokens by provider, by key).
- Debugging: tracing which key caused a 401 or cooldown.
- Future: quota enforcement, cost tracking, or alerting on unusual patterns.

### Why No Dashboard Authentication?

This project is designed for **local single-user demo use**. The dashboard is bound to `127.0.0.1` only (never configurable to another host) and SQLite has no user/auth model. If scaling to multi-user or remote access is needed, authentication (OAuth2, mTLS, API keys) should be added as a separate layer.

### Fetch-Models Routes: Outbound Requests Carrying a Real Secret

`POST /api/keys/fetch-models` and `GET /api/keys/:id/fetch-models` (`src/web/server.ts`) let the dashboard populate the Model field's suggestions by calling an OpenAI-compatible endpoint's `GET {baseURL}/models` with a real API key as a Bearer token — the server makes this call on the caller's behalf, with a destination the request can partially influence (`baseURL`). This is qualitatively different from every other route in this file: those only read/write local SQLite state, this one sends a secret off-box.

Two extra guards exist only for these two routes, beyond the standard `requireSameOrigin`/`validateBaseURL` used elsewhere:
- **`requireSameOriginStrict`** — rejects a request with no `Origin` header at all (the existing lenient `requireSameOrigin`, used by every other mutating route, allows no-Origin requests so `curl`/scripts can call them; that's not acceptable here since a non-browser local caller with no Origin header must not be able to trigger an off-box secret exfiltration).
- **`validateFetchModelsTarget`** — resolves the hostname via DNS and rejects loopback, link-local (including the `169.254.169.254` cloud-metadata address), RFC1918 private ranges, and CGNAT (`100.64.0.0/10`), for both a request-supplied `baseURL` and a previously-saved one used as a fallback. `validateBaseURL` alone only checks URL syntax/scheme, never the destination.

**Accepted residual risk:** a same-origin browser context with DOM access to an already-open dashboard tab (e.g. a malicious browser extension) still passes both checks. This is accepted because it requires the attacker to already have code execution inside the user's browser on a tab where this specific local dashboard is open — a materially higher bar than "any local process" or "any cross-site page" — and such a context already has full read/write access to every other unauthenticated route in this file, not just these two. Closing that gap (e.g. a per-session CSRF token) would apply to the whole dashboard, not just this feature, and is out of scope here.

This design was arrived at via adversarial red-team review before implementation (see `plans/260710-1355-fetch-models-dashboard/plan.md`'s `## Red Team Review` section) — the original design's stated mitigations (`validateBaseURL` + the existing lenient `requireSameOrigin` alone) did not actually close the SSRF/credential-exfiltration risk.

### Why Stdio Transport?

MCP requires a transport. Stdio is simple, works in all environments, and integrates seamlessly with Claude Code's MCP client.

## Statelessness

The server maintains no conversation history, session state, or caching. Each `ask_chatgpt` call is independent:

- No memory of previous questions.
- No session token or conversation ID.
- All context must be provided by the caller.

This simplifies the implementation and prevents accidental data leaks across unrelated asks.

## Configuration Storage

All configuration is stored in SQLite (`data.sqlite` at repo root, mode 0o600):

| Setting | Table | Configurable Via |
|---------|-------|------------------|
| Active provider (openai or gemini) | settings | Web dashboard |
| API keys, labels, enabled flag | provider_keys | Web dashboard |
| Telegram/Slack/Port settings | settings | Web dashboard |
| Usage events (read-only log) | usage_events | (Logged by server, readable via dashboard) |

**Legacy env var bootstrap (one-time only):** On startup, if the setting doesn't already exist in SQLite, the server reads these optional env vars and seeds the database:
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `SLACK_WEBHOOK_URL`, `WEB_CONFIG_PORT`

After the first run, all configuration goes through the dashboard; env vars are never consulted again.

## Integration with Claude Code

The MCP server is registered via `claude mcp add` or manually in `.mcp.json`:

```bash
# Simple: no env vars needed
claude mcp add chatgpt-bridge -s user -- node /path/to/dist/index.js
```

Or manually in `~/.claude.json` or project `.mcp.json`:

```json
{
  "mcpServers": {
    "chatgpt-bridge": {
      "command": "node",
      "args": ["/path/to/dist/index.js"]
    }
  }
}
```

Claude Code then:
1. Spawns the server process.
2. Communicates via stdio.
3. Calls `ask_chatgpt` tool when needed (or via the global gate hook).

**Configuration:** Before using the tool, run `npm run web` in the project directory, open `http://localhost:4141`, and add API keys. The server will read from the SQLite database at runtime.

## Global Hook Enforcement

The auto-consult behavior is *not* built into this server. Instead, two Claude Code hooks push Claude to call `ask_chatgpt` before asking the user something. Their source lives in this repo's [`hooks/`](../hooks) directory and gets installed into `~/.claude/hooks/` (and registered in `~/.claude/settings.json`) via `npm run install-hooks` — see [Deployment Guide](./deployment-guide.md). Once installed they're global in scope: they affect every Claude Code project on the machine, not just this one.

- `hooks/ask-chatgpt-pretool-gate.cjs` (installed as `~/.claude/hooks/ask-chatgpt-pretool-gate.cjs`, PreToolUse matcher `AskUserQuestion`) — denies the tool call outright until `ask_chatgpt` has been called. This is the real enforcement point, since the question never renders until Claude complies. Verified working end-to-end (2026-07-09).
- `hooks/ask-chatgpt-gate.cjs` (installed as `~/.claude/hooks/ask-chatgpt-gate.cjs`, Stop) — nags Claude for plain-text questions ending in `?`. There's no tool call to intercept for plain text, so this is best-effort only — the model can ignore it.

Both cap at 2 consecutive blocks/denials per session and then let the turn through, to avoid an infinite loop if the tool is broken or the model won't comply. So this is a strong push, **not a 100% guarantee** — a plain-text question can still slip through uncommented.

Both hooks require `hooks/lib/ck-config-utils.cjs`, vendored here as a frozen snapshot of shared infra owned by a broader personal hook framework (12+ unrelated hooks depend on the live copy in `~/.claude/hooks/lib/`). The installer only writes it if missing at the destination, to avoid clobbering a newer version those other hooks rely on.

This separation of concerns keeps the MCP server simple and allows the hooks to be updated independently.

See your Claude Code settings (`~/.claude/settings.json`) for hook status and `CK_ASK_CHATGPT_GATE_DISABLED` env var to disable.
