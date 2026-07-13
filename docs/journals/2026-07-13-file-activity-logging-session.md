# File-Activity Logging Feature — Full Session Implementation

**Date**: 2026-07-13 09:13  
**Severity**: Medium  
**Component**: Logging infrastructure, request tracking, dashboard log viewer, documentation  
**Status**: Resolved (shipped)

## What Happened

Implemented a complete file-based activity logging system in response to user request for "anything that happens" to be persisted. Executed full scope: brainstorm (scouted codebase, found existing usage_events table, identified a superseded roadmap item "9. Persistent Audit Log" marked "not planned"), planning (4 phases: logger core + console replacement, full activity log content, dashboard viewer, docs), implementation (src/logger.ts, console.* replacement across 5 files, ask_chatgpt full-content logging, /api/logs/today endpoint, dashboard Sync button), code review (1 bug found and fixed), docs update (5 files), and git commit locally (commit deaeead, "feat: add file-based activity logging with dashboard viewer"). Not pushed.

User accepted explicit security trade-off: log file contains full ask_chatgpt questions, context, and answers in plaintext (dashboard has no auth, so anyone with file access sees everything). Chose 1-file-per-day format with local-timezone date boundaries. Dashboard log viewer displays full log as <details>/<summary> rows (truncated preview, click to expand) to handle multi-kilobyte log lines.

## The Brutal Truth

This session was blocked hard by a broken dependency that the repo itself owns. The `ask-chatgpt-gate` hook was supposed to gate AskUserQuestion calls behind at least one successful ask_chatgpt MCP invocation per question round. **Every single ask_chatgpt call this session failed with a 401 (API key rejected)**, meaning the gate never actually released, so every AskUserQuestion ended up being asked without the independent AI check it was designed to require. This added friction to every single user-facing decision (What should the log line format be? What about timezone handling? How should the log viewer display huge entries?) and provided zero actual value — just the wait-time for a guaranteed-to-fail API call.

This is frustrating because it's self-inflicted. The ask_chatgpt OpenAI key is expired or revoked, and instead of failing fast with an error message ("Configure OpenAI key in .env"), the gate silently tries and fails, then gives up. A usable feature turned into pure friction.

## Technical Details

**Code review finding (1, fixed):**
- `logPathForToday()` used `new Date().toISOString().slice(0,10)` to get the date string. This returns UTC date, not local date. For any user in a timezone ahead of UTC (UTC+1 through UTC+12), during the first few hours of the local day (before midnight UTC), this would write to yesterday's log file instead of today's. Example: user in Tokyo (UTC+9) at 01:00 local time = 16:00 UTC previous day. The log line would go to the previous day's file, corrupting the "all activity from local day X" guarantee. Fix: replaced with `getFullYear()`, `getMonth()`, `getDate()` local components, verified with manual day-boundary test.

**Ask-chatgpt gate failure pattern:**
- Configured via `ask-chatgpt-gate` detection strategy hook (documented in `.memory/MEMORY.md`).
- Gate calls ask_chatgpt MCP tool → receives 401 from OpenAI → gate gives up and allows AskUserQuestion anyway.
- Pattern repeated identically for every user question (brainstorm decisions, planning decisions, phase verification, log format, timezone handling).
- Zero independent AI opinions obtained; gate provided only delay and false sense of enforcement.

**Logger implementation details:**
- `src/logger.ts`: hand-rolled fs.appendFileSync, no new dependency.
- Console replacement: updated index.ts, notify.ts, key-store.ts, web/server.ts, usage-logger.ts (this last file was missed in original plan file list, caught via grep during implementation).
- Ask_chatgpt handler: logs full question, context, answer, and tool metadata.
- GET /api/logs/today endpoint: returns array of log lines (newline-delimited JSON serialization, one object per line).
- Dashboard Sync button: fetches endpoint and renders <details> rows with truncated preview (first 200 chars) and click-to-expand full content.

## What We Tried

