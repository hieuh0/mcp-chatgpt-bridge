import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import {
  addKey,
  deleteKey,
  ensureMigrated,
  getActiveProvider,
  getKeyForFetchModels,
  getKeyProvider,
  isValidProvider,
  listKeysMasked,
  mask,
  setActiveProvider,
  updateKey,
} from "../config/key-store.js";
import { deleteSetting, getSetting, migrateAppSettings, setSetting } from "../config/app-settings.js";
import { summarize } from "../usage/usage-aggregator.js";
import { DEFAULT_MODEL as OPENAI_DEFAULT_MODEL, resolveOpenAIBaseURL } from "../providers/openai-provider.js";
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

// Stricter than requireSameOrigin: REQUIRES Origin to be present and match, rather than
// merely rejecting a *mismatched* Origin. requireSameOrigin's no-Origin passthrough is
// deliberate for the older mutating routes (curl/script convenience) but is not
// acceptable for the fetch-models routes below — they send a real secret to a
// request-influenced destination, so a non-browser local caller with no Origin header
// must not pass.
function requireSameOriginStrict(req: Request, res: Response, next: NextFunction): void {
  if (!req.headers.host || !ALLOWED_HOSTS.has(req.headers.host)) {
    res.status(403).json({ error: "Invalid host" });
    return;
  }
  if (!req.headers.origin || req.headers.origin !== `http://${req.headers.host}`) {
    res.status(403).json({ error: "Origin header required and must match this server" });
    return;
  }
  next();
}

