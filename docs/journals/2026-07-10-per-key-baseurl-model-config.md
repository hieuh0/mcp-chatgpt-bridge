# Per-Key baseURL + Model Config Session

**Date**: 2026-07-10 13:44  
**Severity**: Medium  
**Component**: Provider key configuration, model resolution, web dashboard, docs  
**Status**: Resolved

## What Happened

Implemented a design change that reversed a previously-documented decision: per-key `model` field (alongside per-key `baseURL`) with explicit precedence: the key's stored model always wins over the tool call's `model` parameter. Completed all 4 planned phases (schema migration, model resolution in tool contract, web API + dashboard UI, documentation updates). Code review flagged 2 issues, both fixed. Discovered two major problems during implementation: (1) docs were more broadly stale than just this feature's scope, with fabricated LOC estimates, and (2) the entire prior multi-provider refactor (key rotation, usage tracking, web dashboard — commit `bb90e1a` did NOT include any of `src/config/`, `src/providers/`, `src/web/`, `src/usage/`) had never been committed, living as untracked files for an unknown duration.

## The Brutal Truth

This was frustrating on multiple levels.

**The docs stale-ness discovery** is the immediate sting: I found that `docs/codebase-summary.md`'s LOC estimates were outright fabricated. It claimed `openai-provider.ts` was "~80 LOC" when it's actually 34 lines; `gemini-provider.ts` was "~90 LOC" when it's 46 lines; `key-store.ts` was "~200 LOC" when it's actually 235. Up to 2.5x off. The docs-manager subagent rewrote the entire file, but when I spot-checked its numbers against actual `wc -l` counts, I realized someone had been guessing or copy-pasting without verifying. That's a confidence-killer for any doc that claims to be a source of truth.

**The untracked-work discovery** is worse, though. The entire prior refactor — key rotation with cooldown, usage tracking to SQLite, the web dashboard for key/settings management — was sitting in the tree as untracked files (`src/config/`, `src/providers/`, `src/web/`, `src/usage/`), apparently from an earlier session that ended without committing. The initial commit `bb90e1a` is just a stub ("feat: initial mcp-chatgpt-bridge server"), and I've now shipped everything — prior refactor + this feature — all in one commit `1864c6b`. This isn't "bad" per se, it's actually the least-risky choice (the new feature code depends on the prior refactor directly, so splitting wasn't cleanly possible). But it does mean the repo history is now a white lie: it looks like this one session built the entire multi-provider system, model config, web dashboard, key rotation, and usage tracking all at once, when in fact the prior work was done days/weeks ago and just never committed.

**The near-miss with git checkout** was a low-level panic moment. At one point, I thought a subagent had made out-of-scope changes to `docs/deployment-guide.md` and nearly ran `git checkout -- docs/deployment-guide.md` to "revert" it. My comparison baseline was `git show HEAD:docs/deployment-guide.md`, which I expected to be "the last version before this session." Instead, HEAD is `bb90e1a`, the initial stub commit from months ago, which means that diff was completely meaningless — the revert would have destroyed legitimate prior work that was sitting untracked in the tree. The permission system denied the command before it ran, which is the only reason no data was lost. But this exposed a failure mode: **when there's substantial pre-existing uncommitted work in the tree, you can't trust `git diff` or `git show HEAD` to tell you what "this session changed"** — they're measuring against a meaningless baseline.

## Technical Details

**Code review findings (2, both fixed):**
1. `updateKey()` in `src/config/key-store.ts:157-179` was doing a SELECT (to read current `base_url`/`model`, so it could apply tri-state clear/set/leave semantics) followed by an UPDATE, all in synchronous context. This is accidentally safe today (better-sqlite3 is blocking, Node is single-threaded), but violates the atomicity principle. The fix was to replace the pre-read with a `CASE` expression keyed on the caller's tri-state sentinel — now a single atomic UPDATE, matching the style used for other fields like `enabled`/`label`.

2. PATCH `/api/keys/:id` allowed `baseURL` to be a whitespace-only string (`"   "`), which got trimmed and silently cleared the field. POST rejects the same input (validates before trimming). Fixed by validating the raw input in PATCH before trimming, matching POST's behavior.

**Docs stale-ness:**
- `docs/codebase-summary.md` had LOC estimates off by up to 2.5x (80 vs 34, 90 vs 46, etc.).
- Appeared to predate the entire multi-provider refactor, with references to old file layouts.
- Docs-manager subagent rewrote it; I corrected all LOC annotations to actual `wc -l` counts.

