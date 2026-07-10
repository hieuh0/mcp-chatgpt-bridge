/**
 * Shared logic for the ask-chatgpt-gate hooks (Stop nag + PreToolUse hard-block
 * on AskUserQuestion). Single forward pass over the transcript, resetting state
 * at every real "the human just responded" boundary — a free-text prompt, or a
 * tool_result answering an AskUserQuestion call — so an already-answered
 * question from earlier in the session never leaks into "is Claude currently
 * asking something" for the latest turn.
 */

const fs = require('node:fs');
const readline = require('node:readline');

const ASK_CHATGPT_NAME_PATTERN = /ask_chatgpt/i;

function endsWithQuestion(text) {
  const trimmed = String(text || '').replace(/\s+$/, '');
  return /[?？]$/.test(trimmed);
}

function isHumanFreeTextPrompt(entry) {
  const content = entry.message?.content;
  if (typeof content === 'string') return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((block) => block.type === 'text' && block.text?.trim());
}

async function analyzeTranscript(transcriptPath) {
  const toolUseNames = new Map(); // tool_use id -> name
  let lastText = null;
  let calledAskChatgpt = false;
  let askUserQuestionText = null;

  const rl = readline.createInterface({
    input: fs.createReadStream(transcriptPath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;

    if (entry.type === 'user') {
      const answeredAskUserQuestion = content.some(
        (block) => block.type === 'tool_result' && toolUseNames.get(block.tool_use_id) === 'AskUserQuestion'
      );
      if (isHumanFreeTextPrompt(entry) || answeredAskUserQuestion) {
        lastText = null;
        calledAskChatgpt = false;
        askUserQuestionText = null;
      }
      continue;
    }

    if (entry.type !== 'assistant') continue;
    for (const block of content) {
      if (block.type === 'text' && block.text?.trim()) lastText = block.text;
      if (block.type === 'tool_use') {
        if (block.id && block.name) toolUseNames.set(block.id, block.name);
        if (ASK_CHATGPT_NAME_PATTERN.test(block.name || '')) calledAskChatgpt = true;
        if (block.name === 'AskUserQuestion') {
          askUserQuestionText =
            (block.input?.questions || []).map((q) => q.question).filter(Boolean).join(' / ') ||
            askUserQuestionText;
        }
      }
    }
  }

  return { lastText, calledAskChatgpt, askUserQuestionText };
}

module.exports = { ASK_CHATGPT_NAME_PATTERN, endsWithQuestion, analyzeTranscript };
