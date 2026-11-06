import { Cron } from 'croner';
import type { ScheduleSpec } from './types';

/**
 * @description Pure recurrence math for the scheduler (no I/O, no `Date.now()`
 * inside — every entry point takes the caller's `nowMs`/`fromMs` so the logic
 * is fully deterministic and testable). All computation is host-local time
 * (croner's default), matching the single-host bot.
 */

/**
 * Minimum allowed gap between two consecutive fires of a cron job (5 min). A
 * tighter cron would let one topic burn through the chat-wide 20-msg/min send
 * budget with announcements; `validateScheduleSpec` rejects anything below it.
 */
export const minFireIntervalMs = 5 * 60 * 1000;

/** The gap in force: {@link minFireIntervalMs}, or a test instance's shorter one ({@link registerMinFireIntervalMs}). */
let effectiveMinFireIntervalMs = minFireIntervalMs;

/**
 * @description Register a test instance's shorter minimum gap (`CHARNESS_TEST_TIMINGS` `scheduleMinFireIntervalMs`), so a
 * flow can fire a check every minute instead of waiting five. Never called in production.
 */
export function registerMinFireIntervalMs(intervalMs: number): void {
  effectiveMinFireIntervalMs = intervalMs;
}

/**
 * Tolerance for classifying a fire as "on time" vs a catch-up. A timer can fire
 * a few ms early/late and a boot replay computes `nowMs` slightly after the due
 * instant; within this window we treat the run as on-time, beyond it as a
 * missed run that needs the catch-up annotation.
 */
export const catchUpToleranceMs = 30 * 1000;

/** How many consecutive runs we sample to measure a cron's minimal gap. */
const minIntervalSampleCount = 5;

// Field periods used to verify a cron step-of-N divides evenly (truthful "every N" wording).
const minutesPerHour = 60;
const hoursPerDay = 24;

/**
 * @description Build a croner `Cron` for a spec. Returns `null` (instead of
 * throwing) when the cron string is unparseable, so callers can produce a
 * readable message. `once` specs build a `Cron` from the absolute Date.
 */
function createCron(spec: ScheduleSpec): Cron | null {
  try {
    if (spec.kind === 'once') {
      const at = new Date(spec.onceAtIso);
      if (Number.isNaN(at.getTime())) return null;
      return new Cron(at);
    }
    return new Cron(spec.cronExpr);
  } catch {
    return null;
  }
}

/**
 * @description Validate a schedule spec. Returns a readable error string, or
 * `null` when the spec is valid.
 *
 * Rejections:
 *  - cron string croner can't parse → the parse error message.
 *  - cron firing more often than {@link minFireIntervalMs} (e.g. `* * * * *`)
 *    → measured by sampling consecutive `nextRuns` and checking the min gap.
 *  - `once` whose instant is unparseable or already in the past.
 */
export function validateScheduleSpec(spec: ScheduleSpec, nowMs: number): string | null {
  if (spec.kind === 'once') {
    const at = new Date(spec.onceAtIso);
    if (Number.isNaN(at.getTime())) {
      return `Invalid one-shot time: "${spec.onceAtIso}" is not a valid ISO date`;
    }
    if (at.getTime() <= nowMs) {
      return 'One-shot time is in the past';
    }
    return null;
  }

  if (typeof spec.remainingRuns === 'number' && spec.remainingRuns <= 0) {
    return 'remainingRuns must be a positive number';
  }

  const cron = createCron(spec);
  if (!cron) {
    return `Invalid cron expression: "${spec.cronExpr}"`;
  }

  const from = new Date(nowMs);
  const runs = cron.nextRuns(minIntervalSampleCount, from);
  if (runs.length < 2) {
    // Fewer than two future runs means the cron is effectively a one-shot
    // (e.g. a fixed year) — no recurrence-frequency concern, accept it.
    return null;
  }
  let minGapMs = Number.POSITIVE_INFINITY;
  for (let i = 1; i < runs.length; i += 1) {
    const gap = runs[i].getTime() - runs[i - 1].getTime();
    if (gap < minGapMs) minGapMs = gap;
  }
  if (minGapMs < effectiveMinFireIntervalMs) {
    const minMinutes = Math.round(effectiveMinFireIntervalMs / 60000);
    return `Cron fires too often (min gap ${Math.round(minGapMs / 1000)}s); minimum allowed interval is ${minMinutes} min`;
  }
  return null;
}

