import { db } from "../config/db.js";
import type { ProviderName } from "../config/key-store.js";
import { logError } from "../logger.js";

export interface UsageEvent {
  ts: string; // ISO 8601
  provider: ProviderName;
  keyId: string;
  label: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  ok: boolean;
  errorKind?: string; // "401" | "429" | "5xx" | "other", only when ok=false
}

const insertStmt = db.prepare(`
  INSERT INTO usage_events
    (ts, provider, key_id, label, model, prompt_tokens, completion_tokens, total_tokens, ok, error_kind)
  VALUES (@ts, @provider, @keyId, @label, @model, @promptTokens, @completionTokens, @totalTokens, @ok, @errorKind)
`);

export function appendUsageEvent(e: UsageEvent): void {
  try {
    insertStmt.run({ ...e, ok: e.ok ? 1 : 0, errorKind: e.errorKind ?? null });
  } catch (err) {
    // Fail-open — matches notify.ts's precedent: logging must never throw into the caller.
    logError("mcp", "appendUsageEvent failed (non-fatal)", err);
  }
}
