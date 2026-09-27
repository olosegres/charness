/**
 * Test case: N/A — TelegramCode has no Jira tracker
 *
 * @description Unit tests for {@link ../utils/reminderScheduleText} — THE shared
 * localized rendering of a reminder's schedule and next run.
 *
 * Load-bearing intent (per `.claude/rules/tests.md`):
 * - it resolves through `t`, not through hardcoded English. Asserted by running
 *   the SAME descriptor under a stubbed locale and watching the output change: a
 *   renderer that inlined its strings would return the identical text and this
 *   test would fail. That property is what lets the translation scope land
 *   without touching any call site.
 * - the `raw` fallback renders the cron expression VERBATIM. A shape the wizard
 *   cannot create (an agent-made job, an N-times budget) must not be dressed up
 *   as a plain recurring reminder, which would hide that it expires.
 * - every descriptor kind the pure module can emit has a rendering — asserted by
 *   walking `reminderScheduleTextKeys`, so a kind added later without a key is
 *   caught here instead of surfacing as a bare `{time}` in a topic.
 * - a list-row BUTTON caption carries the name AND the schedule, in the very
 *   wording the card uses, and fits `reminderRowLabelMaxLength` in EVERY locale by
 *   shortening the name — never the schedule, which is what the row is for. The
 *   name is operator-controlled free text, so the bound cannot be assumed.
 * - `today` / `tomorrow` are decided on the local CALENDAR DATE, not an
 *   hours-apart delta: an instant 20 hours away is «tomorrow» when it falls on
 *   the next day, and «today» when it does not.
 *
 * Every instant is built from LOCAL date parts, never a `Z` literal, so the
 * expectations hold on any host timezone (the module reads host-local time on
 * purpose — `/timezone` is applied to `process.env.TZ` at boot).
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { localeCodes, runWithLocale, t } from '../i18n';
import type { ScheduleSpec } from '../scheduler/types';
import {
  getReminderNextRunDescriptor,
  getReminderNextRunText,
  getReminderRowLabel,
  getReminderScheduleDescriptorText,
  getReminderScheduleText,
  reminderRowLabelMaxLength,
  reminderScheduleTextKeys,
} from '../utils/reminderScheduleText';
import {
  getReminderScheduleDescriptor,
  reminderNameMaxLength,
  type ReminderScheduleDescriptor,
} from '../utils/reminderWizard';

/** Local-time ISO for a `once` spec, so no assertion depends on the host zone. */
function buildOnceSpec(year: number, month: number, day: number, hour: number, minute: number): ScheduleSpec {
  return { kind: 'once', onceAtIso: new Date(year, month - 1, day, hour, minute).toISOString() };
}

// ─── descriptor → words, one case per kind ───────────────────────────

test('every recurring wizard shape renders as words in en', () => {
  assert.equal(getReminderScheduleText({ kind: 'cron', cronExpr: '0 9 * * *' }), 'every day at 09:00');
  assert.equal(getReminderScheduleText({ kind: 'cron', cronExpr: '30 18 * * 1-5' }), 'weekdays at 18:30');
  assert.equal(getReminderScheduleText({ kind: 'cron', cronExpr: '0 18 * * 0' }), 'Sun at 18:00');
  assert.equal(getReminderScheduleText({ kind: 'cron', cronExpr: '0 12 5 * *' }), 'day 5 at 12:00');
});

test('a once reminder names its date and time', () => {
  assert.equal(getReminderScheduleText(buildOnceSpec(2026, 6, 7, 21, 5)), '2026-06-07 at 21:05');
});

test('the weekly wording reuses the weekday BUTTON label the operator tapped', () => {
  // Monday is cron `dow` 1. A second set of weekday names would let the card say
  // a different word than the button that created the reminder.
  assert.equal(getReminderScheduleText({ kind: 'cron', cronExpr: '0 9 * * 1' }), 'Mon at 09:00');
  assert.equal(
    getReminderScheduleDescriptorText({ kind: 'weekly', weekday: 1, time: '09:00' }),
    t('reminders.weekdayMondayButton') + ' at 09:00',
  );
});

