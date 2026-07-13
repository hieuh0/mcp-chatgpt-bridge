import fs from "node:fs";
import path from "node:path";

const LOG_DIR = path.join(process.cwd(), "logs");

function logPathForToday(): string {
  // Local date, not UTC — toISOString() would misfile events into the wrong day's
  // file for any timezone ahead of UTC during its first few hours (e.g. UTC+7).
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return path.join(LOG_DIR, `${today}.log`);
}

function writeLine(component: "mcp" | "web", level: "INFO" | "ERROR", message: string): void {
  try {
    // Owner-only permissions — log lines can contain full ask_chatgpt question/context/answer
    // text (an explicit user decision), so the directory and file should not be world-readable.
    fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    const safeMessage = message.replace(/\r?\n/g, "\\n");
    const line = `[${new Date().toISOString()}] [${component}] [${level}] ${safeMessage}\n`;
    const fd = fs.openSync(logPathForToday(), "a", 0o600);
    try {
      fs.writeSync(fd, line);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Fail-open — logging must never throw into the caller (matches notify.ts precedent).
    // No console fallback: this logger IS the replacement for console output.
  }
}

export function logInfo(component: "mcp" | "web", message: string): void {
  writeLine(component, "INFO", message);
}

export function logError(component: "mcp" | "web", message: string, err?: unknown): void {
  const errText = err instanceof Error ? err.message : err !== undefined ? String(err) : "";
  writeLine(component, "ERROR", errText ? `${message}: ${errText}` : message);
}

export function getTodayLogPath(): string {
  return logPathForToday();
}
