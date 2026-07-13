# Red-Team Review Catches Critical SSRF Before Implementation

**Date**: 2026-07-10 14:33  
**Severity**: Critical (security implications; resolved via design revision)  
**Component**: Fetch-models dashboard feature, server proxy endpoint  
**Status**: Resolved

## What Happened

Implemented a feature to let users click "Fetch models" on the dashboard and auto-populate model suggestions from an OpenAI-compatible endpoint. The feature is inherently security-sensitive: it sends a real API key as a Bearer token to a URL the request can partially control (`baseURL`). Before writing code, sent the plan through red-team review (2 adversarial reviewers: Security Adversary, Assumption Destroyer). They found 10 findings, 3 Critical. The plan was rewritten to close all three Critical gaps, implementation proceeded, and code review found 2 additional Medium issues, both fixed. Commit `682d7b0`.

## The Brutal Truth

This session validates something that should be obvious but often isn't: **red-teaming a security-sensitive plan before implementation is worth the overhead**, because the gaps it catches would be real vulnerabilities in production.

The original design's CRITICAL failures were not edge cases or theoretical bugs — they were concrete attack paths that would have worked:

1. **SSRF to cloud metadata was wide open**: `validateBaseURL()` checked only that the URL's syntax was valid and used `http:`/`https:` scheme. It never checked the destination hostname. So `baseURL: "http://169.254.169.254/latest/meta-data/..."` would pass cleanly, and the server would send a real Bearer token there. Same for loopback (`127.0.0.1:6379`, hit a local Redis), or any RFC1918 private-range address. In a containerized environment with an adjacent service, this is a real exfiltration path.

2. **Credential exfiltration bypass via missing Origin header was feasible**: The existing `requireSameOrigin` middleware explicitly allows requests with no `Origin` header at all — by design, so `curl` scripts can hit other routes. Any local non-browser process (malware, a compromised dependency, another running app) could call the new route with correct Host header and no Origin, and it would pass through. Then the server would send the real key to wherever the local process pointed `baseURL`. The fact that `/api/state` was unauthenticated and returned key IDs meant an attacker could enumerate all keys first.

3. **Regression to existing ask() behavior was silent**: The plan had `resolveOpenAIBaseURL()` always return a concrete string. But the OpenAI Node SDK only consults the `OPENAI_BASE_URL` env var when `baseURL` is **omitted** from the constructor (i.e. `undefined`). Passing an explicit string, even one equal to the SDK's own default, disables that fallback. For anyone relying on `OPENAI_BASE_URL` without a per-key baseURL set, the existing `ask()` call path would silently break. Not a security hole, but a shipped regression to behavior that existed before this feature.

If the naive first-draft plan had been implemented without review, three distinct attack surfaces would have shipped: SSRF, credential exfiltration, and a regression to unrelated code.

The red-team review cost maybe 1–2 hours. The cost of rolling back SSRF vulnerabilities from production is orders of magnitude higher.

## Technical Details

**Finding severity breakdown (10 total, 0 rejected):**
- **Critical (3):** SSRF via unvalidated destination (Finding 1), credential exfiltration via no-Origin bypass (Finding 2), regression to `ask()`'s env-var fallback (Finding 3).
- **High (2):** First `async` handlers in Express 4, which don't forward rejected promises to error middleware (Finding 4); unvalidated query-param type assertion, where duplicate params yield arrays and `.trim()` crashes (Finding 5).
- **Medium (5):** Disabled keys still usable via the new route (Finding 6); no `redirect: "manual"` letting a 3xx bypass destination validation (Finding 7); apiKey not trimmed like baseURL, reintroducing a whitespace/401 bug (Finding 8); success-criteria test only replayed an old unrelated test, missing the actual no-Origin gap (Finding 9); Phase 2's "single helper" claim contradicted by its own code sample (Finding 10).

**Code-reviewer findings (2 additional, caught during implementation):**
- `isForbiddenTarget()` didn't handle IPv4-mapped-IPv6 notation (`::ffff:127.0.0.1`), letting loopback be reached via IPv6 bypass. Fixed: strip the prefix before checks.
- CGNAT range (`100.64.0.0/10`) wasn't in the blocklist. Fixed: added regex check.

**Documentation gaps found and closed:**
- `docs/system-architecture.md` had no explanation of why this feature's security guards exist. Added a subsection "Fetch-Models Routes: Outbound Requests Carrying a Real Secret" explaining the rationale and accepted residual risk (same-origin-with-DOM-access).
- `docs/deployment-guide.md` had no row for the new "Fetch models" feature or a previously-documented "Edit key" feature (both OpenAI-only). Added both.

## What We Tried

