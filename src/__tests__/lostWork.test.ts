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
  checkHasLostWork,
  formatLostWorkTopicLine,
  getLostWorkFromTailRecord,
  getLostWorkPlan,
  getTailRecordWithoutPendingWork,
  lostWorkResumeCooldownMs,
  mergeLostWorkRecords,
  type LostWorkRecord,
} from '../utils/lostWork';
import { enDict } from '../i18n/en';

const record: LostWorkRecord = {
  backgroundTasks: [{ taskId: 'b1', description: 'Watch the test run' }, { taskId: 'b2', description: '' }],
  scheduledJobCount: 2,
  hasUnreadTaskResult: true,
  reason: 'exited',
  lostAt: 1_000,
};

/** The English dictionary as the `t` the bot passes: `{name}` placeholders filled. */
function translateEn(code: string, vars: Record<string, string | number> = {}): string {
  const template = enDict[code];
  assert.ok(template !== undefined, `the key ${code} exists`);
  return template.replace(/\{(\w+)\}/g, (_, name: string) => vars[name]?.toString() ?? `{${name}}`);
}

describe('lostWork', () => {
  it('counts background tasks, scheduled jobs and an unread task result; nothing of these is no loss', () => {
    assert.equal(checkHasLostWork({ backgroundTasks: [], scheduledJobCount: 0, hasUnreadTaskResult: false }), false);
    assert.equal(checkHasLostWork({ backgroundTasks: [{ taskId: 'b1', description: '' }], scheduledJobCount: 0, hasUnreadTaskResult: false }), true);
    assert.equal(checkHasLostWork({ backgroundTasks: [], scheduledJobCount: 1, hasUnreadTaskResult: false }), true);
    assert.equal(checkHasLostWork({ backgroundTasks: [], scheduledJobCount: 0, hasUnreadTaskResult: true }), true);
  });

  it('a gone process\'s record: its tasks, jobs and an announced turn are lost work; a record of another conversation holds none; the stripped record keeps the rest', () => {
    const tail = {
      sessionId: 'sess-1', offsetBytes: 500, backgroundTaskIds: ['b1'], backgroundTasks: [{ taskId: 'b1', description: 'Watch' }], isTurnInFlight: false,
      outstandingToolUseIds: [], scheduledJobs: [{ jobId: 'j1', isRecurring: true }], notificationTurnPendingSinceMs: 5, lastTurnEndedAtMs: 4, claudeCodeVersion: '2.1.310',
    };
    assert.deepEqual(getLostWorkFromTailRecord(tail, 'sess-1'), { backgroundTasks: [{ taskId: 'b1', description: 'Watch' }], scheduledJobCount: 1, hasUnreadTaskResult: true });
    assert.equal(checkHasLostWork(getLostWorkFromTailRecord(tail, 'other')), false);
    assert.equal(checkHasLostWork(getLostWorkFromTailRecord(null, 'sess-1')), false);
    const stripped = getTailRecordWithoutPendingWork(tail);
    assert.deepEqual(stripped, { sessionId: 'sess-1', offsetBytes: 500, backgroundTaskIds: [], isTurnInFlight: false, outstandingToolUseIds: [], claudeCodeVersion: '2.1.310' });
    assert.equal(checkHasLostWork(getLostWorkFromTailRecord(stripped, 'sess-1')), false, 'told once');
  });

  it('the plan: a crash, a gone process or a re-spawn resumes at once; a spent hold, an armed limit wait or a recent resume waits for the next prompt', () => {
    for (const reason of ['exited', 'foundDead', 'restarted'] as const) {
      assert.deepEqual(getLostWorkPlan({ reason, isLimitWaitArmed: false, msSinceLastAutoResume: null }), { isAutoResume: true }, reason);
    }
    assert.deepEqual(getLostWorkPlan({ reason: 'holdExpired', isLimitWaitArmed: false, msSinceLastAutoResume: null }), { isAutoResume: false }, 'a forgotten task is not woken');
    assert.deepEqual(getLostWorkPlan({ reason: 'exited', isLimitWaitArmed: true, msSinceLastAutoResume: null }), { isAutoResume: false }, 'the limit resume carries it');
    assert.deepEqual(getLostWorkPlan({ reason: 'exited', isLimitWaitArmed: false, msSinceLastAutoResume: lostWorkResumeCooldownMs - 1 }), { isAutoResume: false }, 'no resume loop');
    assert.deepEqual(getLostWorkPlan({ reason: 'exited', isLimitWaitArmed: false, msSinceLastAutoResume: lostWorkResumeCooldownMs }), { isAutoResume: true }, 'after the cooldown, again');
  });

  it('a newer loss adds to an untold one: tasks by id, the larger job count, the newer reason and time', () => {
    const newer: LostWorkRecord = {
      backgroundTasks: [{ taskId: 'b2', description: 'Rerun' }, { taskId: 'b3', description: 'Deploy' }],
      scheduledJobCount: 1,
      hasUnreadTaskResult: false,
      reason: 'holdExpired',
      lostAt: 2_000,
    };
    assert.equal(mergeLostWorkRecords(undefined, newer), newer);
    assert.deepEqual(mergeLostWorkRecords(record, newer), {
      backgroundTasks: [{ taskId: 'b1', description: 'Watch the test run' }, { taskId: 'b2', description: 'Rerun' }, { taskId: 'b3', description: 'Deploy' }],
      scheduledJobCount: 2,
      hasUnreadTaskResult: true,
      reason: 'holdExpired',
      lostAt: 2_000,
    });
  });

  it('the note names the reason and every lost piece, says no notification will come, and bakes the reply language', () => {
    const note = buildLostWorkNote(record, 'Русский');
    assert.ok(note.startsWith('[charness] Your Claude Code process ended while your own work was still pending (it exited unexpectedly)'), note);
    assert.ok(note.includes('background tasks b1 «Watch the test run», b2'), note);
    assert.ok(note.includes('2 session-only CronCreate job(s)'), note);
    assert.ok(note.includes('which you had not read'), note);
    assert.ok(note.includes('no notification will ever arrive'), note);
    assert.ok(note.endsWith('IN Русский.'), note);
    assert.ok(buildLostWorkNote({ ...record, reason: 'holdExpired' }, 'English').includes('after a long time without a turn'));
  });

  it('the topic line: resumed now, or held for the next message; the tasks by description, the hold in hours', () => {
    assert.equal(
      formatLostWorkTopicLine(record, { isAutoResume: true }, 6, translateEn),
      '⚠️ The agent\'s process ended unexpectedly while its own work was pending — background tasks «Watch the test run», b2; scheduled jobs: 2; a finished task\'s result it had not read. I resumed it and asked it to check that work again.',
    );
    assert.equal(
      formatLostWorkTopicLine({ ...record, scheduledJobCount: 0, hasUnreadTaskResult: false, reason: 'holdExpired' }, { isAutoResume: false }, 6, translateEn),
      '⚠️ The agent\'s process had no turn for 6 h and was stopped while its own work was pending — background tasks «Watch the test run», b2. Your next message resumes it and tells it what was lost.',
    );
  });
});
