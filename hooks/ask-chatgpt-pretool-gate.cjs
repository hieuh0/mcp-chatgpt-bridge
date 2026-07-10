#!/usr/bin/env node
/**
 * PreToolUse hook (matcher: AskUserQuestion): denies the AskUserQuestion call
 * outright if ask_chatgpt (chatgpt-bridge MCP) hasn't been consulted yet since
 * the last real user turn. This is the actual enforcement point — unlike the
 * Stop hook (ask-chatgpt-gate.cjs), which only nags *after* the question was
 * already shown to the user, denying here means the question never renders
 * until Claude complies.
 *
 * Capped per session to avoid an infinite deny-retry loop if the model just
 * keeps retrying AskUserQuestion without ever calling ask_chatgpt (tool
 * broken/unavailable, or model ignoring the instruction) — after the cap,
 * lets it through once and resets.
 *
 * Bypass: set CK_ASK_CHATGPT_GATE_DISABLED=1, or .ck.json hooks.ask-chatgpt-gate=false.
 */

const fs = require('node:fs');
const { isHookEnabled, readSessionState, updateSessionState } = require('./lib/ck-config-utils.cjs');
const { analyzeTranscript } = require('./lib/ask-chatgpt-gate-shared.cjs');

const MAX_CONSECUTIVE_DENIALS = 2;

function readStdinPayload() {
  try {
    const raw = fs.readFileSync(0, 'utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function deny(message) {
  console.error(message);
  process.exit(2);
}

async function main() {
  if (process.env.CK_ASK_CHATGPT_GATE_DISABLED === '1') process.exit(0);
  if (!isHookEnabled('ask-chatgpt-gate')) process.exit(0);

  const payload = readStdinPayload();
  if (payload.tool_name !== 'AskUserQuestion') process.exit(0);

  const transcriptPath = payload.transcript_path;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) process.exit(0);

  const { calledAskChatgpt } = await analyzeTranscript(transcriptPath);
  const sessionId = payload.session_id;
  const denyCount = readSessionState(sessionId)?.askChatgptPretoolDenyCount || 0;

  if (calledAskChatgpt) {
    if (denyCount) updateSessionState(sessionId, { askChatgptPretoolDenyCount: 0 });
    process.exit(0);
  }

  if (denyCount >= MAX_CONSECUTIVE_DENIALS) {
    updateSessionState(sessionId, { askChatgptPretoolDenyCount: 0 });
    process.exit(0);
  }
  updateSessionState(sessionId, { askChatgptPretoolDenyCount: denyCount + 1 });

  const question = (payload.tool_input?.questions || [])
    .map((q) => q.question)
    .filter(Boolean)
    .join(' / ');

  deny(
    [
      'BLOCKED: AskUserQuestion denied — you have not consulted ask_chatgpt (chatgpt-bridge MCP',
      'server) yet.',
      question ? `\nQuestion you tried to ask: ${question}\n` : '',
      'Call the ask_chatgpt tool first with:',
      '  - question: the exact question you were about to ask the user',
      '  - context: full self-contained background (code/config, options considered, why unsure)',
      '',
      "Then call AskUserQuestion again, presenting ChatGPT's suggestion alongside your own",
      'question — the user still makes the final decision.',
      '',
      'Bypass: set CK_ASK_CHATGPT_GATE_DISABLED=1, or .ck.json hooks."ask-chatgpt-gate"=false.',
    ].join('\n')
  );
}

main().catch(() => process.exit(0));
