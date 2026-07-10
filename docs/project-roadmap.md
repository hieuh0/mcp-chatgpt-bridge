# Project Roadmap

## Current State (v0.1.0)

**Status:** Demo / personal-use project, post-refactor.

- Single tool `ask_chatgpt` working end-to-end: Claude Code → MCP server → Active provider (OpenAI or Gemini) → answer + Telegram/Slack push.
- Dual-provider support implemented: OpenAI (live-tested with OpenRouter, 2026-07-09), Gemini (code complete, SDK verified, not yet live-tested).
- SQLite config + web dashboard for runtime key/provider/setting management (no env vars required after initial bootstrap).
- Usage tracking with LRU key rotation and 429 cooldown built-in.
- Git repository initialized (commit `bb90e1a`).
- No test suite.
- No CI/CD pipeline.

## Known Gaps & Open Items

### 1. Rate-Limiting & Cost-Cap (Partially Addressed)

**Issue:** No enforcement of hard rate limits or maximum token spend per session.

**Current mitigation:**
- **Key rotation (LRU):** Multiple keys per provider allow load distribution. If one key hits quota, others can still be used.
- **429 cooldown (60s):** When a key is rate-limited, it enters cooldown and the next call tries another key automatically.
- **Usage logging:** Every call is logged to SQLite (tokens, provider, key, timestamp, outcome), enabling manual quota review.

