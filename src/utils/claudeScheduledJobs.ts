/**
 * @description Session-only `CronCreate` jobs of a Claude Code process, read off its tool results. The CLI keeps them
 * in memory only ("Session-only (not written to disk, dies when Claude exits)") and never lists them in
 * `background_tasks_changed`, so the bot tracks them itself: a stop drops every job with the process.
 *
 * The wordings were probed live on Claude Code 2.1.310:
 *   CronCreate  → `Scheduled one-shot task 59151bd3 (…). … It will fire once then auto-delete.`
 *               → `Scheduled recurring job 99a38c99 (Every 3 hours at :17). … Auto-expires after 7 days. …`
 *   CronDelete  → `Cancelled job 99a38c99.`
 * A job firing starts a turn with a `command_lifecycle` frame (`wakeup_source: "schedule_wakeup"`) that does not name
 * the job. An unrecognised wording tracks nothing — the process is then held exactly as before this tracking.
 */

export const cronCreateToolName = 'CronCreate';
export const cronDeleteToolName = 'CronDelete';

/** @name ScheduledJob @description A session-only job: a one-shot job is gone once it fires, a recurring one stays until cancelled. */
export interface ScheduledJob {
  jobId: string;
  isRecurring: boolean;
}

const cronCreateResultRe = /^Scheduled (one-shot|recurring) (?:task|job) ([0-9a-z]+)\b/;
const cronDeleteResultRe = /^Cancelled job ([0-9a-z]+)\b/;

/** @description The job a `CronCreate` result scheduled, `null` for any other text (an error, a new wording). */
export function getScheduledJobFromCronCreateResult(output: string): ScheduledJob | null {
  const match = cronCreateResultRe.exec(output.trim());
  return match ? { jobId: match[2], isRecurring: match[1] === 'recurring' } : null;
}

/** @description The id a `CronDelete` result cancelled, `null` for any other text. */
export function getCancelledJobIdFromCronDeleteResult(output: string): string | null {
  return cronDeleteResultRe.exec(output.trim())?.[1] ?? null;
}

/**
 * @description The jobs left after a job fired. The firing frame does not name the job, so one one-shot job is taken
 * off — the OLDEST, whichever fired, keeps the count right — and recurring jobs stay. With no one-shot job left, the
 * firing was a recurring job's and nothing changes.
 */
export function getScheduledJobsAfterFiring(jobs: ReadonlyMap<string, ScheduledJob>): Map<string, ScheduledJob> {
  const remaining = new Map(jobs);
  const firedOneShot = [...remaining.values()].find((job) => !job.isRecurring);
  if (firedOneShot) remaining.delete(firedOneShot.jobId);
  return remaining;
}
