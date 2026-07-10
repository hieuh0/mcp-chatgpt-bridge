#!/usr/bin/env node
/**
 * Stop hook: if Claude's current-turn answer ends with '?' (i.e. Claude is
 * asking the user something), or Claude called AskUserQuestion, and
 * ask_chatgpt (chatgpt-bridge MCP) hasn't been called yet since that question
 * was raised, block the stop and force Claude to consult ChatGPT first.
 * ChatGPT's answer is auto-pushed to Telegram/Slack by the tool itself (see
 * mcp/src/notify.ts) so the user can review independently; the user still
 * makes the final call.
 *
 * This is advisory only (the model can ignore it) — see
 * ask-chatgpt-pretool-gate.cjs for a harder PreToolUse block specifically on
 * AskUserQuestion, which is the enforcement point that actually matters since
 * by the time Stop fires here, any plain-text question has already been shown
 * to the user.
 *
 * Bypass: set CK_ASK_CHATGPT_GATE_DISABLED=1, or .ck.json hooks.ask-chatgpt-gate=false.
 */

const fs = require('node:fs');
const { isHookEnabled, readSessionState, updateSessionState } = require('./lib/ck-config-utils.cjs');
const { endsWithQuestion, analyzeTranscript } = require('./lib/ask-chatgpt-gate-shared.cjs');

// Cap consecutive blocks per session: if Claude still hasn't called ask_chatgpt
// after this many forced continuations (e.g. the tool is broken/unavailable, or
// the model is simply ignoring the instruction), stop fighting it and let the
// turn end instead of looping.
const MAX_CONSECUTIVE_BLOCKS = 2;

function readStdinPayload() {
  try {
    const raw = fs.readFileSync(0, 'utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function emitBlock(reason) {
  console.log(JSON.stringify({ continue: false, decision: 'block', reason }));
  process.exit(2);
}

async function main() {
  if (process.env.CK_ASK_CHATGPT_GATE_DISABLED === '1') process.exit(0);
  if (!isHookEnabled('ask-chatgpt-gate')) process.exit(0);

  const payload = readStdinPayload();
  if (payload.stop_hook_active) process.exit(0); // avoid recursive re-block

  const transcriptPath = payload.transcript_path;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) process.exit(0);

  const { lastText, calledAskChatgpt, askUserQuestionText } = await analyzeTranscript(transcriptPath);
  const askingUser = endsWithQuestion(lastText) || Boolean(askUserQuestionText);

  const sessionId = payload.session_id;
  const fireCount = readSessionState(sessionId)?.askChatgptGateFireCount || 0;

  if (calledAskChatgpt || !askingUser) {
    if (fireCount) updateSessionState(sessionId, { askChatgptGateFireCount: 0 });
    process.exit(0);
  }

  if (fireCount >= MAX_CONSECUTIVE_BLOCKS) {
    // Claude isn't complying (tool likely broken/unavailable, or ignoring the
    // instruction) — stop looping.
    updateSessionState(sessionId, { askChatgptGateFireCount: 0 });
    process.exit(0);
  }
  updateSessionState(sessionId, { askChatgptGateFireCount: fireCount + 1 });

  const askedHint = askUserQuestionText
    ? `\nQuestion(s) you asked via AskUserQuestion: ${askUserQuestionText}\n`
    : '';

  emitBlock(
    [
      'You are about to end this turn with a question for the user, but you have not consulted',
      'ask_chatgpt (chatgpt-bridge MCP server) yet.',
      askedHint,
      'Before asking the user, call the ask_chatgpt tool with:',
      '  - question: the exact question you were about to ask the user',
      '  - context: full self-contained background (code/config, options considered, why unsure)',
      '',
      "Then present ChatGPT's suggestion alongside your own question to the user — the user still",
      'makes the final decision. (The Q&A is also auto-pushed to Telegram/Slack if configured.)',
      '',
      'Bypass: set CK_ASK_CHATGPT_GATE_DISABLED=1, or .ck.json hooks."ask-chatgpt-gate"=false.',
    ].join('\n')
  );
}

main().catch(() => process.exit(0));
