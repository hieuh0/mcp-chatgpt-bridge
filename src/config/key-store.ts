import crypto from "node:crypto";
import { db } from "./db.js";
import { getSetting, setSetting } from "./app-settings.js";

export type ProviderName = "openai" | "gemini";

const VALID_PROVIDERS: ProviderName[] = ["openai", "gemini"];

export interface ProviderKey {
  id: string;
  provider: ProviderName;
  label: string;
  value: string;
  enabled: boolean;
  baseURL?: string;
  model?: string;
  cooldownUntil?: string;
  lastUsedAt: string;
}

interface ProviderKeyRow {
  id: string;
  provider: ProviderName;
  label: string;
  value: string;
  enabled: number;
  base_url: string | null;
  model: string | null;
  cooldown_until: string | null;
  last_used_at: string;
}

function rowToKey(row: ProviderKeyRow): ProviderKey {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    value: row.value,
    enabled: row.enabled === 1,
    baseURL: row.base_url ?? undefined,
    model: row.model ?? undefined,
    cooldownUntil: row.cooldown_until ?? undefined,
    lastUsedAt: row.last_used_at,
  };
}

export function isValidProvider(value: string): value is ProviderName {
  return (VALID_PROVIDERS as string[]).includes(value);
}

// Used by the web server to validate a PATCH's `baseURL` against the key's existing
// provider (gemini keys reject a non-empty baseURL) without leaking raw SQL into server.ts.
export function getKeyProvider(id: string): ProviderName | undefined {
  const row = db.prepare(`SELECT provider FROM provider_keys WHERE id = @id`).get({ id }) as
    | { provider: ProviderName }
    | undefined;
  return row?.provider;
}

// The single place `activeProvider` is read from `settings` — every downstream
// `provider === "openai" ? ... : ...` dispatch trusts this value without re-validating.
export function getActiveProvider(): ProviderName {
  const value = getSetting("activeProvider");
  if (!value || !isValidProvider(value)) {
    if (value) {
      console.error(`getActiveProvider: invalid stored value "${value}", falling back to "openai"`);
    }
    return "openai";
  }
  return value;
}

export function setActiveProvider(provider: ProviderName): void {
  setSetting("activeProvider", provider);
}

export function pickKeyForCall(provider: ProviderName): { key: ProviderKey } | null {
  const row = db
    .prepare(
      `SELECT * FROM provider_keys
       WHERE provider = @provider AND enabled = 1 AND (cooldown_until IS NULL OR cooldown_until < @now)
       ORDER BY last_used_at ASC LIMIT 1`
    )
    .get({ provider, now: new Date().toISOString() }) as ProviderKeyRow | undefined;
  return row ? { key: rowToKey(row) } : null;
}

export interface MaskedKey {
  id: string;
  label: string;
  masked: string;
  enabled: boolean;
  baseURL?: string;
  model?: string;
}

// Reused by the web dashboard (Phase 3) and migration logging (Phase 4) — raw key
// values must never be printed anywhere, this is the one place that masks them.
export function mask(value: string): string {
  return value.length <= 6 ? "***" : "***" + value.slice(-4);
}

export function listKeysMasked(provider: ProviderName): MaskedKey[] {
  const rows = db
    .prepare(
      `SELECT id, label, value, enabled, base_url, model FROM provider_keys WHERE provider = @provider ORDER BY label`
    )
    .all({ provider }) as Array<{
    id: string;
    label: string;
    value: string;
    enabled: number;
    base_url: string | null;
    model: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    masked: mask(r.value),
    enabled: r.enabled === 1,
    baseURL: r.base_url ?? undefined,
    model: r.model ?? undefined,
  }));
}

export function addKey(
  provider: ProviderName,
  label: string,
  value: string,
  opts?: { baseURL?: string; model?: string }
): MaskedKey {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO provider_keys (id, provider, label, value, enabled, base_url, model, last_used_at)
     VALUES (@id, @provider, @label, @value, 1, @baseURL, @model, '')`
  ).run({ id, provider, label, value, baseURL: opts?.baseURL ?? null, model: opts?.model ?? null });
  return { id, label, masked: mask(value), enabled: true, baseURL: opts?.baseURL, model: opts?.model };
}

// `id` is a globally-unique UUID (dashboard-added) or fixed migration id — no provider
// scoping needed, matches every key across both providers.
//
// `baseURL`/`model` use clear/leave/set semantics (same convention as `/api/settings`):
// `undefined` (key omitted from patch) leaves the column unchanged, `""` clears it to
// NULL, any other non-empty string sets it. Expressed as a single CASE-guarded UPDATE
// (no separate SELECT-then-UPDATE) so there's no read-then-write window a concurrent
// PATCH on the same row could land in between.
export function updateKey(
  id: string,
  patch: { enabled?: boolean; label?: string; baseURL?: string; model?: string }
): boolean {
  const result = db
    .prepare(
      `UPDATE provider_keys SET
         enabled = COALESCE(@enabled, enabled),
         label = COALESCE(@label, label),
         base_url = CASE WHEN @baseURLTouched = 1 THEN @baseURL ELSE base_url END,
         model = CASE WHEN @modelTouched = 1 THEN @model ELSE model END
       WHERE id = @id`
    )
    .run({
      id,
      enabled: patch.enabled === undefined ? null : patch.enabled ? 1 : 0,
      label: patch.label ?? null,
      baseURLTouched: patch.baseURL === undefined ? 0 : 1,
      baseURL: patch.baseURL === "" ? null : (patch.baseURL ?? null),
      modelTouched: patch.model === undefined ? 0 : 1,
      model: patch.model === "" ? null : (patch.model ?? null),
    });
  return result.changes > 0;
}

export function deleteKey(id: string): boolean {
  const result = db.prepare(`DELETE FROM provider_keys WHERE id = @id`).run({ id });
  return result.changes > 0;
}

// Schema (CREATE TABLE IF NOT EXISTS) already ran in db.ts at import time. No more
// auto-seeding a key from OPENAI_API_KEY — keys are managed exclusively via the web
// dashboard from the very first run (see app-settings.ts for the equivalent decision on
// notify/port settings). This only ensures a default `activeProvider` exists so
// getActiveProvider() has a persisted value. INSERT OR IGNORE on a fixed primary key is a
// real no-op at the database level on conflict — safe to call from both the MCP and web
// processes at startup without clobbering a value the user already chose via the dashboard.
export function ensureMigrated(): void {
  db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('activeProvider', 'openai')`).run();
}

// `cooldownUntil` is only set on 429 (a real rate-limit signal worth pausing on); other
// failures (401, 5xx, other) still update `last_used_at` with no cooldown, so a broken key
// gets pushed to the back of the LRU queue and the next call tries a different key instead
// of retrying the same dead one indefinitely.
export type CallOutcome = { success: true } | { success: false; cooldownUntil?: string };

// Single atomic UPDATE — no separate read-then-write, no snapshot held across the async call.
// If the key was deleted mid-call, WHERE matches 0 rows: correct, silent no-op.
export function recordCallOutcome(provider: ProviderName, keyId: string, outcome: CallOutcome): void {
  db.prepare(
    `UPDATE provider_keys SET last_used_at = @lastUsedAt, cooldown_until = @cooldownUntil
     WHERE id = @keyId AND provider = @provider`
  ).run({
    lastUsedAt: new Date().toISOString(),
    cooldownUntil: outcome.success ? null : (outcome.cooldownUntil ?? null),
    keyId,
    provider,
  });
}