// Ranges a "fetch models" convenience call must never reach, regardless of what the
// request claims — this endpoint sends a real Bearer token wherever it's pointed, so
// "the URL parses and uses http/https" (validateBaseURL) is not sufficient on its own.
function isForbiddenTarget(rawIp: string): boolean {
  // Strip an IPv4-mapped-IPv6 prefix ("::ffff:127.0.0.1" -> "127.0.0.1") so the IPv4
  // checks below can't be bypassed by a resolver returning that notation instead.
  const ip = rawIp.replace(/^::ffff:/i, "");
  if (/^127\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return true; // 100.64.0.0/10 (CGNAT)
  if (ip === "0.0.0.0") return true;
  if (ip === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true; // fc00::/7 (unique-local)
  if (/^fe80:/i.test(ip)) return true; // fe80::/10 (link-local)
  return false;
}

// Resolves the hostname, rejects loopback/link-local/private destinations, and returns the
// validated address to pin the actual request to. Returning the IP (not just an ok/error
// verdict) closes a TOCTOU gap: if this function only validated and the caller re-resolved
// the hostname itself for the real request, a DNS-rebinding attacker (TTL=0 record) could
// serve a public address here and a private one moments later for the real connection.
async function validateFetchModelsTarget(baseURL: string): Promise<{ ip: string } | { error: string }> {
  let hostname: string;
  try {
    hostname = new URL(baseURL).hostname;
  } catch {
    return { error: "baseURL must be a valid URL" };
  }
  let addresses: string[];
  try {
    const result = await dns.lookup(hostname, { all: true });
    addresses = result.map((r) => r.address);
  } catch {
    return { error: "Could not resolve baseURL host" };
  }
  if (addresses.length === 0 || addresses.some(isForbiddenTarget)) {
    return { error: "baseURL resolves to a disallowed address (loopback/private/link-local)" };
  }
  // Every address here already passed the check above (`.some()` would have rejected
  // otherwise), so any of them is safe to pin to — use the first.
  return { ip: addresses[0] };
}

// Shared by both fetch-models routes below. Connects directly to `pinnedIp` (the address
// validateFetchModelsTarget already checked) instead of letting the HTTP client re-resolve
// the hostname, which is what actually closes the DNS-rebinding TOCTOU window — the
// resolution used for the real request is the exact one that was validated, not a second,
// independent lookup an attacker's nameserver could answer differently. `Host` header and
// TLS `servername` still use the original hostname, so the request looks correct to the
// server and certificate validation is checked against the real hostname, not the IP.
// No manual redirect-following (matches the previous `redirect: "manual"` requirement) —
// any 3xx is treated as a failure, same as before.
async function fetchModelIds(apiKey: string, baseURL: string, pinnedIp: string): Promise<string[]> {
  const url = new URL(baseURL);
  const isHttps = url.protocol === "https:";
  const client = isHttps ? https : http;
  const requestPath = `${url.pathname.replace(/\/$/, "")}/models${url.search}`;

  const body = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn();
    };

    // A wall-clock deadline independent of the request's idle-timeout below: `options.timeout`
    // only fires when the socket has been idle, which never happens if the connection dies
    // mid-response without another event — this deadline fires regardless of socket state.
    const deadline = setTimeout(() => {
      req.destroy();
      settle(() => reject(new Error("request timed out")));
    }, 8000);

    const req = client.request(
      {
        hostname: pinnedIp,
        port: url.port || (isHttps ? 443 : 80),
        path: requestPath,
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}`, Host: url.host },
        // TLS SNI + certificate hostname verification target — keeps cert validation
        // correct even though the socket connects to `pinnedIp`, not `url.hostname`.
        servername: isHttps ? url.hostname : undefined,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          settle(() => reject(new Error("upstream returned a redirect")));
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          settle(() => reject(new Error(`upstream returned ${status}`)));
          return;
        }
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          data += chunk;
        });
        res.on("end", () => settle(() => resolve(data)));
        // Fires if the connection drops mid-response (reset, truncated body) without a
        // clean 'end' — without this, the promise would never settle and the request
        // would hang until the deadline above, or forever if that were ever removed.
        res.on("close", () => {
          if (!res.complete) settle(() => reject(new Error("upstream connection closed before response completed")));
        });
        res.on("error", (err) => settle(() => reject(err)));
      }
    );
    req.on("error", (err) => settle(() => reject(err)));
    req.end();
  });

  const parsed = JSON.parse(body) as { data?: Array<{ id?: string }> };
  const ids = (parsed.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
  return [...new Set(ids)].sort();
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

// For the Add-key form, before the key is saved — the raw apiKey is only ever used for
// this one outbound call, never persisted. requireSameOriginStrict (not the lenient
// requireSameOrigin) + validateFetchModelsTarget guard the real secret this route sends
// out. Entire body wrapped in one try/catch: this is the first async handler in this
// file, and Express 4 does not forward a rejected promise to the error middleware below.
app.post("/api/keys/fetch-models", requireSameOriginStrict, async (req, res) => {
  try {
    // No `provider` field — this route only exists for the openai Add-key form (Phase 2
    // never renders its "Fetch models" button for gemini); unlike the GET route below, it
    // never looks up a stored key's real provider, so there is no "wrong provider" input.
    const { apiKey, baseURL } = req.body ?? {};
    if (typeof apiKey !== "string" || !apiKey.trim()) {
      res.status(400).json({ error: "apiKey is required" });
      return;
    }
    const baseURLError = validateBaseURL("openai", baseURL);
    if (baseURLError) {
      res.status(400).json({ error: baseURLError });
      return;
    }
    const trimmedBaseURL = typeof baseURL === "string" && baseURL.trim() ? baseURL.trim() : undefined;
    const resolved = resolveOpenAIBaseURL(apiKey.trim(), trimmedBaseURL) ?? "https://api.openai.com/v1";
    // Validated (and pinned) regardless of whether baseURL came from the request or a
    // hardcoded default — the pinned IP is required either way for fetchModelIds below.
    const target = await validateFetchModelsTarget(resolved);
    if ("error" in target) {
      res.status(400).json({ error: target.error });
      return;
    }
    const models = await fetchModelIds(apiKey.trim(), resolved, target.ip);
    res.json({ models });
  } catch (err) {
    res.status(502).json({ error: `Could not fetch models: ${err instanceof Error ? err.message : "unknown error"}` });
  }
});

// For an already-saved key's row-edit mode — the client never has the raw key (only
// masked), so the server looks up its own stored value by id and makes the call itself.
app.get("/api/keys/:id/fetch-models", requireSameOriginStrict, async (req, res) => {
  try {
    const key = getKeyForFetchModels(req.params.id);
    if (!key) {
      res.status(404).json({ error: "key not found" });
      return;
    }
    if (key.provider !== "openai") {
      res.status(400).json({ error: "Model listing is only supported for openai keys" });
      return;
    }
    if (!key.enabled) {
      res.status(400).json({ error: "Key is disabled — enable it first to fetch its models" });
      return;
    }
    const queryBaseURL = req.query.baseURL;
    if (queryBaseURL !== undefined && typeof queryBaseURL !== "string") {
      res.status(400).json({ error: "baseURL must be a single string value" });
      return;
    }
    const baseURLError = validateBaseURL("openai", queryBaseURL);
    if (baseURLError) {
      res.status(400).json({ error: baseURLError });
      return;
    }
    const effectiveBaseURL = (queryBaseURL?.trim() || key.baseURL) ?? undefined;
    const resolved = resolveOpenAIBaseURL(key.value.trim(), effectiveBaseURL) ?? "https://api.openai.com/v1";
    // Validated (and pinned) regardless of whether baseURL came from the request, the
    // key's stored value, or a hardcoded default — the pinned IP is required either way.
    const target = await validateFetchModelsTarget(resolved);
    if ("error" in target) {
      res.status(400).json({ error: target.error });
      return;
    }
    const models = await fetchModelIds(key.value.trim(), resolved, target.ip);
    res.json({ models });
  } catch (err) {
    res.status(502).json({ error: `Could not fetch models: ${err instanceof Error ? err.message : "unknown error"}` });
  }
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
