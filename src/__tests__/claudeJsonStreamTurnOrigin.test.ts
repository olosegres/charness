/**
 * @description What the json-stream adapter tells the request wake-up probe about the turns around a `result`, driven by the
 * CLI's own frames and read through the real turn probe (`requests/sessionTurnProbe.ts`). Load-bearing facts proven here:
 * - an ERROR result keeps the messages queued behind the failed turn (the CLI runs them as its next turn, measured on 2.1.330):
 *   they read unread and working, so the watch of such a message reads `running` and the per-turn stop waits; past the grace they
 *   hold nothing, and their echo takes them off (review 17 #1);
 * - a background task that finished inside a turn announces its own turn: from that turn's `result` to the task turn's `init` the
 *   probe reads the session busy, so a watched turn runs on into the task's turn (review 17 #2);
 * - a turn the CLI started by itself (a finished task's, a session job's, one with nothing of ours listed) is told apart from one the
 *   bot wrote, until an echo of ours shows (review 17 #4).
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
import { unconsumedInputGraceMs, notificationTurnGraceMs } from '../utils/jsonStreamPendingWork';
import { type UnconsumedInput } from '../utils/jsonStreamUnconsumedInput';
import { createStreamSessionFixture } from './claudeJsonStreamSessionFixture';

const key: SessionKey = makeTelegramKey(-100999333, 91);
const sessionId = 'sess-origin';
const queuedText = 'M: a message written while the turn ran';
const unclassifiedErrorResult = `${JSON.stringify({ type: 'result', is_error: true, result: 'The agent runner stopped unexpectedly' })}\n`;
const okResult = `${JSON.stringify({ type: 'result', is_error: false, result: 'done' })}\n`;
const initFrame = `${JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-test' })}\n`;
const taskId = 'task-1';
const backgroundTaskFrame = `${JSON.stringify({ type: 'system', subtype: 'background_tasks_changed', session_id: sessionId, tasks: [{ task_id: taskId, description: 'yarn build', status: 'running' }] })}\n`;
const taskNotificationFrame = `${JSON.stringify({ type: 'system', subtype: 'task_notification', session_id: sessionId, task_id: taskId, status: 'completed' })}\n`;
const jobFiringFrame = `${JSON.stringify({ type: 'command_lifecycle', state: 'started', wakeup_source: 'schedule_wakeup' })}\n`;
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

describe('a finished background task\'s own turn on its way (review 17 #2)', () => {
  it('from the result of the turn it finished in to its own `init` the probe reads busy, so the watched turn runs on into it; the grace bounds it', () => {
    const { adapter, probe } = setup();
    const session = adapter['sessions'].get(keyToString(key))!;
    session.isBusy = true;
    adapter['onStdout'](session, backgroundTaskFrame + taskNotificationFrame);
    const busyAtTurnEnd: boolean[] = [];
    adapter.on('turnEnded', () => { busyAtTurnEnd.push(probe(key).isBusy); });
    adapter['onStdout'](session, okResult);
    assert.deepEqual(busyAtTurnEnd, [true], 'the task\'s turn is on its way: not an end');
    assert.equal(adapter.checkIsTurnOnItsWay(key), true);
    adapter['onStdout'](session, initFrame);
    assert.equal(adapter.checkIsTurnOnItsWay(key), false, 'it opened');
    assert.equal(probe(key).isBusy, true);
    adapter['onStdout'](session, okResult);
    assert.equal(probe(key).isBusy, false, 'the task\'s turn ended: now the watched turn ends');

    session.notificationTurnPendingSince = Date.now() - notificationTurnGraceMs - 1;
    assert.equal(adapter.checkIsTurnOnItsWay(key), false, 'a notification whose turn never showed holds nothing past the grace');
  });
});

describe('whose turn runs: the CLI\'s own, or the bot\'s (review 17 #4)', () => {
  it('a finished task\'s turn, a session job\'s firing and a turn with nothing of ours listed are the CLI\'s own; one opened behind our message, or that echoed it, is the bot\'s', () => {
    const { adapter, probe } = setup();
    const session = adapter['sessions'].get(keyToString(key))!;
    // A task finished in the last turn: its turn on its way, then running, is the CLI's own.
    session.isBusy = true;
    adapter['onStdout'](session, backgroundTaskFrame + taskNotificationFrame + okResult);
    assert.equal(probe(key).isCliOwnTurn, true, 'on its way');
    session.unconsumedInputs = [queued(queuedText)];
    adapter['onStdout'](session, initFrame);
    assert.equal(probe(key).isCliOwnTurn, true, 'the task started it, whatever is queued behind it');
    adapter['onStdout'](session, okResult);
    assert.equal(probe(key).isCliOwnTurn, undefined, 'no turn runs');

    // The bot's message opens the next turn.
    adapter['onStdout'](session, initFrame);
    assert.equal(probe(key).isCliOwnTurn, undefined, 'opened with our message listed: the bot\'s');
    adapter['onStdout'](session, echoFrame(queuedText) + okResult);

    // Nothing of ours listed: the CLI's own; a session job firing: the CLI's own.
    adapter['onStdout'](session, initFrame);
    assert.equal(probe(key).isCliOwnTurn, true);
    adapter['onStdout'](session, okResult + jobFiringFrame);
    assert.equal(probe(key).isCliOwnTurn, true, 'a job firing');
    adapter['onStdout'](session, okResult);

    // A turn the CLI opened with nothing listed, that then echoes a message of ours written meanwhile, is the bot's.
    adapter['onStdout'](session, initFrame);
    session.unconsumedInputs = [queued('written as it opened')];
    adapter['onStdout'](session, echoFrame('written as it opened'));
    assert.equal(probe(key).isCliOwnTurn, undefined);
  });
});
