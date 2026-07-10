import { db } from "../config/db.js";

export interface UsageSummary {
  totalRequests: number;
  totalTokens: number;
  byProvider: Record<string, { requests: number; tokens: number }>;
  byKey: Record<string, { provider: string; label: string; requests: number; tokens: number }>;
}

// Note: `label` in `byKey` reflects whatever label was recorded AT THE TIME of each logged
// call (denormalized into usage_events, not joined against the current provider_keys.label) —
// renaming a key later does not rewrite historical usage rows. Intentional, not a bug.
export function summarize(sinceIso?: string): UsageSummary {
  const where = sinceIso ? "WHERE ts >= ?" : "";
  const args = sinceIso ? [sinceIso] : [];

  const totals = db
    .prepare(`SELECT COUNT(*) as requests, COALESCE(SUM(total_tokens), 0) as tokens FROM usage_events ${where}`)
    .get(...args) as { requests: number; tokens: number };

  const byProviderRows = db
    .prepare(
      `SELECT provider, COUNT(*) as requests, COALESCE(SUM(total_tokens), 0) as tokens FROM usage_events ${where} GROUP BY provider`
    )
    .all(...args) as Array<{ provider: string; requests: number; tokens: number }>;

  const byKeyRows = db
    .prepare(
      `SELECT key_id, provider, label, COUNT(*) as requests, COALESCE(SUM(total_tokens), 0) as tokens FROM usage_events ${where} GROUP BY key_id`
    )
    .all(...args) as Array<{ key_id: string; provider: string; label: string; requests: number; tokens: number }>;

  return {
    totalRequests: totals.requests,
    totalTokens: totals.tokens,
    byProvider: Object.fromEntries(byProviderRows.map((r) => [r.provider, { requests: r.requests, tokens: r.tokens }])),
    byKey: Object.fromEntries(
      byKeyRows.map((r) => [r.key_id, { provider: r.provider, label: r.label, requests: r.requests, tokens: r.tokens }])
    ),
  };
}