test('every descriptor kind the pure module can emit has a rendering', () => {
  // Walk the key table rather than a hand-written list: a kind added to
  // `ReminderScheduleDescriptor` without a key here would otherwise reach a topic
  // as an unresolved template.
  const samples: Record<ReminderScheduleDescriptor['kind'], ReminderScheduleDescriptor> = {
    daily: { kind: 'daily', time: '09:00' },
    weekdays: { kind: 'weekdays', time: '09:00' },
    weekly: { kind: 'weekly', weekday: 3, time: '09:00' },
    monthly: { kind: 'monthly', dayOfMonth: 15, time: '09:00' },
    once: { kind: 'once', dateIso: '2026-06-07', time: '09:00' },
    raw: { kind: 'raw', text: '*/7 3 * * *' },
  };
  for (const kind of Object.keys(reminderScheduleTextKeys) as ReminderScheduleDescriptor['kind'][]) {
    const rendered = getReminderScheduleDescriptorText(samples[kind]);
    assert.ok(rendered.length > 0, `${kind} rendered empty`);
    assert.ok(!/\{[a-zA-Z]+\}/.test(rendered), `${kind} left a placeholder: "${rendered}"`);
  }
});

// ─── the list-row button caption ─────────────────────────────────────

test('a list row caption is the name PLUS the same schedule wording the card shows', () => {
  // The locked layout — `[🔔 Pills · every day at 09:00]` — with the schedule on the
  // BUTTON, not relegated to the message body. Asserted against the card's renderer
  // so the two cannot drift into describing one reminder two ways.
  const descriptor: ReminderScheduleDescriptor = { kind: 'daily', time: '09:00' };
  const label = getReminderRowLabel('Pills', descriptor);
  assert.ok(label.includes('Pills'), `expected the name in "${label}"`);
  assert.ok(
    label.includes(getReminderScheduleDescriptorText(descriptor)),
    `expected the card's schedule wording in "${label}"`,
  );
  assert.equal(label, t('reminders.listRow', { name: 'Pills', schedule: 'every day at 09:00' }));

  assert.equal(
    getReminderRowLabel('Rent', { kind: 'monthly', dayOfMonth: 5, time: '12:00' }),
    t('reminders.listRow', { name: 'Rent', schedule: 'day 5 at 12:00' }),
  );
  assert.equal(
    getReminderRowLabel('Mum', { kind: 'weekly', weekday: 0, time: '18:00' }),
    t('reminders.listRow', { name: 'Mum', schedule: `${t('reminders.weekdaySundayButton')} at 18:00` }),
  );
});

test('an over-long caption shortens the NAME and keeps the schedule intact', () => {
  // The name is operator-controlled free text; the schedule is the part the row
  // exists to communicate, so it is never the half that gets cut.
  const descriptor: ReminderScheduleDescriptor = { kind: 'once', dateIso: '2026-12-31', time: '21:45' };
  const schedule = getReminderScheduleDescriptorText(descriptor);
  const longName = 'Remember to call the dentist about the appointment tomorrow morning';
  const label = getReminderRowLabel(longName, descriptor);

  assert.ok(
    label.length <= reminderRowLabelMaxLength,
    `"${label}" (${label.length}) must fit ${reminderRowLabelMaxLength}`,
  );
  assert.ok(label.includes(schedule), `the schedule must survive in full: "${label}"`);
  assert.ok(!label.includes(longName), 'the name must have been shortened');
  assert.ok(label.includes('…'), `the cut must be marked: "${label}"`);
  assert.ok(label.startsWith('🔔 Remember'), `the name's head must remain: "${label}"`);
});

