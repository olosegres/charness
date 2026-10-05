/**
 * @description The wake-up rules (`requests/wakeUpRules.ts`, request/answer core
 * S4) as pure decisions: every branch of the turn-end decision, the follow-up and
 * backstop sweep, the post retries (R28), the turn-end detection with both race
 * guards, and the backstop override.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenRequestState } from '../requests/types';
import {
  checkIsWatchedTurnStale,
  decideTurnEnd,
  decideUnwatchedRequest,
  defaultRequestBackstopMs,
  getPostRetryUpdate,
  getRequestBackstopMs,
  getWatchedTurnState,
  maxWakeUpsPerRequest,
  progressFollowUpDelayMs,
  type SessionTurnProbe,
  type WatchedTurn,
} from '../requests/wakeUpRules';

const nowMs = 10_000_000;
const backstopMs = 90 * 60 * 1000;

function createRequest(overrides: Partial<OpenRequestState> = {}): OpenRequestState {
  return {
    id: 'req_AbCd1234',
    origin: { kind: 'message', attributes: {} },
    createdAt: nowMs - 1000,
    progressAnswerCount: 0,
    silentTurnCount: 0,
    wakeCount: 0,
    isWakeStopped: false,
    ...overrides,
  };
}

const idleProbe: SessionTurnProbe = { isActive: true, isBusy: false, hasUnconsumedInput: false, isTurnEndBlocked: false };

function createTurn(overrides: Partial<WatchedTurn> = {}): WatchedTurn {
  return { requestId: 'req_AbCd1234', progressCountAtTurnStart: 0, hasSeenBusy: false, hasSeenOutput: false, ...overrides };
}

describe('getRequestBackstopMs', () => {
  it('defaults to 90 minutes and honours a positive minute override', () => {
    assert.equal(getRequestBackstopMs(undefined), defaultRequestBackstopMs);
    assert.equal(defaultRequestBackstopMs, backstopMs);
    assert.equal(getRequestBackstopMs('3'), 3 * 60 * 1000);
  });

  it('ignores an empty, non-numeric or non-positive override', () => {
    for (const value of ['', ' ', 'abc', '0', '-5']) {
      assert.equal(getRequestBackstopMs(value), defaultRequestBackstopMs, `"${value}"`);
    }
  });
});

describe('decideTurnEnd', () => {
  it('a first silent turn wakes the session at once', () => {
    assert.deepEqual(decideTurnEnd(createRequest(), 0, nowMs), {
      kind: 'wake',
      reason: 'silentTurn',
      update: { silentTurnCount: 1, lastTurnActivityAt: nowMs, wakeCount: 1, nextWakeAt: undefined },
    });
  });

  it('a second silent turn in a row alerts and stops waking', () => {
    assert.deepEqual(decideTurnEnd(createRequest({ silentTurnCount: 1, wakeCount: 1 }), 0, nowMs), {
      kind: 'alert',
      reason: 'silentTurns',
      update: { silentTurnCount: 2, isWakeStopped: true, nextWakeAt: undefined },
    });
  });

  it('a progress answer resets the counter and schedules the follow-up 15 min later', () => {
    const request = createRequest({ silentTurnCount: 1, progressAnswerCount: 2 });
    assert.deepEqual(decideTurnEnd(request, 1, nowMs), {
      kind: 'followUpLater',
      update: { silentTurnCount: 0, nextWakeAt: nowMs + progressFollowUpDelayMs, lastTurnActivityAt: nowMs },
    });
    assert.equal(progressFollowUpDelayMs, 15 * 60 * 1000);
  });

  it('a silent turn after the wake-up cap alerts instead of waking', () => {
    const decision = decideTurnEnd(createRequest({ wakeCount: maxWakeUpsPerRequest }), 0, nowMs);
    assert.equal(decision.kind, 'alert');
    assert.equal(decision.kind === 'alert' ? decision.reason : null, 'wakeCap');
    assert.equal(maxWakeUpsPerRequest, 10);
  });

  it('nothing happens once the rules gave up', () => {
    assert.deepEqual(decideTurnEnd(createRequest({ isWakeStopped: true }), 0, nowMs), { kind: 'none' });
  });

  it('nothing happens while a limit stop holds', () => {
    assert.deepEqual(decideTurnEnd(createRequest({ isLimitStopped: true }), 0, nowMs), { kind: 'none' });
  });
});

describe('decideUnwatchedRequest', () => {
  it('never wakes a stopped request, a working session or a blocked one', () => {
    const due = createRequest({ createdAt: nowMs - backstopMs - 1 });
    assert.equal(decideUnwatchedRequest(createRequest({ ...due, isWakeStopped: true }), idleProbe, nowMs, backstopMs).kind, 'none');
    assert.equal(decideUnwatchedRequest(createRequest({ ...due, isLimitStopped: true }), idleProbe, nowMs, backstopMs).kind, 'none');
    assert.equal(decideUnwatchedRequest(due, { ...idleProbe, isBusy: true }, nowMs, backstopMs).kind, 'none');
    assert.equal(decideUnwatchedRequest(due, { ...idleProbe, isTurnEndBlocked: true }, nowMs, backstopMs).kind, 'none');
  });

  it('fires the progress follow-up only once it is due', () => {
    assert.equal(decideUnwatchedRequest(createRequest({ nextWakeAt: nowMs + 1 }), idleProbe, nowMs, backstopMs).kind, 'none');
    assert.deepEqual(decideUnwatchedRequest(createRequest({ nextWakeAt: nowMs, wakeCount: 3 }), idleProbe, nowMs, backstopMs), {
      kind: 'wake',
      reason: 'progressFollowUp',
      update: { wakeCount: 4, nextWakeAt: undefined },
    });
  });

  it('a due follow-up past the cap alerts', () => {
    const decision = decideUnwatchedRequest(
      createRequest({ nextWakeAt: nowMs, wakeCount: maxWakeUpsPerRequest }), idleProbe, nowMs, backstopMs,
    );
    assert.equal(decision.kind === 'alert' ? decision.reason : null, 'wakeCap');
  });

  it('the backstop counts from the last activity, else from the creation', () => {
    assert.equal(decideUnwatchedRequest(createRequest({ createdAt: nowMs - backstopMs + 1 }), idleProbe, nowMs, backstopMs).kind, 'none');
    assert.deepEqual(decideUnwatchedRequest(createRequest({ createdAt: nowMs - backstopMs }), idleProbe, nowMs, backstopMs), {
      kind: 'wake',
      reason: 'backstop',
      update: { lastTurnActivityAt: nowMs, wakeCount: 1, nextWakeAt: undefined },
    });
    const recentlyActive = createRequest({ createdAt: nowMs - 2 * backstopMs, lastTurnActivityAt: nowMs - 1000 });
    assert.equal(decideUnwatchedRequest(recentlyActive, idleProbe, nowMs, backstopMs).kind, 'none');
  });
});

describe('post retries (R28)', () => {
  const minuteMs = 60 * 1000;

  it('a failed post is retried after about 1, 5 and 15 minutes, then left to the normal rules', () => {
    assert.deepEqual(getPostRetryUpdate(createRequest(), nowMs), { postRetryCount: 1, nextPostRetryAt: nowMs + minuteMs });
    assert.deepEqual(getPostRetryUpdate(createRequest({ postRetryCount: 1 }), nowMs), { postRetryCount: 2, nextPostRetryAt: nowMs + 5 * minuteMs });
    assert.deepEqual(getPostRetryUpdate(createRequest({ postRetryCount: 2 }), nowMs), { postRetryCount: 3, nextPostRetryAt: nowMs + 15 * minuteMs });
    assert.equal(getPostRetryUpdate(createRequest({ postRetryCount: 3 }), nowMs), null);
  });

  it('a due retry wakes under its own reason, outside the wake-up cap', () => {
    const due = createRequest({ nextPostRetryAt: nowMs, wakeCount: maxWakeUpsPerRequest });
    assert.deepEqual(decideUnwatchedRequest(due, idleProbe, nowMs, backstopMs), {
      kind: 'wake',
      reason: 'postRetry',
      update: { nextPostRetryAt: undefined, lastTurnActivityAt: nowMs },
    });
  });

  it('a retry not yet due waits — the backstop does not jump ahead of it', () => {
    const pending = createRequest({ createdAt: nowMs - 2 * backstopMs, nextPostRetryAt: nowMs + 1 });
    assert.equal(decideUnwatchedRequest(pending, idleProbe, nowMs, backstopMs).kind, 'none');
  });

  it('a due retry still waits for a working or blocked session', () => {
    const due = createRequest({ nextPostRetryAt: nowMs });
    assert.equal(decideUnwatchedRequest(due, { ...idleProbe, isBusy: true }, nowMs, backstopMs).kind, 'none');
    assert.equal(decideUnwatchedRequest(due, { ...idleProbe, isTurnEndBlocked: true }, nowMs, backstopMs).kind, 'none');
  });
});

describe('getWatchedTurnState', () => {
  it('a gone session is not a turn end', () => {
    assert.equal(getWatchedTurnState(createTurn(), { ...idleProbe, isActive: false }), 'sessionGone');
  });

  it('a session not active while its turn is held — its start under way — is coming, not gone (J7b)', () => {
    const startingProbe: SessionTurnProbe = { isActive: false, isBusy: false, hasUnconsumedInput: true, isTurnEndBlocked: true };
    assert.equal(getWatchedTurnState(createTurn(), startingProbe), 'running', 'the buffered message replays once the session is up');
  });

  it('an idle backend that has not taken in the message is still running (earlier-turn race)', () => {
    assert.equal(getWatchedTurnState(createTurn(), { ...idleProbe, hasUnconsumedInput: true }), 'running');
    assert.equal(getWatchedTurnState(createTurn(), idleProbe), 'ended');
  });

  it('busy or blocked is still running', () => {
    assert.equal(getWatchedTurnState(createTurn(), { ...idleProbe, isBusy: true }), 'running');
    assert.equal(getWatchedTurnState(createTurn(), { ...idleProbe, isTurnEndBlocked: true }), 'running');
  });

  it('without a consumption signal the turn must have been seen busy or talking (busy-onset race)', () => {
    const noSignalProbe: SessionTurnProbe = { ...idleProbe, hasUnconsumedInput: null };
    assert.equal(getWatchedTurnState(createTurn(), noSignalProbe), 'running');
    assert.equal(getWatchedTurnState(createTurn({ hasSeenBusy: true }), noSignalProbe), 'ended');
    assert.equal(getWatchedTurnState(createTurn({ hasSeenOutput: true }), noSignalProbe), 'ended');
  });
});

describe('checkIsWatchedTurnStale', () => {
  it('a watch idle and unblocked for the whole backstop window has lost its tracking', () => {
    const request = createRequest({ lastTurnActivityAt: nowMs - backstopMs });
    assert.equal(checkIsWatchedTurnStale(request, idleProbe, nowMs, backstopMs), true);
    assert.equal(checkIsWatchedTurnStale(request, idleProbe, nowMs - 1, backstopMs), false);
  });

  it('falls back to the creation time when nothing was ever seen working', () => {
    const request = createRequest({ createdAt: nowMs - backstopMs });
    assert.equal(checkIsWatchedTurnStale(request, idleProbe, nowMs, backstopMs), true);
  });

  it('a busy or blocked turn is never stale, however long it lasts', () => {
    const request = createRequest({ lastTurnActivityAt: nowMs - 10 * backstopMs });
    assert.equal(checkIsWatchedTurnStale(request, { ...idleProbe, isBusy: true }, nowMs, backstopMs), false);
    assert.equal(checkIsWatchedTurnStale(request, { ...idleProbe, isTurnEndBlocked: true }, nowMs, backstopMs), false);
  });
});
