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
  const startIdx = botSource.search(new RegExp(`\\nasync function ${name}\\(`));
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
  assert.match(body.slice(route), /forward: \(\) => forwardPromptToLiveAgent\(/);
  assert.equal(body.slice(wait, route).includes('forwardPromptToLiveAgent('), false, 'no forward between the wait and the routing');
});

test('a prompt that finds no session after the wait is answered with the no-session reply, unless the wake already said why', () => {
  const body = getFunctionBody('forwardPromptToAgent');
  const report = body.slice(body.indexOf('reportNoSession: async (isAlreadyTold) => {'));
  assert.match(report, /^reportNoSession: async \(isAlreadyTold\) => \{[\s\S]*?if \(!isAlreadyTold\) await replyToThread\(key, t\('agent\.no_session'\)\);/, 'the person is told, unless the wake said why');
});

test('the live forward does not wait for the replay itself', () => {
  assert.equal(getFunctionBody('forwardPromptToLiveAgent').includes('waitForAdoptedReplay'), false);
});
