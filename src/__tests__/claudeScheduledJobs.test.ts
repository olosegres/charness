/**
 * @description Session-only `CronCreate` jobs read off the tool results, in the wordings probed live on Claude Code
 * 2.1.310; an unrecognised wording tracks nothing (the process is then held exactly as before the tracking).
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getCancelledJobIdFromCronDeleteResult,
  getScheduledJobFromCronCreateResult,
  getScheduledJobFromLoopWakeupResult,
  getScheduledJobsAfterFiring,
  loopWakeupJobId,
  type ScheduledJob,
} from '../utils/claudeScheduledJobs';

describe('claudeScheduledJobs', () => {
  it('reads a one-shot task and a recurring job from CronCreate results; anything else is no job', () => {
    assert.deepEqual(getScheduledJobFromCronCreateResult('Scheduled one-shot task 59151bd3 (20 11 24 10 *). Next run: Oct 24 11:20am. Session-only.'), { jobId: '59151bd3', kind: 'oneShot' });
    assert.deepEqual(getScheduledJobFromCronCreateResult('Scheduled recurring job 99a38c99 (Every 3 hours at :17). Auto-expires after 7 days.'), { jobId: '99a38c99', kind: 'recurring' });
    assert.equal(getScheduledJobFromCronCreateResult('<tool_use_error>InputValidationError: bad cron</tool_use_error>'), null);
    assert.equal(getScheduledJobFromCronCreateResult(''), null);
  });

  it('reads the cancelled id from a CronDelete result; anything else is none', () => {
    assert.equal(getCancelledJobIdFromCronDeleteResult('Cancelled job 99a38c99.'), '99a38c99');
    assert.equal(getCancelledJobIdFromCronDeleteResult('No job with id 99a38c99'), null);
  });

  it('reads the ScheduleWakeup (/loop) wakeup from its result, in its one slot; anything else is none', () => {
    assert.deepEqual(getScheduledJobFromLoopWakeupResult('Next wakeup scheduled for 15:05:00 (in 63s). If you owe the user a status update this tick, write it now.'), { jobId: loopWakeupJobId, kind: 'loopWakeup' });
    assert.equal(getScheduledJobFromLoopWakeupResult('Loop stopped.'), null);
  });

  it('a CronCreate firing takes the oldest one-shot job off and leaves recurring jobs and the wakeup; a loop firing takes the wakeup alone', () => {
    const jobs = new Map<string, ScheduledJob>([
      ['r1', { jobId: 'r1', kind: 'recurring' }],
      ['o1', { jobId: 'o1', kind: 'oneShot' }],
      [loopWakeupJobId, { jobId: loopWakeupJobId, kind: 'loopWakeup' }],
      ['o2', { jobId: 'o2', kind: 'oneShot' }],
    ]);
    assert.deepEqual([...getScheduledJobsAfterFiring(jobs, 'cron').keys()], ['r1', loopWakeupJobId, 'o2']);
    assert.deepEqual([...getScheduledJobsAfterFiring(jobs, 'loop').keys()], ['r1', 'o1', 'o2'], 'a /loop wakeup never takes a cron job off (its frame says loop_wakeup, probed live)');
    assert.deepEqual([...jobs.keys()], ['r1', 'o1', loopWakeupJobId, 'o2'], 'the input is not changed');
    const recurringOnly = new Map<string, ScheduledJob>([['r1', { jobId: 'r1', kind: 'recurring' }]]);
    assert.deepEqual([...getScheduledJobsAfterFiring(recurringOnly, 'cron').keys()], ['r1']);
  });
});
