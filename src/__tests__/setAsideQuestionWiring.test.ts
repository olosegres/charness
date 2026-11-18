/**
 * @description The places `bot.ts` hands the set-aside questions their lifecycle — the composition root cannot be imported by a
 * test (its module scope parses the environment and exits), so, like the other wiring guards, the source of the isolated functions
 * is read:
 *
 *   • a conversation that ENDED or was REPLACED closes its set-aside questions: the release of its saved ids (`/new`, `/quit`,
 *     `/quitall`, leaving the folder), a switch to another backend or conversation, and a boot that finds it released;
 *   • one that only SLEEPS or died keeps them: the idle stop, a suspend and an unexpected exit never close them — a late answer
 *     wakes the conversation;
 *   • a reply to a set-aside question's message is taken before the talker branch, so an operator and a topic member alike answer;
 *   • a waiting question's own end (`clearPendingQuestion`) never touches a set-aside one;
 *   • the buttons are registered once, beside the compaction's, disjoint from `qa_` and `reask_`.
 * The real flows are `questionSetAsideE2e.test.ts` (the release, `/new`, a restart) and `openCodeQuestionE2e.test.ts`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { botSource, getFunctionBody, getSourceSlice } from './botSource';

const closeCall = /closeSetAsideQuestionsInBackground\(\s*key\s*\)/;

test('the conversations that end or are replaced close their set-aside questions', () => {
  assert.match(getFunctionBody('releaseConversationIds'), closeCall, '/new, /quit, /quitall, leaving the folder');
  assert.match(getFunctionBody('switchThreadAdapter'), closeCall, 'another backend');
  assert.match(getFunctionBody('resumeSessionByIndex'), closeCall, 'another conversation');
  assert.match(getFunctionBody('closeSetAsideQuestionsInBackground'), /closeSetAsideQuestions\(\s*key\s*\)\.catch\(/, 'not awaited, a failure is logged');
});

test('a conversation that only sleeps or died keeps its set-aside questions: no stop, suspend or unexpected exit closes them', () => {
  for (const name of ['handleAgentSuspended', 'handleAgentStopped', 'handleAgentClosed', 'clearGoneProcessFrames', 'clearPendingQuestion', 'dropPendingQuestion', 'notePersonActivity']) {
    assert.doesNotMatch(getFunctionBody(name), /closeSetAsideQuestions/, name);
  }
});

test('the boot closes the questions of a conversation that cannot be resumed, after the sessions reattached', () => {
  const restore = getFunctionBody('restoreSetAsideQuestions');
  assert.match(restore, /checkIsServedConversation\(\s*key\s*,\s*ENV\.servedPlatforms\s*\)/, 'a platform this instance does not serve is left alone');
  assert.match(restore, /getThreadAdapter\(key\)\.checkIsActive\(key\)\s*\|\|\s*getResumableSessionId\(key\)\s*!==\s*null/, 'one that can be resumed keeps them');
  assert.match(restore, closeCall);
  const afterReattach = getSourceSlice('restoreAfterReattach: () => {', 'recoverLimitEpisodesFromDisk();');
  assert.ok(afterReattach.indexOf('restoreReAskedQuestions();') !== -1 && afterReattach.indexOf('restoreSetAsideQuestions();') > afterReattach.indexOf('restoreReAskedQuestions();'), 'the step runs in the restore that follows the reattach');
});

test('a reply to a set-aside question\'s message is taken before the talker branch of the text handler', () => {
  const handler = getSourceSlice("bot.on(message('text'), async (ctx) => {", "//  Voice message handler");
  const replyAt = handler.indexOf('answerSetAsideQuestionByReply(ctx.from, key,');
  assert.notEqual(replyAt, -1);
  assert.ok(replyAt < handler.indexOf("speaker.role === 'talker'"), 'before an admin or a topic member is routed on');
  assert.match(handler, /answerSetAsideQuestionByReply\(ctx\.from,\s*key,\s*\{[^}]*isForwarded:\s*checkIsTelegramForward\(ctx\.message\)[^}]*\},\s*speaker\.role\s*\)/, 'a forward is told apart, and the role rides along');
});

test('the buttons of a set-aside question are registered once, beside the compaction\'s', () => {
  assert.equal(botSource.match(/registerQuestionSetAsideCallbacks\(bot\);/g)?.length, 1);
  assert.ok(botSource.indexOf('registerQuestionSetAsideCallbacks(bot);') > botSource.indexOf('registerCompactionCallbacks();'));
});

test('a late answer is delivered without the free-text route of a waiting question: it cancels none and aborts no turn', () => {
  const late = getFunctionBody('deliverLateAnswerPrompt');
  assert.match(late, /deliverPromptByState\(\s*key\s*,\s*getThreadAdapter\(key\)\s*,\s*text\s*,\s*null\s*,\s*undefined\s*,\s*messageContext\s*\)/, 'no request opened for it, the topic member\'s mark rides along');
  assert.doesNotMatch(late, /cancelPendingQuestionAndForward|checkIsWedgedOnQuestion|pendingQuestions/);
  assert.doesNotMatch(getFunctionBody('deliverPromptByState'), /cancelPendingQuestionAndForward|checkIsWedgedOnQuestion/);
});