/**
 * @description Epoch ms of the next occurrence strictly after `fromMs`, or
 * `null` when there is none (a `once` already past, or an exhausted cron).
 * croner's `nextRun(fromDate)` is strictly-after, so a fire exactly at the due
 * instant correctly advances to the following occurrence.
 */
export function getNextRunAt(spec: ScheduleSpec, fromMs: number): number | null {
  const cron = createCron(spec);
  if (!cron) return null;
  const next = cron.nextRun(new Date(fromMs));
  return next ? next.getTime() : null;
}

/**
 * @description Whether the run that is firing NOW is the last the job will ever make: a one-shot, or an N-times cron on its final
 * run. `remainingRuns` counts the runs still to come INCLUDING the current one — the engine decrements it only after the
 * delivery — so `1` is the last. One source for everything that must not promise a later run (the status line of a finished
 * check, the next run in a fire announcement).
 */
export function checkIsFinalRun(spec: ScheduleSpec): boolean {
  return spec.kind === 'once' || (typeof spec.remainingRuns === 'number' && spec.remainingRuns <= 1);
}

/**
 * @description Whether a fire is on time or a catch-up, used both by timer
 * fires and by boot replay. Returns `null` when there is nothing to fire.
 *
 *  - `nextRunAt === null`            → `null` (exhausted; nothing to do).
 *  - `nowMs - nextRunAt > tolerance` → `'fire-missed'` (a run was missed,
 *    e.g. the bot was down — fire once, annotated).
 *  - otherwise                       → `'on-time'`.
 */
export function getCatchUpDecision(args: {
  nextRunAt: number | null;
  nowMs: number;
}): 'fire-missed' | 'on-time' | null {
  const { nextRunAt, nowMs } = args;
  if (nextRunAt === null) return null;
  if (nowMs - nextRunAt > catchUpToleranceMs) return 'fire-missed';
  return 'on-time';
}

// ─── human description ───────────────────────────────────────────────

const weekdayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Pad a number to two digits (`9` → `"09"`) for HH:MM rendering. */
function padTwo(value: number): string {
  return value.toString().padStart(2, '0');
}

/**
 * @name CronInterval
 * @description A cron that fires on a fixed step: every `step` minutes, or every `step` hours at minute `minute`.
 */
export type CronInterval = { kind: 'minutes'; step: number } | { kind: 'hours'; step: number; minute: number };

/**
 * @description The fixed-step shape of a cron (`*​/N * * * *`, `m *​/N * * *`), or `null` for any other. "Every N" is only
 * truthful when the step divides the field's period — `*​/40 * * * *` actually fires at :00 and :40 (gaps 40m/20m
 * alternating, the step resets each hour) — so a non-divisor step is no interval, and callers fall back instead of lying.
 * The one source of the shape for the English description below and the localized one in the topic (`scheduleText.ts`).
 */
export function getCronInterval(cronExpr: string): CronInterval | null {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (dayOfMonth !== '*' || month !== '*' || dayOfWeek !== '*') return null;

  const everyMinuteMatch = minute.match(/^\*\/(\d+)$/);
  if (everyMinuteMatch && hour === '*') {
    const stepMinutes = Number(everyMinuteMatch[1]);
    return minutesPerHour % stepMinutes === 0 ? { kind: 'minutes', step: stepMinutes } : null;
  }

  const everyHourMatch = hour.match(/^\*\/(\d+)$/);
  if (everyHourMatch && /^\d+$/.test(minute)) {
    const stepHours = Number(everyHourMatch[1]);
    return hoursPerDay % stepHours === 0 ? { kind: 'hours', step: stepHours, minute: Number(minute) } : null;
  }
  return null;
}

