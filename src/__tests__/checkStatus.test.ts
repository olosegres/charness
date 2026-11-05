/**
 * @description Coverage for the pure decisions of a passing check's status line (`scheduler/checkStatus.ts`): when a line is
 * due (the slack that keeps a 5-minute cron at one line per 15 minutes, the first line counted from the check's creation), the
 * final-run rule, the ONE gate that decides whether a topic shows lines, and the line's text.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCheckStatusLine,
  checkIsCheckStatusDue,
  checkIsCheckStatusShown,
  checkIsFinalCheckRun,
  checkStatusActivityMaxChars,
  checkStatusSlackMs,
  defaultCheckStatusEveryMinutes,
  formatCheckStatusActivity,
  getCheckStatusActivityFromOutput,
  getCheckStatusIntervalMs,
  getCheckStatusSinceMs,
} from '../scheduler/checkStatus';
import { runWithLocale } from '../i18n';
import type { TopicView } from '../types';

const minuteMs = 60_000;
const fifteenMinutesMs = defaultCheckStatusEveryMinutes * minuteMs;
/** A cron tick lands a few seconds after the minute; the run that should post a line sees an interval less this. */
const tickJitterMs = 2_000;

test('the default interval is 15 minutes, a job’s own statusEveryMinutes replaces it', () => {
  assert.equal(getCheckStatusIntervalMs({}), fifteenMinutesMs);
  assert.equal(getCheckStatusIntervalMs({ statusEveryMinutes: 5 }), 5 * minuteMs);
});

test('due: a line comes an interval after the check was created, not at once', () => {
  const createdAtMs = Date.parse('2026-11-05T10:00:00.000Z');
  const sinceMs = getCheckStatusSinceMs({ createdAt: new Date(createdAtMs).toISOString() });
  assert.equal(sinceMs, createdAtMs, 'no line yet: counted from the creation');
  assert.equal(checkIsCheckStatusDue({ sinceMs, nowMs: createdAtMs + 5 * minuteMs, intervalMs: fifteenMinutesMs }), false);
  assert.equal(checkIsCheckStatusDue({ sinceMs, nowMs: createdAtMs + fifteenMinutesMs, intervalMs: fifteenMinutesMs }), true);
});

test('due: after the first line the next is counted from the last line', () => {
  const lastStatusAt = Date.parse('2026-11-05T10:15:00.000Z');
  const sinceMs = getCheckStatusSinceMs({ createdAt: '2026-11-05T10:00:00.000Z', lastStatusAt });
  assert.equal(sinceMs, lastStatusAt);
  assert.equal(checkIsCheckStatusDue({ sinceMs, nowMs: lastStatusAt + 10 * minuteMs, intervalMs: fifteenMinutesMs }), false);
  assert.equal(checkIsCheckStatusDue({ sinceMs, nowMs: lastStatusAt + fifteenMinutesMs, intervalMs: fifteenMinutesMs }), true);
});

test('due: the slack lets a 5-minute cron post every third tick, not every fourth', () => {
  // Ticks sit a little after the minute and the previous line was posted a little after ITS tick: at the third tick the gap is
  // 15 minutes less a couple of seconds, which only the slack counts as due.
  const lastStatusAt = 1_000_000_000_000;
  const thirdTickMs = lastStatusAt + fifteenMinutesMs - tickJitterMs;
  const secondTickMs = lastStatusAt + 10 * minuteMs - tickJitterMs;
  assert.equal(checkIsCheckStatusDue({ sinceMs: lastStatusAt, nowMs: secondTickMs, intervalMs: fifteenMinutesMs }), false);
  assert.equal(checkIsCheckStatusDue({ sinceMs: lastStatusAt, nowMs: thirdTickMs, intervalMs: fifteenMinutesMs }), true);
});

test('due: the slack is a minute at most, and a share of a short test interval — a 2-minute window is still a window', () => {
  const sinceMs = 1_000_000_000_000;
  const twoMinutesMs = 2 * minuteMs;
  // Production windows: exactly the one-minute slack.
  assert.equal(checkIsCheckStatusDue({ sinceMs, nowMs: sinceMs + fifteenMinutesMs - checkStatusSlackMs, intervalMs: fifteenMinutesMs }), true);
  assert.equal(checkIsCheckStatusDue({ sinceMs, nowMs: sinceMs + fifteenMinutesMs - checkStatusSlackMs - 1, intervalMs: fifteenMinutesMs }), false);
  // A short window: one minute after the last line is NOT due (a full minute of slack would make every run due).
  assert.equal(checkIsCheckStatusDue({ sinceMs, nowMs: sinceMs + minuteMs, intervalMs: twoMinutesMs }), false);
  assert.equal(checkIsCheckStatusDue({ sinceMs, nowMs: sinceMs + twoMinutesMs, intervalMs: twoMinutesMs }), true);
});

