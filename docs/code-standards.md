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

In `index.ts`, the `ask_chatgpt` tool handler wraps OpenAI calls in try-catch:

```typescript
catch (err) {
  const apiErr = err as { status?: number; message?: string };
  let hint = apiErr.message || String(err);
  if (apiErr.status === 401) {
    hint = "OpenAI rejected the API key (401). Check OPENAI_API_KEY is valid and not expired.";
  } else if (apiErr.status === 429) {
    hint = "OpenAI rate-limited this request (429). Wait a few seconds and retry...";
  }
  // ... etc
  return { content: [...], isError: true };
}
```

**In notify.ts,** failures are logged and never thrown:

```typescript
if (!res.ok) {
  console.error(`Telegram notify failed (${res.status}): ${await res.text()}`);
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

## Environment Variables

- Load via `process.env.*`; do not hardcode values.
- Use sensible defaults where appropriate (e.g., `DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-5"`).
- Document all expected env vars in `.env.example`.
- Never log or console.log sensitive values (API keys, tokens).

## Auto-routing Logic

For OpenRouter support, detect key format and auto-set endpoint:

```typescript
const OPENROUTER_KEY_PREFIX = "sk-or-";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const baseURL =
  process.env.OPENAI_BASE_URL ||
  (apiKey.startsWith(OPENROUTER_KEY_PREFIX) ? OPENROUTER_BASE_URL : undefined);
```

Do not require manual config for common provider transitions.

## Lazy Initialization

Initialize expensive resources (e.g., API clients) on first use, not at startup:

```typescript
let client: OpenAI | undefined;
function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey, baseURL });
  }
  return client;
}
```

This allows the server to start quickly even if the API is temporarily unavailable.

## Notifications & Side-Effects

Side-channel effects (Telegram, Slack) must be best-effort and never block the primary response.

Use `Promise.allSettled()` to handle multiple side-effects:

```typescript
const results = await Promise.allSettled([notifyTelegram(text), notifySlack(text)]);
for (const r of results) {
  if (r.status === "rejected") console.error("Notify error:", r.reason);
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
- **Functions:** camelCase, descriptive verbs (e.g., `getClient()`, `truncate()`, `notifyChannels()`).
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
- Always commit built `dist/` OR provide a build step in deployment; don't require build at runtime.
