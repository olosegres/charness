/**
 * @description The named "working" signals: the log wording the idle fire prints for each, and the reason the topic's notice
 * gives for a compaction skipped at the idle mark.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { describeWorkingSignal, describeWorkingSignals, getIdleHeldNoticeReason, type WorkingSignal } from '../utils/workingSignals';

describe('describeWorkingSignal — the bot console names which signal keeps a process working', () => {
  it('names each kind, with its figure when it has one', () => {
    const signals: WorkingSignal[] = [
      { kind: 'turn' },
      { kind: 'backgroundTasks', count: 2 },
      { kind: 'scheduledJobs', count: 1 },
      { kind: 'taskTurnOnItsWay' },
      { kind: 'unconsumedInput', count: 3 },
      { kind: 'compaction' },
    ];
    assert.deepEqual(signals.map(describeWorkingSignal), [
      'busy turn', 'background tasks 2', 'scheduled jobs 1', 'task result turn on its way', 'unconsumed input 3', 'compaction in flight',
    ]);
  });
});

describe('describeWorkingSignals', () => {
  it('lists every signal that holds the process, in order', () => {
    assert.equal(describeWorkingSignals([{ kind: 'turn' }, { kind: 'unconsumedInput', count: 2 }]), 'busy turn, unconsumed input 2');
    assert.equal(describeWorkingSignals([]), '');
  });
});

describe('getIdleHeldNoticeReason — what the person is told', () => {
  it('the agent\'s background work comes first: tasks, jobs and a finished task\'s turn on its way alike', () => {
    assert.equal(getIdleHeldNoticeReason([{ kind: 'backgroundTasks', count: 1 }]), 'backgroundWork');
    assert.equal(getIdleHeldNoticeReason([{ kind: 'scheduledJobs', count: 1 }]), 'backgroundWork');
    assert.equal(getIdleHeldNoticeReason([{ kind: 'taskTurnOnItsWay' }]), 'backgroundWork');
    assert.equal(getIdleHeldNoticeReason([{ kind: 'turn' }, { kind: 'unconsumedInput', count: 1 }, { kind: 'backgroundTasks', count: 1 }]), 'backgroundWork');
  });

  it('then a message it has not taken in — also beside a running turn', () => {
    assert.equal(getIdleHeldNoticeReason([{ kind: 'turn' }, { kind: 'unconsumedInput', count: 2 }]), 'unconsumedInput');
    assert.equal(getIdleHeldNoticeReason([{ kind: 'unconsumedInput', count: 1 }]), 'unconsumedInput');
  });

  it('a running turn alone has no line: a long silent command is no news, and the turn\'s end opens a new idle period anyway', () => {
    assert.equal(getIdleHeldNoticeReason([{ kind: 'turn' }]), null);
  });

  it('a compaction in flight alone, or nothing, has no reason to tell: the compaction is what the idle mark would have done', () => {
    assert.equal(getIdleHeldNoticeReason([{ kind: 'compaction' }]), null);
    assert.equal(getIdleHeldNoticeReason([]), null);
  });
});
