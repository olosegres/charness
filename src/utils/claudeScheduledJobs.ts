/**
 * @description Session-only scheduled jobs of a Claude Code process, read off its tool results: `CronCreate` jobs and
 * the `ScheduleWakeup` (`/loop`) wakeup. The CLI keeps them in memory only ("Session-only (not written to disk, dies
 * when Claude exits)") and never lists them in `background_tasks_changed`, so the bot tracks them itself: a stop drops
 * every one with the process.
 *
 * The wordings were probed live on Claude Code 2.1.310:
 *   CronCreate        → `Scheduled one-shot task 59151bd3 (…). … It will fire once then auto-delete.`
 *                     → `Scheduled recurring job 99a38c99 (Every 3 hours at :17). … Auto-expires after 7 days. …`
 *   CronDelete        → `Cancelled job 99a38c99.`
 *   ScheduleWakeup    → `Next wakeup scheduled for 15:05:00 (in 63s). …`
 * A job firing starts a turn with a `command_lifecycle` frame naming its source, not the job: `schedule_wakeup` for a
 * `CronCreate` job, `loop_wakeup` for the `ScheduleWakeup` one. An unrecognised wording tracks nothing — the process
 * is then held exactly as before this tracking (a cancelled wakeup's wording is not known: it is held until the hold
 * runs out).
 */

export const cronCreateToolName = 'CronCreate';
export const cronDeleteToolName = 'CronDelete';
export const loopWakeupToolName = 'ScheduleWakeup';

/**
 * @name ScheduledJobKind
 * @description `oneShot` / `recurring` — a `CronCreate` job (a one-shot job is gone once it fires, a recurring one stays
 * until cancelled); `loopWakeup` — the one pending `ScheduleWakeup`, gone once it fires.
 */
export type ScheduledJobKind = 'oneShot' | 'recurring' | 'loopWakeup';

/** @name ScheduledJob @description A session-only job the process holds. */
export interface ScheduledJob {
  jobId: string;
  kind: ScheduledJobKind;
}

/** The firing source of a `command_lifecycle` frame: a `CronCreate` job, or the `ScheduleWakeup` wakeup. */
export type ScheduledWakeupSource = 'cron' | 'loop';

/** The one `ScheduleWakeup` slot: a new wakeup replaces the pending one. */
export const loopWakeupJobId = 'loop-wakeup';

const cronCreateResultRe = /^Scheduled (one-shot|recurring) (?:task|job) ([0-9a-z]+)\b/;
const cronDeleteResultRe = /^Cancelled job ([0-9a-z]+)\b/;
const loopWakeupResultRe = /^Next wakeup scheduled for /;

/** @description The job a `CronCreate` result scheduled, `null` for any other text (an error, a new wording). */
export function getScheduledJobFromCronCreateResult(output: string): ScheduledJob | null {
  const match = cronCreateResultRe.exec(output.trim());
  return match ? { jobId: match[2], kind: match[1] === 'recurring' ? 'recurring' : 'oneShot' } : null;
}

/** @description The id a `CronDelete` result cancelled, `null` for any other text. */
export function getCancelledJobIdFromCronDeleteResult(output: string): string | null {
  return cronDeleteResultRe.exec(output.trim())?.[1] ?? null;
}

/** @description The wakeup a `ScheduleWakeup` result scheduled, `null` for any other text. */
export function getScheduledJobFromLoopWakeupResult(output: string): ScheduledJob | null {
  return loopWakeupResultRe.test(output.trim()) ? { jobId: loopWakeupJobId, kind: 'loopWakeup' } : null;
}

/**
 * @description The jobs left after a job of `source` fired. A `ScheduleWakeup` firing takes the wakeup off. A
 * `CronCreate` firing does not name the job, so one one-shot job is taken off — the OLDEST, whichever fired, keeps the
 * count right — and recurring jobs stay; with no one-shot job left, the firing was a recurring job's.
 */
export function getScheduledJobsAfterFiring(jobs: ReadonlyMap<string, ScheduledJob>, source: ScheduledWakeupSource): Map<string, ScheduledJob> {
  const remaining = new Map(jobs);
  const fired = source === 'loop' ? remaining.get(loopWakeupJobId) : [...remaining.values()].find((job) => job.kind === 'oneShot');
  if (fired) remaining.delete(fired.jobId);
  return remaining;
}