/**
 * @description Try to render a recognised cron shape as short English text.
 * Returns `null` for shapes we don't special-case, so {@link describeSchedule}
 * can fall back to the raw cron string.
 *
 * Recognised shapes (5-field `min hour dom mon dow`):
 *  - daily at HH:MM            (`m h * * *`)
 *  - every Nh at :MM           (`m  *​/N * * *`)
 *  - every Nm                  (`*​/N * * * *`)
 *  - weekly on <weekday> HH:MM (`m h * * d`, single dow)
 *  - weekdays at HH:MM         (`m h * * 1-5`)
 *  - monthly on day D at HH:MM (`m h D * *`, single dom)
 */
function describeCron(cronExpr: string): string | null {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;

  const interval = getCronInterval(cronExpr);
  if (interval) {
    return interval.kind === 'minutes' ? `every ${interval.step}m` : `every ${interval.step}h at :${padTwo(interval.minute)}`;
  }

  // The remaining shapes all need fixed minute + hour.
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return null;
  const atTime = `${padTwo(Number(hour))}:${padTwo(Number(minute))}`;

  if (month === '*') {
    if (dayOfMonth === '*') {
      if (dayOfWeek === '*') return `daily at ${atTime}`;
      if (dayOfWeek === '1-5') return `weekdays at ${atTime}`;
      if (/^[0-6]$/.test(dayOfWeek)) return `weekly on ${weekdayNames[Number(dayOfWeek)]} at ${atTime}`;
      return null;
    }
    if (dayOfWeek === '*' && /^\d+$/.test(dayOfMonth)) {
      return `monthly on day ${dayOfMonth} at ${atTime}`;
    }
  }
  return null;
}

/** ISO `2026-06-07T09:00:00.000Z` → `2026-06-07 09:00` (host-local). */
function describeOnce(onceAtIso: string): string {
  const at = new Date(onceAtIso);
  if (Number.isNaN(at.getTime())) return `once at ${onceAtIso}`;
  const datePart = `${at.getFullYear()}-${padTwo(at.getMonth() + 1)}-${padTwo(at.getDate())}`;
  const timePart = `${padTwo(at.getHours())}:${padTwo(at.getMinutes())}`;
  return `once at ${datePart} ${timePart}`;
}

/** @description `base` with the N-times budget of a cron appended: `daily at 09:00 (3 runs left)`. */
function withRunsLeft(base: string, spec: ScheduleSpec): string {
  return spec.kind === 'cron' && typeof spec.remainingRuns === 'number' ? `${base} (${spec.remainingRuns} runs left)` : base;
}

/**
 * @description Short human description of a spec in English when a plain wording exists for it, else `null` — a cron shape
 * nothing phrases (`0 9,18 * * *`). For a text that names the schedule to a person, where a bare cron expression is a
 * command line and the caller shows the next run instead; {@link describeSchedule} is the one that never gives up.
 */
export function describePhrasedSchedule(spec: ScheduleSpec): string | null {
  if (spec.kind === 'once') return describeOnce(spec.onceAtIso);
  const base = describeCron(spec.cronExpr);
  return base === null ? null : withRunsLeft(base, spec);
}

/**
 * @description Short human description of a spec, English (it lands inside
 * announcements that are i18n'd around it). Unrecognised cron shapes fall back
 * to the raw cron string; N-times jobs append the remaining-runs count.
 */
export function describeSchedule(spec: ScheduleSpec): string {
  if (spec.kind === 'once') return describeOnce(spec.onceAtIso);
  return describePhrasedSchedule(spec) ?? withRunsLeft(`cron ${spec.cronExpr}`, spec);
}