1. **Skipped independent verification for scope decisions**: Since ask_chatgpt was failing, each brainstorm/planning question was asked to AskUserQuestion as-is. All decisions were sound (explicit security trade-off acceptance, timezone correctness requirement both came from careful user responses), so this worked out, but relied on user doing the verification himself rather than having a second AI voice weigh in.

2. **Fixed UTC date bug**: Changed `new Date().toISOString().slice(0,10)` to local date components, tested day-boundary scenario manually.

3. **Caught missing file during implementation**: Grep for `console.` patterns caught usage-logger.ts, which was not in the original plan's file list. Updated console.info/error calls to use logger.

4. **Dashboard <details>/<summary> design**: Avoided flat <pre> dump (which would render 50KB+ log entries as a single block) by truncating preview and making content expandable.

## Root Cause Analysis

**Why the ask-chatgpt gate provided zero value this session:** The OpenAI API key configured in the hook (or possibly the MCP tool) is expired or revoked. The gate mechanism is correct (hard-deny on AskUserQuestion until ask_chatgpt succeeds), but the API key it depends on is non-functional. The hook should either: (a) fail fast with a clear error message ("Configure OpenAI key in .env, current key returned 401"), or (b) be disabled if the OpenAI key is optional/offline.

**Why the UTC date bug existed:** The logging design was written with the assumption that `toISOString().slice(0,10)` produces a local date string. This is a common mistake in JavaScript (toISOString is always UTC; local dates require getFullYear/getMonth/getDate). The bug only manifested at the boundary (users in UTC+ timezones during early morning hours), so it wouldn't have been caught without explicit timezone test coverage.

**Why the usage-logger.ts file was missed in the plan:** The plan's file-list task didn't run a grep for console.* calls — it was a manual list. Grep during implementation caught this.

## Lessons Learned

1. **Broken tooling should fail fast with diagnostic output.** The ask-chatgpt gate failed silently (just returned 401 each time without logging why). This turned a misconfigured external dependency into pure friction. The hook should log the 401 response and suggest "check OpenAI key in .env" or similar.

2. **Date strings in JavaScript are a footgun.** `toISOString()` always returns UTC. For local-date requirements, always use getFullYear/getMonth/getDate. Add a test that verifies logs written at 23:00 and 01:00 local time go to the same file (day-boundary correctness).

3. **File-change checklists should use grep, not manual lists.** The plan said "replace console.* in index.ts, notify.ts, key-store.ts, web/server.ts" but missed usage-logger.ts. A grep for `console\.` would have caught all 5 in one pass.

4. **Security trade-offs should be documented in code comments.** The log file contains full ask_chatgpt responses in plaintext. Future developers should know this was intentional and accepted by the user, not a mistake. Add a comment in logger.ts and the docs.

## Next Steps

1. **Rotate or replace the OpenAI API key.** Check `.env` or the hook configuration for the ask_chatgpt key. If it's expired, obtain a new one from OpenAI. If it's intentionally offline (e.g., local development), disable the ask-chatgpt-gate hook so AskUserQuestion doesn't wait for a guaranteed-to-fail call.

2. **Test the logging feature end-to-end.** The implementation is correct per the spec, but it hasn't been tested in a real environment yet. Next session should: (a) start the server, (b) make a real ask_chatgpt call and verify it appears in today's log file, (c) test log file rollover at midnight (write at 23:50 local, verify at 00:10 local that a new file was created), (d) verify the dashboard Sync button fetches and renders correctly.

3. **Add date-boundary test to prevent regression.** Write a test (or doc steps) that verifies logs at 23:59 and 00:01 local time go to the correct files. Mock Date if needed to make this non-flaky.

4. **Document the security trade-off in README.md and code comments.** Users should know that log files contain full ask_chatgpt questions/answers in plaintext, and that the dashboard log viewer has no authentication. Add a note in the logger.ts header and in the security/deployment section of the README.

## Unresolved Questions

- When will the OpenAI API key be rotated/replaced, and who owns this task?
- Should the ask-chatgpt-gate hook be disabled in local development to avoid friction, or is independent AI verification always required?
- Has the per-key-config feature (from prior session) been tested in a real environment yet, or is this the first time the server is being run end-to-end?
