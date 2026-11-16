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
  assert.match(getFunctionBody('deliverActivePrompt'), /forward: \(\) => forwardPromptToAgent\(key, getThreadAdapter\(key\), text, sentAtMs, \{ messageContext, requestHeader: opening\.header, isPersonInput: true \}\),/);
  assert.match(getFunctionBody('deliverActivePrompt'), /, true, undefined, \{ isPersonInput: true \}\);/, 'and its buffered twin');
  assert.match(getFunctionBody('bufferPromptDuringStartup'), /, true, undefined, \{ isPersonInput: true \}\);/);
  assert.match(getFunctionBody('cancelPendingQuestionAndForward'), /isPersonInput: true \}\);/);
  for (const name of ['forwardRequestWakeUp', 'remindAnswerTail', 'postTodoReminder']) {
    assert.ok(!getFunctionBody(name).includes('isPersonInput'), `${name} awaits its write`);
  }
  // A buffered prompt replays with the flag it was buffered with.
  assert.ok(botSource.includes('forward: async (prompt, isPersonInput) => { await forwardPromptToAgent(key, adapter, prompt, undefined, { isPersonInput }); },'));
  // R23: what people asked for during a usage-limit wait, released to the next session — a failed write was only logged.
  assert.match(getFunctionBody('replayBufferedPrompts'), /await forwardPromptToAgent\(key, adapter, heldText, undefined, \{ isPersonInput: true \}\);/);
});

test('a bot-made prompt that waits for an adopt replay behind a start counts only once replayed', () => {
  const body = getFunctionBody('forwardPromptToAgent');
  const buffer = body.slice(body.indexOf('buffer: async () => {'));
  assert.match(buffer, /const buffered = createBufferedOutcome\(\);\n\s*await deliverPromptOrBuffer\([^\n]*, true, buffered\.settle, \{ isPersonInput: options\.isPersonInput \}\);\n\s*if \(options\.isPersonInput !== true\) await buffered\.assertReplayed\(\);/);
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