1. **Red-team review before implementation:** sent the plan to 2 adversarial reviewers with explicit criteria (Fact-Checker pass on all cited code locations). Result: 10 findings, all backed by source code, 0 rejected as unfounded.
2. **Rewrote the plan:** addressed all 3 Critical findings:
   - Critical #1: Added `validateFetchModelsTarget()` — DNS-resolve hostname, blocklist loopback/link-local/private/CGNAT ranges.
   - Critical #2: Added `requireSameOriginStrict()` — require Origin header, not just lenient match. Applied only to these two new routes; did not change existing lenient middleware for other routes.
   - Critical #3: Kept `resolveOpenAIBaseURL()`'s return type as `string | undefined`; `ask()`'s call site unchanged; only the new routes apply a default string at call time.
3. **Implemented both phases** with the revised plan, testing all 9 success criteria (including the corrected test for no-Origin requests).
4. **Code review found 2 additional issues** during implementation. Both were Medium-severity edge cases (IPv4-mapped-IPv6 bypass, CGNAT omission). Fixed immediately.
5. **Updated docs** after implementation to cover the new attack surface and rationale.

## Root Cause Analysis

**Why the original plan had three Critical gaps:** The plan author (me) was thinking about the feature functionally (fetch models, show suggestions) and assumed the existing `validateBaseURL()` + `requireSameOrigin` middleware would be sufficient. They are not — `validateBaseURL` was designed to check syntax/scheme, not destination; `requireSameOrigin` was designed to protect against cross-site forgery when `curl` support is also needed, so it explicitly allows no-Origin. The plan's own text listed SSRF as the "top concern" but the stated mitigations were actually insufficient. Red-team review forced me to verify that each mitigation actually closed its corresponding threat.

**Why the IPv4-mapped-IPv6 and CGNAT issues slipped past red-team:** These were edge cases the red-team's two reviewers didn't anticipate (they checked the explicit blocklist structure I provided, but didn't brainstorm all possible IPv6 notations or CGNAT as a separate threat). Code review during implementation is the right place to catch these residual gaps, and it did.

## Lessons Learned

1. **Red-team review of security-sensitive designs before implementation is not a luxury.** It's worth the 1–2 hour cost because it catches real vulnerabilities that would be expensive to patch in production. Don't wait for code review; do it before you start implementing.

2. **State mitigations explicitly, then verify they actually work.** The plan said "SSRF is a top concern" and "we'll use `validateBaseURL` to mitigate it." But `validateBaseURL` doesn't actually do that — it only checks syntax. The review forced me to articulate what mitigation actually closes that gap (destination-host validation) and implement it.

3. **Relying on existing middleware for new threat models is risky.** The `requireSameOrigin` middleware was designed for one set of threats (cross-site forgery). The new routes have a different threat model (a non-browser local caller exfiltrating a secret). The existing middleware doesn't apply; a stricter variant was needed.

4. **IPv6 notation and CGNAT are real gaps in naive IP blocklists.** Both are legitimate edge cases, not corner cases. IPv4-mapped-IPv6 is how some DNS resolvers return results; CGNAT is in widespread use (carrier-grade NAT). If you're blocking IP ranges, enumerate all these variants explicitly.

5. **Documentation of threat models is worth the effort.** Future maintainers (and future-me) need to understand why these specific guards exist and what residual risk was accepted. That understanding is in the red-team review notes and the phase files; I added it to the architecture doc so it's findable without digging through plan history.

## Next Steps

1. **Monitor for regression:** The feature is now live. No known issues in testing, but edge cases (unusual baseURL formats, IPv6 endpoints, rate-limiting on the target endpoint) might emerge in real use. Next session should spot-check the logs for any failed fetches and investigate outliers.

2. **Consider documenting the red-team process.** This worked well. Future security-sensitive features should follow the same pattern: plan + red-team review + revised plan + implementation + code review. Codify this as part of the development workflow.

3. **Audit other routes for similar gaps.** `validateBaseURL()` is used elsewhere (POST /api/keys, PATCH /api/keys/:id). Neither sends secrets off-box, so the stakes are different, but verifying they don't have unintended SSRF surface would be good hygiene.

## Unresolved Questions

- Were there any other IPv6 notations or CIDR bypasses the blocklist still misses? (Unlikely, but a more comprehensive audit against RFC 5952 and other IPv6 specs might catch edge cases.)
- Is 8 seconds an appropriate timeout for the upstream fetch? (Tested against live api.openai.com; no observed hangs. But different endpoints might have different latencies. Could make this configurable per-key in a future iteration.)
- Should the same strict Origin requirement apply to other routes that make assumptions about browser vs. script contexts? (Out of scope for this feature, but worth an audit.)