**What's still missing:**
- No hard cap on tokens per session / per day / per calendar month.
- No automatic rejection when threshold is exceeded.
- No cost estimation before call (would require token estimation without making the call).
- No per-user quotas (MCP client doesn't provide caller context).

**Possible approaches:**
- Server-side session token counter: Track tokens in this session, warn/reject after threshold. Risk: token counting is lossy (estimates before call, actual differs).
- Daily/monthly quota ledger: Maintain a quota per key or global, decrement on each call. Risk: quota exhaustion blocks all calls equally.
- Cost estimation + budget check: Estimate tokens from context length, check against budget before calling API. Risk: estimate may be inaccurate.

**Status:** Partially mitigated. Unresolved if hard cap is required. Requires product decision on:
- Is soft mitigation (LRU rotation + cooldown + logging) sufficient for demo use?
- If hard cap needed: what threshold (tokens per session? per day?), and how to communicate (error vs warning)?
- Whether to implement server-side or rely on external cost-control service.

### 2. Test Suite (Medium Priority)

**Current state:** No tests.

**What needs testing:**
- Tool input validation (Zod schemas).
- Truncation logic (input, output).
- Error mapping (401, 429, 5xx).
- OpenAI client initialization and auto-routing for OpenRouter.
- Notification side-channel (both success and failure paths).
- Integration test with mock OpenAI API.

**Effort estimate:** ~3–4 hours with jest + ts-jest + node-fetch mocks.

### 3. CI/CD Pipeline (Low Priority, Nice-to-Have)

**Current state:** None.

**What would help:**
- Lint check (eslint or default TypeScript strict mode).
- Build verification (tsc, no type errors).
- Test run on PR.
- Automated publish to npm (if desired).

**Effort estimate:** ~1–2 hours with GitHub Actions.

### 4. Git Repository Initialization (Admin Task)

**Status:** ✅ Done (commit `bb90e1a` initialized). Standard git workflow ready.

**Notes:**
- Hooks are in place (`install-hooks.cjs` copies them to `~/.claude/hooks`).
- Code is committable (no secrets hardcoded; all config in SQLite + env bootstrap).

**Not critical for demo phase — completed with initial refactor.**

### 5. Gemini Path Live Testing (Medium Priority)

**Status:** ✅ Code complete and verified, but not yet live-tested.

**What's done:**
- Provider interface implemented (`gemini-provider.ts`, ~70 LOC).
- Google `@google/genai` SDK field names verified against GitHub source (response.text, response.usageMetadata, etc.).
- Type compilation successful.
- Zod schema validation in place.

**What's pending:**
- No live API call made (no Gemini API key available at refactor time).
- Actual response handling untested in production.
- Token counting accuracy on Gemini responses unverified.

**How to unblock:** Create a Gemini API key via Google AI Studio, add it to the dashboard, select Gemini as active provider, and make a test call. If successful, mark this as resolved.

**Not blocking v0.1.0 (OpenAI path verified); needed before using Gemini in production.**

### 6. Dashboard Authentication (Low Priority, Noted Limitation)

**Issue:** Web dashboard (`npm run web`) has no authentication.

**Current design:**
- Bound to `127.0.0.1` only (never configurable to bind elsewhere).
- SQLite has no user/permissions model.
- Suitable for **local single-user demo use only**.

**Why it matters:**
- If the dashboard is exposed to a network (directly or via port forwarding), anyone with access can view masked API keys and modify settings.
- No audit trail of who changed what.

**Possible mitigations (for future):**
- Add a simple password/token check (requires minor HTTP middleware).
- Add mTLS or OAuth2 if multi-user access is needed.
- Implement SQLite row-level security (complex, probably overkill).

**Current recommendation:** Keep this project **local-only** (not exposed to networks). For remote access, use a VPN or SSH tunnel to localhost:4141.

**Not planned for v0.1.0 (demo phase); required if scaling to shared/multi-user.**

### 7. Usage Events Unbounded Growth (Low Priority, Noted Limitation)

**Issue:** `usage_events` table has no retention policy.

**Current state:**
- Every `ask_chatgpt` call appends a record (timestamp, provider, key, model, tokens, ok/error).
- No automatic cleanup or archival.
- Over months, the table can grow large and slow down aggregations.

**Why it matters:**
- Storage space (negligible for local SQLite, but good practice).
- Aggregation query performance (indexes help, but unbounded growth is a code smell).
- Compliance: long-term audit log might be needed (or not, depending on product).

**Possible approaches:**
- Add a cron job or startup task to delete events older than N days.
- Archive old events to a separate table or file periodically.
- Add a `/admin/cleanup` endpoint to manually delete old events (for dashboard).

**Current workaround:** Manual SQL delete (user must manage DB file).

**Not blocking v0.1.0; suggested for v0.2.0 if usage grows.**

### 8. Configurable System Prompt (Low Priority)

**Current:** System prompt is hardcoded (Vietnamese, fixed structure).

**Limitation:** All calls return Vietnamese; cannot request other languages or formats.

**Possible enhancement:**
- Accept `systemPrompt` as optional tool input.
- Fall back to hardcoded Vietnamese if not provided.
- Risk: Requires schema change + update to global hook (if it inspects tool call).

**Not planned for v0.1.0; consider for v0.2.0 if multi-language support is needed.**

### 9. Persistent Audit Log (Very Low Priority)

**Current:** Errors logged to console; no persistent log file.

**Why it matters:**
- Long-term record of what was asked and what ChatGPT said.
- Compliance / review if this becomes production-critical.

**Current workaround:** Telegram/Slack archive serves as audit trail, and usage_events table logs all calls.

**Not planned unless compliance requirement emerges.**

## Next Steps (Immediate)

1. **Live-test Gemini path** — Create a Gemini API key, add to dashboard, test a call to unblock Gemini production use.
2. **Optional: Add test suite** — Improve confidence in error handling, key rotation logic, and provider dispatch.
3. **Optional: Add CI/CD** — GitHub Actions for lint/build/test on PR, if this project is shared or maintained long-term.

## Future Scenarios

### If used beyond personal demo:

- **Multi-user support:** Add dashboard authentication (password, OAuth2, or mTLS). Bind to a network-facing host (requires careful security review). Track per-user quotas and cost.
- **Cost tracking:** Integrate Stripe, OpenAI's usage API, or Gemini's quota dashboard to alert on spending. Consider implementing a session-level or daily token budget.
- **Analytics:** Dashboard to visualize call volume, tokens over time, error rates by provider/key, popular question patterns.
- **Provider scaling:** Add support for Claude (Anthropic API), Llama (via OpenAI-compatible endpoint), or other LLMs. Existing `Provider` interface makes this straightforward.

### If model landscape changes:

- **Model list fetch:** The dashboard's per-key Model field is free-text (set per key, see `docs/code-standards.md`'s Configuration Storage section) — an API-driven dropdown fetching each provider's live model list would replace manual typing but isn't needed yet.
- **Fallback providers:** If one provider is down, auto-failover to another. Requires circuit-breaker logic and provider health checks.
- **Fine-tuned models:** Support for custom-trained models (OpenAI fine-tuning, etc.). Requires metadata tracking and per-call model specification.

### If Claude Code features evolve:

- **Hook updates:** Monitor for changes to `CK_ASK_CHATGPT_GATE_DISABLED` env var or hook registration mechanism. Hook scripts are vendored here; update on release if behavior changes.
- **MCP 2.0 capabilities:** New MCP versions may enable bidirectional file access or richer tool metadata. Could reduce need for caller-provided context in some use cases.
- **Sampling & logging:** Future Claude Code versions may support request/response logging; consider integrating structured logs for compliance/audit.
