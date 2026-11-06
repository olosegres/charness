import { t } from '../i18n';
import { formatLocalDateAndClock } from '../utils/localClock';
import { getReminderScheduleDescriptorText } from '../utils/reminderScheduleText';
import { getReminderScheduleDescriptor } from '../utils/reminderWizard';
import { getCronInterval, getNextRunAt } from './recurrence';
import type { ScheduleSpec } from './types';

/**
 * @description The schedule as the TOPIC says it, in the topic's language — never a raw cron expression, never a foreign
 * word in the middle of a sentence. The ladder, first fit wins:
 *  1. the wording a reminder shows for the shape (daily, weekdays, weekly, monthly, once) — the same words as its list row;
 *  2. a fixed step («every 5 min», «every 6 h at :00»);
 *  3. anything else (`0 9,18 * * *`): the NEXT RUN as a local date and time, which a person can use where the expression
 *     is a command line — or «the last run» when there is none.
 * An N-times budget rides along as a suffix on any of them. The agent-facing English text lives in `recurrence.ts`
 * (`describeSchedule`): the agent reads the expression, the topic reads this.
 */

/** Minute of an hour as the clock writes it: `:05`. */
const minuteDigits = 2;

/** The spec without its N-times budget: the budget is a suffix of the text, not a reason for the shape to read as raw. */
function getSpecWithoutBudget(spec: ScheduleSpec): ScheduleSpec {
  return spec.kind === 'cron' ? { kind: 'cron', cronExpr: spec.cronExpr } : spec;
}

/** @description What the spec fires on — the ladder above, without the budget. */
function getScheduleShapeText(spec: ScheduleSpec, nowMs: number): string {
  const descriptor = getReminderScheduleDescriptor(spec);
  if (descriptor.kind !== 'raw') return getReminderScheduleDescriptorText(descriptor);

  const interval = spec.kind === 'cron' ? getCronInterval(spec.cronExpr) : null;
  if (interval?.kind === 'minutes') return t('schedule.everyMinutes', { count: interval.step });
  if (interval?.kind === 'hours') {
    return t('schedule.everyHours', { count: interval.step, minute: interval.minute.toString().padStart(minuteDigits, '0') });
  }

  const nextRunAt = getNextRunAt(spec, nowMs);
  return nextRunAt === null ? t('schedule.lastRunText') : t('schedule.nextRunText', { time: formatLocalDateAndClock(nextRunAt) });
}

/**
 * @description The schedule of a fired job for its topic announcement; `nowMs` is the instant the next run is counted from
 * when nothing phrases the shape.
 */
export function getAnnouncedScheduleText(spec: ScheduleSpec, nowMs: number): string {
  const shapeText = getScheduleShapeText(getSpecWithoutBudget(spec), nowMs);
  const budgetText = spec.kind === 'cron' && spec.remainingRuns !== undefined ? t('schedule.runsLeftSuffix', { count: spec.remainingRuns }) : '';
  return `${shapeText}${budgetText}`;
}
