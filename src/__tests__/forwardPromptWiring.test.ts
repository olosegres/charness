/**
 * @description Wiring guard for the single prompt-forward choke point (`forwardPromptToAgent` in `bot.ts`), which cannot be
 * imported by a test (its module-scope `parseEnv()` exits the process). Two invariants a flow can only show by luck:
 *  - with no adopt replay pending the forward runs in the CALLER'S TICK: nothing is awaited ahead of the live forward, so a
 *    stop queued in the same tick (the per-turn stop at a turn's end) cannot begin before the prompt is written;
 *  - with a replay pending the prompt waits for it and is ROUTED AGAIN afterwards (`deliverLatePrompt`: buffer when the stop
 *    window is open, wake when the session is gone, else forward) — a blind forward after the wait wrote to the process the
 *    replayed turn's end had just started to stop.
 * The behaviours themselves are covered by `adoptReplayGate.test.ts` (the wait) and the `adoptReplayE2e` flow (the per-turn
 * topic that lost its resume prompt).
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const botSource = fs.readFileSync(path.join(__dirname, '..', 'bot.ts'), 'utf8');

/** A top-level function's body — up to the next top-level declaration. */
function getFunctionBody(name: string): string {
  const startIdx = botSource.search(new RegExp(`\\n(?:async )?function ${name}\\(`));
  assert.notEqual(startIdx, -1, `${name} must exist in bot.ts`);
  const nextIdx = botSource.slice(startIdx + 1).search(/\n(?:async function|function|interface|const|\/\*\*)/);
  return botSource.slice(startIdx, nextIdx === -1 ? undefined : startIdx + 1 + nextIdx);
}

test('with no replay pending the forward awaits nothing ahead of the live forward', () => {
  const body = getFunctionBody('forwardPromptToAgent');
  const pendingCheck = body.indexOf('if (!adapter.checkIsAdoptReplayPending?.(key)) {');
  const liveForward = body.indexOf('await forwardPromptToLiveAgent(key, adapter, text, sentAtMs, options);');
  assert.ok(pendingCheck > 0 && liveForward > pendingCheck, 'the pending check comes first and its branch forwards live');
  const codeAhead = body.slice(0, liveForward).split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.equal(codeAhead.includes('await'), false, 'no await ahead of the live forward in the no-replay branch');
});

test('after the replay wait the prompt is routed again like a late prompt, not forwarded blindly', () => {
  const body = getFunctionBody('forwardPromptToAgent');
  const wait = body.indexOf('await waitForAdoptedReplay(adapter, key);');
  const route = body.indexOf('await deliverLatePrompt({');
  assert.ok(wait > 0 && route > wait, 'the wait, then the late-prompt routing');
  assert.match(body.slice(route), /checkIsWindowOpen: \(\) => startupPromptBuffer\.checkIsStarting\(keyToString\(key\)\)/);
  assert.match(body.slice(route), /forward: async \(\) => \{\n\s*await forwardPromptToLiveAgent\([^\n]*\);\n\s*return 'forwarded';\n\s*\},/, 'the live forward answers `forwarded`');
  assert.equal(body.slice(wait, route).includes('forwardPromptToLiveAgent('), false, 'no forward between the wait and the routing');
});

test('a technical prompt is routed as one after the wait, and the reminder that is dropped is not reported as posted', () => {
  const body = getFunctionBody('forwardPromptToAgent');
  const route = body.slice(body.indexOf('await deliverLatePrompt({'));
  assert.match(route, /isTechnical: isTechnicalPrompt,/, 'the routing knows the prompt is technical (no buffer, no wake, no report)');
  assert.match(route, /checkIsSessionActive: \(\) => adapter\.checkIsActive\(key\) && !\(isTechnicalPrompt && \(adapter\.checkIsBusy\?\.\(key\) \?\? false\)\),/, 'and wants a session that is idle as well as live');
  const reminder = getFunctionBody('postTodoReminder');
  assert.match(reminder, /=== 'dropped'/, 'the reminder reads the outcome');
  assert.match(reminder, /return isPosted && !isDropped;/, 'a dropped reminder is not posted');
});

