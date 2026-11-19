/**
 * @description The rules that turn what the bot knows of a topic's agent into the facts its status mark is chosen from
 * (`utils/topicIndicatorSources.ts`): which schedules are a watched worker that still runs, and how a process that is up or stopped, a
 * turn at work, an open question and a stuck agent become working, finished, asleep, ❓ and ❗️.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ScheduleRecord } from '../scheduler/types';
import { checkIsWatchedWorkerRunning, getTopicStatusInputs, type TopicAgentFacts } from '../utils/topicIndicatorSources';

/** A check that watches a worker's run directory, armed and passing — the recipe of `scheduler/workerWatch.ts`. */
function createWorkerWatch(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id: 'watch-1',
    threadKey: 'telegram:-1001234567890:11',
    name: 'builder',
    spec: { kind: 'cron', cronExpr: '*/5 * * * *' },
    prompt: 'the builder ended',
    createdBy: 'agent',
    createdAt: '2026-11-18T10:00:00.000Z',
    updatedAt: '2026-11-18T10:00:00.000Z',
    nextRunAt: 1_800_000_000_000,
    deliveryKind: 'check',
    checkCommand: 'kill -0 123',
    statusWorkerRunDir: '/tmp/run',
    ...overrides,
  };
}

const idleAgent: TopicAgentFacts = {
  hasAgent: true,
  isActive: false,
  isTurnRunning: false,
  isPerTurnBackend: false,
  watchedWorkerCount: 0,
  hasOpenQuestion: false,
  isStuck: false,
  hasResumableSession: false,
};

describe('checkIsWatchedWorkerRunning', () => {
  it('is a passing, armed check with a worker\'s run directory', () => {
    assert.equal(checkIsWatchedWorkerRunning(createWorkerWatch()), true);
  });

  it('is not a check without a worker\'s run directory, a prompt job, or a reminder', () => {
    assert.equal(checkIsWatchedWorkerRunning(createWorkerWatch({ statusWorkerRunDir: undefined })), false);
    assert.equal(checkIsWatchedWorkerRunning(createWorkerWatch({ deliveryKind: undefined })), false);
    assert.equal(checkIsWatchedWorkerRunning(createWorkerWatch({ deliveryKind: 'reminder' })), false);
  });

  it('stops being one when it is parked, has no next run, or is failing (a failing check IS the worker\'s end)', () => {
    assert.equal(checkIsWatchedWorkerRunning(createWorkerWatch({ isPaused: true })), false);
    assert.equal(checkIsWatchedWorkerRunning(createWorkerWatch({ nextRunAt: null })), false);
    assert.equal(checkIsWatchedWorkerRunning(createWorkerWatch({ isCheckFailing: true })), false);
  });
});

describe('getTopicStatusInputs', () => {
  it('a topic with no agent has none of the facts, whatever else is set', () => {
    assert.deepEqual(
      getTopicStatusInputs({ ...idleAgent, hasAgent: false, isActive: true, isTurnRunning: true, hasOpenQuestion: true, isStuck: true, watchedWorkerCount: 2, hasResumableSession: true }),
      { hasOpenQuestion: false, isStuck: false, isWorking: false, isFinished: false, isAsleep: false },
    );
  });

  it('a running turn is working, not finished', () => {
    assert.deepEqual(getTopicStatusInputs({ ...idleAgent, isActive: true, isTurnRunning: true }), { hasOpenQuestion: false, isStuck: false, isWorking: true, isFinished: false, isAsleep: false });
  });

  it('a process that is up and idle is finished', () => {
    assert.deepEqual(getTopicStatusInputs({ ...idleAgent, isActive: true }), { hasOpenQuestion: false, isStuck: false, isWorking: false, isFinished: true, isAsleep: false });
  });

  it('a stopped process whose conversation is kept is asleep; one with nothing to resume is nothing', () => {
    assert.equal(getTopicStatusInputs({ ...idleAgent, hasResumableSession: true }).isAsleep, true);
    assert.deepEqual(getTopicStatusInputs(idleAgent), { hasOpenQuestion: false, isStuck: false, isWorking: false, isFinished: false, isAsleep: false });
  });

  it('the per-turn backend\'s stopped process after its turn is FINISHED, not asleep: ✅ until the next turn, as for an agent that stayed up', () => {
    const afterTurn = getTopicStatusInputs({ ...idleAgent, isPerTurnBackend: true, hasResumableSession: true });
    assert.deepEqual(afterTurn, { hasOpenQuestion: false, isStuck: false, isWorking: false, isFinished: true, isAsleep: false });
    assert.equal(getTopicStatusInputs({ ...idleAgent, isPerTurnBackend: true, hasResumableSession: true, isActive: true, isTurnRunning: true }).isWorking, true, 'its turn runs: working');
    assert.equal(getTopicStatusInputs({ ...idleAgent, isPerTurnBackend: true }).isFinished, false, 'nothing to resume, nothing finished');
    assert.equal(getTopicStatusInputs({ ...idleAgent, isPerTurnBackend: true, hasResumableSession: true, isStuck: true }).isStuck, true, 'a crash is still stuck — it outranks ✅ in the plan');
  });

  it('the idle stop of the other backends is asleep: the conversation is kept, the process was stopped on purpose', () => {
    assert.deepEqual(getTopicStatusInputs({ ...idleAgent, hasResumableSession: true }), { hasOpenQuestion: false, isStuck: false, isWorking: false, isFinished: false, isAsleep: true });
  });

  it('a turn flag of a process that is not up counts for nothing', () => {
    assert.equal(getTopicStatusInputs({ ...idleAgent, isTurnRunning: true }).isWorking, false);
  });

  it('a watched worker makes the topic work even while its own agent rests or sleeps', () => {
    const resting = getTopicStatusInputs({ ...idleAgent, isActive: true, watchedWorkerCount: 1 });
    assert.equal(resting.isWorking, true);
    assert.equal(resting.isFinished, true, 'the agent itself finished; working wins by priority');
    assert.equal(getTopicStatusInputs({ ...idleAgent, hasResumableSession: true, watchedWorkerCount: 1 }).isWorking, true);
  });

  it('an open question and a stuck agent are carried through', () => {
    assert.equal(getTopicStatusInputs({ ...idleAgent, isActive: true, hasOpenQuestion: true }).hasOpenQuestion, true);
    assert.equal(getTopicStatusInputs({ ...idleAgent, isStuck: true }).isStuck, true);
  });
});
