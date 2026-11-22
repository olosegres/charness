/**
 * @description «A request waits for its schedule» (`requests/scheduleWait.ts`): the three readings over a conversation's
 * jobs — which jobs count (armed under the request or one it replaced; agent jobs; not paused) and how a failing check
 * differs from a passing one.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkIsJobArmedUnderRequest,
  checkIsWaitingAtTurnEnd,
  checkIsWaitingBetweenTurns,
  getRequestScheduleWait,
} from '../requests/scheduleWait';
import type { ScheduleRecord } from '../scheduler/types';

const request = { id: 'req_Current1', supersededRequestIds: ['req_Older001', 'req_Older002'] };

function createJob(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id: 'job-1',
    threadKey: 'jira:PROJ:PROJ-1',
    name: 'watch worker',
    spec: { kind: 'cron', cronExpr: '*/5 * * * *' },
    prompt: 'check the worker',
    createdBy: 'agent',
    createdAt: '2026-11-22T10:00:00.000Z',
    updatedAt: '2026-11-22T10:00:00.000Z',
    nextRunAt: 1,
    requestId: request.id,
    ...overrides,
  };
}

describe('checkIsJobArmedUnderRequest', () => {
  it('a job is armed under the request it names and under every request that one replaced', () => {
    assert.equal(checkIsJobArmedUnderRequest(createJob({ requestId: 'req_Current1' }), request), true);
    assert.equal(checkIsJobArmedUnderRequest(createJob({ requestId: 'req_Older001' }), request), true);
    assert.equal(checkIsJobArmedUnderRequest(createJob({ requestId: 'req_Older002' }), request), true);
  });

  it('another request\'s job, or a job armed under none, is not armed under it', () => {
    assert.equal(checkIsJobArmedUnderRequest(createJob({ requestId: 'req_Other' }), request), false);
    assert.equal(checkIsJobArmedUnderRequest(createJob({ requestId: undefined }), request), false);
    assert.equal(checkIsJobArmedUnderRequest(createJob({ requestId: 'req_Older001' }), { id: 'req_Current1' }), false);
  });
});

describe('getRequestScheduleWait', () => {
  it('no jobs, or none armed under the request: none', () => {
    assert.equal(getRequestScheduleWait([], request), 'none');
    assert.equal(getRequestScheduleWait([createJob({ requestId: 'req_Other' }), createJob({ requestId: undefined })], request), 'none');
  });

  it('a prompt job and a passing check watch the request', () => {
    assert.equal(getRequestScheduleWait([createJob({ spec: { kind: 'once', onceAtIso: '2026-11-23T10:00:00.000Z' } })], request), 'watching');
    assert.equal(getRequestScheduleWait([createJob({ deliveryKind: 'check', checkCommand: 'true' })], request), 'watching');
    assert.equal(getRequestScheduleWait([createJob({ deliveryKind: 'check', checkCommand: 'true', isCheckFailing: false })], request), 'watching');
  });

  it('a failing check alone only arms it — a watch that just fired', () => {
    assert.equal(getRequestScheduleWait([createJob({ deliveryKind: 'check', checkCommand: 'false', isCheckFailing: true })], request), 'armed');
  });

  it('one job that is not failing is enough for `watching`, whatever order the others come in', () => {
    const failing = createJob({ id: 'a', deliveryKind: 'check', checkCommand: 'false', isCheckFailing: true });
    const passing = createJob({ id: 'b', deliveryKind: 'check', checkCommand: 'true' });
    assert.equal(getRequestScheduleWait([failing, passing], request), 'watching');
    assert.equal(getRequestScheduleWait([passing, failing], request), 'watching');
  });

  it('a reminder wakes nobody and a paused job fires nothing: neither counts', () => {
    assert.equal(getRequestScheduleWait([createJob({ deliveryKind: 'reminder' })], request), 'none');
    assert.equal(getRequestScheduleWait([createJob({ isPaused: true, pauseReason: 'unbound' })], request), 'none');
    assert.equal(
      getRequestScheduleWait([createJob({ deliveryKind: 'reminder' }), createJob({ id: 'c', isPaused: true }), createJob({ id: 'd', deliveryKind: 'check', checkCommand: 'false', isCheckFailing: true })], request),
      'armed',
    );
  });

  it('a job armed under a request this one replaced still counts', () => {
    assert.equal(getRequestScheduleWait([createJob({ requestId: 'req_Older002' })], request), 'watching');
  });
});

describe('what each reading means to the rules', () => {
  it('the end of a watched turn reads `armed` and `watching` as waiting; between turns only `watching` holds the request', () => {
    assert.deepEqual((['none', 'armed', 'watching'] as const).map(checkIsWaitingAtTurnEnd), [false, true, true]);
    assert.deepEqual((['none', 'armed', 'watching'] as const).map(checkIsWaitingBetweenTurns), [false, false, true]);
  });
});
