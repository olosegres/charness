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
  decideRestartWake,
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
  return { requestId: 'req_AbCd1234', progressCountAtTurnStart: 0, hasSeenBusy: false, hasSeenOutput: false, isRequestPrompt: false, ...overrides };
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

describe('decideRestartWake — a tracker request whose process was found gone', () => {
  const goneProbe: SessionTurnProbe = { isActive: false, isBusy: false, hasUnconsumedInput: null, isTurnEndBlocked: false };

  it('wakes at once — long before the backstop — and counts the wake and the activity', () => {
    assert.deepEqual(decideRestartWake(createRequest({ wakeCount: 2, lastTurnActivityAt: nowMs - 60_000 }), goneProbe, nowMs), {
      kind: 'wake',
      reason: 'restarted',
      update: { lastTurnActivityAt: nowMs, wakeCount: 3, nextWakeAt: undefined },
    });
  });

  it('never wakes what has its own next step or may not be woken: a post retry, a follow-up, a give-up, a limit stop', () => {
    for (const overrides of [{ nextPostRetryAt: nowMs + 1 }, { nextWakeAt: nowMs + 1 }, { isWakeStopped: true }, { isLimitStopped: true }]) {
      assert.deepEqual(decideRestartWake(createRequest(overrides), goneProbe, nowMs), { kind: 'none' }, JSON.stringify(overrides));
    }
  });

  it('never wakes a session that works or is blocked (a pending question, an armed retry or limit wait, a start under way)', () => {
    assert.deepEqual(decideRestartWake(createRequest(), { ...goneProbe, isActive: true, isBusy: true }, nowMs), { kind: 'none' });
    assert.deepEqual(decideRestartWake(createRequest(), { ...goneProbe, isTurnEndBlocked: true }, nowMs), { kind: 'none' });
  });

  it('past the cap it alerts like any wake (a crash loop never wakes forever)', () => {
    const decision = decideRestartWake(createRequest({ wakeCount: maxWakeUpsPerRequest }), goneProbe, nowMs);
    assert.equal(decision.kind, 'alert');
    assert.ok(decision.kind === 'alert' && decision.reason === 'wakeCap');
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

  it('a test instance\'s first retry delay replaces the first minute only', () => {
    const firstDelayMs = 5_000;
    assert.deepEqual(getPostRetryUpdate(createRequest(), nowMs, firstDelayMs), { postRetryCount: 1, nextPostRetryAt: nowMs + firstDelayMs });
    assert.deepEqual(getPostRetryUpdate(createRequest({ postRetryCount: 1 }), nowMs, firstDelayMs), { postRetryCount: 2, nextPostRetryAt: nowMs + 5 * minuteMs });
    assert.equal(getPostRetryUpdate(createRequest({ postRetryCount: 3 }), nowMs, firstDelayMs), null);
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

describe('a request that waits for its schedule (scheduleWait) and a scheduled run\'s turn', () => {
  const quietUpdate = { silentTurnCount: 0, nextWakeAt: undefined, lastTurnActivityAt: nowMs };
  /** A fire's quiet end that no schedule holds: the request's own follow-up is none of its business, so the update does not name it. */
  const quietFireUpdate = { silentTurnCount: 0, lastTurnActivityAt: nowMs };
  const goneProbe: SessionTurnProbe = { isActive: false, isBusy: false, hasUnconsumedInput: null, isTurnEndBlocked: false };
  /** A request that owes nobody an answer: the person's words were answered (a progress note went out), no silent turn is pending. */
  const answeredRequest = (overrides: Partial<OpenRequestState> = {}): OpenRequestState => createRequest({ progressAnswerCount: 1, ...overrides });

  it('turn end: a progress note under a passing watch schedules no follow-up; under a watch that fired (`armed`) only the turn a fire started is held — any other turn reads it as `none`', () => {
    const request = createRequest({ silentTurnCount: 1, progressAnswerCount: 1 });
    assert.deepEqual(decideTurnEnd(request, 0, nowMs, { scheduleWait: 'watching' }), { kind: 'quiet', update: quietUpdate });
    assert.deepEqual(decideTurnEnd(request, 0, nowMs, { scheduleWait: 'armed', isScheduledRun: true }), { kind: 'quiet', update: quietUpdate }, 'the agent that handled the wake');
    // `none` keeps today's follow-up — and so does an `armed` reading for a person\'s or a reminder\'s turn.
    assert.equal(decideTurnEnd(request, 0, nowMs, { scheduleWait: 'none' }).kind, 'followUpLater');
    assert.equal(decideTurnEnd(request, 0, nowMs, { scheduleWait: 'armed' }).kind, 'followUpLater', 'a reminder\'s turn under a watch nobody re-armed');
  });

  it('turn end: no answer while the watch passes is not silence — counter 0, no wake, activity recorded; a watch that fired is the alarm\'s turn only, a reminder\'s is silent', () => {
    // The request was answered before (nothing is owed): the agent\'s own work may stay silent under a passing watch.
    assert.deepEqual(decideTurnEnd(answeredRequest(), 1, nowMs, { scheduleWait: 'watching' }), { kind: 'quiet', update: quietUpdate });
    // A watch that fired and was not re-armed: the fire\'s turn handled the wake (quiet); an engine reminder is not the alarm.
    assert.deepEqual(decideTurnEnd(answeredRequest(), 1, nowMs, { scheduleWait: 'armed', isScheduledRun: true }), { kind: 'quiet', update: quietUpdate });
    const reminder = decideTurnEnd(answeredRequest(), 1, nowMs, { scheduleWait: 'armed' });
    assert.equal(reminder.kind === 'wake' ? reminder.reason : null, 'silentTurn', 'nothing else will wake the agent: a quiet reminder only postpones the give-up');
    const second = decideTurnEnd(answeredRequest({ silentTurnCount: 1, wakeCount: 1 }), 1, nowMs, { scheduleWait: 'armed' });
    assert.equal(second.kind === 'alert' ? second.reason : null, 'silentTurns');
  });

  it('turn end: a scheduled run\'s turn without an answer is not silence either, even with nothing armed — while the request owes nobody an answer', () => {
    assert.deepEqual(decideTurnEnd(answeredRequest(), 1, nowMs, { isScheduledRun: true }), { kind: 'quiet', update: quietFireUpdate });
    assert.deepEqual(decideTurnEnd(answeredRequest(), 1, nowMs, { isScheduledRun: true, scheduleWait: 'none' }), { kind: 'quiet', update: quietFireUpdate });
  });

  it('turn end: a scheduled run\'s turn that sent a progress note is followed up like any, unless a watch is armed', () => {
    const request = createRequest({ progressAnswerCount: 1 });
    assert.equal(decideTurnEnd(request, 0, nowMs, { isScheduledRun: true }).kind, 'followUpLater');
    assert.equal(decideTurnEnd(request, 0, nowMs, { isScheduledRun: true, scheduleWait: 'watching' }).kind, 'quiet');
  });

  it('turn end: a turn that ends with no answer while the request owes one is SILENT whatever is armed — a watch never leaves a requester unanswered', () => {
    const owed: Array<[string, OpenRequestState]> = [
      ['a person\'s request never answered', createRequest()],
      ['a person\'s words not answered yet', answeredRequest({ isPersonInputUnanswered: true })],
    ];
    for (const [label, request] of owed) {
      for (const scheduleWait of ['armed', 'watching'] as const) {
        const first = decideTurnEnd(request, request.progressAnswerCount, nowMs, { scheduleWait });
        assert.equal(first.kind, 'wake', `${label} ${scheduleWait}`);
        assert.equal(first.kind === 'wake' ? first.reason : null, 'silentTurn');
        assert.equal(decideTurnEnd({ ...request, silentTurnCount: 1 }, request.progressAnswerCount, nowMs, { scheduleWait }).kind, 'alert', `${label} ${scheduleWait}`);
      }
    }
  });

  it('turn end: nothing owed — the person\'s words were answered before the turn (a continuation after an API error, a reminder\'s turn) — a watch makes a silent end quiet, none does not', () => {
    // The kind of the turn is not an input: the persisted request alone says whether anything is owed.
    assert.deepEqual(decideTurnEnd(answeredRequest(), 1, nowMs, { scheduleWait: 'watching' }), { kind: 'quiet', update: quietUpdate });
    const unwatched = decideTurnEnd(answeredRequest(), 1, nowMs, { scheduleWait: 'none' });
    assert.equal(unwatched.kind === 'wake' ? unwatched.reason : null, 'silentTurn', 'without a watch a silent turn is a silent turn');
  });

  it('turn end: the reminder\'s turn that follows a silent person turn keeps counting under a watch — the pending silent turn is owed an answer', () => {
    for (const scheduleWait of ['armed', 'watching'] as const) {
      const second = decideTurnEnd(createRequest({ silentTurnCount: 1, wakeCount: 1 }), 0, nowMs, { scheduleWait });
      assert.equal(second.kind, 'alert', scheduleWait);
      assert.equal(second.kind === 'alert' ? second.reason : null, 'silentTurns');
    }
  });

  it('turn end: a person\'s turn that sent a progress note under a watch still schedules no follow-up (the watch holds the request)', () => {
    const request = createRequest({ progressAnswerCount: 1 });
    assert.equal(decideTurnEnd(request, 0, nowMs, { scheduleWait: 'watching' }).kind, 'quiet');
    assert.equal(decideTurnEnd(request, 0, nowMs, { scheduleWait: 'none' }).kind, 'followUpLater');
  });

  it('turn end: a fire\'s quiet end leaves the follow-up of a request that waits for nothing — an unrelated alarm must not wipe it; a schedule that holds the request still clears it', () => {
    const dueFollowUp = nowMs + 10 * 60 * 1000;
    const request = createRequest({ progressAnswerCount: 1, nextWakeAt: dueFollowUp });
    const fire = decideTurnEnd(request, 1, nowMs, { isScheduledRun: true, scheduleWait: 'none' });
    assert.equal(fire.kind, 'quiet');
    assert.ok(fire.kind === 'quiet' && !('nextWakeAt' in fire.update), 'the update does not name the follow-up, so the request keeps it');
    assert.equal(fire.kind === 'quiet' ? fire.update.lastTurnActivityAt : null, nowMs, 'the activity is still recorded');
    const held = decideTurnEnd(request, 1, nowMs, { isScheduledRun: true, scheduleWait: 'watching' });
    assert.ok(held.kind === 'quiet' && 'nextWakeAt' in held.update && held.update.nextWakeAt === undefined, 'held by a watch: nothing is due');
  });

  it('turn end: a fire\'s turn on a request that owes an answer is a SILENT turn, not the alarm\'s quiet one — the count grows to the give-up, whatever is armed', () => {
    const owed: Array<[string, OpenRequestState]> = [
      ['a silent turn pending', answeredRequest({ silentTurnCount: 1, wakeCount: 1 })],
      ['a person\'s words not answered yet', answeredRequest({ isPersonInputUnanswered: true })],
      ['a person\'s request never answered', createRequest()],
    ];
    for (const [label, request] of owed) {
      for (const scheduleWait of ['none', 'armed', 'watching'] as const) {
        const fire = decideTurnEnd(request, request.progressAnswerCount, nowMs, { isScheduledRun: true, scheduleWait });
        const expected = request.silentTurnCount > 0 ? 'alert' : 'wake';
        assert.equal(fire.kind, expected, `${label} ${scheduleWait}`);
        assert.equal(fire.kind === 'wake' ? fire.reason : fire.kind === 'alert' ? fire.reason : null, request.silentTurnCount > 0 ? 'silentTurns' : 'silentTurn');
      }
    }
    // With nothing owed the fire is the alarm's and quiet; a progress note answers whatever was owed and resets the count.
    assert.deepEqual(decideTurnEnd(answeredRequest(), 1, nowMs, { isScheduledRun: true }), { kind: 'quiet', update: quietFireUpdate });
    const withProgress = decideTurnEnd(createRequest({ silentTurnCount: 1, progressAnswerCount: 1 }), 0, nowMs, { isScheduledRun: true, scheduleWait: 'watching' });
    assert.ok(withProgress.kind === 'quiet' && withProgress.update.silentTurnCount === 0);
  });
  it('turn end: the alarm\'s own request (a scheduler fire\'s) left with no answer settles at the quiet end — one that sent a progress note, or a hand-over a fire only rides, does not', () => {
    const fireRequest = createRequest({ origin: { kind: 'scheduledRun', attributes: { requester: 'scheduler' } } });
    const silent = decideTurnEnd(fireRequest, 0, nowMs, { isScheduledRun: true });
    assert.equal(silent.kind, 'quiet');
    assert.equal(silent.kind === 'quiet' ? silent.isRequestSettled : null, true);
    const withProgress = decideTurnEnd({ ...fireRequest, progressAnswerCount: 1 }, 0, nowMs, { isScheduledRun: true });
    assert.notEqual(withProgress.kind === 'quiet' ? withProgress.isRequestSettled : null, true, 'a note was sent: the request stays open');
    // A note sent in an EARLIER turn counts as well: a quiet end of a later turn (a «continue» that kept the alarm\'s kind) never closes it.
    const answeredEarlier = decideTurnEnd({ ...fireRequest, progressAnswerCount: 1 }, 1, nowMs, { isScheduledRun: true });
    assert.equal(answeredEarlier.kind, 'quiet');
    assert.equal(answeredEarlier.kind === 'quiet' ? answeredEarlier.isRequestSettled : null, undefined, 'answered earlier: it stays open');
    // A fire request that REPLACED one the agent had answered is no more settled silently than the answered one: the operator has «working on it».
    const afterAnswered = decideTurnEnd({ ...fireRequest, isSupersededRequestAnswered: true }, 0, nowMs, { isScheduledRun: true });
    assert.equal(afterAnswered.kind, 'quiet');
    assert.equal(afterAnswered.kind === 'quiet' ? afterAnswered.isRequestSettled : null, undefined, 'it replaced an answered fire request: stays open');
    const handOver = decideTurnEnd(answeredRequest({ origin: { kind: 'trackerEvent', attributes: {} } }), 1, nowMs, { isScheduledRun: true });
    assert.equal(handOver.kind, 'quiet');
    assert.equal(handOver.kind === 'quiet' ? handOver.isRequestSettled : null, undefined, 'a fire only rides a hand-over: it is owed its own answer');
  });

  it('turn end: nothing armed and not a scheduled run — the silent-turn rules are unchanged', () => {
    assert.equal(decideTurnEnd(createRequest(), 0, nowMs, { scheduleWait: 'none', isScheduledRun: false }).kind, 'wake');
    assert.equal(decideTurnEnd(createRequest({ silentTurnCount: 1 }), 0, nowMs, {}).kind, 'alert');
  });

  it('turn end: a request the rules gave up on stays untouched whatever is armed', () => {
    assert.deepEqual(decideTurnEnd(createRequest({ isWakeStopped: true }), 0, nowMs, { scheduleWait: 'watching', isScheduledRun: true }), { kind: 'none' });
    assert.deepEqual(decideTurnEnd(createRequest({ isLimitStopped: true }), 0, nowMs, { scheduleWait: 'armed' }), { kind: 'none' });
  });

  it('between turns: a watch that is not failing holds off the follow-up and the backstop; `armed` (only failing checks) and `none` do not', () => {
    const due = answeredRequest({ nextWakeAt: nowMs - 1 });
    assert.deepEqual(decideUnwatchedRequest(due, idleProbe, nowMs, backstopMs, 'watching'), { kind: 'none' });
    assert.equal(decideUnwatchedRequest(due, idleProbe, nowMs, backstopMs, 'armed').kind, 'wake');
    assert.equal(decideUnwatchedRequest(due, idleProbe, nowMs, backstopMs, 'none').kind, 'wake');
    const idleForBackstop = answeredRequest({ lastTurnActivityAt: nowMs - backstopMs });
    assert.deepEqual(decideUnwatchedRequest(idleForBackstop, idleProbe, nowMs, backstopMs, 'watching'), { kind: 'none' });
    const backstop = decideUnwatchedRequest(idleForBackstop, idleProbe, nowMs, backstopMs, 'armed');
    assert.equal(backstop.kind === 'wake' ? backstop.reason : null, 'backstop');
  });

  it('between turns: a post retry still runs while a watch holds the request (the agent never saw the request)', () => {
    const decision = decideUnwatchedRequest(createRequest({ nextPostRetryAt: nowMs - 1 }), idleProbe, nowMs, backstopMs, 'watching');
    assert.equal(decision.kind === 'wake' ? decision.reason : null, 'postRetry');
  });

  it('between turns: a request that owes an answer is NOT held by a watch — the backstop takes back a person\'s turn whose watch was lost; one that owes nothing is held', () => {
    const lastSeen = { lastTurnActivityAt: nowMs - backstopMs };
    const owed: Array<[string, Partial<OpenRequestState>]> = [
      ['a person\'s words not answered yet', { isPersonInputUnanswered: true }],
      ['a silent turn pending', { silentTurnCount: 1 }],
      ['a person\'s request never answered', { progressAnswerCount: 0 }],
    ];
    for (const [label, overrides] of owed) {
      const decision = decideUnwatchedRequest(answeredRequest({ ...lastSeen, ...overrides }), idleProbe, nowMs, backstopMs, 'watching');
      assert.equal(decision.kind === 'wake' ? decision.reason : null, 'backstop', label);
    }
    assert.deepEqual(decideUnwatchedRequest(answeredRequest(lastSeen), idleProbe, nowMs, backstopMs, 'watching'), { kind: 'none' }, 'nothing owed: held');
    const alarm = createRequest({ ...lastSeen, origin: { kind: 'scheduledRun', attributes: {} } });
    assert.deepEqual(decideUnwatchedRequest(alarm, idleProbe, nowMs, backstopMs, 'watching'), { kind: 'none' }, 'a fire\'s own request, never answered, owes nobody');
    // A due progress follow-up of an owed request is the same: the watch does not hold it.
    const dueFollowUp = answeredRequest({ nextWakeAt: nowMs - 1, isPersonInputUnanswered: true });
    assert.equal(decideUnwatchedRequest(dueFollowUp, idleProbe, nowMs, backstopMs, 'watching').kind, 'wake');
  });

  it('restart wake: a LOST-WORK loss (the agent\'s own work died with the process) wakes a request a passing watch holds — the hold is for a boot; every other guard stays', () => {
    assert.deepEqual(decideRestartWake(answeredRequest(), goneProbe, nowMs, 'watching'), { kind: 'none' }, 'a boot: held');
    const decision = decideRestartWake(answeredRequest(), goneProbe, nowMs, 'watching', true);
    assert.equal(decision.kind === 'wake' ? decision.reason : null, 'restarted');
    const busy: SessionTurnProbe = { ...goneProbe, isBusy: true };
    assert.equal(decideRestartWake(answeredRequest(), busy, nowMs, 'watching', true).kind, 'none', 'a working session is never woken');
    assert.equal(decideRestartWake(answeredRequest({ nextWakeAt: nowMs + 1 }), goneProbe, nowMs, 'watching', true).kind, 'none', 'a request with its own next step');
    assert.equal(decideRestartWake(answeredRequest({ isWakeStopped: true }), goneProbe, nowMs, 'watching', true).kind, 'none', 'given up on');
    assert.equal(decideRestartWake(answeredRequest({ wakeCount: 10 }), goneProbe, nowMs, 'watching', true).kind, 'alert', 'the cap stays');
  });

  it('restart wake: a request that owes an answer is woken at once though a watch passes; one that owes nothing is not', () => {
    assert.equal(decideRestartWake(answeredRequest({ isPersonInputUnanswered: true }), goneProbe, nowMs, 'watching').kind, 'wake');
    assert.equal(decideRestartWake(answeredRequest({ silentTurnCount: 1 }), goneProbe, nowMs, 'watching').kind, 'wake');
    assert.equal(decideRestartWake(createRequest(), goneProbe, nowMs, 'watching').kind, 'wake', 'a person\'s request never answered');
    assert.deepEqual(decideRestartWake(answeredRequest(), goneProbe, nowMs, 'watching'), { kind: 'none' });
  });

  it('turn end: an owed answer (a person\'s words unanswered, read from the persisted request) makes a turn that carries none silent under a watch too — the lost-and-rebuilt watch', () => {
    for (const scheduleWait of ['armed', 'watching'] as const) {
      const decision = decideTurnEnd(answeredRequest({ isPersonInputUnanswered: true }), 1, nowMs, { scheduleWait });
      assert.equal(decision.kind === 'wake' ? decision.reason : null, 'silentTurn', scheduleWait);
    }
    // A fire's turn on a request that owes the words is no exception: it is silent too (the next test).
    const fire = decideTurnEnd(answeredRequest({ isPersonInputUnanswered: true }), 1, nowMs, { scheduleWait: 'watching', isScheduledRun: true });
    assert.equal(fire.kind === 'wake' ? fire.reason : null, 'silentTurn');
  });

  it('restart wake: a watch that is not failing means nobody is woken; `armed` and `none` still wake', () => {
    assert.deepEqual(decideRestartWake(answeredRequest(), goneProbe, nowMs, 'watching'), { kind: 'none' });
    assert.equal(decideRestartWake(createRequest(), goneProbe, nowMs, 'armed').kind, 'wake');
    assert.equal(decideRestartWake(createRequest(), goneProbe, nowMs, 'none').kind, 'wake');
  });
});

