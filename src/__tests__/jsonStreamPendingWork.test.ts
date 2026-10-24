/**
 * @description The pending-work judgement's pure rules: the hold after the agent's last turn, the grace of a finished
 * task's turn.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkHasPendingWork,
  checkIsNotificationTurnPending,
  getPendingWorkHoldRemainingMs,
  notificationTurnGraceMs,
  type PendingWorkInput,
} from '../utils/jsonStreamPendingWork';

const now = 10_000_000;
const holdMs = 60_000;
const idle: PendingWorkInput = { now, backgroundTaskCount: 0, scheduledJobCount: 0, lastTurnEndedAt: now, holdMs, notificationTurnPendingSince: null };

describe('jsonStreamPendingWork', () => {
  it('the hold: tasks or jobs hold within it after the last turn, not past it; nothing pending has no hold', () => {
    assert.equal(getPendingWorkHoldRemainingMs(idle), null);
    assert.equal(checkHasPendingWork(idle), false);
    const withTask = { ...idle, backgroundTaskCount: 1, lastTurnEndedAt: now - 20_000 };
    assert.equal(getPendingWorkHoldRemainingMs(withTask), 40_000);
    assert.equal(checkHasPendingWork(withTask), true);
    const withJob = { ...idle, scheduledJobCount: 1, lastTurnEndedAt: now - holdMs };
    assert.equal(getPendingWorkHoldRemainingMs(withJob), 0);
    assert.equal(checkHasPendingWork(withJob), false, 'a spent hold no longer holds');
  });

  it('a finished task\'s turn on its way holds within the grace, without any task left in the list', () => {
    assert.equal(checkIsNotificationTurnPending({ now, notificationTurnPendingSince: now - 1_000 }), true);
    assert.equal(checkHasPendingWork({ ...idle, notificationTurnPendingSince: now - 1_000 }), true);
    assert.equal(checkIsNotificationTurnPending({ now, notificationTurnPendingSince: now - notificationTurnGraceMs }), false);
  });
});
