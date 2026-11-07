/**
 * @description Wiring guard — a voice note or a file sent as a Telegram REPLY (or a
 * FORWARD) reaches the agent with the same message-context block a typed one does (the
 * reply quote, the forwarded mark), on every route it can take: forwarded to a live
 * session, or buffered behind a session start (a fresh start, a resume of a sleeping
 * conversation, an idle or per-turn stop in progress).
 *
 * Why a structural test (and not a behavioural one): the handlers live in the
 * side-effecting `bot.ts` entrypoint and depend on Telegram + download +
 * transcription I/O, so they cannot be exercised in isolation. The pieces they
 * wire are pure and covered behaviourally — reading the block off a voice or file
 * message in `telegramInbound.test.ts` (`getTelegramMessageContext`), folding it
 * into a prompt in `messageContext.test.ts` (`getPromptWithMessageContext`). This guard
 * locks the seam between them: the startup buffer used to forward the bare
 * transcript, and a file announcement never carried the block at all, so either
 * reached the agent without the message it pointed at. The process-level proof is
 * `messageContextE2e.test.ts`.
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
  const startIdx = botSource.search(new RegExp(`\\n(?:async )?function ${name}\\(`));
  assert.notEqual(startIdx, -1, `${name} must exist in bot.ts`);
  const after = botSource.slice(startIdx + 1);
  const nextDeclMatch = after.search(/\n(?:async function|function) /);
  return after.slice(0, nextDeclMatch === -1 ? undefined : nextDeclMatch);
}

test('the voice handler reads the message-context block off the voice message and hands it to the job', () => {
  const handler = getSourceSlice("bot.on(message('voice')", 'async function processVoiceJob(');
  assert.match(handler, /const\s+messageContext\s*=\s*getMessageContext\(\s*key\s*,\s*ctx\.message\s*\)/);
  assert.match(
    handler,
    /processVoiceJob\(\s*key\s*,\s*fileId\s*,.*,\s*messageContext\s*\)/,
    'the block must ride into the job, which no longer has ctx',
  );
});

test('the bot reads a message\'s context with the connector\'s one reader — the reply quote AND the forwarded mark', () => {
  assert.match(
    getFunctionBody('getMessageContext'),
    /return\s+getTelegramMessageContext\(\s*message\s*,\s*\{\s*userId:\s*bot\.botInfo\?\.id\s*\}\s*,/,
  );
});

test('a voice transcript buffered behind a session start keeps its reply quote', () => {
  assert.match(
    getFunctionBody('processVoiceJob'),
    /await\s+bufferPromptDuringStartup\(\s*key\s*,\s*transcript\s*,\s*\{\s*source:\s*'voice'\s*,\s*requesterId\s*\}\s*,\s*messageContext\s*\)/,
  );
});

test('a voice transcript forwarded to a live session keeps its reply quote', () => {
  assert.match(
    getFunctionBody('processVoiceJob'),
    /await\s+deliverActivePrompt\([^;]*\{\s*source:\s*'voice'\s*,\s*requesterId\s*\}\s*,\s*sentAtMs\s*,\s*messageContext\s*\)/,
  );
});

test('a typed text buffered behind a session start keeps its reply quote too', () => {
  assert.match(
    botSource,
    /await\s+bufferPromptDuringStartup\(\s*key\s*,\s*text\s*,\s*\{\s*source:\s*'text'[^}]*\}\s*,\s*getMessageContext\(\s*key\s*,\s*ctx\.message\s*\)\s*\)/,
  );
});

test('every route folds the block with the one rule', () => {
  // The live forward and the finished-text helper end in the same agent-facing
  // shape only while they share the pure fold; an inline copy is how one of them
  // drifts (or loses the shell guard).
  for (const name of ['getPromptWithThreadMessageContext', 'forwardPromptToLiveAgent']) {
    assert.match(getFunctionBody(name), /getPromptWithMessageContext\(/, `${name} must fold through getPromptWithMessageContext`);
    assert.match(getFunctionBody(name), /isShellInput:\s*[^,\n]*\.name\s*===\s*'terminal'/, `${name} must keep the block out of a terminal`);
  }
  assert.match(
    getFunctionBody('bufferPromptDuringStartup'),
    /getPromptWithThreadMessageContext\(\s*key\s*,\s*text\s*,\s*messageContext\s*\)/,
  );
});

test('a single file sent as a reply carries the quote into its announcement', () => {
  const body = getFunctionBody('handleIncomingFile');
  assert.match(body, /const\s+messageContext\s*=\s*getMessageContext\(\s*key\s*,\s*ctx\.message\s*\)/);
  assert.match(body, /const\s+quotedPrompt\s*=\s*getPromptWithThreadMessageContext\(\s*key\s*,\s*promptText\s*,\s*messageContext\s*\)/);
  assert.match(body, /deliverPromptOrBuffer\(\s*key\s*,\s*`\$\{opening\.header\}\$\{quotedPrompt\}`/);
});

test('an album sent as a reply carries the quote: each member records it, the flush folds the first', () => {
  assert.match(getFunctionBody('handleAlbumFile'), /messageContext:\s*getMessageContext\(\s*key\s*,\s*ctx\.message\s*\)/);
  const flush = getSourceSlice('const albumCollector = ', 'function buildAlbumGroupKey(');
  assert.match(flush, /const\s+messageContext\s*=\s*orderedItems\.find\(\(item\)\s*=>\s*item\.messageContext\)\?\.messageContext/);
  assert.match(flush, /const\s+quotedPrompt\s*=\s*getPromptWithThreadMessageContext\(\s*key\s*,\s*promptText\s*,\s*messageContext\s*\)/);
  assert.match(flush, /deliverPromptOrBuffer\(\s*key\s*,\s*`\$\{opening\.header\}\$\{quotedPrompt\}`/);
});

test('the request ledger keeps the prompt WITH its message context, at every entry point that carries one', () => {
  // A stored prompt is what is posted again when the session never took the first post in; kept raw, a forwarded message
  // would come back as the operator's own words.
  const opener = getFunctionBody('openTopicRequest');
  assert.match(opener, /const\s+promptBody\s*=\s*getPromptWithThreadMessageContext\(\s*key\s*,\s*text\s*,\s*messageContext\s*\)/);
  assert.match(opener, /buildTopicRequestPrompt\(\{[^}]*\bpromptBody\b[^}]*\}\)/);
  assert.match(getFunctionBody('bufferPromptDuringStartup'), /openTopicRequest\(\s*key\s*,\s*text\s*,\s*intake\s*,\s*messageContext\s*\)/);
  const active = getFunctionBody('deliverActivePrompt');
  assert.equal(active.match(/openTopicRequest\(\s*key\s*,\s*text\s*,\s*intake\s*,\s*messageContext\s*\)/g)?.length, 2, 'both the question-cancel route and the plain route');
  assert.match(getFunctionBody('handleIncomingFile'), /openTopicRequest\([^;]*,\s*messageContext\s*\)/);
  const flush = getSourceSlice('const albumCollector = ', 'function buildAlbumGroupKey(');
  assert.match(flush, /openTopicRequest\([^;]*,\s*messageContext\s*\)/);
});

test('a FORWARDED text is content: the text handler never takes it for a command, a pick, a start phrase or a selector answer', () => {
  const handler = getSourceSlice("bot.on(message('text'), async (ctx) => {", "//  Voice message handler");
  assert.match(handler, /const\s+isForwarded\s*=\s*checkIsTelegramForward\(\s*ctx\.message\s*\)/);
  assert.match(handler, /const\s+isSlashText\s*=\s*!isForwarded\s*&&\s*text\.startsWith\('\/'\)/);
  assert.equal(handler.match(/text\.startsWith\('\/'\)/g)?.length, 1, 'the one definition of «a slash command»; every other route asks isSlashText');
  assert.match(handler, /!isForwarded\s*&&\s*\/\^\\d\+\$\/\.test\(text\)\s*&&\s*awaitingModelSelection/, 'the numeric model pick');
  assert.match(handler, /!isForwarded\s*&&\s*awaitingSessionSelection\.has/, 'the session pick');
  assert.match(handler, /if\s*\(!isForwarded\s*&&\s*!adapter\.checkIsActive\(key\)\)\s*\{\s*const startMatch\s*=\s*checkIsStartAgentPhrase\(text\)/, 'the natural-language start');
  assert.match(handler, /isQuestionPending:\s*!isForwarded\s*&&/, 'the TUI selector answer');
});

test('a FORWARDED voice note is content too: its transcript starts no agent', () => {
  assert.match(
    getFunctionBody('processVoiceJob'),
    /if\s*\(messageContext\?\.isForwarded\s*!==\s*true\s*&&\s*!getThreadAdapter\(key\)\.checkIsActive\(key\)\)\s*\{\s*const startMatch\s*=\s*checkIsStartAgentPhrase\(transcript\)/,
  );
});

test('a FORWARDED message answers no pending question and wipes no context, whatever its words are', () => {
  const active = getFunctionBody('deliverActivePrompt');
  assert.match(active, /const\s+isForwarded\s*=\s*messageContext\?\.isForwarded\s*===\s*true/);
  assert.match(active, /intake\s*!==\s*null\s*&&\s*!isForwarded\s*&&\s*await\s+answerReAskedQuestionByNumber/);
  assert.match(active, /route\.kind\s*===\s*'answer'\s*&&\s*!isForwarded/);
  assert.match(active, /text\s*===\s*forwardedClearCommand\s*&&\s*!isForwarded/);
  assert.match(getFunctionBody('bufferPromptDuringStartup'), /messageContext\?\.isForwarded\s*!==\s*true\s*&&\s*await\s+answerReAskedQuestionByNumber/);
});

test('the decoration of a forwarded prompt and the request it opens ask «is it a slash command» with the context, not the bare text', () => {
  const live = getFunctionBody('forwardPromptToLiveAgent');
  assert.match(live, /const\s+isSlashCommand\s*=\s*checkIsSlashCommandPrompt\(\s*text\s*,\s*options\.messageContext\s*\)/);
  assert.doesNotMatch(live, /checkShouldSkipPreambleForText\(/, 'no bare-text slash test is left in the live forward');
  assert.match(getFunctionBody('openTopicRequest'), /checkShouldOpenTopicRequest\(\s*view\s*,\s*checkIsSlashCommandPrompt\(\s*text\s*,\s*messageContext\s*\)\s*\)/);
});

test('a forwarded /pair re-points the bot to no group, and goes on to the text handler instead of being swallowed', () => {
  const pairHandler = getSourceSlice("bot.command('pair', async (ctx, next) => {", 'const routeChat');
  assert.match(pairHandler, /if\s*\(checkIsTelegramForward\(ctx\.message\)\)\s*return\s+next\(\);/);
  assert.ok(pairHandler.indexOf('checkIsTelegramForward') < pairHandler.indexOf('const userId'), 'asked before anything else');
});
