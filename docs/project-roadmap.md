# Project Roadmap

## Current State (v0.1.0)

**Status:** Demo / personal-use project.

- Single tool `ask_chatgpt` working end-to-end: Claude Code → MCP server → OpenAI/OpenRouter → answer + Telegram/Slack push.
- Verified in production testing (2026-07-09): real OpenRouter API calls + Telegram delivery confirmed.
- No test suite.
- No CI/CD pipeline.
- No git repository initialized yet.

## Known Gaps & Open Items

### 1. Rate-Limiting & Cost-Cap (High Priority)

**Issue:** No enforcement of rate limits or maximum token spend per session.

**Current behavior:**
- Each call goes directly to OpenAI/OpenRouter.
- No check on accumulated cost, daily quota, or call frequency.
- If a loop or auto-consult enforcement gets stuck, ChatGPT can be called repeatedly, leading to unexpected charges.

**Possible approaches:**
- Server-side token counter: Track tokens in this session, warn/reject after threshold.
- Time-based throttling: Allow max 1 call per N seconds; queue excess requests.
- Cost estimation before call: Estimate tokens, check against budget, error if over.
- Per-user quotas: Track by caller identity (if MCP client provides context).

**Status:** Unresolved. Requires product decision on:
- What threshold to enforce (tokens per session? per day? per calendar month?).
- How to communicate limits to Claude Code (error, warning, metadata).
- Whether to implement server-side (this tool) or rely on external rate limiter.

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

**Status:** Not initialized yet in `/Users/hieuho/Desktop/mcp`.

**Why it matters:**
- Cleaner history if this project is shared or maintained long-term.
- Standard branching & PR workflows.

**Not critical for demo phase.**

### 5. Configurable System Prompt (Low Priority)

**Current:** System prompt is hardcoded (Vietnamese, fixed structure).

**Limitation:** All calls return Vietnamese; cannot request other languages or formats.

**Possible enhancement:**
- Accept `systemPrompt` as optional tool input.
- Fall back to hardcoded Vietnamese if not provided.
- Risk: Requires schema change + update to global hook (if it inspects tool call).

**Not planned for v0.1.0; consider for v0.2.0 if multi-language support is needed.**

### 6. Persistent Audit Log (Very Low Priority)

**Current:** Errors logged to console; no persistent log file.

**Why it matters:**
- Long-term record of what was asked and what ChatGPT said.
- Compliance / review if this becomes production-critical.

**Current workaround:** Telegram/Slack archive serves as audit trail.

**Not planned unless compliance requirement emerges.**

## Next Steps (Immediate)

1. **Resolve rate-limit gap** — Discuss threshold and approach with product owner (user).
2. **Add test suite** — Improve confidence in error handling and edge cases.
3. **Initialize git** — Clean commit history and standard workflows.

## Future Scenarios

### If used beyond personal demo:

- Add authentication / per-user quotas.
- Integrate with cost tracking (e.g., Stripe, internal billing).
- Add metrics (call count, avg latency, error rate).
- Scale to multiple endpoints (not just OpenAI-compatible).

### If model landscape changes:

- Support Claude, Gemini, or other LLMs as consultation sources (requires new client SDKs).
- Allow per-call model selection (already supported in input, but limited by OpenAI SDK).

### If Claude Code features evolve:

- Hook may change; monitor for `CK_ASK_CHATGPT_GATE_*` env var updates.
- New MCP capabilities may allow direct file access (reduces need for caller-provided context).