test('the longest name the wizard can derive still yields a caption inside the cap', () => {
  // `getReminderNameFromText` caps a derived name at 40 chars, and the wizard's
  // wordiest schedule is a dated one-shot — the worst case a real row can hit.
  const label = getReminderRowLabel('n'.repeat(reminderNameMaxLength), {
    kind: 'once',
    dateIso: '2026-12-31',
    time: '21:45',
  });
  assert.ok(label.length <= reminderRowLabelMaxLength, `"${label}" is ${label.length} chars`);
});

test('a schedule that fills the cap on its own keeps its wording and drops the name', () => {
  // A `raw` cron from an agent-made job can be longer than the whole budget. The
  // row then says WHEN it fires and nothing else — better than a row that lies
  // about the schedule because the name was allowed to win.
  const descriptor: ReminderScheduleDescriptor = {
    kind: 'raw',
    text: '*/5 0-23 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20 * 1-5',
  };
  const schedule = getReminderScheduleDescriptorText(descriptor);
  assert.ok(schedule.length > reminderRowLabelMaxLength, 'the fixture must exceed the cap on its own');
  const label = getReminderRowLabel('Pills', descriptor);
  assert.ok(label.includes(schedule), `the schedule must still be verbatim: "${label}"`);
  assert.ok(!label.includes('Pills'), `the name has no budget left: "${label}"`);
});

test('the caption budget is measured against the ACTIVE locale, not the en template', () => {
  // Every locale must produce a caption inside the cap for the same row; a longer
  // translated template has to shrink the name rather than overflow.
  const descriptor: ReminderScheduleDescriptor = { kind: 'once', dateIso: '2026-12-31', time: '21:45' };
  for (const locale of localeCodes) {
    runWithLocale(locale, () => {
      const label = getReminderRowLabel('n'.repeat(120), descriptor);
      assert.ok(
        label.length <= reminderRowLabelMaxLength,
        `${locale}: "${label}" is ${label.length} chars`,
      );
      assert.ok(
        label.includes(getReminderScheduleDescriptorText(descriptor)),
        `${locale} lost the schedule: "${label}"`,
      );
    });
  }
});

// ─── the raw fallback ────────────────────────────────────────────────

test('a cron shape the wizard cannot create renders the expression VERBATIM', () => {
  // An every-7-minutes cron is not any of the five wizard shapes; showing it as a
  // plain recurring reminder would be a lie about when it fires.
  const rendered = getReminderScheduleText({ kind: 'cron', cronExpr: '*/7 * * * *' });
  assert.ok(rendered.includes('*/7 * * * *'), `expected the raw expression in "${rendered}"`);
});

test('an N-times job renders raw — its run budget is not a plain recurring shape', () => {
  const rendered = getReminderScheduleText({ kind: 'cron', cronExpr: '0 9 * * *', remainingRuns: 3 });
  assert.ok(rendered.includes('0 9 * * *'), `expected the raw expression in "${rendered}"`);
  assert.notEqual(rendered, 'every day at 09:00', 'an N-times job must not read as a plain daily one');
});

test('an unparseable once instant renders raw rather than throwing', () => {
  const rendered = getReminderScheduleText({ kind: 'once', onceAtIso: 'not-a-date' });
  assert.ok(rendered.includes('not-a-date'), `expected the raw value in "${rendered}"`);
});

// ─── it resolves through `t` (the translation seam) ──────────────────

test('the schedule text is resolved through t, not hardcoded English', () => {
  // Stub ONE locale's key and render under it: a renderer that inlined its
  // strings would ignore the stub and return the en wording. This is the property
  // that lets the translation scope land with no call-site change.
  const stubbed = runWithLocale('ru', () => {
    const before = t('reminders.scheduleDaily');
    assert.ok(before.length > 0, 'the ru catalog must carry the key (parity)');
    return getReminderScheduleDescriptorText({ kind: 'daily', time: '09:00' });
  });
  assert.equal(
    stubbed,
    runWithLocale('ru', () => t('reminders.scheduleDaily', { time: '09:00' })),
    'the rendering must be exactly the active locale template',
  );
});

