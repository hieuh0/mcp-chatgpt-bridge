# Code Standards

## Observed Conventions

This document describes the patterns and conventions actually present in the codebase. Developers should follow these patterns when adding or modifying code.

## TypeScript & Compilation

- **Target:** ES2022
- **Module system:** NodeNext (ESM + CommonJS compatibility)
- **Output:** dist/ directory, source in src/
- **Strict mode:** On (no `any`, no implicit `unknown`, etc.)
- **File structure:** One tool per logical concern (index.ts for server/tool, notify.ts for side-channel).

## Error Handling

**Pattern:** Catch and map errors to user-friendly messages, never throw from a tool.

In `index.ts`, the `ask_chatgpt` tool handler wraps the active provider's call in try-catch, classifying by HTTP status so the hint text is generic across both providers:

```typescript
function classifyErrorKind(status: number | undefined): string {
  if (status === 401) return "401";
  if (status === 429) return "429";
  if (status !== undefined && status >= 500) return "5xx";
  return "other";
}

catch (err) {
  const apiErr = err as { status?: number; message?: string };
  const errorKind = classifyErrorKind(apiErr.status);
  let hint = apiErr.message || String(err);
  if (errorKind === "401") {
    hint = `${provider} rejected the API key (401). Check the key is valid and not expired in the web dashboard.`;
  } else if (errorKind === "429") {
    hint = `${provider} rate-limited this request (429). Wait a few seconds and retry...`;
    keyStore.recordCallOutcome(provider, picked.key.id, { success: false, cooldownUntil: ... }); // only 429 touches rotation state
  }
  // ... etc
  return { content: [...], isError: true };
}
```

**In notify.ts,** failures are logged to the activity log and never thrown:

```typescript
if (!res.ok) {
  logError("mcp", `Telegram notify failed (${res.status}): ${await res.text()}`);
}
```

Use `Promise.allSettled()` when multiple operations may fail independently.

## Input Validation

Use Zod schemas for all tool inputs. Example:

```typescript
{
  question: z.string().min(1).describe("..."),
  context: z.string().min(1).describe("..."),
  model: z.string().optional().describe("..."),
}
```

- Validation happens before the tool handler runs.
- Error messages from Zod are user-facing; write them clearly.

## Truncation & Guards

Prevent token runaway with explicit limits:

```typescript
const MAX_INPUT_CHARS = 60_000;
const MAX_OUTPUT_CHARS = 20_000;

function truncate(text: string, limit: number, label: string): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[...truncated, ${label} exceeded ${limit} chars...]`;
}
```

Apply truncation before passing to external APIs. Always note in the output when truncation occurred.

## Configuration Storage

- No env vars for provider config. All API keys, active provider, web dashboard port, and notify secrets live in SQLite (`data.sqlite`, `settings`/`provider_keys` tables), managed exclusively via `npm run web`. Do not add a new `process.env.X` read for anything that belongs in this store — add a `getSetting`/`setSetting` entry instead (see `src/config/app-settings.ts`).
- A default model per provider is a hardcoded code constant (`DEFAULT_MODEL` in each `src/providers/*.ts` file). A key can also carry its own `model` (`provider_keys.model`, set via the dashboard) — this exists because a key's `baseURL` can point at a different endpoint (OpenAI itself, OpenRouter, a self-hosted proxy) with its own model namespace, so the model has to travel with the key, not the provider. Resolution order in `src/index.ts`: `picked.key.model || toolCallModelParam || DEFAULT_MODEL` — the picked key's own model always wins over the tool call's `model` param.
- The only env-var reads left are inside `migrateAppSettings()`/legacy migration — a ONE-TIME bootstrap from a previous setup, checked only if the corresponding SQLite setting doesn't already exist.
- Never log or console.log sensitive values (API keys, tokens, webhook URLs) — use the `mask()` helper (`src/config/key-store.ts`) for any user-facing display of a secret.

  **Exception (by design):** The `ask_chatgpt` tool logs **full question + context text on tool invocation, and full answer text on success** to the daily log file (`logs/YYYY-MM-DD.log`) via `src/logger.ts`. This is an explicit, user-approved decision to maintain a complete audit trail of what was asked and what was answered, supporting future compliance/review. This does **not** contradict the no-secrets rule — API keys, tokens, and webhook URLs remain completely excluded from all logging (they are never visible in the log file or web dashboard). The full-text logging applies only to call context and answers, not credentials.

## Auto-routing Logic

For OpenRouter support, detect key format and auto-set endpoint (`src/providers/openai-provider.ts`):

```typescript
const OPENROUTER_KEY_PREFIX = "sk-or-";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const resolvedBaseURL =
  baseURL ?? // per-key base_url column, set via the dashboard — not an env var
  (apiKey.startsWith(OPENROUTER_KEY_PREFIX) ? OPENROUTER_BASE_URL : undefined);
```

Do not require manual config for common provider transitions.

## Client Construction

Each provider builds its SDK client fresh inside `.ask()`, per call — not a cached singleton:

```typescript
async ask({ apiKey, baseURL }: AskParams): Promise<AskResult> {
  const client = new OpenAI({ apiKey, baseURL: resolvedBaseURL });
  // ...
}
```

Deliberate: the API key/base URL can differ on every call now (key rotation, dashboard edits between calls), so there's nothing stable to cache. Don't reintroduce a module-level singleton client.

## Notifications & Side-Effects

Side-channel effects (Telegram, Slack) must be best-effort and never block the primary response.

Use `Promise.allSettled()` to handle multiple side-effects:

```typescript
const results = await Promise.allSettled([notifyTelegram(text), notifySlack(text)]);
for (const r of results) {
  if (r.status === "rejected") logError("mcp", "Notify error", r.reason);
}
```

Log errors; don't throw or propagate them to the caller.

## Message Formatting

When pushing notifications:

- Include context in the message (e.g., "🤖 ChatGPT tư vấn" prefix for Vietnamese).
- Respect platform-specific character limits (Telegram 3500, Slack 8000).
- Use platform-native formatting where applicable.

## Comments & Documentation

- Add comments explaining *why*, not *what* (the code shows what).
- Document non-obvious constants (e.g., why 60K char limit exists).
- Keep comments up to date; stale comments are worse than none.

Example:

```typescript
// Keep prompt + answer within a sane token budget so a single call can't blow up cost/latency.
const MAX_INPUT_CHARS = 60_000;
```

## Naming

- **Variables:** camelCase (e.g., `apiKey`, `chatId`, `notifyChannels`).
- **Constants:** SCREAMING_SNAKE_CASE (e.g., `OPENROUTER_KEY_PREFIX`, `MAX_INPUT_CHARS`).
- **Functions:** camelCase, descriptive verbs (e.g., `pickKeyForCall()`, `truncate()`, `notifyChannels()`).
- **Types:** PascalCase (from OpenAI SDK and MCP SDK imports).

## Testing

Currently no test suite. When tests are added, follow these conventions:

- Test filenames: `{src-file}.test.ts`
- Test structure: Describe blocks for features, it/test for cases.
- Mocks: Mock fetch and OpenAI client, not stdin/stdout.

## Build & Deployment

- `npm run build` compiles to dist/.
- `npm start` runs the compiled server.
- `npm run dev` watches and recompiles on file change.
- `dist/` is gitignored (not committed) — always run `npm run build` after pulling changes or editing `src/`, and rebuild + restart the MCP client to pick up changes (it doesn't hot-reload).
