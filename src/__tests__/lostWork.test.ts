/**
 * @description The agent's own pending work that a process took with it when it ended anyway: what counts, when the
 * bot resumes the conversation at once and when the note waits for the next prompt, how two losses merge, the note the
 * agent reads and the one line a topic gets.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLostWorkNote,
  checkHasLostBackgroundWork,
  checkHasLostWork,
  formatLostWorkTopicLine,
  getHeldLostWorkPlan,
  getLostWorkFromTailRecord,
  getLostWorkPlan,
  getTailRecordWithoutPendingWork,
  lostWorkResumeCooldownMs,
  mergeLostWorkRecords,
  type LostWork,
  type LostWorkRecord,
  type LostWorkReason,
} from '../utils/lostWork';
import { enDict } from '../i18n/en';

const nothing: LostWork = { backgroundTasks: [], scheduledJobCount: 0, hasUnreadTaskResult: false, wasTurnInFlight: false };

const record: LostWorkRecord = {
  backgroundTasks: [{ taskId: 'b1', description: 'Watch the test run' }, { taskId: 'b2', description: '' }],
  scheduledJobCount: 2,
  hasUnreadTaskResult: true,
  wasTurnInFlight: false,
  reason: 'exited',
  lostAt: 1_000,
};

/** The English dictionary as the `t` the bot passes: `{name}` placeholders filled. */
function translateEn(code: string, vars: Record<string, string | number> = {}): string {
  const template = enDict[code];
  assert.ok(template !== undefined, `the key ${code} exists`);
  return template.replace(/\{(\w+)\}/g, (_, name: string) => vars[name]?.toString() ?? `{${name}}`);
}

/** The plan for a Telegram topic, with no limit wait and no recent resume unless the case says so. */
function planFor(reason: LostWorkReason, overrides: Partial<Parameters<typeof getLostWorkPlan>[0]> = {}): ReturnType<typeof getLostWorkPlan> {
  return getLostWorkPlan({ reason, isLimitWaitArmed: false, msSinceLastAutoResume: null, isRequestRequired: false, ...overrides });
}