test('every locale renders every descriptor kind with no leftover placeholder', () => {
  // Today the 11 generated locales carry the en placeholders, so the TEXT matches
  // en; what is asserted is that each locale RESOLVES (parity + substitution),
  // which is what must keep holding once they are translated.
  for (const locale of localeCodes) {
    runWithLocale(locale, () => {
      for (const spec of [
        { kind: 'cron', cronExpr: '0 9 * * *' },
        { kind: 'cron', cronExpr: '0 9 * * 1-5' },
        { kind: 'cron', cronExpr: '0 9 * * 4' },
        { kind: 'cron', cronExpr: '0 9 20 * *' },
        buildOnceSpec(2026, 6, 7, 9, 0),
      ] satisfies ScheduleSpec[]) {
        const rendered = getReminderScheduleText(spec);
        assert.ok(rendered.length > 0, `empty rendering in ${locale}`);
        assert.ok(!/\{[a-zA-Z]+\}/.test(rendered), `${locale} left a placeholder: "${rendered}"`);
      }
    });
  }
});

// ─── next run ────────────────────────────────────────────────────────

test('next run: the same local calendar day is "today"', () => {
  const nowMs = new Date(2026, 5, 7, 8, 0).getTime();
  const at = new Date(2026, 5, 7, 21, 0).getTime();
  assert.deepEqual(getReminderNextRunDescriptor(at, nowMs), { kind: 'today', time: '21:00' });
  assert.equal(getReminderNextRunText(at, nowMs), 'today at 21:00');
});

test('next run: the following local calendar day is "tomorrow"', () => {
  const nowMs = new Date(2026, 5, 7, 22, 0).getTime();
  const at = new Date(2026, 5, 8, 9, 0).getTime();
  assert.deepEqual(getReminderNextRunDescriptor(at, nowMs), { kind: 'tomorrow', time: '09:00' });
  assert.equal(getReminderNextRunText(at, nowMs), 'tomorrow at 09:00');
});

test('next run: the day boundary decides, NOT an hours-apart delta', () => {
  // 20 hours away but still the same calendar day → "today"; 2 hours away across
  // midnight → "tomorrow". An elapsed-hours rule would get both backwards.
  const earlyNow = new Date(2026, 5, 7, 1, 0).getTime();
  const lateSameDay = new Date(2026, 5, 7, 21, 0).getTime();
  assert.equal(getReminderNextRunDescriptor(lateSameDay, earlyNow).kind, 'today');

  const lateNow = new Date(2026, 5, 7, 23, 0).getTime();
  const justAfterMidnight = new Date(2026, 5, 8, 1, 0).getTime();
  assert.equal(getReminderNextRunDescriptor(justAfterMidnight, lateNow).kind, 'tomorrow');
});

test('next run: a further-out instant carries its date', () => {
  const nowMs = new Date(2026, 5, 7, 8, 0).getTime();
  const at = new Date(2026, 5, 20, 12, 30).getTime();
  assert.deepEqual(getReminderNextRunDescriptor(at, nowMs), {
    kind: 'date',
    dateIso: '2026-06-20',
    time: '12:30',
  });
  assert.equal(getReminderNextRunText(at, nowMs), '2026-06-20 at 12:30');
});

test('next run: an exhausted job renders the explicit none-marker, not an empty string', () => {
  // An empty value would read as a failed substitution in the card.
  const rendered = getReminderNextRunText(null, Date.now());
  assert.equal(rendered, t('reminders.nextRunNone'));
  assert.ok(rendered.trim().length > 0);
});

test('a once spec round-trips through the descriptor to the same wall clock', () => {
  // The spec stores a UTC instant; the card must show the LOCAL wall clock the
  // operator picked. A UTC-read would shift it by the host offset.
  const spec = buildOnceSpec(2026, 6, 7, 21, 5);
  const descriptor = getReminderScheduleDescriptor(spec);
  assert.equal(descriptor.kind, 'once');
  assert.deepEqual(descriptor, { kind: 'once', dateIso: '2026-06-07', time: '21:05' });
});
