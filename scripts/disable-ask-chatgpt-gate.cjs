#!/usr/bin/env node
/**
 * Toggles the "ask-chatgpt-gate" hooks off (or back on) via ~/.claude/.ck.json,
 * so a fresh machine that just ran `npm run install-hooks` can also disable the
 * nag/deny behavior in one step — no manual JSON editing needed.
 *
 * Safe to run whether ~/.claude/.ck.json already exists or not:
 * - Missing: creates it with just { hooks: { "ask-chatgpt-gate": false } }.
 * - Existing: merges the single key in, leaving every other setting (other
 *   hooks, statusline, plan config, etc.) untouched.
 *
 * Usage:
 *   node scripts/disable-ask-chatgpt-gate.cjs [--enable] [--dry-run]
 *   --enable    re-enable the gate (sets the key back to true) instead of disabling it
 *   --dry-run   print what would change without writing anything
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DRY_RUN = process.argv.includes('--dry-run');
const ENABLE = process.argv.includes('--enable');
const TARGET_VALUE = ENABLE; // disable by default (ENABLE=false) -> hooks["ask-chatgpt-gate"] = false

const CK_JSON_PATH = path.join(os.homedir(), '.claude', '.ck.json');

function log(action, detail) {
  console.log(`[${action}] ${detail}`);
}

function main() {
  if (DRY_RUN) console.log('--- dry run, no files will be changed ---\n');

  let config = {};
  let existed = false;

  if (fs.existsSync(CK_JSON_PATH)) {
    existed = true;
    const raw = fs.readFileSync(CK_JSON_PATH, 'utf8');
    try {
      config = JSON.parse(raw);
    } catch (err) {
      log('error', `${CK_JSON_PATH} is not valid JSON — aborting to avoid clobbering it (${err.message})`);
      process.exitCode = 1;
      return;
    }
  } else {
    log('warn', `${CK_JSON_PATH} not found — will create a new one with just this setting`);
  }

  config.hooks = config.hooks || {};
  const current = config.hooks['ask-chatgpt-gate'];

  if (current === TARGET_VALUE) {
    log('skip', `hooks."ask-chatgpt-gate" already ${TARGET_VALUE} — nothing to do`);
    return;
  }

  config.hooks['ask-chatgpt-gate'] = TARGET_VALUE;

  if (DRY_RUN) {
    log('would-set', `hooks."ask-chatgpt-gate" = ${TARGET_VALUE} in ${CK_JSON_PATH}`);
    return;
  }

  if (existed) {
    const backupPath = `${CK_JSON_PATH}.bak-${Date.now()}`;
    fs.copyFileSync(CK_JSON_PATH, backupPath);
    log('backup', backupPath);
  }

  fs.mkdirSync(path.dirname(CK_JSON_PATH), { recursive: true });
  fs.writeFileSync(CK_JSON_PATH, JSON.stringify(config, null, 2) + '\n');
  log('wrote', `${CK_JSON_PATH} (hooks."ask-chatgpt-gate" = ${TARGET_VALUE})`);
}

main();
