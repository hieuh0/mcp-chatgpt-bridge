import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DB_PATH = path.join(REPO_ROOT, "data.sqlite");

export const db = new Database(DB_PATH);
// Allows the MCP stdio process and the web server process to read/write
// concurrently without blocking each other on every statement.
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS provider_keys (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('openai','gemini')),
    label TEXT NOT NULL,
    value TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    base_url TEXT,
    cooldown_until TEXT,
    last_used_at TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_provider_keys_provider ON provider_keys(provider);
  CREATE TABLE IF NOT EXISTS usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    provider TEXT NOT NULL,
    key_id TEXT NOT NULL,
    label TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL,
    completion_tokens INTEGER NOT NULL,
    total_tokens INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    error_kind TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_usage_provider ON usage_events(provider);
  CREATE INDEX IF NOT EXISTS idx_usage_key ON usage_events(key_id);
`);

// `CREATE TABLE IF NOT EXISTS` above is a no-op for a `provider_keys` table that already
// exists (pre-existing data.sqlite files), so a new column must be added via ALTER TABLE.
// Safe to run on every startup: SQLite throws "duplicate column name" once the column
// exists, which we treat as expected; any other error still surfaces.
try {
  db.exec(`ALTER TABLE provider_keys ADD COLUMN model TEXT`);
} catch (err) {
  if (!(err instanceof Error) || !err.message.includes("duplicate column name")) throw err;
}

// Holds raw API keys — must not be group/world-readable.
fs.chmodSync(DB_PATH, 0o600);
