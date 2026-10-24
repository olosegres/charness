/**
 * @description Session-only `CronCreate` jobs read off the tool results, in the wordings probed live on Claude Code
 * 2.1.310; an unrecognised wording tracks nothing (the process is then held exactly as before the tracking).
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getCancelledJobIdFromCronDeleteResult, getScheduledJobFromCronCreateResult, getScheduledJobsAfterFiring, type ScheduledJob } from '../utils/claudeScheduledJobs';

describe('claudeScheduledJobs', () => {
  it('reads a one-shot task and a recurring job from CronCreate results; anything else is no job', () => {
    assert.deepEqual(getScheduledJobFromCronCreateResult('Scheduled one-shot task 59151bd3 (20 11 24 10 *). Next run: Oct 24 11:20am. Session-only.'), { jobId: '59151bd3', isRecurring: false });
    assert.deepEqual(getScheduledJobFromCronCreateResult('Scheduled recurring job 99a38c99 (Every 3 hours at :17). Auto-expires after 7 days.'), { jobId: '99a38c99', isRecurring: true });
    assert.equal(getScheduledJobFromCronCreateResult('<tool_use_error>InputValidationError: bad cron</tool_use_error>'), null);
    assert.equal(getScheduledJobFromCronCreateResult(''), null);
  });

  it('reads the cancelled id from a CronDelete result; anything else is none', () => {
    assert.equal(getCancelledJobIdFromCronDeleteResult('Cancelled job 99a38c99.'), '99a38c99');
    assert.equal(getCancelledJobIdFromCronDeleteResult('No job with id 99a38c99'), null);
  });

  it('a firing takes the oldest one-shot job off and leaves recurring jobs; with only recurring jobs nothing changes', () => {
    const jobs = new Map<string, ScheduledJob>([
      ['r1', { jobId: 'r1', isRecurring: true }],
      ['o1', { jobId: 'o1', isRecurring: false }],
      ['o2', { jobId: 'o2', isRecurring: false }],
    ]);
    assert.deepEqual([...getScheduledJobsAfterFiring(jobs).keys()], ['r1', 'o2']);
    assert.deepEqual([...jobs.keys()], ['r1', 'o1', 'o2'], 'the input is not changed');
    const recurringOnly = new Map<string, ScheduledJob>([['r1', { jobId: 'r1', isRecurring: true }]]);
    assert.deepEqual([...getScheduledJobsAfterFiring(recurringOnly).keys()], ['r1']);
  });
});