test('the live forward awaits nothing between its start and the write to the agent, except the OpenCode hooks', () => {
  // Merged code once put the todo board's read there (async); a stop queued in the caller's tick then began before the write.
  const body = getFunctionBody('forwardPromptToLiveAgent');
  const beforeWrite = body.slice(0, body.indexOf('adapter.sendInput('));
  assert.ok(beforeWrite.length > 0, 'the write is in the live forward');
  const awaited = beforeWrite.split('\n').map((line) => line.trim()).filter((line) => !line.startsWith('//') && line.includes('await'));
  assert.deepEqual(awaited, ['await adapter.interruptAndWaitIdle(key);', 'await adapter.detachRunningSubagents(key);']);
});

test('the live forward awaits the write\'s outcome — except for a person\'s own message, whose write never holds the topic\'s queue and whose failure is told in the topic', () => {
  // A json-stream stdin write that failed was only logged once, and a hand-over prompt counted as delivered was never read.
  const body = getFunctionBody('forwardPromptToLiveAgent');
  assert.match(body, /const written = adapter\.sendInputAndWait \? adapter\.sendInputAndWait\(key, promptText\) : \(adapter\.sendInput\(key, promptText\), Promise\.resolve\(\)\);/);
  const personBranch = body.indexOf('if (options.isPersonInput === true) {');
  const awaitWritten = body.indexOf('await written;');
  assert.ok(personBranch > body.indexOf('const written ='), 'the write is handed over first');
  assert.match(body.slice(personBranch), /^if \(options\.isPersonInput === true\) \{\n\s*void written\.then\(noteToldIfDelivered, \(error: unknown\) => reportUndeliveredTopicPrompt\(key, error\)\);\n\s*return;\n\s*\}/, 'a person\'s message: not awaited, the person told on failure');
  assert.ok(!body.includes('checkIsTelegramKey(key)'), 'decided by who wrote the prompt, never by the platform: a wake-up, a scheduled run, a retry\'s nudge in a topic await it');
  assert.ok(awaitWritten > personBranch, 'every other prompt awaits it');
  assert.ok(body.indexOf('noteToldIfDelivered();') > awaitWritten, 'the note counts as told only after the write');
  assert.ok(body.indexOf("startClaudeLiveness(key, 'busyOnset');") < personBranch, 'the busy-onset arm still starts at the write, not after its outcome');
  assert.match(getFunctionBody('reportUndeliveredTopicPrompt'), /replyToThread\(key, t\('agent\.prompt_not_delivered', \{ error: message \}\)\)/);
});