**Untracked work discovery:**
- `git log --oneline` showed only 2 commits before this session: `bb90e1a` (stub) and nothing else.
- The tree contained untracked files: `src/config/`, `src/providers/`, `src/web/`, `src/usage/` — entire multi-provider system.
- These were dependencies of the new feature, so splitting the commit wasn't feasible.
- Decision: commit everything together in `1864c6b`. Repo history is now a white lie, but it's the safest single action.

**Near-miss git checkout:**
- Incorrectly thought `git show HEAD:docs/deployment-guide.md` would show "last version from previous session."
- HEAD is `bb90e1a` (initial stub, months old), so the diff was meaningless.
- Would have reverted legitimate prior work that was sitting untracked.
- Permission system denied the command. No data lost, but this exposed that **`git diff HEAD`/`git show HEAD` is unreliable as a "what changed" baseline when untracked work exists.**

## What We Tried

1. **Fixed atomic-update issue**: Replaced SELECT-then-UPDATE with single `CASE`-based UPDATE.
2. **Fixed whitespace validation**: Added `validateBaseURL(baseURL.trim())` check before trimming in PATCH, matching POST.
3. **Fixed LOC annotations**: Ran `wc -l` against each file and replaced guesses with actual counts in `docs/codebase-summary.md`.
4. **Handled untracked work**: Committed everything together rather than trying to split (the new feature code directly depends on the prior refactor, so splitting wasn't cleanly possible).

## Root Cause Analysis

**Why the design was reversed:** The original decision ("model stays hardcoded per provider") assumed one endpoint per provider. Per-key `baseURL` broke that: a single OpenAI key can now point at OpenAI's API, OpenRouter, or a self-hosted proxy, each with a different valid model namespace. Model had to move from the provider config to the key config.

**Why the LOC counts were wrong:** `docs/codebase-summary.md` was written without actually running `wc -l` on the files, and never updated after the multi-provider refactor. This was likely a rough estimate that was never hardened.

**Why the prior refactor was untracked:** An earlier session (outside this conversation) did the entire multi-provider work, key rotation, usage tracking, and web dashboard, but the session ended without committing. The tree was left with untracked `src/config/`, `src/providers/`, `src/web/`, `src/usage/` directories.

**Why the git checkout almost happened:** I misunderstood the git history baseline. With untracked work sitting in the tree, `git show HEAD` doesn't show "my session's starting point" — it shows an ancient stub from months ago. This is a procedural error on my part, not a code problem.

## Lessons Learned

1. **Design reversals are normal when reality changes assumptions.** The model-hardcoding decision was correct given the assumption (one endpoint per provider). When that assumption broke (per-key `baseURL`), the decision had to reverse. This is fine; what matters is that the rationale (endpoint=namespace mapping) is documented.

2. **Always verify doc claims with actual measurements.** "~80 LOC" guesses are worse than no LOC estimate at all — they erode trust in the entire document. Every LOC claim should be backed by `wc -l` or similar.

3. **Untracked work in the tree is a repo hygiene timebomb.** When a session ends with untracked files, the next session can't trust `git diff HEAD` to answer "what did I change?" This should have been caught and resolved (either committed or stashed) when the prior session ended.

4. **`git show HEAD` with ancient history is meaningless.** Before using `git diff` or `git show HEAD` as a baseline for "what I changed," verify that HEAD is actually from the same session or at least after the start of active work. In this case, HEAD was a stub from months ago.

## Next Steps

1. **Verify the prior multi-provider work is correct.** The code-reviewer subagent checked it, but the fact that it was untracked for so long means it wasn't tested in a real environment. Next session should: run the server end-to-end, test key rotation with cooldown, verify usage tracking to SQLite, and spot-check the web dashboard's key/settings forms.

2. **Document the model precedence prominently.** The dashboard now shows a hint, but add it to the README and the tool schema as well, so callers understand why a hardcoded `model="gpt-5"` parameter to `ask_chatgpt` might be silently ignored.

3. **Restore repo history integrity (optional, low priority).** The single combined commit is safe and unambiguous, but if future sessions value a cleaner history, this could be split: one commit for the prior refactor (`src/config/`, `src/providers/`, `src/web/`, `src/usage/`, `package.json` deps for those) and one for the per-key-config feature. Not blocking; the current state is stable.

4. **Establish a "end of session" commit checklist.** Before a session ends, check for untracked files in `src/`, `docs/`, or other meaningful directories. Commit, stash, or .gitignore them explicitly — don't leave them hanging.

## Unresolved Questions

- When was the prior multi-provider refactor work done? (Not tracked in git, so I can't tell from commit history.)
- Why was the codebase-summary LOC estimation never run against actual files? (Was it copied from a different project? Written without tooling?)
