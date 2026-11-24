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
 *   • the buttons are registered once, beside the compaction's, disjoint from `qa_` and `reask_`;
 *   • the idle fire reaches the set-aside module through the compaction's port, and the wait a topic has is its own choice
 *     (`/question_wait`), else the instance's `settings.json` value (`questionWait`); a changed wait sets the timers again;
 *   • a question the agent asks again while its set-aside copy is open is answered by the module before anything is posted, and
 *     the module posts a question it cannot answer that way through the one function that posts a new question.
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
  assert.match(getFunctionBody('resumePickedSession'), closeCall, 'another conversation');
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
  assert.match(late, /deliverPromptByState\(\s*key\s*,\s*text\s*,\s*null\s*\)/, 'no request opened for it, and no message context: a member\'s attribution travels inside the answer');
  assert.doesNotMatch(late, /cancelPendingQuestionAndForward|checkIsWedgedOnQuestion|pendingQuestions/);
  assert.doesNotMatch(getFunctionBody('deliverPromptByState'), /cancelPendingQuestionAndForward|checkIsWedgedOnQuestion/);
  assert.doesNotMatch(getFunctionBody('deliverPersonPromptAtWrite'), /cancelPendingQuestionAndForward|checkIsWedgedOnQuestion|pendingQuestions/);
});

test('a late answer cancels an armed usage-limit wait first, like typed text — before anything is written to the session', () => {
  const late = getFunctionBody('deliverLateAnswerPrompt');
  assert.ok(late.indexOf('cancelApiRetry(key)') !== -1 && late.indexOf('cancelApiRetry(key)') < late.indexOf('deliverPromptByState('), 'the wait is cancelled before the answer is delivered');
});

test('a VOICE reply to a set-aside question is a late answer: its transcript goes through the same function as a typed reply, before the other voice routes', () => {
  const handler = getSourceSlice("bot.on(message('voice'), async (ctx) => {", "/**\n * @description Background worker for a single voice note");
  assert.match(handler, /reply:\s*VoiceReply\s*=\s*\{[^}]*role:\s*speaker\.role[^}]*replyToMessageId:\s*getTelegramReplyTargetId\(ctx\.message\)[^}]*\}/, 'the genuine reply target and the role ride to the job');
  assert.match(handler, /processVoiceJob\([^;]*progressNote,\s*reply,/);
  const job = getFunctionBody('processVoiceJob');
  const routeAt = job.indexOf('answerSetAsideQuestionByReply(reply.from, key, { message_id: reply.messageId, text: transcript, replyToMessageId: reply.replyToMessageId');
  assert.notEqual(routeAt, -1);
  assert.match(job, /isForwarded:\s*messageContext\?\.isForwarded\s*===\s*true\s*\},\s*reply\.role\)\)\s*return;/, 'a forward is told apart, the role rides along, and a taken reply ends the job');
  assert.ok(routeAt > job.indexOf("t('voice.transcribed'") && routeAt < job.indexOf('claimReminderTextCapture'), 'after the echo, before the reminder step and the startup buffer');
  assert.ok(routeAt < job.indexOf('deliverActivePrompt('), 'and before the transcript is delivered as a prompt');
});

test('a backend switch closes the set-aside questions only when the operator chose it: an AUTOMATIC usage-limit fallback keeps the conversation, parked and bridged', () => {
  assert.match(getFunctionBody('switchThreadAdapter'), /if\s*\(options\.isConversationKept\s*!==\s*true\)\s*closeSetAsideQuestionsInBackground\(key\)/);
  assert.match(getFunctionBody('moveTopicToOtherBackend'), /switchThreadAdapter\([^;]*,\s*options\)/, 'the flag is handed on');
  assert.match(getFunctionBody('switchTopicToFallbackEntryNow'), /moveTopicToOtherBackend\([^;]*\{\s*isConversationKept:\s*options\.isAutomatic\s*===\s*true\s*\}\)/);
  // The automatic callers say so …
  assert.match(botSource, /resumeOnRung:[^}]*switchTopicToFallbackEntry\(key,\s*from,\s*rung,\s*\{\s*isAnnounced:\s*true,\s*isAutomatic:\s*true\s*\}\)/s, 'the wait that ends on another rung');
  assert.equal(botSource.match(/switchTopicToFallbackEntry\(key,\s*plan\.from,\s*to,\s*\{\s*isAnnounced:\s*true,\s*isAutomatic:\s*true(?:,\s*ending)?\s*\}\)/g)?.length, 2, 'the two auto-switch paths (a used-up balance\'s hands its hold on the conversation along)');
  assert.match(getFunctionBody('handleClaudeAuthRefusal'), /switchTopicToFallbackEntry\(key,\s*from,\s*to,\s*\{\s*isAnnounced:\s*true,\s*isAutomatic:\s*true,\s*reason:\s*'signIn'\s*\}\)/, 'the move off an account the CLI refused');
  // … and an operator's own move (a pick, a tapped offer, `/claude` · `/opencode`) does not.
  assert.equal(botSource.match(/await switchTopicToFallbackEntry\([^)]*isAutomatic/g)?.length, 4, 'four automatic callers, no more');
  assert.doesNotMatch(getFunctionBody('executeBackendSwitch'), /isConversationKept/, 'the operator\'s manual switch ends the conversation it leaves');
});

