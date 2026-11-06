/**
 * @description Coverage for `scheduler/scheduleText.ts`: the schedule as the TOPIC says it. The ladder is checked rung by rung
 * and in another language, with the two things the owner asked to never see: a raw cron expression and English inside a
 * localized sentence.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAnnouncedScheduleText } from '../scheduler/scheduleText';
import { getNextRunAt } from '../scheduler/recurrence';
import { getReminderScheduleText } from '../utils/reminderScheduleText';
import { formatLocalDateAndClock } from '../utils/localClock';
import { localeCodes, runWithLocale, t } from '../i18n';
import type { ScheduleSpec } from '../scheduler/types';

/** A fixed local instant: a next run is counted from it. */
const nowMs = new Date(2026, 5, 6, 10, 0, 0).getTime();

/** The next run of `spec` after {@link nowMs}, as the text writes it. */
function getExpectedNext(spec: ScheduleSpec): string {
  const nextRunAt = getNextRunAt(spec, nowMs);
  assert.ok(nextRunAt !== null);
  return formatLocalDateAndClock(nextRunAt);
}

test('a shape a reminder can say is said in the reminder\'s words, in the topic\'s language', () => {
  const daily: ScheduleSpec = { kind: 'cron', cronExpr: '0 9 * * *' };
  assert.equal(getAnnouncedScheduleText(daily, nowMs), getReminderScheduleText(daily));
  assert.equal(getAnnouncedScheduleText(daily, nowMs), 'every day at 09:00');
  const russian = runWithLocale('ru', () => getAnnouncedScheduleText(daily, nowMs));
  assert.equal(russian, runWithLocale('ru', () => getReminderScheduleText(daily)));
  assert.notEqual(russian, 'every day at 09:00');
});

test('a fixed step is said as a step, in the topic\'s language — minutes, and hours at a minute', () => {
  assert.equal(getAnnouncedScheduleText({ kind: 'cron', cronExpr: '*/5 * * * *' }, nowMs), 'every 5 min');
  assert.equal(getAnnouncedScheduleText({ kind: 'cron', cronExpr: '5 */6 * * *' }, nowMs), 'every 6 h at :05');
  assert.equal(runWithLocale('ru', () => getAnnouncedScheduleText({ kind: 'cron', cronExpr: '*/5 * * * *' }, nowMs)), 'каждые 5 мин');
  assert.equal(runWithLocale('de', () => getAnnouncedScheduleText({ kind: 'cron', cronExpr: '0 */2 * * *' }, nowMs)), 'alle 2 Std., bei :00');
});

test('a shape nothing phrases is its NEXT RUN as a local date and time — never the cron expression', () => {
  for (const cronExpr of ['0 9,18 * * *', '*/30 9-18 * * 1-5', '*/40 * * * *', '0 */7 * * *']) {
    const spec: ScheduleSpec = { kind: 'cron', cronExpr };
    const text = getAnnouncedScheduleText(spec, nowMs);
    assert.equal(text, `next: ${getExpectedNext(spec)}`, cronExpr);
    assert.ok(!text.includes('*') && !/cron/i.test(text), `no expression in "${text}"`);
  }
  assert.equal(
    runWithLocale('ru', () => getAnnouncedScheduleText({ kind: 'cron', cronExpr: '0 9,18 * * *' }, nowMs)),
    `следующий: ${getExpectedNext({ kind: 'cron', cronExpr: '0 9,18 * * *' })}`,
  );
});

test('an N-times budget rides along as a localized suffix on any rung — and does not turn a phrased shape into a raw one', () => {
  const mondays: ScheduleSpec = { kind: 'cron', cronExpr: '0 9 * * 1' };
  assert.equal(
    getAnnouncedScheduleText({ ...mondays, remainingRuns: 3 }, nowMs),
    `${getReminderScheduleText(mondays)} · runs left: 3`,
    'the budget does not turn a weekly job into a bare cron',
  );
  assert.equal(getAnnouncedScheduleText({ kind: 'cron', cronExpr: '*/5 * * * *', remainingRuns: 2 }, nowMs), 'every 5 min · runs left: 2');
  assert.equal(
    runWithLocale('ru', () => getAnnouncedScheduleText({ kind: 'cron', cronExpr: '*/5 * * * *', remainingRuns: 2 }, nowMs)),
    'каждые 5 мин · осталось запусков: 2',
  );
  const irregular: ScheduleSpec = { kind: 'cron', cronExpr: '0 9,18 * * *', remainingRuns: 4 };
  assert.equal(getAnnouncedScheduleText(irregular, nowMs), `next: ${getExpectedNext({ kind: 'cron', cronExpr: '0 9,18 * * *' })} · runs left: 4`);
});

test('a one-shot is its date and time; one that cannot be read, or has no run left, says it is the last', () => {
  const once: ScheduleSpec = { kind: 'once', onceAtIso: new Date(2026, 5, 7, 9, 30, 0).toISOString() };
  assert.equal(getAnnouncedScheduleText(once, nowMs), getReminderScheduleText(once));
  assert.match(getAnnouncedScheduleText(once, nowMs), /2026-06-07/);
  assert.equal(getAnnouncedScheduleText({ kind: 'once', onceAtIso: 'not a date' }, nowMs), 'the last run');
});

test('every locale has every word of the ladder, with its placeholders', () => {
  for (const locale of localeCodes) {
    runWithLocale(locale, () => {
      assert.ok(t('schedule.everyMinutes', { count: 5 }).includes('5'), `${locale} everyMinutes`);
      const hours = t('schedule.everyHours', { count: 6, minute: '05' });
      assert.ok(hours.includes('6') && hours.includes('05'), `${locale} everyHours: ${hours}`);
      assert.ok(t('schedule.runsLeftSuffix', { count: 3 }).includes('3'), `${locale} runsLeftSuffix`);
      assert.ok(t('schedule.nextRunText', { time: 'T1' }).includes('T1'), `${locale} nextRunText`);
      assert.ok(t('schedule.lastRunText').length > 0 && !t('schedule.lastRunText').includes('{'), `${locale} lastRunText`);
      for (const text of [t('schedule.everyMinutes', { count: 5 }), hours, t('schedule.nextRunText', { time: 'T1' })]) {
        assert.ok(!/[{}]/.test(text), `${locale}: placeholders not substituted in "${text}"`);
      }
    });
  }
});
