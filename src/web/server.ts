import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import {
  addKey,
  deleteKey,
  ensureMigrated,
  getActiveProvider,
  getKeyProvider,
  isValidProvider,
  listKeysMasked,
  mask,
  setActiveProvider,
  updateKey,
} from "../config/key-store.js";
import { deleteSetting, getSetting, migrateAppSettings, setSetting } from "../config/app-settings.js";
import { summarize } from "../usage/usage-aggregator.js";
import { DEFAULT_MODEL as OPENAI_DEFAULT_MODEL } from "../providers/openai-provider.js";
import { DEFAULT_MODEL as GEMINI_DEFAULT_MODEL } from "../providers/gemini-provider.js";

// Idempotent — safe to run here even if the MCP stdio process already ran these at its
// own startup (INSERT OR IGNORE, see key-store.ts / app-settings.ts).
ensureMigrated();
migrateAppSettings();

const DEFAULT_PORT = 4141;
// No more WEB_CONFIG_PORT env var — the port is a dashboard-editable setting. A value
// changed here only takes effect on the NEXT `npm run web` restart (an already-listening
// Express server can't rebind), the dashboard surfaces this explicitly.
const PORT = Number(getSetting("webConfigPort")) || DEFAULT_PORT;
// Host is intentionally hardcoded, never configurable — relaxing this needs a
// follow-up security decision, not a config flag (see plan.md Critical Constraint).
const HOST = "127.0.0.1";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dashboardHtml = fs.readFileSync(path.join(REPO_ROOT, "src", "web", "dashboard.html"), "utf-8");

const app = express();
app.use(express.json());

// [Red Team fix — no CSRF/Origin defense] "Localhost-only, no auth" defends against remote
// network attackers, not a malicious page in another browser tab silently POSTing to this
// port. Reject cross-origin mutating requests; same-origin/no-Origin (curl, the dashboard
// page itself) requests pass through.
//
// Allow both hostnames a browser may use to reach this server (both resolve to the same
// loopback interface) — same-origin fetch() from the dashboard page sends whichever one
// the user typed in the address bar. Hardcoding one would 403 every legitimate request
// whenever the other hostname is used.
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

// [Security fix — DNS rebinding] The previous check only compared `Origin` against
// `Host`, which a DNS-rebinding attacker fully controls on both sides (a page served from
// their own domain, later rebound to resolve to 127.0.0.1, sends a matching Origin/Host
// pair that isn't actually this server's loopback address). Validate `Host` against an
// explicit allowlist first — this is what actually anchors the check to "this server",
// not just "these two headers agree with each other".
function requireSameOrigin(req: Request, res: Response, next: NextFunction): void {
  if (!req.headers.host || !ALLOWED_HOSTS.has(req.headers.host)) {
    res.status(403).json({ error: "Invalid host" });
    return;
  }
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) {
    res.status(403).json({ error: "Cross-origin requests are not allowed" });
    return;
  }
  next();
}

app.get("/", (_req, res) => {
  res.type("html").send(dashboardHtml);
});

app.get("/api/state", (_req, res) => {
  const activeProvider = getActiveProvider();
  const usage = summarize();
  res.json({
    activeProvider,
    providers: {
      openai: { defaultModel: OPENAI_DEFAULT_MODEL, keys: listKeysMasked("openai") },
      gemini: { defaultModel: GEMINI_DEFAULT_MODEL, keys: listKeysMasked("gemini") },
    },
    usage,
  });
});

app.post("/api/provider", requireSameOrigin, (req, res) => {
  const { provider } = req.body ?? {};
  if (typeof provider !== "string" || !isValidProvider(provider)) {
    res.status(400).json({ error: "provider must be exactly 'openai' or 'gemini'" });
    return;
  }
  setActiveProvider(provider);
  res.json({ ok: true });
});

// Only http/https make sense as an OpenAI-SDK baseURL — reject other schemes (e.g.
// `file://`) at input time instead of letting them fail confusingly inside the SDK later.
// Returns an error string on failure, or null when `value` is valid (or empty/undefined).
function validateBaseURL(provider: string, value: unknown): string | null {
  if (value === undefined || value === "") return null;
  if (typeof value !== "string") return "baseURL must be a string if provided";
  if (provider === "gemini") return "baseURL is not supported for gemini keys";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "baseURL must be a valid URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "baseURL must use http or https";
  }
  return null;
}

