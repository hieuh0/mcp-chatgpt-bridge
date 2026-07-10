import { db } from "./db.js";

// Generic key-value accessors for the `settings` table — used for anything that isn't
// provider/key-store specific (web dashboard port, notify-channel secrets). Provider-specific
// settings (activeProvider) still live in key-store.ts, which is the concern that owns them.
export function getSetting(key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM settings WHERE key = @key`).get({ key }) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (@key, @value)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run({ key, value });
}

export function deleteSetting(key: string): void {
  db.prepare(`DELETE FROM settings WHERE key = @key`).run({ key });
}

const LEGACY_ENV_SETTINGS: Record<string, string> = {
  webConfigPort: "WEB_CONFIG_PORT",
  telegramBotToken: "TELEGRAM_BOT_TOKEN",
  telegramChatId: "TELEGRAM_CHAT_ID",
  slackWebhookUrl: "SLACK_WEBHOOK_URL",
};

// One-time bootstrap from a previous .env-based setup, same spirit as key-store's
// ensureMigrated() for provider keys: only seeds if the settings table doesn't already
// have a value (INSERT OR IGNORE) and the env var is actually set. After this runs once,
// the env vars are never read again — manage everything from here on via the dashboard.
export function migrateAppSettings(): void {
  for (const [settingKey, envVar] of Object.entries(LEGACY_ENV_SETTINGS)) {
    const envValue = process.env[envVar];
    if (envValue) {
      db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (@key, @value)`).run({
        key: settingKey,
        value: envValue,
      });
    }
  }
}