describe('lostWork', () => {
  it('counts background tasks, scheduled jobs, an unread task result and a cut-off turn; nothing of these is no loss', () => {
    assert.equal(checkHasLostWork(nothing), false);
    assert.equal(checkHasLostWork({ ...nothing, backgroundTasks: [{ taskId: 'b1', description: '' }] }), true);
    assert.equal(checkHasLostWork({ ...nothing, scheduledJobCount: 1 }), true);
    assert.equal(checkHasLostWork({ ...nothing, hasUnreadTaskResult: true }), true);
    assert.equal(checkHasLostWork({ ...nothing, wasTurnInFlight: true }), true);
  });

  it('a gone process\'s record: its tasks, jobs and an announced turn are lost work; a record of another conversation holds none; the stripped record keeps the rest', () => {
    const tail = {
      sessionId: 'sess-1', offsetBytes: 500, backgroundTaskIds: ['b1'], backgroundTasks: [{ taskId: 'b1', description: 'Watch' }], isTurnInFlight: true,
      outstandingToolUseIds: [], scheduledJobs: [{ jobId: 'j1', kind: 'recurring' as const }], notificationTurnPendingSinceMs: 5, lastTurnEndedAtMs: 4, claudeCodeVersion: '2.1.310',
    };
    assert.deepEqual(getLostWorkFromTailRecord(tail, 'sess-1'), { backgroundTasks: [{ taskId: 'b1', description: 'Watch' }], scheduledJobCount: 1, hasUnreadTaskResult: true, wasTurnInFlight: false },
      'a turn a crash cut off is the request core\'s, not lost work here');
    assert.equal(checkHasLostWork(getLostWorkFromTailRecord(tail, 'other')), false);
    assert.equal(checkHasLostWork(getLostWorkFromTailRecord(null, 'sess-1')), false);
    const stripped = getTailRecordWithoutPendingWork(tail);
    assert.deepEqual(stripped, { sessionId: 'sess-1', offsetBytes: 500, backgroundTaskIds: [], isTurnInFlight: true, outstandingToolUseIds: [], claudeCodeVersion: '2.1.310' });
    assert.equal(checkHasLostWork(getLostWorkFromTailRecord(stripped, 'sess-1')), false, 'told once');
  });

  it('background work the operator is told a switch stopped: tasks, jobs or an unread result — a cut-off turn alone or nothing is none', () => {
    assert.equal(checkHasLostBackgroundWork(null), false);
    assert.equal(checkHasLostBackgroundWork(nothing), false);
    assert.equal(checkHasLostBackgroundWork({ ...nothing, wasTurnInFlight: true }), false);
    assert.equal(checkHasLostBackgroundWork({ ...nothing, backgroundTasks: [{ taskId: 'b1', description: '' }] }), true);
    assert.equal(checkHasLostBackgroundWork({ ...nothing, scheduledJobCount: 1 }), true);
    assert.equal(checkHasLostBackgroundWork({ ...nothing, hasUnreadTaskResult: true }), true);
  });

  it('a record written before the pending work was tracked (bare task ids, never cleared after a crash) is no loss: no wake-up about tasks that died long ago', () => {
    assert.equal(checkHasLostWork(getLostWorkFromTailRecord({ sessionId: 'sess-1', offsetBytes: 9, backgroundTaskIds: ['old1', 'old2'], isTurnInFlight: false }, 'sess-1')), false);
  });

  it('the plan: a crash or a gone process resumes at once, the person\'s next message resumes after a spent hold, a recent resume or a limit wait', () => {
    for (const reason of ['exited', 'foundDead'] as const) {
      assert.deepEqual(planFor(reason), { isAutoResume: true, isResumedByNextMessage: false }, reason);
      assert.deepEqual(planFor(reason, { msSinceLastAutoResume: lostWorkResumeCooldownMs - 1 }), { isAutoResume: false, isResumedByNextMessage: true }, `${reason}: no resume loop`);
      assert.deepEqual(planFor(reason, { msSinceLastAutoResume: lostWorkResumeCooldownMs }), { isAutoResume: true, isResumedByNextMessage: false }, `${reason}: after the cooldown, again`);
      assert.deepEqual(planFor(reason, { isLimitWaitArmed: true }), { isAutoResume: false, isResumedByNextMessage: false }, `${reason}: the limit wait's own resume carries it`);
    }
    assert.deepEqual(planFor('holdExpired'), { isAutoResume: false, isResumedByNextMessage: true }, 'a forgotten task is not woken');
  });

  it('the plan for a process that is still alive (a re-spawn, a switch): resumed at once unless held, and never "your next message resumes it"', () => {
    assert.deepEqual(planFor('restarted'), { isAutoResume: true, isResumedByNextMessage: false });
    assert.deepEqual(planFor('restarted', { msSinceLastAutoResume: 1 }), { isAutoResume: false, isResumedByNextMessage: false });
    assert.deepEqual(planFor('restarted', { isLimitWaitArmed: true }), { isAutoResume: false, isResumedByNextMessage: false });
    assert.deepEqual(planFor('switched'), { isAutoResume: false, isResumedByNextMessage: false }, 'a switch sends its own first prompt');
  });

  it('the held plan (a resume the bot tried and could not do): a live process is told with its next prompt, a gone one by the person\'s next message, a limit wait by its own resume', () => {
    assert.deepEqual(getHeldLostWorkPlan({ reason: 'restarted', isLimitWaitArmed: false }), { isAutoResume: false, isResumedByNextMessage: false });
    assert.deepEqual(getHeldLostWorkPlan({ reason: 'switched', isLimitWaitArmed: false }), { isAutoResume: false, isResumedByNextMessage: false });
    for (const reason of ['exited', 'foundDead', 'holdExpired'] as const) {
      assert.deepEqual(getHeldLostWorkPlan({ reason, isLimitWaitArmed: false }), { isAutoResume: false, isResumedByNextMessage: true }, reason);
      assert.deepEqual(getHeldLostWorkPlan({ reason, isLimitWaitArmed: true }), { isAutoResume: false, isResumedByNextMessage: false }, `${reason}: limit wait`);
    }
  });

  it('a conversation that answers only through a request (a tracker issue) is never resumed by a bare note', () => {
    for (const reason of ['exited', 'foundDead', 'restarted'] as const) {
      assert.equal(planFor(reason, { isRequestRequired: true }).isAutoResume, false, reason);
    }
  });

  it('a newer loss adds to an untold one: tasks by id, the larger job count, either flag, the newer reason and time', () => {
    const newer: LostWorkRecord = {
      backgroundTasks: [{ taskId: 'b2', description: 'Rerun' }, { taskId: 'b3', description: 'Deploy' }],
      scheduledJobCount: 1,
      hasUnreadTaskResult: false,
      wasTurnInFlight: true,
      reason: 'holdExpired',
      lostAt: 2_000,
    };
    assert.equal(mergeLostWorkRecords(undefined, newer), newer);
    const toldPart: LostWork = { ...nothing, backgroundTasks: [{ taskId: 'b1', description: 'Watch the test run' }] };
    assert.deepEqual(mergeLostWorkRecords({ ...record, otherAgentTold: toldPart }, newer).otherAgentTold, toldPart,
      'the part the other agent heard survives a merge, and a loss merged in later is not added to it');
    assert.deepEqual(mergeLostWorkRecords(record, newer), {
      backgroundTasks: [{ taskId: 'b1', description: 'Watch the test run' }, { taskId: 'b2', description: 'Rerun' }, { taskId: 'b3', description: 'Deploy' }],
      scheduledJobCount: 2,
      hasUnreadTaskResult: true,
      wasTurnInFlight: true,
      reason: 'holdExpired',
      lostAt: 2_000,
    });
  });

  it('the note names the reason and every lost piece, says no notification will come, and bakes the reply language', () => {
    const note = buildLostWorkNote({ ...record, wasTurnInFlight: true }, 'Русский');
    assert.ok(note.startsWith('[charness] This conversation\'s agent process ended while its own work was still pending (it exited unexpectedly)'), note);
    assert.ok(note.includes('background tasks b1 «Watch the test run», b2'), note);
    assert.ok(note.includes('2 session-only CronCreate job(s)'), note);
    assert.ok(note.includes('which you had not read'), note);
    assert.ok(note.includes('the turn you were in the middle of, which was cut off'), note);
    assert.ok(note.includes('no notification will ever arrive'), note);
    assert.ok(note.endsWith('IN Русский.'), note);
    assert.ok(buildLostWorkNote({ ...record, reason: 'holdExpired' }, 'English').includes('after a long time without a turn'));
    assert.ok(buildLostWorkNote({ ...record, reason: 'switched' }, 'English').includes('(the conversation moved to another backend)'));
    assert.ok(!note.includes('was told first about'), 'only a parked note says another agent was told');
    const parkedNote = buildLostWorkNote({ ...record, reason: 'switched', otherAgentTold: { ...nothing, backgroundTasks: [{ taskId: 'b1', description: 'Watch the test run' }] } }, 'English');
    assert.ok(parkedNote.includes('The agent this conversation moved to meanwhile was told first about background tasks b1 «Watch the test run», and may'), parkedNote);
    assert.ok(!buildLostWorkNote({ ...record, otherAgentTold: nothing }, 'English').includes('was told first about'), 'an empty told part says nothing');
    const toldWithTurn = buildLostWorkNote({ ...record, reason: 'switched', otherAgentTold: { ...record, wasTurnInFlight: true } }, 'English');
    const caveat = toldWithTurn.split('\n').find((line) => line.includes('was told first about')) ?? '';
    assert.ok(caveat.includes('background tasks b1 «Watch the test run», b2; 2 session-only CronCreate job(s), and may'), caveat);
    assert.ok(!caveat.includes('cut off') && !caveat.includes('had not read'), `the caveat names only what could be started again: ${caveat}`);
    assert.ok(!buildLostWorkNote({ ...record, otherAgentTold: { ...nothing, hasUnreadTaskResult: true, wasTurnInFlight: true } }, 'English').includes('was told first about'),
      'a told part with nothing to start again says nothing');
  });

  it('the topic line: resumed now, resumed by the next message, or told with the next prompt — the tasks by description, the hold in hours', () => {
    assert.equal(
      formatLostWorkTopicLine(record, { isAutoResume: true, isResumedByNextMessage: false }, 6, translateEn),
      '⚠️ The agent\'s process ended unexpectedly while its own work was pending — background tasks «Watch the test run», b2; scheduled jobs: 2; a finished task\'s result it had not read. I resumed it and asked it to check that work again.',
    );
    assert.equal(
      formatLostWorkTopicLine({ ...record, scheduledJobCount: 0, hasUnreadTaskResult: false, reason: 'holdExpired' }, { isAutoResume: false, isResumedByNextMessage: true }, 6, translateEn),
      '⚠️ The agent\'s process had no turn for 6 h and was stopped while its own work was pending — background tasks «Watch the test run», b2. Your next message resumes it and tells it what was lost.',
    );
    assert.equal(
      formatLostWorkTopicLine({ ...nothing, wasTurnInFlight: true, reason: 'restarted', lostAt: 1 }, { isAutoResume: false, isResumedByNextMessage: false }, 6, translateEn),
      '⚠️ The agent\'s process was restarted for the model, effort or account change while its own work was pending — the turn it was in the middle of. The agent is told with the next prompt it gets.',
      'a live process is never said to wait for "your next message"',
    );
  });
});
