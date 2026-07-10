#!/usr/bin/env node
/**
 * Installs the ask-chatgpt-gate hooks (Stop nag + PreToolUse hard-deny on
 * AskUserQuestion) into the user's global Claude Code config, so cloning this
 * repo onto a new machine is enough to restore the "consult ask_chatgpt before
 * asking the user" behavior — no manual file copying or JSON editing.
 *
 * These hooks are global-scope by design (see docs/system-architecture.md):
 * they affect every Claude Code project on the machine, not just this repo.
 *
 * lib/ck-config-utils.cjs is vendored here as a frozen snapshot — it is owned
 * by the broader personal hook framework (12+ unrelated hooks depend on the
 * live copy in ~/.claude/hooks/lib/). This installer never overwrites it if
 * it already exists, to avoid clobbering a newer version other hooks rely on.
 *
 * Usage: node scripts/install-hooks.cjs [--dry-run]
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DRY_RUN = process.argv.includes('--dry-run');

const REPO_HOOKS_DIR = path.join(__dirname, '..', 'hooks');
const CLAUDE_HOOKS_DIR = path.join(os.homedir(), '.claude', 'hooks');
const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

// [source relative to hooks/, always overwrite (owned by this repo)]
const OWNED_FILES = ['ask-chatgpt-gate.cjs', 'ask-chatgpt-pretool-gate.cjs', 'lib/ask-chatgpt-gate-shared.cjs'];
// Shared infra owned by the broader hook framework — only install if missing.
const SHARED_FILE = 'lib/ck-config-utils.cjs';

const PRETOOL_COMMAND = 'node "$HOME/.claude/hooks/ask-chatgpt-pretool-gate.cjs"';
const STOP_COMMAND = 'node "$HOME/.claude/hooks/ask-chatgpt-gate.cjs"';

function log(action, detail) {
  console.log(`[${action}] ${detail}`);
}

function copyFile(relPath, { overwrite }) {
  const src = path.join(REPO_HOOKS_DIR, relPath);
  const dest = path.join(CLAUDE_HOOKS_DIR, relPath);

  if (!overwrite && fs.existsSync(dest)) {
    log('skip', `${relPath} already exists at destination (not overwriting shared infra)`);
    return;
  }

  if (DRY_RUN) {
    log('would-copy', `${relPath} -> ${dest}`);
    return;
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  log('copied', `${relPath} -> ${dest}`);
}

function hasCommand(hooksArr, needle) {
  return (hooksArr || []).some((h) => h.command && h.command.includes(needle));
}

function mergeSettings(settings) {
  settings.hooks = settings.hooks || {};

  // PreToolUse: matcher "AskUserQuestion" -> ask-chatgpt-pretool-gate.cjs
  settings.hooks.PreToolUse = settings.hooks.PreToolUse || [];
  let preToolEntry = settings.hooks.PreToolUse.find((e) => e.matcher === 'AskUserQuestion');
  if (!preToolEntry) {
    preToolEntry = { matcher: 'AskUserQuestion', hooks: [] };
    settings.hooks.PreToolUse.push(preToolEntry);
    log('added', 'PreToolUse entry for matcher "AskUserQuestion"');
  }
  if (hasCommand(preToolEntry.hooks, 'ask-chatgpt-pretool-gate.cjs')) {
    log('skip', 'PreToolUse hook already registered');
  } else {
    preToolEntry.hooks.push({ type: 'command', command: PRETOOL_COMMAND });
    log('added', 'PreToolUse hook command');
  }

  // Stop: no matcher -> ask-chatgpt-gate.cjs
  settings.hooks.Stop = settings.hooks.Stop || [];
  let stopEntry = settings.hooks.Stop.find((e) => !e.matcher);
  if (!stopEntry) {
    stopEntry = { hooks: [] };
    settings.hooks.Stop.push(stopEntry);
    log('added', 'Stop entry (no matcher)');
  }
  if (hasCommand(stopEntry.hooks, 'ask-chatgpt-gate.cjs')) {
    log('skip', 'Stop hook already registered');
  } else {
    stopEntry.hooks.push({ type: 'command', command: STOP_COMMAND });
    log('added', 'Stop hook command');
  }

  return settings;
}

function main() {
  if (DRY_RUN) console.log('--- dry run, no files or settings will be changed ---\n');

  for (const relPath of OWNED_FILES) copyFile(relPath, { overwrite: true });
  copyFile(SHARED_FILE, { overwrite: false });

  let settings = {};
  if (fs.existsSync(SETTINGS_PATH)) {
    settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } else {
    log('warn', `${SETTINGS_PATH} not found — will create a new one with just these hooks`);
  }

  const before = JSON.stringify(settings);
  const merged = mergeSettings(settings);
  const changed = JSON.stringify(merged) !== before;

  if (!changed) {
    log('skip', 'settings.json already up to date, no write needed');
    return;
  }

  if (DRY_RUN) {
    log('would-write', SETTINGS_PATH);
    return;
  }

  if (fs.existsSync(SETTINGS_PATH)) {
    const backupPath = `${SETTINGS_PATH}.bak-${Date.now()}`;
    fs.copyFileSync(SETTINGS_PATH, backupPath);
    log('backup', backupPath);
  }

  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2) + '\n');
  log('wrote', SETTINGS_PATH);
}

main();
