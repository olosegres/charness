import { t } from '../i18n';
import { checkIsStreamShown } from '../utils/topicView';
import type { TopicView } from '../types';
import type { ScheduleRecord } from './types';

/**
 * @description The STATUS LINE of a passing check: while a `'check'` job keeps passing and carries a status source
 * (a worker's run directory, or a command), the BOT itself posts a short silent line into the topic — «⏳ builder S2 ·
 * works 30 min · now: Bash: Run the unit tests» — and deletes the previous one. The agent is never woken and no turn
 * runs, so a topic whose agent is idle, compacting or stopped still shows that its worker is alive. This file holds the
 * pure decisions (when a line is due, whether the topic shows it, its text); the I/O lives in `delivery.ts`
 * (`updateCheckStatus`) and `workerActivity.ts`.
 */

/** Minutes between two status lines when `schedule_create` leaves `statusEveryMinutes` out. */
export const defaultCheckStatusEveryMinutes = 15;

/** The shortest `statusEveryMinutes`: a status line is a heartbeat, not a stream (the bot posts at most one per 5 min). */
export const minCheckStatusEveryMinutes = 5;

/** The longest `statusEveryMinutes` (4 h). */
export const maxCheckStatusEveryMinutes = 240;

/** Longest `statusCommand` accepted (the same bound as `checkCommand`). */
export const maxCheckStatusCommandLength = 1000;

/** Longest `statusWorkerRunDir` accepted. */
export const maxCheckStatusRunDirLength = 1000;

/** Seconds a `statusCommand` run may take; a slow probe only costs the «now» part of its line. */
export const checkStatusCommandTimeoutSec = 15;

/**
 * How much earlier than a full interval a line may come due. A check runs on a cron tick, a few seconds after the minute,
 * so «15 min since the last line» is measured at 14 min 58 s on the tick that should post it, and a plain `>=` would
 * push every line one tick later (a cron ticking every 5 minutes would post every 20 min, not 15).
 */
export const checkStatusSlackMs = 60_000;

/** The slack never exceeds this share of the interval, so a test window of a minute or two is still an interval. */
const checkStatusSlackShareDivisor = 5;

/** The longest «now» part of a line: one line of a phone's width, never a paragraph. */
export const checkStatusActivityMaxChars = 120;

const msPerMinute = 60_000;
const minutesPerHour = 60;

/** A leading `watch ` of a check's name is the recipe's own prefix (`watch builder S2`), noise in the topic. */
const leadingWatchWordPattern = /^watch\s+/i;

/** @description The status interval of a check, in ms. */
export function getCheckStatusIntervalMs(job: Pick<ScheduleRecord, 'statusEveryMinutes'>): number {
  return (job.statusEveryMinutes ?? defaultCheckStatusEveryMinutes) * msPerMinute;
}

/**
 * @description Whether a status line is due: an interval (less the slack) has passed since the last line, or since the
 * check was created before the first one — the manager's own launch message covers the first minutes.
 */
export function checkIsCheckStatusDue(input: { sinceMs: number; nowMs: number; intervalMs: number }): boolean {
  const slackMs = Math.min(checkStatusSlackMs, Math.floor(input.intervalMs / checkStatusSlackShareDivisor));
  return input.nowMs - input.sinceMs >= input.intervalMs - slackMs;
}

/** @description The instant a check's next line is counted from: its last line, else its creation. */
export function getCheckStatusSinceMs(job: Pick<ScheduleRecord, 'lastStatusAt' | 'createdAt'>): number {
  return job.lastStatusAt ?? Date.parse(job.createdAt);
}

/**
 * @description Whether this is the LAST run the job will ever make (a `once` job, or the final run of an N-times cron): its
 * line would be deleted at once by the finished check, so none is posted and the existing one goes.
 */
export function checkIsFinalCheckRun(job: Pick<ScheduleRecord, 'spec'>): boolean {
  const { spec } = job;
  return spec.kind === 'once' || (typeof spec.remainingRuns === 'number' && spec.remainingRuns <= 1);
}

/**
 * @description The ONE gate that decides whether a topic shows status lines: a Telegram conversation (a tracker issue gets no
 * message, no comment, no edited note) whose view shows the agent's stream — the answers-only view shows nothing but answers.
 */
export function checkIsCheckStatusShown(input: { isTelegram: boolean; view: TopicView }): boolean {
  return input.isTelegram && checkIsStreamShown(input.view);
}

/**
 * @description One line of activity text: whitespace collapsed, cut to {@link checkStatusActivityMaxChars} with an ellipsis;
 * `null` when nothing readable is left. Shared by the log reader and the `statusCommand` output.
 */
export function formatCheckStatusActivity(text: string): string | null {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return null;
  return collapsed.length <= checkStatusActivityMaxChars ? collapsed : `${collapsed.slice(0, checkStatusActivityMaxChars - 1)}…`;
}

/**
 * @description The «now» of a `statusCommand`: the first non-empty line of its output, which is stdout and stderr together,
 * so a command that only complained has a «now» of its complaint — callers pass the output of a run that exited 0.
 */
export function getCheckStatusActivityFromOutput(output: string): string | null {
  const firstLine = output.split('\n').find((line) => line.trim() !== '');
  return firstLine === undefined ? null : formatCheckStatusActivity(firstLine);
}

/** @description «N min» under an hour, «H h M min» from an hour on (rounded to the nearest minute). */
export function getCheckStatusElapsedText(elapsedMs: number): string {
  const totalMinutes = Math.max(0, Math.round(elapsedMs / msPerMinute));
  if (totalMinutes < minutesPerHour) return t('schedule.statusElapsedMinutes', { minutes: totalMinutes });
  return t('schedule.statusElapsedHours', {
    hours: Math.floor(totalMinutes / minutesPerHour),
    minutes: totalMinutes % minutesPerHour,
  });
}

/**
 * @description The status line: `⏳ <name> · works <elapsed>[ · now: <activity>]`. The name is the check's own without the
 * recipe's leading `watch `; the «now» part is left out when there is nothing readable to say.
 */
export function buildCheckStatusLine(input: { name: string; elapsedMs: number; activity: string | null }): string {
  const shownName = input.name.replace(leadingWatchWordPattern, '').trim() || input.name;
  return t('schedule.statusLineText', {
    name: shownName,
    elapsed: getCheckStatusElapsedText(input.elapsedMs),
    activity: input.activity === null ? '' : t('schedule.statusLineActivity', { activity: input.activity }),
  });
}
