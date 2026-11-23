/**
 * @description What the json-stream adapter tells the request wake-up probe about the turns around a `result`, driven by the
 * CLI's own frames and read through the real turn probe (`requests/sessionTurnProbe.ts`). Load-bearing facts proven here:
 * - an ERROR result keeps the messages queued behind the failed turn (the CLI runs them as its next turn, measured on 2.1.330):
 *   they read unread and working, so the watch of such a message reads `running` and the per-turn stop waits; past the grace they
 *   hold nothing, and their echo takes them off (review 17 #1).
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ClaudeJsonStreamAdapter } from '../adapters/claudeJsonStreamAdapter';
import { keyToString, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { createSessionTurnProbe } from '../requests/sessionTurnProbe';
import { getWatchedTurnState, checkIsTurnInputConsumed, type WatchedTurn } from '../requests/wakeUpRules';
import { unconsumedInputGraceMs } from '../utils/jsonStreamPendingWork';
import { type UnconsumedInput } from '../utils/jsonStreamUnconsumedInput';
import { createStreamSessionFixture } from './claudeJsonStreamSessionFixture';

const key: SessionKey = makeTelegramKey(-100999333, 91);
const sessionId = 'sess-origin';
const queuedText = 'M: a message written while the turn ran';
const unclassifiedErrorResult = `${JSON.stringify({ type: 'result', is_error: true, result: 'The agent runner stopped unexpectedly' })}\n`;
const okResult = `${JSON.stringify({ type: 'result', is_error: false, result: 'done' })}\n`;
const initFrame = `${JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-test' })}\n`;
const echoFrame = (text: string): string => `${JSON.stringify({ type: 'user', message: { role: 'user', content: text }, session_id: sessionId })}\n`;

function queued(text: string): UnconsumedInput {
  return { text, since: Date.now(), hasUnmatchedEcho: false };
}

function setup(): { adapter: ClaudeJsonStreamAdapter; probe: ReturnType<typeof createSessionTurnProbe> } {
  const adapter = new ClaudeJsonStreamAdapter();
  adapter['sessions'].set(keyToString(key), createStreamSessionFixture({ key, sessionId, workDir: '/tmp/jsonstream-origin-work' }));
  const probe = createSessionTurnProbe({
    getAdapter: () => adapter,
    checkHasPendingQuestion: () => false,
    checkHasQuestionPin: () => false,
    checkIsCompacting: () => false,
    getApiRetryTimer: () => undefined,
    checkIsWedgeRecoveryInFlight: () => false,
    checkIsRetryKickInFlight: () => false,
    checkIsApiErrorInHandling: () => false,
    checkIsSessionStarting: () => false,
    checkIsReplayingBufferedPrompts: () => false,
    serializeKey: keyToString,
  });
  return { adapter, probe };
}

/** The watch of the queued message: its forward came while the turn ran, nothing was seen of it since. */
const queuedMessageWatch: WatchedTurn = { requestId: 'req_M', progressCountAtTurnStart: 0, hasSeenBusy: false, hasSeenOutput: false, isRequestPrompt: true };

describe('a message queued behind a turn that ends in an error result (review 17 #1)', () => {
  it('stays unread and working through the turn end — its watch reads `running`, no R21 mark — and holds nothing past the grace', () => {
    const { adapter, probe } = setup();
    const session = adapter['sessions'].get(keyToString(key))!;
    session.isBusy = true;
    session.unconsumedInputs = [queued(queuedText)];
    const atTurnEnd: Array<{ isWorking: boolean; state: string; isConsumed: boolean }> = [];
    adapter.on('turnEnded', () => {
      const turnProbe = probe(key);
      atTurnEnd.push({ isWorking: adapter.checkIsWorking(key), state: getWatchedTurnState(queuedMessageWatch, turnProbe), isConsumed: checkIsTurnInputConsumed(queuedMessageWatch, turnProbe) });
    });
    adapter['onStdout'](session, unclassifiedErrorResult);
    assert.deepEqual(atTurnEnd, [{ isWorking: true, state: 'running', isConsumed: false }], 'what the per-turn stop and the turn-end settle read');
    assert.equal(session.unconsumedInputs[0]?.isQueuedBehindFailedTurn, true);

    // Past the grace a message the CLI never echoes holds nothing any more.
    session.unconsumedInputs = session.unconsumedInputs.map((input) => ({ ...input, since: Date.now() - unconsumedInputGraceMs - 1 }));
    assert.equal(adapter.checkHasUnconsumedInput(key), false);
    assert.equal(adapter.checkIsWorking(key), false);
  });

  it('its own turn takes it in: the echo takes it off, and the end of that turn is the end of its watch', () => {
    const { adapter, probe } = setup();
    const session = adapter['sessions'].get(keyToString(key))!;
    session.isBusy = true;
    session.unconsumedInputs = [queued(queuedText)];
    adapter['onStdout'](session, unclassifiedErrorResult);
    adapter['onStdout'](session, initFrame + echoFrame(queuedText));
    assert.deepEqual(session.unconsumedInputs, []);
    assert.equal(getWatchedTurnState({ ...queuedMessageWatch, hasSeenBusy: true }, probe(key)), 'running', 'its turn runs');
    adapter['onStdout'](session, okResult);
    assert.equal(getWatchedTurnState({ ...queuedMessageWatch, hasSeenBusy: true }, probe(key)), 'ended');
  });
});