test('a reply to a message other than the question that waits is no pick for it, but its words still cancel the waiting question; the reply target is the genuine one', () => {
  const active = getFunctionBody('deliverActivePrompt');
  assert.match(active, /isReplyToAnotherMessage\s*=\s*replyToMessageId\s*!=\s*null\s*&&\s*replyToMessageId\s*!==\s*pending\.messageId\s*&&\s*replyToMessageId\s*!==\s*pending\.originalMessageId/);
  assert.match(active, /route\.kind\s*===\s*'answer'\s*&&\s*!isForwarded\s*&&\s*!isReplyToAnotherMessage/, 'only the pick is refused');
  assert.ok(active.indexOf('cancelPendingQuestionAndForward(') > active.indexOf("route.kind === 'answer'"), 'the cancel stays after the pick');
  assert.doesNotMatch(active.slice(active.indexOf('isReplyToAnotherMessage'), active.indexOf('cancelPendingQuestionAndForward(')), /deliverPromptByState/, 'a reply elsewhere does not skip the cancel');
  const handler = getSourceSlice("bot.on(message('text'), async (ctx) => {", "//  Voice message handler");
  assert.equal(handler.match(/deliverActivePrompt\([^;]*\{\s*replyToMessageId:\s*getTelegramReplyTargetId\(ctx\.message\)\s*\}\)/g)?.length, 2, 'the operator\'s two routes read the genuine reply target');
  assert.equal(getFunctionBody('handleTalkerText').match(/deliverActivePrompt\([^;]*\{\s*replyToMessageId:\s*getTelegramReplyTargetId\(ctx\.message\)\s*\}\)/g)?.length, 2, 'and a topic member\'s');
  assert.match(handler, /answerSetAsideQuestionByReply\(ctx\.from,\s*key,\s*\{[^}]*replyToMessageId:\s*getTelegramReplyTargetId\(ctx\.message\)[^}]*\}/, 'the late-answer route reads the same value');
  assert.doesNotMatch(botSource, /reply_to_message\??\.message_id/, 'no route reads the raw reply: «post in this topic» is no reply');
});

test('the idle fire sets a waiting question aside through the module, and the wait it reads is the topic\'s own choice, else the instance setting', () => {
  assert.match(botSource, /setQuestionAsideAtIdle:\s*\(key\)\s*=>\s*setPendingQuestionAsideAtIdle\(key\)/, 'the compaction port is the module\'s idle entry');
  assert.match(botSource, /getQuestionWaitChoice:\s*\(key\)\s*=>\s*resolveQuestionWait\(state\.getQuestionWaitOverride\(key\),\s*readInstanceQuestionWait\(\)\s*\?\?\s*undefined\)/, 'the topic\'s choice wins over the instance value of settings.json');
  assert.match(botSource, /readInstanceQuestionWait\s*=\s*createQuestionWaitSettingsReader\(\(\)\s*=>\s*getInstanceSettingsPath\(\)/);
});

test('/question_wait is a registered, listed command wired to the one reader of the instance value, and a changed wait sets the waiting questions\' timers again', () => {
  assert.match(botSource, /createQuestionWait\(\{\s*\.\.\.botCore,\s*readInstanceQuestionWait,\s*getSettingsPath:\s*\(\)\s*=>\s*getInstanceSettingsPath\(\),(?:\s*\/\/[^\n]*)*\s*noteQuestionWaitChanged:\s*\(key\)\s*=>\s*rearmQuestionSetAsideTimers\(key\)/, 'the module reads the same instance value the timers do');
  assert.equal(botSource.match(/registerQuestionWaitCommands\(\);/g)?.length, 1);
  assert.equal(botSource.match(/registerQuestionWaitCallbacks\(\);/g)?.length, 1);
  assert.match(botSource, /const botCommands = new Set\([^;]*'question_wait'/s, 'a stray /question_wait is never forwarded to the agent as text');
  assert.match(botSource, /\{ command: 'question_wait', description: /, 'and it is in the menu');
  const rearm = getFunctionBody('rearmQuestionSetAsideTimers');
  assert.match(rearm, /armQuestionSetAsideTimer\(key\)/, 'one conversation\'s timer');
  assert.match(rearm, /pendingQuestions\.keys\(\)[^]*armQuestionSetAsideTimer\(pendingKey\)/, 'and, when the instance value changed, every waiting one');
});

test('a question the agent asks again is taken over by the set-aside module before anything is posted, and a question it cannot take is posted by the one posting function', () => {
  const handler = getFunctionBody('handleAgentQuestion');
  const persistedCheckAt = handler.indexOf('persistedQuestion.data.requestId === questionData.requestId');
  const askedAgainAt = handler.indexOf('answerQuestionAskedAgain(key, questionData)');
  const postAt = handler.indexOf('postAgentQuestion(key, questionData)');
  assert.ok(persistedCheckAt !== -1 && askedAgainAt > persistedCheckAt, 'after the restart-idempotence check');
  assert.ok(postAt > askedAgainAt, 'and before the question is posted');
  assert.match(handler, /if \(answerQuestionAskedAgain\(key, questionData\)\) return;/, 'a question taken over is not posted');
  assert.match(botSource, /postQuestionAnew:\s*postAgentQuestion\b/, 'the module hands a question it cannot answer back to the function that posts one');
  const posting = getFunctionBody('postAgentQuestion');
  for (const step of ['closeReAskedQuestion(key)', 'setPendingQuestion(key,', 'armQuestionSetAsideTimer(key)', 'postPendingQuestionAt(key)']) assert.ok(posting.includes(step), `a new question still ${step}`);
  assert.doesNotMatch(posting, /answerQuestionAskedAgain/, 'the posting function never takes a question over: the module posts through it');
});