test('only a person\'s own prompts are marked as such: the text, voice and label path, the buffered startup prompt, a file, an album, /schedule and what a usage-limit wait held — a wake-up, a nudge or a reminder is not', () => {
  // The state-routed write every person's prompt ends in (`deliverPromptByState`: text, voice, a file, an album, /schedule, a label, a
  // late answer), and the question-cancelling free text.
  const atWrite = getFunctionBody('deliverPersonPromptAtWrite');
  assert.match(atWrite, /forward: \(\) => forwardPromptToAgent\(key, getThreadAdapter\(key\), text, sentAtMs, \{ messageContext, requestHeader, isPersonInput: true, isAccountsNoteCarrier \}\),/);
  assert.match(atWrite, /, undefined, \{ isPersonInput: true, isAccountsNoteCarrier \}\);/, 'and its buffered twin');
  assert.match(getFunctionBody('deliverPromptByState'), /await deliverPersonPromptAtWrite\(key, text, /);
  assert.match(getFunctionBody('deliverActivePrompt'), /return deliverPromptByState\(key, text, intake, sentAtMs, messageContext\);/, 'a person\'s prompt ends in it');
  assert.match(getFunctionBody('deliverPromptDuringStartup'), /await deliverPromptByState\(key, text, intake, undefined, messageContext\);/, 'one that arrived in a window too');
  assert.match(getFunctionBody('cancelPendingQuestionAndForward'), /return deliverPersonPromptAtWrite\(key, text, \{/);
  for (const name of ['forwardRequestWakeUp', 'remindAnswerTail', 'postTodoReminder']) {
    assert.ok(!getFunctionBody(name).includes('isPersonInput'), `${name} awaits its write`);
  }
  // A buffered prompt replays with the options it was buffered with (its person flag among them).
  assert.ok(botSource.includes('forward: async (prompt, options) => { await forwardPromptToAgent(key, adapter, prompt, undefined, options); },'));
  // R23: what people asked for during a usage-limit wait, released to the next session — a failed write was only logged.
  assert.match(getFunctionBody('replayBufferedPrompts'), /await forwardPromptToAgent\(key, adapter, heldText, undefined, \{ isPersonInput: true \}\);/);
});

test('the lost-work wake of a request a passing watch holds tells the requester only if they must know: the wake message\'s flag reaches the note the prompt carries', () => {
  assert.match(getFunctionBody('forwardRequestWakeUp'), /lostWorkTelling: message\.isAnswerOptional === true \? 'watchHeld' : 'plain',/);
  assert.match(getFunctionBody('forwardPromptToLiveAgent'), /buildLostWorkNote\(lostWorkRecord, getLocaleEndonym\(getActiveLang\(\)\), \{ telling: options\.lostWorkTelling \?\? 'plain' \}\)/);
});

test('a tracker fire whose ridden request owes nothing, or with no request open, asks for the lost-work note\'s optional wording — the fire\'s header already says to answer only if the requester must know (review 14 #3)', () => {
  const body = getFunctionBody('forwardScheduledRun');
  assert.match(body, /const lostWorkTelling: LostWorkTelling = !checkIsTelegramKey\(key\) && ridden\?\.isAnswerOwed !== true \? 'runHeader' : 'plain';/);
  assert.match(body, /\{ isAccountsNoteCarrier: true, lostWorkTelling \}/);
});

test('the turn probe reads the startup buffer\'s replay as the start, and the held prompts of a limit wait are forwarded inside the replay (review 15 #1)', () => {
  assert.ok(botSource.includes('checkIsReplayingBufferedPrompts: (keyString) => startupPromptBuffer.checkIsReplaying(keyString),'));
  const replay = getFunctionBody('replayBufferedPrompts');
  assert.match(replay, /afterReplay: async \(\) => \{/);
  assert.ok(replay.indexOf('afterReplay') < replay.indexOf('limitHeldPrompts.releaseAll(key)'), 'the held prompts are the replay\'s after-step');
});

test('a turn\'s end is decided at the adapter\'s own turn-end event, after a per-turn stop is queued — the stop would otherwise leave the watch to «session gone» (review 15 P1)', () => {
  const body = getFunctionBody('handleAgentTurnEnded');
  assert.match(body, /settleEndedTurnsAndHandOver\(key\);/);
  assert.ok(body.indexOf('suspendThreadSession(key)') < body.indexOf('settleEndedTurnsAndHandOver(key)'), 'after the stop is queued: its window opens only in a later tick');
  assert.doesNotMatch(body.slice(0, body.indexOf('settleEndedTurnsAndHandOver(key)')), /return;/, 'no early return skips it for another backend');
  // The write choke point settles before its write, the same way.
  assert.match(getFunctionBody('forwardPromptToLiveAgent'), /^[^]*?settleEndedTurnsAndHandOver\(key\);[^]*?noteThreadActivity\(key\);/);
});

test('the write choke point names the process a buffered prompt\'s replay writes into: right after its settle, before the write, in the same tick (review 18 #2)', () => {
  const body = getFunctionBody('forwardPromptToLiveAgent');
  const settle = body.indexOf('settleEndedTurnsAndHandOver(key);');
  const named = body.indexOf('requestWakeUpEngine?.noteSessionWrite(key);');
  assert.ok(settle > 0 && named > settle, 'after the settle, which decides the ended watches by what they had');
  assert.equal(body.slice(settle, named).includes('await'), false, 'nothing awaited between them');
  assert.ok(named < body.indexOf('noteThreadActivity(key);'), 'ahead of the write');
});

test('a settle\'s reminders — at a turn end and at the write choke point (a todo reminder written at the turn end included) — are handed to a post waiting for that turn; the post\'s settle takes them, and the post registers itself in flight (review 16 #2, review 17 nit 6)', () => {
  assert.match(getFunctionBody('settleEndedTurnsAndHandOver'), /engine\.settleEndedTurnsOf\(key\)\.then\(\(deliverSettledWakes\) => engine\.deliverOrHandOverWake\(key, deliverSettledWakes\)\)/);
  assert.doesNotMatch(botSource, /settleEndedTurnsOf\(key\)\.then\(\(deliverSettledWakes\) => deliverSettledWakes\(\)\)/, 'no settle delivers past a post in flight');
  const postDeps = getFunctionBody('createSessionPostDeps');
  assert.match(postDeps, /settleEndedTurns: \(conversationKey\) => requestWakeUpEngine\?\.settleEndedTurnsForPost\(keyFromString\(conversationKey\)\)/);
  assert.match(postDeps, /notePostInFlight: \(conversationKey\) => requestWakeUpEngine\?\.notePostInFlight\(keyFromString\(conversationKey\)\)/);
});

test('an API error that arms nothing holds the turn end until its stop, move or wait has landed — «wait for reset» off, a used-up balance, an account refusal or a logged-out notice (review 16 #1)', () => {
  const handler = getFunctionBody('handleApiError');
  assert.match(handler, /holdTurnEndWhileHandlingApiError\(key, handleBalanceExhausted\(key, cls\)\);/);
  assert.match(handler, /holdTurnEndWhileHandlingApiError\(key, announceUsageLimitOrSwitch\(key, cls, Date\.now\(\), wait, 0, isFirstOffNotice\)\);/);
  assert.match(handler, /holdTurnEndWhileHandlingApiError\(key, getThreadAdapter\(key\) instanceof ClaudeJsonStreamAdapter \? handleClaudeAuthRefusal\(key, cls\) : surfaceLoggedOutNotice\(key\)\);/);
  assert.doesNotMatch(handler, /void (handleBalanceExhausted|handleClaudeAuthRefusal|surfaceLoggedOutNotice)\(/, 'no branch that arms nothing is left fire-and-forget');
  assert.match(getFunctionBody('holdTurnEndWhileHandlingApiError'), /apiErrorsInHandling\.set\(k, \(apiErrorsInHandling\.get\(k\) \?\? 0\) \+ 1\);\s*void handling\.finally\(/, 'held from the synchronous branch to the handling\'s end');
  assert.ok(botSource.includes('checkIsApiErrorInHandling: (keyString) => apiErrorsInHandling.has(keyString),'), 'the probe reads it');
});

test('a prompt that waits for an adopted replay keeps its lost-work wording when it lands in a start window (review 16 nit 7)', () => {
  const body = getFunctionBody('forwardPromptToAgent');
  assert.match(body, /buffered\.settle, \{ isPersonInput: options\.isPersonInput, isAccountsNoteCarrier: options\.isAccountsNoteCarrier, lostWorkTelling: options\.lostWorkTelling \}\);/);
});

test('a bot-made prompt that waits for an adopt replay behind a start counts only once replayed', () => {
  const body = getFunctionBody('forwardPromptToAgent');
  const buffer = body.slice(body.indexOf('buffer: async () => {'));
  assert.match(buffer, /const buffered = createBufferedOutcome\(\);\n\s*await deliverPromptOrBuffer\([^\n]*, buffered\.settle, \{ isPersonInput: options\.isPersonInput, isAccountsNoteCarrier: options\.isAccountsNoteCarrier, lostWorkTelling: options\.lostWorkTelling \}\);\n\s*if \(options\.isPersonInput !== true\) await buffered\.assertReplayed\(\);/);
});

test('a session post (a tracker\'s request or update, a scheduled run, the lost-work note) whose prompt waited for the session start counts only once it was replayed', () => {
  const postDeps = botSource.slice(botSource.indexOf('function createSessionPostDeps('), botSource.indexOf('function createSessionPostDeps(') + 3000);
  assert.match(postDeps, /if \(delivery === 'buffered'\) await buffered\.assertReplayed\(\);/);
  const lostWork = getFunctionBody('createLostWorkPostDeps');
  assert.match(lostWork, /if \(delivery === 'buffered'\) await buffered\.assertReplayed\(\);/);
});

test('an untold lost-work note rides a request\'s reminder too (the restart wake of a tracker request), never a slash command, a technical prompt or a shell line', () => {
  const body = getFunctionBody('forwardPromptToLiveAgent');
  assert.match(body, /const isLostWorkNoteCarried = \(isReplayable \|\| options\.isRequestReminder === true\) && adapter\.name !== 'terminal';/);
  assert.match(body, /const lostWorkRecord = isLostWorkNoteCarried \? state\.getLostWork\(key\) : undefined;/);
});

test('a prompt that finds no session after the wait is answered with the no-session reply, unless the wake already said why', () => {
  const body = getFunctionBody('forwardPromptToAgent');
  const report = body.slice(body.indexOf('reportNoSession: async (isAlreadyTold) => {'));
  assert.match(report, /^reportNoSession: async \(isAlreadyTold\) => \{[\s\S]*?if \(!isAlreadyTold\) await replyToThread\(key, t\('agent\.no_session'\)\);/, 'the person is told, unless the wake said why');
});

test('the live forward does not wait for the replay itself', () => {
  assert.equal(getFunctionBody('forwardPromptToLiveAgent').includes('waitForAdoptedReplay'), false);
});