test('final run: a once job and the last run of an N-times cron, not a plain or longer cron', () => {
  assert.equal(checkIsFinalCheckRun({ spec: { kind: 'once', onceAtIso: '2026-11-05T10:00:00.000Z' } }), true);
  assert.equal(checkIsFinalCheckRun({ spec: { kind: 'cron', cronExpr: '*/5 * * * *', remainingRuns: 1 } }), true);
  assert.equal(checkIsFinalCheckRun({ spec: { kind: 'cron', cronExpr: '*/5 * * * *', remainingRuns: 2 } }), false);
  assert.equal(checkIsFinalCheckRun({ spec: { kind: 'cron', cronExpr: '*/5 * * * *' } }), false);
});

test('gate: the stream views of a Telegram conversation show lines; answers-only and a tracker conversation do not', () => {
  const shownByView: Array<[TopicView, boolean]> = [
    ['stream', true],
    ['streamAnswers', true],
    ['answers', false],
  ];
  for (const [view, isShown] of shownByView) {
    assert.equal(checkIsCheckStatusShown({ isTelegram: true, view }), isShown, `Telegram, view ${view}`);
    assert.equal(checkIsCheckStatusShown({ isTelegram: false, view }), false, `a tracker conversation, view ${view}`);
  }
});

test('activity text: whitespace collapsed, cut at the limit with an ellipsis, blank is nothing', () => {
  assert.equal(formatCheckStatusActivity('  Bash:\n  run   the\ttests  '), 'Bash: run the tests');
  assert.equal(formatCheckStatusActivity(' \n\t '), null);
  const exact = 'x'.repeat(checkStatusActivityMaxChars);
  assert.equal(formatCheckStatusActivity(exact), exact, 'a text of exactly the limit is kept whole');
  const cut = formatCheckStatusActivity('y'.repeat(checkStatusActivityMaxChars + 50));
  assert.equal(cut?.length, checkStatusActivityMaxChars);
  assert.ok(cut?.endsWith('…'));
});

test('statusCommand output: the first non-empty line is «now»', () => {
  assert.equal(getCheckStatusActivityFromOutput('\n\n  step 4 of 9: linking  \nsecond line\n'), 'step 4 of 9: linking');
  assert.equal(getCheckStatusActivityFromOutput(''), null);
  assert.equal(getCheckStatusActivityFromOutput('  \n \n'), null);
});

test('line text: name without the recipe’s leading «watch », elapsed under an hour, «now» part', () => {
  const line = runWithLocale('en', () => buildCheckStatusLine({ name: 'watch builder S2', elapsedMs: 30 * minuteMs, activity: 'Bash: Run the unit tests' }));
  assert.equal(line, '⏳ builder S2 · works 30 min · now: Bash: Run the unit tests');
});

test('line text: from an hour on the elapsed time is «H h M min»; minutes are rounded', () => {
  const hourAndHalf = runWithLocale('en', () => buildCheckStatusLine({ name: 'builder S2', elapsedMs: 105 * minuteMs, activity: null }));
  assert.equal(hourAndHalf, '⏳ builder S2 · works 1 h 45 min');
  const justUnderFifteen = runWithLocale('en', () => buildCheckStatusLine({ name: 'builder S2', elapsedMs: fifteenMinutesMs - tickJitterMs, activity: null }));
  assert.equal(justUnderFifteen, '⏳ builder S2 · works 15 min', 'a line posted at 14 min 58 s reads 15 min');
});

test('line text: no activity leaves the «now» part out; a name that is only «watch» stays as it is', () => {
  const withoutNow = runWithLocale('en', () => buildCheckStatusLine({ name: 'API health', elapsedMs: 45 * minuteMs, activity: null }));
  assert.equal(withoutNow, '⏳ API health · works 45 min');
  const onlyWatch = runWithLocale('en', () => buildCheckStatusLine({ name: 'watch', elapsedMs: 15 * minuteMs, activity: null }));
  assert.equal(onlyWatch, '⏳ watch · works 15 min');
  const notAPrefix = runWithLocale('en', () => buildCheckStatusLine({ name: 'watchdog db', elapsedMs: 15 * minuteMs, activity: null }));
  assert.equal(notAPrefix, '⏳ watchdog db · works 15 min', '«watchdog» is a name, not the prefix «watch »');
});

test('line text: another locale words every part through its own keys', () => {
  const line = runWithLocale('ru', () => buildCheckStatusLine({ name: 'watch builder S2', elapsedMs: 75 * minuteMs, activity: 'Edit: a.ts' }));
  assert.equal(line, '⏳ builder S2 · работает 1 ч 15 мин · сейчас: Edit: a.ts');
});