app.post("/api/keys", requireSameOrigin, (req, res) => {
  const { provider, label, value, baseURL, model } = req.body ?? {};
  if (typeof provider !== "string" || !isValidProvider(provider)) {
    res.status(400).json({ error: "provider must be exactly 'openai' or 'gemini'" });
    return;
  }
  if (typeof label !== "string" || !label.trim() || typeof value !== "string" || !value.trim()) {
    res.status(400).json({ error: "label and value are required" });
    return;
  }
  const baseURLError = validateBaseURL(provider, baseURL);
  if (baseURLError) {
    res.status(400).json({ error: baseURLError });
    return;
  }
  if (model !== undefined && typeof model !== "string") {
    res.status(400).json({ error: "model must be a string if provided" });
    return;
  }
  // Trim — a key pasted from a clipboard commonly carries a trailing newline/space that
  // would pass the .trim() check above but still get stored (and later sent as an auth
  // header) with the whitespace intact, causing a confusing 401.
  const key = addKey(provider, label.trim(), value.trim(), {
    baseURL: typeof baseURL === "string" && baseURL.trim() ? baseURL.trim() : undefined,
    model: typeof model === "string" && model.trim() ? model.trim() : undefined,
  });
  res.status(201).json(key);
});

app.patch("/api/keys/:id", requireSameOrigin, (req, res) => {
  const { enabled, label, baseURL, model } = req.body ?? {};
  if (enabled !== undefined && typeof enabled !== "boolean") {
    res.status(400).json({ error: "enabled must be a boolean if provided" });
    return;
  }
  if (label !== undefined && (typeof label !== "string" || !label.trim())) {
    res.status(400).json({ error: "label must be a non-empty string if provided" });
    return;
  }
  if (baseURL !== undefined && typeof baseURL !== "string") {
    res.status(400).json({ error: "baseURL must be a string if provided" });
    return;
  }
  // Clearing (an exact `""`) is always allowed for either provider; anything else
  // (including a whitespace-only string, same as POST) is validated against scheme +
  // gemini rejection, using the key's existing provider.
  if (baseURL !== undefined && baseURL !== "") {
    const provider = getKeyProvider(req.params.id);
    if (provider) {
      const baseURLError = validateBaseURL(provider, baseURL);
      if (baseURLError) {
        res.status(400).json({ error: baseURLError });
        return;
      }
    }
  }
  if (model !== undefined && typeof model !== "string") {
    res.status(400).json({ error: "model must be a string if provided" });
    return;
  }
  const found = updateKey(req.params.id, {
    enabled,
    label: label?.trim(),
    baseURL: baseURL === undefined ? undefined : baseURL.trim(),
    model: model === undefined ? undefined : model.trim(),
  });
  if (!found) {
    res.status(404).json({ error: "key not found" });
    return;
  }
  res.json({ ok: true });
});

app.delete("/api/keys/:id", requireSameOrigin, (req, res) => {
  const found = deleteKey(req.params.id);
  if (!found) {
    res.status(404).json({ error: "key not found" });
    return;
  }
  res.json({ ok: true });
});

app.get("/api/settings", (_req, res) => {
  const telegramBotToken = getSetting("telegramBotToken");
  const slackWebhookUrl = getSetting("slackWebhookUrl");
  res.json({
    webConfigPort: PORT,
    telegram: {
      botToken: telegramBotToken ? mask(telegramBotToken) : null,
      chatId: getSetting("telegramChatId") ?? null,
    },
    slack: {
      webhookUrl: slackWebhookUrl ? mask(slackWebhookUrl) : null,
    },
  });
});

// Empty string clears a setting (e.g. disable a notify channel); omitted field leaves it
// unchanged. webConfigPort only takes effect after restarting `npm run web`.
app.patch("/api/settings", requireSameOrigin, (req, res) => {
  const { webConfigPort, telegramBotToken, telegramChatId, slackWebhookUrl } = req.body ?? {};

  if (webConfigPort !== undefined) {
    const portNum = Number(webConfigPort);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      res.status(400).json({ error: "webConfigPort must be an integer between 1 and 65535" });
      return;
    }
    setSetting("webConfigPort", String(portNum));
  }
  for (const [key, value] of Object.entries({ telegramBotToken, telegramChatId, slackWebhookUrl })) {
    if (value === undefined) continue;
    if (typeof value !== "string") {
      res.status(400).json({ error: `${key} must be a string` });
      return;
    }
    if (value === "") deleteSetting(key);
    else setSetting(key, value);
  }
  res.json({ ok: true, restartRequired: webConfigPort !== undefined });
});

// Catches malformed JSON bodies (express.json() throws) and any other unhandled route error.
// Must be registered last, with 4 params, for Express to treat it as an error handler.
// Never leak the stack trace or internal file paths to the HTTP client — log full detail
// server-side, return a generic message (see security-rules: no stack traces in API responses).
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled web server error:", err);
  res.status(400).json({ error: "Invalid request" });
});

app.listen(PORT, HOST, () => {
  console.log(`mcp-chatgpt-bridge web config server listening on http://${HOST}:${PORT}`);
});
