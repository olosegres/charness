/**
 * @description Wiring guard — a voice note sent as a Telegram REPLY reaches the
 * agent with the same reply-quote block a typed reply does, on every route its
 * transcript can take: forwarded to a live session, or buffered behind a session
 * start (a fresh start, a resume of a sleeping conversation, an idle or per-turn
 * stop in progress).
 *
 * Why a structural test (and not a behavioural one): the handlers live in the
 * side-effecting `bot.ts` entrypoint and depend on Telegram + download +
 * transcription I/O, so they cannot be exercised in isolation. The pieces they
 * wire are pure and covered behaviourally — reading the block off a voice
 * message in `telegramInbound.test.ts` (`getTelegramReplyQuoteBlock`), folding it
 * into a prompt in `replyQuote.test.ts` (`getPromptWithReplyQuote`). This guard
 * locks the seam between them: the startup buffer used to forward the bare
 * transcript, so a reply made while the agent booted lost the message it
 * pointed at.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const botSource = fs.readFileSync(
  path.join(__dirname, '..', 'bot.ts'),
  'utf8',
);

/** The source from `startMarker` up to (not including) the next `endMarker`. */
function getSourceSlice(startMarker: string, endMarker: string): string {
  const startIdx = botSource.indexOf(startMarker);
  assert.notEqual(startIdx, -1, `${startMarker} must exist in bot.ts`);
  const endIdx = botSource.indexOf(endMarker, startIdx + startMarker.length);
  assert.notEqual(endIdx, -1, `${endMarker} must follow ${startMarker} in bot.ts`);
  return botSource.slice(startIdx, endIdx);
}

/** A top-level function's body — up to the next top-level declaration. */
function getFunctionBody(name: string): string {
  const startIdx = botSource.indexOf(`async function ${name}(`);
  assert.notEqual(startIdx, -1, `${name} must exist in bot.ts`);
  const after = botSource.slice(startIdx + 1);
  const nextDeclMatch = after.search(/\n(?:async function|function) /);
  return after.slice(0, nextDeclMatch === -1 ? undefined : nextDeclMatch);
}

test('the voice handler reads the reply-quote block off the voice message and hands it to the job', () => {
  const handler = getSourceSlice("bot.on(message('voice')", 'async function processVoiceJob(');
  assert.match(handler, /const\s+replyBlock\s*=\s*getReplyQuoteBlock\(\s*ctx\.message\s*\)/);
  assert.match(
    handler,
    /processVoiceJob\(\s*key\s*,\s*fileId\s*,.*,\s*replyBlock\s*\)/,
    'the block must ride into the job, which no longer has ctx',
  );
});

test('a voice transcript buffered behind a session start keeps its reply quote', () => {
  assert.match(
    getFunctionBody('processVoiceJob'),
    /await\s+bufferPromptDuringStartup\(\s*key\s*,\s*transcript\s*,\s*\{\s*source:\s*'voice'\s*,\s*requesterId\s*\}\s*,\s*replyContext\s*\)/,
  );
});

test('a voice transcript forwarded to a live session keeps its reply quote', () => {
  assert.match(
    getFunctionBody('processVoiceJob'),
    /await\s+deliverActivePrompt\([^;]*\{\s*source:\s*'voice'\s*,\s*requesterId\s*\}\s*,\s*sentAtMs\s*,\s*replyContext\s*\)/,
  );
});

test('a typed text buffered behind a session start keeps its reply quote too', () => {
  assert.match(
    botSource,
    /await\s+bufferPromptDuringStartup\(\s*key\s*,\s*text\s*,\s*\{\s*source:\s*'text'[^}]*\}\s*,\s*getReplyQuoteBlock\(\s*ctx\.message\s*\)\s*\)/,
  );
});

test('the startup buffer and the live forward fold the block with the one rule', () => {
  // Both routes end in the same agent-facing shape only while they share the
  // helper; an inline copy is how one of them drifts (or loses the shell guard).
  for (const name of ['bufferPromptDuringStartup', 'forwardPromptToAgent']) {
    assert.match(getFunctionBody(name), /getPromptWithReplyQuote\(/, `${name} must fold through getPromptWithReplyQuote`);
    assert.match(getFunctionBody(name), /isShellInput:\s*[^,\n]*\.name\s*===\s*'terminal'/, `${name} must keep the block out of a terminal`);
  }
});
