# README Clarity Discovery: Architecture Mismatch, Not Decoration Debt

**Date**: 2026-07-22 15:35  
**Severity**: Low  
**Component**: Documentation / README.md  
**Status**: Decision Made / Awaiting Implementation

## What Happened

User asked to "prettify README.md, want it clear" — vague scope. Ran brainstorm skill to clarify. Discovered root cause wasn't decoration (badges, ToC, formatting) but structural: README duplicates architectural detail that belongs in `docs/system-architecture.md`. Presented concrete redesign (badge row + ToC + feature list + Mermaid flowchart + trimmed Architecture section linking to authoritative docs). User approved all recommendations. No implementation done yet — deferred to follow-up session.

## The Brutal Truth

Almost implemented the wrong fix. Without scouting first, would've added badges and prettier formatting to an already-too-detailed document. The clarity problem isn't that README lacks decoration — it's that README tries to be both intro AND architecture reference simultaneously. Duplication creates cognitive load, not badges.

## Technical Details

**Actual state:**
- README: 85 lines, plain prose, no ToC/badges/diagram
- docs/system-architecture.md: 7-step detailed data flow + hook mechanics (500+ lines, authoritative)
- README duplicates: MCP spec, data flow, hook system architecture
- package.json: no `license` or `repository` fields; no LICENSE file exists
- README currently hedges with misleading "See LICENSE file if present"
- No CI/test suite (so no CI badges to claim)

**Discovery questions & user choices:**
1. Scope: Trim + reformat vs format-only → Chose trim + reformat (correct)
2. Badges: Add verifiable ones vs none → Chose verifiable (node>=18, MCP-compatible, license-none, status-demo)
3. Diagram: Mermaid vs text → Chose Mermaid (clearer)
4. Language: English-only vs bilingual → Chose English-only (matches existing docs convention)

## Root Cause

README structure conflates two audiences: users looking for quick overview (badges, features, quick-start) and developers needing architecture (data flow, hook mechanics). The document tries to serve both, creating 85 lines of mixed detail. Clarity failed not at decoration layer but at information architecture layer.

## Lessons Learned

When asked to "make docs clearer," scout the information structure first. Don't assume the fix is CSS/formatting. Check:
- What detail actually belongs here vs in specialized docs?
- Is duplication the hidden cost of the prose?
- Are there false claims or misleading statements (LICENSE file hedge)?
- What dependencies or context gaps create confusion?

Trim + reformat beats decoration-only every time.

## Next Steps

1. Implement README.md edits per approved design (follow-up session, not blocked)
2. Create LICENSE file or update package.json with license info (to remove misleading hedge)
3. Verify all badge claims are current/verifiable before shipping

**Owner**: Deferred to implementer  
**Timeline**: Next session  
**Blockers**: None
