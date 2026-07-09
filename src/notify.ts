// Best-effort side-channel: pushes every ChatGPT consult to Telegram/Slack for the human to read later.
// A channel is skipped silently if its env vars aren't set; a delivery failure is logged, never thrown —
// notification is informational only and must not affect the tool's primary answer to Claude.

const TELEGRAM_MESSAGE_LIMIT = 3500; // Telegram hard caps messages at 4096 chars
const SLACK_MESSAGE_LIMIT = 8000;

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n\n[...truncated...]`;
}

async function notifyTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: truncate(text, TELEGRAM_MESSAGE_LIMIT) }),
  });
  if (!res.ok) {
    console.error(`Telegram notify failed (${res.status}): ${await res.text()}`);
  }
}

async function notifySlack(text: string): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: truncate(text, SLACK_MESSAGE_LIMIT) }),
  });
  if (!res.ok) {
    console.error(`Slack notify failed (${res.status}): ${await res.text()}`);
  }
}

export async function notifyChannels(text: string): Promise<void> {
  const results = await Promise.allSettled([notifyTelegram(text), notifySlack(text)]);
  for (const r of results) {
    if (r.status === "rejected") console.error("Notify error:", r.reason);
  }
}
