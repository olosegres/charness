/**
 * Test case: N/A — Charness has no Jira tracker
 *
 * @description Unit tests for {@link ../utils/reminderWizard} — the pure core of
 * the `/reminders` button wizard: step transitions, the stale-tap guard, the
 * INDEX/token callback codec, cron+once spec assembly, the localizable schedule
 * descriptor, the list/card plans, and name derivation.
 *
 * Load-bearing intent (per `.claude/rules/tests.md`):
 * - EVERY callback id the wizard, list, card and delete button can emit fits
 *   Telegram's 64-BYTE `callback_data` cap — asserted with the longest wizard id
 *   the codec accepts and the longest schedule id `generateScheduleId` can mint.
 *   An over-long id is rejected by Telegram, so the whole screen goes dead.
 * - EVERY spec the wizard can produce is accepted by `validateScheduleSpec` and
 *   rendered as WORDS by `describeSchedule` (never a raw `cron …` fallback).
 *   That is the reason the wizard offers exactly these five repeat kinds, and
 *   nothing in this module states it — only this test does.
 * - a stale tap (a callback carrying another wizard's id, or one belonging to a
 *   step this wizard has left) changes NOTHING. Inline keyboards stay tappable
 *   forever, so without this an abandoned wizard feeds picks into the live one.
 * - «today» plus a time that has already passed is an ERROR, never a silent roll
 *   to tomorrow — a silent roll reminds the operator 24h off what they asked for,
 *   and the mistake is invisible until the reminder fails to arrive. The guard sits
 *   in `buildReminderSpec`, so «tomorrow» and grid dates get the same refusal.
 * - the reminder text is typed EXACTLY ONCE. When the picked instant goes stale
 *   while the operator types, the wizard re-asks the TIME alone and the next pick
 *   creates from the retained text (`createNow`, never a second `awaitText`). Every
 *   other pick — `back`, a repeat change — keeps that text too. The whole flow is
 *   buttons for this reason, so losing the text is a design failure, not a nuisance.
 * - `back` RESETS the pick owned by the step it lands on, so re-entering a screen
 *   never keeps the value the operator came to change.
 * - a wall-clock time a DST spring-forward SKIPS is reported as a TIME problem and
 *   lands the operator on the time step. Reporting it as an invalid date (the one
 *   code both causes used to share) sent them to re-pick a day that was never the
 *   problem, and the whole skipped hour would have failed again. The host zone has
 *   no DST, so this can only be covered by pinning a zone that does.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { describeSchedule, validateScheduleSpec } from '../scheduler/recurrence';
import type { ScheduleSpec } from '../scheduler/types';
import { checkIsCallbackDataWithinLimit } from '../utils/modelPickerPlan';
import {
  applyReminderWizardCallback,
  buildReminderCardCallback,
  buildReminderCardPlan,
  buildReminderDateCallback,
  buildReminderDateGridCallback,
  buildReminderDayOfMonthCallback,
  buildReminderDayOfMonthGridCallback,
  buildReminderDeleteCallback,
  buildReminderHourCallback,
  buildReminderHourGridCallback,
  buildReminderHubKeyboard,
  buildReminderListPageCallback,
  buildReminderListPlan,
  buildReminderMinuteCallback,
  buildReminderQuickTimeCallback,
  buildReminderRepeatCallback,
  buildReminderSpec,
  buildReminderStepKeyboard,
  buildReminderWeekdayCallback,
  buildReminderBackCallback,
  buildReminderCancelCallback,
  checkIsReminderRepeatKind,
  createReminderInstant,
  createReminderWizardId,
  createReminderWizardState,
  formatReminderDateIso,
  getLocalDateAtDayOffset,
  getReminderActionAfterTime,
  getReminderCardBackPage,
  getReminderDeleteTarget,
  getReminderNameFromText,
  getReminderPicksFromState,
  getReminderPreviousStep,
  getReminderRowAt,
  getReminderScheduleDescriptor,
  getReminderStateForRetime,
  getReminderStepAfterRepeat,
  getShortenedText,
  parseReminderCardCallback,
  parseReminderDeleteCallback,
  parseReminderListPageCallback,
  parseReminderWizardCallback,
  reminderAddCallback,
  reminderCloseCallback,
  reminderHubCallback,
  reminderListPageSize,
  reminderMinuteStep,
  reminderNameFallback,
  reminderNameMaxLength,
  reminderQuickTimes,
  reminderRepeatKinds,
  reminderWeekdayDisplayOrder,
  reminderWizardCallbackRe,
  reminderWizardIdMaxLength,
  reminderLabelKeys,
  reminderWeekdayLabelKeys,
  type ReminderButtonPlan,
  type ReminderKeyboardPlan,
  type ReminderListRow,
  type ReminderSchedulePicks,
  type ReminderWizardState,
  type ReminderWizardStep,
  type ReminderWizardTransition,
} from '../utils/reminderWizard';

const wizardId = 'w7k2';
/** The longest id the codec accepts — the real `callback_data` budget check. */
const longestWizardId = 'Zz9Zz9Zz9Zz9';

/** Fixed local instant: 2026-09-26 12:00 host-local (TZ-agnostic by construction). */
const nowMs = new Date(2026, 8, 26, 12, 0, 0, 0).getTime();

function createStateAt(
  step: ReminderWizardStep,
  overrides: Partial<ReminderWizardState> = {},
): ReminderWizardState {
  return { ...createReminderWizardState(wizardId), step, ...overrides };
}

/** The state a transition carries, failing loudly on a terminal/expired result. */
function getTransitionState(transition: ReminderWizardTransition): ReminderWizardState {
  if (transition.kind !== 'render' && transition.kind !== 'awaitText' && transition.kind !== 'error') {
    assert.fail(`expected a state-carrying transition, got "${transition.kind}"`);
  }
  return transition.state;
}

function applyTap(state: ReminderWizardState, callbackData: string): ReminderWizardTransition {
  return applyReminderWizardCallback({ state, callbackData, nowMs });
}

function getKeyboardButtons(keyboard: ReminderKeyboardPlan): ReminderButtonPlan[] {
  return keyboard.flat();
}

function getCallbackDataList(keyboard: ReminderKeyboardPlan): string[] {
  return getKeyboardButtons(keyboard).map((button) => button.callbackData);
}

// ─── vocabularies ────────────────────────────────────────────────────

test('the repeat vocabulary is the locked five options, in the locked order', () => {
  assert.deepEqual([...reminderRepeatKinds], ['once', 'daily', 'weekdays', 'weekly', 'monthly']);
  assert.ok(checkIsReminderRepeatKind('weekdays'));
  assert.equal(checkIsReminderRepeatKind('yearly'), false);
});

test('wizard ids: minted from the caller clock and carried intact by the codec', () => {
  const mintedId = createReminderWizardId(nowMs);
  assert.ok(mintedId.length <= reminderWizardIdMaxLength);
  // The codec is the id's only consumer, so "usable" means it round-trips through a
  // real callback — that is the property the stale-tap guard actually depends on.
  assert.deepEqual(parseReminderWizardCallback(buildReminderBackCallback(mintedId)), {
    wizardId: mintedId,
    action: { kind: 'back' },
  });
  // Monotonic: a wizard opened later can never collide with the one it replaced.
  assert.notEqual(createReminderWizardId(nowMs + 1000), mintedId);

  // An id the wire format cannot carry (`_` is the field separator, and the length
  // is bounded so the anchored matcher can never accept garbage) is refused at parse
  // time — where refusing it matters.
  for (const unusableId of ['has_underscore', 'a'.repeat(reminderWizardIdMaxLength + 1), '']) {
    assert.equal(
      parseReminderWizardCallback(buildReminderBackCallback(unusableId)),
      null,
      `expected the codec to refuse wizard id "${unusableId}"`,
    );
  }
});

// ─── callback codec ──────────────────────────────────────────────────

test('the codec round-trips every wizard action', () => {
  assert.deepEqual(parseReminderWizardCallback(buildReminderRepeatCallback(wizardId, 'monthly')), {
    wizardId,
    action: { kind: 'pickRepeat', repeatKind: 'monthly' },
  });
  assert.deepEqual(parseReminderWizardCallback(buildReminderDateGridCallback(wizardId)), {
    wizardId,
    action: { kind: 'openDateGrid' },
  });
  assert.deepEqual(parseReminderWizardCallback(buildReminderDateCallback(wizardId, '2026-09-26')), {
    wizardId,
    action: { kind: 'pickDate', dateIso: '2026-09-26' },
  });
  assert.deepEqual(parseReminderWizardCallback(buildReminderWeekdayCallback(wizardId, 0)), {
    wizardId,
    action: { kind: 'pickWeekday', weekday: 0 },
  });
  assert.deepEqual(parseReminderWizardCallback(buildReminderDayOfMonthGridCallback(wizardId)), {
    wizardId,
    action: { kind: 'openDayOfMonthGrid' },
  });
  assert.deepEqual(parseReminderWizardCallback(buildReminderDayOfMonthCallback(wizardId, 31)), {
    wizardId,
    action: { kind: 'pickDayOfMonth', dayOfMonth: 31 },
  });
  assert.deepEqual(parseReminderWizardCallback(buildReminderQuickTimeCallback(wizardId, 3)), {
    wizardId,
    action: { kind: 'pickQuickTime', hour: reminderQuickTimes[3].hour, minute: reminderQuickTimes[3].minute },
  });
  assert.deepEqual(parseReminderWizardCallback(buildReminderHourGridCallback(wizardId)), {
    wizardId,
    action: { kind: 'openHourGrid' },
  });
  assert.deepEqual(parseReminderWizardCallback(buildReminderHourCallback(wizardId, 21)), {
    wizardId,
    action: { kind: 'pickHour', hour: 21 },
  });
  assert.deepEqual(parseReminderWizardCallback(buildReminderMinuteCallback(wizardId, 55)), {
    wizardId,
    action: { kind: 'pickMinute', minute: 55 },
  });
  assert.deepEqual(parseReminderWizardCallback(buildReminderBackCallback(wizardId)), {
    wizardId,
    action: { kind: 'back' },
  });
  assert.deepEqual(parseReminderWizardCallback(buildReminderCancelCallback(wizardId)), {
    wizardId,
    action: { kind: 'cancel' },
  });
});

test('the codec rejects foreign, malformed and out-of-range callback data', () => {
  for (const foreign of ['', 'rw_', 'mdl_1_2', 'rmlp_0', 'rw_w7k2', 'rw_w7k2_zz', 'rw_w7k2_b_1']) {
    assert.equal(parseReminderWizardCallback(foreign), null, `"${foreign}" must not parse`);
  }
  // Out-of-range arguments must die at the codec, never reach the assembler.
  assert.equal(parseReminderWizardCallback(`rw_${wizardId}_w_7`), null, 'weekday 7 does not exist');
  assert.equal(parseReminderWizardCallback(`rw_${wizardId}_m_32`), null, 'day 32 does not exist');
  assert.equal(parseReminderWizardCallback(`rw_${wizardId}_m_0`), null, 'day 0 does not exist');
  assert.equal(parseReminderWizardCallback(`rw_${wizardId}_h_24`), null, 'hour 24 does not exist');
  assert.equal(parseReminderWizardCallback(`rw_${wizardId}_q_9`), null, 'quick-time index 9 does not exist');
  assert.equal(
    parseReminderWizardCallback(`rw_${wizardId}_i_7`),
    null,
    'a minute off the 5-minute grid is not a button the wizard rendered',
  );
  assert.equal(parseReminderWizardCallback(`rw_${wizardId}_d_20260231`), null, 'Feb 31 is not a date');
  assert.equal(parseReminderWizardCallback(`rw_${wizardId}_d_2026092`), null, 'a truncated date must not parse');
  // A wizard id longer than the codec allows must not be silently truncated into
  // a DIFFERENT wizard's id.
  assert.equal(parseReminderWizardCallback(`rw_${'a'.repeat(reminderWizardIdMaxLength + 1)}_b`), null);
});

test('every callback the reminder screens can emit fits the 64-byte cap', () => {
  const wizardCallbacks: string[] = [
    buildReminderDateGridCallback(longestWizardId),
    buildReminderDayOfMonthGridCallback(longestWizardId),
    buildReminderHourGridCallback(longestWizardId),
    buildReminderBackCallback(longestWizardId),
    buildReminderCancelCallback(longestWizardId),
  ];
  for (const repeatKind of reminderRepeatKinds) {
    wizardCallbacks.push(buildReminderRepeatCallback(longestWizardId, repeatKind));
  }
  // A year's worth of dates — the widest argument the codec carries (8 digits).
  for (let offsetDays = 0; offsetDays <= 400; offsetDays += 1) {
    const dateIso = formatReminderDateIso(getLocalDateAtDayOffset(nowMs, offsetDays));
    wizardCallbacks.push(buildReminderDateCallback(longestWizardId, dateIso));
  }
  for (let weekday = 0; weekday <= 6; weekday += 1) {
    wizardCallbacks.push(buildReminderWeekdayCallback(longestWizardId, weekday));
  }
  for (let dayOfMonth = 1; dayOfMonth <= 31; dayOfMonth += 1) {
    wizardCallbacks.push(buildReminderDayOfMonthCallback(longestWizardId, dayOfMonth));
  }
  for (let quickTimeIndex = 0; quickTimeIndex < reminderQuickTimes.length; quickTimeIndex += 1) {
    wizardCallbacks.push(buildReminderQuickTimeCallback(longestWizardId, quickTimeIndex));
  }
  for (let hour = 0; hour < 24; hour += 1) {
    wizardCallbacks.push(buildReminderHourCallback(longestWizardId, hour));
  }
  for (let minute = 0; minute < 60; minute += reminderMinuteStep) {
    wizardCallbacks.push(buildReminderMinuteCallback(longestWizardId, minute));
  }

  for (const callbackData of wizardCallbacks) {
    assert.ok(checkIsCallbackDataWithinLimit(callbackData), `"${callbackData}" exceeds the cap`);
    assert.ok(reminderWizardCallbackRe.test(callbackData), `"${callbackData}" must match the handler regex`);
    const parsed = parseReminderWizardCallback(callbackData);
    assert.equal(parsed?.wizardId, longestWizardId, `"${callbackData}" must round-trip its wizard id`);
  }

  // The longest schedule id `generateScheduleId` can mint: a 40-char slug plus
  // `-` plus the 6-char random suffix.
  const longestReminderId = `${'reminder-name'.repeat(4).slice(0, 40)}-ab12cd`;
  assert.equal(longestReminderId.length, 47);
  const listCallbacks = [
    buildReminderListPageCallback(999),
    buildReminderCardCallback(9999),
    buildReminderDeleteCallback(longestReminderId),
  ];
  for (const callbackData of listCallbacks) {
    assert.ok(checkIsCallbackDataWithinLimit(callbackData), `"${callbackData}" exceeds the cap`);
  }
  assert.equal(parseReminderListPageCallback(buildReminderListPageCallback(999)), 999);
  assert.equal(parseReminderCardCallback(buildReminderCardCallback(9999)), 9999);
  assert.equal(parseReminderDeleteCallback(buildReminderDeleteCallback(longestReminderId)), longestReminderId);
  assert.equal(parseReminderDeleteCallback('rmc_3'), null);
  assert.equal(parseReminderCardCallback('rmlp_3'), null);

  // The three flat ids: inside the cap, and DISTINCT from each other's prefixes —
  // Telegraf dispatches action patterns first-match-wins, so an id that another
  // matcher could swallow would silently route to the wrong screen.
  const flatCallbacks = [reminderAddCallback, reminderHubCallback, reminderCloseCallback];
  for (const callbackData of flatCallbacks) {
    assert.ok(checkIsCallbackDataWithinLimit(callbackData), `"${callbackData}" exceeds the cap`);
    assert.equal(parseReminderWizardCallback(callbackData), null, `"${callbackData}" must not read as a wizard tap`);
    assert.equal(parseReminderListPageCallback(callbackData), null);
    assert.equal(parseReminderCardCallback(callbackData), null);
    assert.equal(parseReminderDeleteCallback(callbackData), null);
  }
  assert.equal(new Set(flatCallbacks).size, flatCallbacks.length, 'the flat ids must be unique');
});

// ─── step transitions ────────────────────────────────────────────────

test('a fresh wizard opens on the repeat step with nothing picked', () => {
  const state = createReminderWizardState(wizardId);
  assert.equal(state.step, 'repeat');
  assert.deepEqual(
    { ...state, wizardId: 'x' },
    { wizardId: 'x', step: 'repeat', repeatKind: null, dateIso: null, weekday: null, dayOfMonth: null, hour: null, minute: null, text: null },
  );
});

test('the second step depends on the repeat kind — daily/weekdays SKIP it entirely', () => {
  assert.equal(getReminderStepAfterRepeat('once'), 'date');
  assert.equal(getReminderStepAfterRepeat('weekly'), 'weekday');
  assert.equal(getReminderStepAfterRepeat('monthly'), 'dayOfMonth');
  assert.equal(getReminderStepAfterRepeat('daily'), 'time');
  assert.equal(getReminderStepAfterRepeat('weekdays'), 'time');

  for (const repeatKind of reminderRepeatKinds) {
    const transition = applyTap(createReminderWizardState(wizardId), buildReminderRepeatCallback(wizardId, repeatKind));
    const state = getTransitionState(transition);
    assert.equal(transition.kind, 'render');
    assert.equal(state.repeatKind, repeatKind);
    assert.equal(state.step, getReminderStepAfterRepeat(repeatKind));
  }
});

test('back from the time step lands on the second step — or on repeat when there is none', () => {
  assert.equal(getReminderPreviousStep(createStateAt('time', { repeatKind: 'once' })), 'date');
  assert.equal(getReminderPreviousStep(createStateAt('time', { repeatKind: 'weekly' })), 'weekday');
  assert.equal(getReminderPreviousStep(createStateAt('time', { repeatKind: 'monthly' })), 'dayOfMonth');
  assert.equal(getReminderPreviousStep(createStateAt('time', { repeatKind: 'daily' })), 'repeat');
  assert.equal(getReminderPreviousStep(createStateAt('time', { repeatKind: 'weekdays' })), 'repeat');

  // Driven through the real transition, not just the helper.
  const dailyBack = applyTap(createStateAt('time', { repeatKind: 'daily' }), buildReminderBackCallback(wizardId));
  assert.equal(getTransitionState(dailyBack).step, 'repeat');
  const weeklyBack = applyTap(createStateAt('time', { repeatKind: 'weekly', weekday: 3 }), buildReminderBackCallback(wizardId));
  assert.equal(getTransitionState(weeklyBack).step, 'weekday');
});

test('back RESETS the pick owned by the step it lands on', () => {
  const weekly = createStateAt('time', { repeatKind: 'weekly', weekday: 3 });
  const backToWeekday = getTransitionState(applyTap(weekly, buildReminderBackCallback(wizardId)));
  assert.equal(backToWeekday.step, 'weekday');
  assert.equal(backToWeekday.weekday, null, 're-entering the weekday step must not keep the old weekday');
  assert.equal(backToWeekday.repeatKind, 'weekly', 'the earlier pick survives');

  const monthly = createStateAt('time', { repeatKind: 'monthly', dayOfMonth: 20 });
  const backToDay = getTransitionState(applyTap(monthly, buildReminderBackCallback(wizardId)));
  assert.equal(backToDay.dayOfMonth, null);

  const once = createStateAt('time', { repeatKind: 'once', dateIso: '2026-09-27' });
  const backToDate = getTransitionState(applyTap(once, buildReminderBackCallback(wizardId)));
  assert.equal(backToDate.step, 'date');
  assert.equal(backToDate.dateIso, null);

  // Back to the repeat step clears EVERYTHING — a different repeat kind makes
  // every later pick meaningless.
  const backToRepeat = getTransitionState(
    applyTap(createStateAt('weekday', { repeatKind: 'weekly', weekday: 5 }), buildReminderBackCallback(wizardId)),
  );
  assert.deepEqual(backToRepeat, createReminderWizardState(wizardId));

  // Back out of the text step returns to the time step with the time cleared.
  const fromText = createStateAt('text', { repeatKind: 'daily', hour: 21, minute: 30 });
  const backToTime = getTransitionState(applyTap(fromText, buildReminderBackCallback(wizardId)));
  assert.equal(backToTime.step, 'time');
  assert.equal(backToTime.hour, null);
  assert.equal(backToTime.minute, null);
});

test('back from step 1 leaves the wizard for the hub; cancel is terminal on every step', () => {
  assert.deepEqual(applyTap(createReminderWizardState(wizardId), buildReminderBackCallback(wizardId)), {
    kind: 'backToHub',
  });

  const everyStep: ReminderWizardStep[] = [
    'repeat',
    'date',
    'dateGrid',
    'weekday',
    'dayOfMonth',
    'dayOfMonthGrid',
    'time',
    'hour',
    'minute',
    'text',
  ];
  for (const step of everyStep) {
    assert.deepEqual(
      applyTap(createStateAt(step, { repeatKind: 'daily' }), buildReminderCancelCallback(wizardId)),
      { kind: 'cancelled' },
      `cancel must work on the "${step}" step`,
    );
  }
});

test('the custom-time sub-flow: other time → hour grid → minute grid, and back to the hours', () => {
  const timeStep = createStateAt('time', { repeatKind: 'daily' });
  const hourStep = getTransitionState(applyTap(timeStep, buildReminderHourGridCallback(wizardId)));
  assert.equal(hourStep.step, 'hour');

  const minuteStep = getTransitionState(applyTap(hourStep, buildReminderHourCallback(wizardId, 21)));
  assert.equal(minuteStep.step, 'minute');
  assert.equal(minuteStep.hour, 21, 'the picked hour is exposed so the header can render "21:__"');
  assert.equal(minuteStep.minute, null);

  // back from the minutes returns to the hour grid, dropping the hour so the
  // grid the operator lands on is not silently pre-decided.
  const backToHours = getTransitionState(applyTap(minuteStep, buildReminderBackCallback(wizardId)));
  assert.equal(backToHours.step, 'hour');
  assert.equal(backToHours.hour, null);

  const done = applyTap(minuteStep, buildReminderMinuteCallback(wizardId, 45));
  assert.equal(done.kind, 'awaitText');
  const finished = getTransitionState(done);
  assert.equal(finished.step, 'text');
  assert.deepEqual(getReminderPicksFromState(finished), {
    repeatKind: 'daily',
    hour: 21,
    minute: 45,
  });
});

test('a quick time completes the wizard straight from the time step', () => {
  const transition = applyTap(
    createStateAt('time', { repeatKind: 'weekdays' }),
    buildReminderQuickTimeCallback(wizardId, 1),
  );
  assert.equal(transition.kind, 'awaitText');
  const state = getTransitionState(transition);
  assert.equal(state.step, 'text');
  assert.equal(state.hour, reminderQuickTimes[1].hour);
  assert.equal(state.minute, reminderQuickTimes[1].minute);
});

test('a tap carrying another wizard\'s id is EXPIRED and mutates nothing', () => {
  const state = createStateAt('time', { repeatKind: 'daily' });
  const snapshot = { ...state };
  const foreignTap = applyReminderWizardCallback({
    state,
    callbackData: buildReminderQuickTimeCallback('otherwiz', 0),
    nowMs,
  });
  assert.deepEqual(foreignTap, { kind: 'expired' });
  assert.deepEqual(state, snapshot, 'the live wizard state must be untouched');

  // Same for a cancel from a foreign wizard — it must not tear down the live one.
  assert.deepEqual(
    applyReminderWizardCallback({ state, callbackData: buildReminderCancelCallback('otherwiz'), nowMs }),
    { kind: 'expired' },
  );
  assert.deepEqual(applyTap(state, 'rmlp_0'), { kind: 'expired' }, 'a non-wizard callback is not ours');
});

test('an action belonging to a step the wizard has left is EXPIRED', () => {
  const repeatStep = createReminderWizardState(wizardId);
  assert.deepEqual(applyTap(repeatStep, buildReminderMinuteCallback(wizardId, 15)), { kind: 'expired' });
  assert.deepEqual(applyTap(repeatStep, buildReminderQuickTimeCallback(wizardId, 0)), { kind: 'expired' });

  // A raced double-tap on the hour grid must not re-apply against the minutes.
  const minuteStep = createStateAt('minute', { repeatKind: 'daily', hour: 9 });
  assert.deepEqual(applyTap(minuteStep, buildReminderHourCallback(wizardId, 10)), { kind: 'expired' });

  // A date pick is legitimate on BOTH date screens.
  for (const step of ['date', 'dateGrid'] as const) {
    const transition = applyTap(
      createStateAt(step, { repeatKind: 'once' }),
      buildReminderDateCallback(wizardId, '2026-12-31'),
    );
    assert.equal(getTransitionState(transition).dateIso, '2026-12-31');
  }
  // …and a day-of-month pick on both of its screens.
  for (const step of ['dayOfMonth', 'dayOfMonthGrid'] as const) {
    const transition = applyTap(
      createStateAt(step, { repeatKind: 'monthly' }),
      buildReminderDayOfMonthCallback(wizardId, 17),
    );
    assert.equal(getTransitionState(transition).dayOfMonth, 17);
  }
});

// ─── today / tomorrow and the past-time guard ────────────────────────

test('«today» + a time that already passed is an ERROR on the time step, never a roll to tomorrow', () => {
  const dateKeyboard = buildReminderStepKeyboard({ state: createStateAt('date', { repeatKind: 'once' }), nowMs });
  const [todayButton, tomorrowButton] = dateKeyboard[0];
  assert.equal(todayButton.label.kind === 'key' ? todayButton.label.key : null, reminderLabelKeys.dateToday);

  const todayPicked = getTransitionState(applyTap(createStateAt('date', { repeatKind: 'once' }), todayButton.callbackData));
  assert.equal(todayPicked.dateIso, formatReminderDateIso(getLocalDateAtDayOffset(nowMs, 0)));
  assert.equal(todayPicked.step, 'time');

  // 09:00 is behind the 12:00 "now" of this test.
  const pastTap = applyTap(todayPicked, buildReminderQuickTimeCallback(wizardId, 0));
  assert.equal(pastTap.kind, 'error');
  if (pastTap.kind !== 'error') assert.fail('expected an error transition');
  assert.equal(pastTap.code, 'pastTime');
  assert.deepEqual(pastTap.state, todayPicked, 'the time is NOT committed, so the same screen re-renders');

  // 18:00 today is still ahead → a valid one-shot.
  const futureTap = applyTap(todayPicked, buildReminderQuickTimeCallback(wizardId, 2));
  assert.equal(futureTap.kind, 'awaitText');
  const picks = getReminderPicksFromState(getTransitionState(futureTap));
  assert.ok(picks);
  const spec = buildReminderSpec({ picks, nowMs });
  assert.ok(spec.ok);
  assert.equal(spec.spec.kind, 'once');
  assert.equal(validateScheduleSpec(spec.spec, nowMs), null);

  // Tomorrow is always in the future, whatever hour is picked.
  const tomorrowPicked = getTransitionState(
    applyTap(createStateAt('date', { repeatKind: 'once' }), tomorrowButton.callbackData),
  );
  assert.equal(tomorrowPicked.dateIso, formatReminderDateIso(getLocalDateAtDayOffset(nowMs, 1)));
  for (let quickTimeIndex = 0; quickTimeIndex < reminderQuickTimes.length; quickTimeIndex += 1) {
    const transition = applyTap(tomorrowPicked, buildReminderQuickTimeCallback(wizardId, quickTimeIndex));
    assert.equal(transition.kind, 'awaitText', `tomorrow at ${quickTimeIndex} must be accepted`);
  }
});

test('the past-time error keeps the picked hour so the minute header still reads "21:__"', () => {
  const morning = new Date(2026, 8, 26, 22, 0, 0, 0).getTime();
  const state = createStateAt('minute', {
    repeatKind: 'once',
    dateIso: formatReminderDateIso(getLocalDateAtDayOffset(morning, 0)),
    hour: 21,
  });
  const transition = applyReminderWizardCallback({
    state,
    callbackData: buildReminderMinuteCallback(wizardId, 30),
    nowMs: morning,
  });
  assert.equal(transition.kind, 'error');
  assert.equal(getTransitionState(transition).hour, 21);
  assert.equal(getTransitionState(transition).step, 'minute');
});

test('the past-instant guard covers EVERY once date, not just «today»', () => {
  // The guard lives in `buildReminderSpec`, the one place a `once` instant is
  // validated, so «tomorrow» and an «other date» pick get the SAME refusal — a
  // wizard left open long enough outlives any of them.
  const eveningMs = new Date(2026, 8, 26, 23, 50, 0, 0).getTime();
  const tomorrowIso = formatReminderDateIso(getLocalDateAtDayOffset(eveningMs, 1));
  const tomorrowPicked = getTransitionState(
    applyReminderWizardCallback({
      state: createStateAt('date', { repeatKind: 'once' }),
      callbackData: buildReminderDateCallback(wizardId, tomorrowIso),
      nowMs: eveningMs,
    }),
  );
  // Answered the next morning, after the 09:00 it is about to pick.
  const nextMorningMs = new Date(2026, 8, 27, 9, 5, 0, 0).getTime();
  const staleTomorrow = applyReminderWizardCallback({
    state: tomorrowPicked,
    callbackData: buildReminderQuickTimeCallback(wizardId, 0),
    nowMs: nextMorningMs,
  });
  assert.equal(staleTomorrow.kind, 'error');
  if (staleTomorrow.kind !== 'error') assert.fail('expected an error transition');
  assert.equal(staleTomorrow.code, 'pastTime');

  // A grid date, days later.
  const gridState = createStateAt('time', {
    repeatKind: 'once',
    dateIso: formatReminderDateIso(getLocalDateAtDayOffset(nowMs, 2)),
  });
  const wellPastMs = new Date(2026, 9, 5, 12, 0, 0, 0).getTime();
  const staleGridDate = applyReminderWizardCallback({
    state: gridState,
    callbackData: buildReminderQuickTimeCallback(wizardId, 3),
    nowMs: wellPastMs,
  });
  assert.equal(staleGridDate.kind, 'error');

  // Held text does not buy a bypass: the stale instant still errors instead of
  // creating, and the text survives for the next pick.
  const staleWithText = applyReminderWizardCallback({
    state: { ...gridState, text: 'Take the pills' },
    callbackData: buildReminderQuickTimeCallback(wizardId, 3),
    nowMs: wellPastMs,
  });
  assert.equal(staleWithText.kind, 'error');
  assert.equal(getTransitionState(staleWithText).text, 'Take the pills');
});

// ─── the reminder text is typed exactly ONCE ─────────────────────────

/** The step-4 state a «once / today / 18:00» wizard reaches (18:00 > the 12:00 now). */
function createTodayTextStep(): ReminderWizardState {
  const todayIso = formatReminderDateIso(getLocalDateAtDayOffset(nowMs, 0));
  const datePicked = getTransitionState(
    applyTap(createStateAt('date', { repeatKind: 'once' }), buildReminderDateCallback(wizardId, todayIso)),
  );
  const armed = applyTap(datePicked, buildReminderQuickTimeCallback(wizardId, 2));
  assert.equal(armed.kind, 'awaitText', 'the fixture must reach step 4 the normal way');
  return getTransitionState(armed);
}

test('a stale instant re-asks the TIME only — the text is created from, never retyped', () => {
  // The whole flow is buttons so the operator types EXACTLY once. Losing the text
  // to a race they cannot even see (18:00 went by while they typed) and asking for
  // it again is the one failure this design exists to prevent.
  const textStep = createTodayTextStep();
  assert.equal(textStep.step, 'text');
  assert.equal(textStep.text, null, 'nothing has been typed yet at step 4');

  // They send the text one minute after the instant they picked.
  const typedAtMs = new Date(2026, 8, 26, 18, 1, 0, 0).getTime();
  const picks = getReminderPicksFromState(textStep);
  assert.ok(picks);
  assert.deepEqual(
    buildReminderSpec({ picks, nowMs: typedAtMs }),
    { ok: false, code: 'pastTime' },
    'the picked instant really is behind by now',
  );

  const retime = getReminderStateForRetime(textStep, 'Take the pills');
  assert.equal(retime.step, 'time', 'only the TIME is re-asked');
  assert.equal(retime.text, 'Take the pills', 'the typed text is retained');
  assert.equal(retime.hour, null);
  assert.equal(retime.minute, null);
  assert.equal(retime.dateIso, textStep.dateIso, 'the day they picked still stands');

  // The replacement time pick CREATES — no second `awaitText`, nothing retyped.
  const created = applyReminderWizardCallback({
    state: retime,
    callbackData: buildReminderQuickTimeCallback(wizardId, 3),
    nowMs: typedAtMs,
  });
  assert.notEqual(created.kind, 'awaitText', 'the text step must NOT be entered a second time');
  assert.equal(created.kind, 'createNow');
  if (created.kind !== 'createNow') assert.fail('expected a createNow transition');
  assert.equal(created.text, 'Take the pills', 'the reminder is built from the ORIGINAL text');
  assert.equal(created.spec.kind, 'once');
  if (created.spec.kind !== 'once') assert.fail('expected a once spec');
  const firesAt = new Date(created.spec.onceAtIso);
  assert.equal(firesAt.getHours(), reminderQuickTimes[3].hour, 'the NEW time is what was stored');
  assert.equal(firesAt.getMinutes(), reminderQuickTimes[3].minute);
  assert.equal(validateScheduleSpec(created.spec, typedAtMs), null);
});

test('a replacement time that is ALSO past errors again and still keeps the text', () => {
  const retime = getReminderStateForRetime(createTodayTextStep(), 'Take the pills');
  const typedAtMs = new Date(2026, 8, 26, 18, 1, 0, 0).getTime();
  const stillPast = applyReminderWizardCallback({
    state: retime,
    callbackData: buildReminderQuickTimeCallback(wizardId, 0),
    nowMs: typedAtMs,
  });
  assert.equal(stillPast.kind, 'error');
  if (stillPast.kind !== 'error') assert.fail('expected an error transition');
  assert.equal(stillPast.code, 'pastTime');
  assert.equal(
    getTransitionState(stillPast).text,
    'Take the pills',
    'a second wrong pick must not cost the operator their text either',
  );
});

test('the after-time rule is what skips step 4: askText without text, createNow with it', () => {
  const timeState = createStateAt('time', { repeatKind: 'daily' });
  assert.deepEqual(getReminderActionAfterTime(timeState), { kind: 'askText' });
  assert.deepEqual(getReminderActionAfterTime({ ...timeState, text: 'Take the pills' }), {
    kind: 'createNow',
    text: 'Take the pills',
  });
  // An empty string is still an answer the operator sent — it must not read as
  // "no text yet" and re-open step 4.
  assert.deepEqual(getReminderActionAfterTime({ ...timeState, text: '' }), { kind: 'createNow', text: '' });
});

test('back and a repeat change re-pick the SCHEDULE without discarding held text', () => {
  // Re-picking the schedule is not a reason to ask for the note again, so the text
  // survives every step the operator can walk back through — including the repeat
  // step, which clears everything else.
  const onceRetime = getReminderStateForRetime(createTodayTextStep(), 'Take the pills');
  const backToDate = getTransitionState(applyTap(onceRetime, buildReminderBackCallback(wizardId)));
  assert.equal(backToDate.step, 'date');
  assert.equal(backToDate.dateIso, null, 'the day is re-asked, as before');
  assert.equal(backToDate.text, 'Take the pills');

  const dailyWithText = createStateAt('time', { repeatKind: 'daily', text: 'Take the pills' });
  const backToRepeat = getTransitionState(applyTap(dailyWithText, buildReminderBackCallback(wizardId)));
  assert.equal(backToRepeat.step, 'repeat');
  assert.equal(backToRepeat.repeatKind, null, 'the repeat step still resets its own pick');
  assert.equal(backToRepeat.text, 'Take the pills');

  const repicked = getTransitionState(applyTap(backToRepeat, buildReminderRepeatCallback(wizardId, 'weekly')));
  assert.equal(repicked.step, 'weekday');
  assert.equal(repicked.text, 'Take the pills');

  // And the re-picked schedule creates straight away once its time lands.
  const weekdayPicked = getTransitionState(applyTap(repicked, buildReminderWeekdayCallback(wizardId, 1)));
  const created = applyTap(weekdayPicked, buildReminderQuickTimeCallback(wizardId, 1));
  assert.equal(created.kind, 'createNow');
});

// ─── step keyboards ──────────────────────────────────────────────────

test('the repeat step renders the locked row layout plus a back/cancel row', () => {
  const keyboard = buildReminderStepKeyboard({ state: createReminderWizardState(wizardId), nowMs });
  const labelKeys = keyboard.map((row) => row.map((button) => (button.label.kind === 'key' ? button.label.key : '?')));
  assert.deepEqual(labelKeys, [
    [reminderLabelKeys.repeatOnce, reminderLabelKeys.repeatDaily],
    [reminderLabelKeys.repeatWeekdays, reminderLabelKeys.repeatWeekly],
    [reminderLabelKeys.repeatMonthly],
    [reminderLabelKeys.back, reminderLabelKeys.cancel],
  ]);
});

test('the weekday step is Monday-first in DISPLAY order but carries CRON dow values', () => {
  const keyboard = buildReminderStepKeyboard({
    state: createStateAt('weekday', { repeatKind: 'weekly' }),
    nowMs,
  });
  const weekdayRows = keyboard.slice(0, -1);
  assert.deepEqual(
    weekdayRows.map((row) => row.length),
    [3, 3, 1],
    'Mon Tue Wed / Thu Fri Sat / Sun',
  );

  const mondayButton = weekdayRows[0][0];
  assert.equal(mondayButton.label.kind === 'key' ? mondayButton.label.key : null, reminderWeekdayLabelKeys[1]);
  assert.deepEqual(parseReminderWizardCallback(mondayButton.callbackData)?.action, {
    kind: 'pickWeekday',
    weekday: 1,
  });

  const sundayButton = weekdayRows[2][0];
  assert.equal(sundayButton.label.kind === 'key' ? sundayButton.label.key : null, reminderWeekdayLabelKeys[0]);
  assert.deepEqual(parseReminderWizardCallback(sundayButton.callbackData)?.action, {
    kind: 'pickWeekday',
    weekday: 0,
  });

  assert.deepEqual([...reminderWeekdayDisplayOrder], [1, 2, 3, 4, 5, 6, 0]);
});

test('the time step offers the four presets, a full-width custom row, then navigation', () => {
  const keyboard = buildReminderStepKeyboard({ state: createStateAt('time', { repeatKind: 'daily' }), nowMs });
  assert.deepEqual(
    keyboard[0].map((button) => (button.label.kind === 'literal' ? button.label.text : '?')),
    ['09:00', '12:00', '18:00', '21:00'],
  );
  assert.equal(keyboard[1].length, 1);
  assert.equal(keyboard[1][0].label.kind === 'key' ? keyboard[1][0].label.key : null, reminderLabelKeys.timeOther);
  assert.deepEqual(keyboard[2].map((button) => button.callbackData), [
    buildReminderBackCallback(wizardId),
    buildReminderCancelCallback(wizardId),
  ]);
});

test('the hour grid is 00..23 four per row; the minute grid is :00..:55 in fives, three per row', () => {
  const hourKeyboard = buildReminderStepKeyboard({ state: createStateAt('hour', { repeatKind: 'daily' }), nowMs });
  const hourRows = hourKeyboard.slice(0, -1);
  assert.equal(hourRows.length, 6);
  assert.ok(hourRows.every((row) => row.length === 4));
  assert.deepEqual(
    hourRows.flat().map((button) => (button.label.kind === 'literal' ? button.label.text : '?')),
    Array.from({ length: 24 }, (_unused, hour) => hour.toString().padStart(2, '0')),
  );

  const minuteKeyboard = buildReminderStepKeyboard({
    state: createStateAt('minute', { repeatKind: 'daily', hour: 21 }),
    nowMs,
  });
  const minuteRows = minuteKeyboard.slice(0, -1);
  assert.equal(minuteRows.length, 4);
  assert.ok(minuteRows.every((row) => row.length === 3));
  assert.deepEqual(
    minuteRows.flat().map((button) => (button.label.kind === 'literal' ? button.label.text : '?')),
    [':00', ':05', ':10', ':15', ':20', ':25', ':30', ':35', ':40', ':45', ':50', ':55'],
  );
});

test('the date grid skips today/tomorrow and the day grid covers 1..31', () => {
  const dateKeyboard = buildReminderStepKeyboard({ state: createStateAt('dateGrid', { repeatKind: 'once' }), nowMs });
  const dateButtons = dateKeyboard.slice(0, -1).flat();
  const firstDate = parseReminderWizardCallback(dateButtons[0].callbackData)?.action;
  assert.deepEqual(firstDate, {
    kind: 'pickDate',
    dateIso: formatReminderDateIso(getLocalDateAtDayOffset(nowMs, 2)),
  });
  // Every grid date must be strictly in the future, so the grid can never
  // produce a pick that immediately errors.
  for (const button of dateButtons) {
    const action = parseReminderWizardCallback(button.callbackData)?.action;
    assert.ok(action && action.kind === 'pickDate');
    assert.ok(action.dateIso > formatReminderDateIso(getLocalDateAtDayOffset(nowMs, 0)));
  }

  const dayKeyboard = buildReminderStepKeyboard({
    state: createStateAt('dayOfMonthGrid', { repeatKind: 'monthly' }),
    nowMs,
  });
  const dayButtons = dayKeyboard.slice(0, -1).flat();
  assert.equal(dayButtons.length, 31);
  assert.deepEqual(
    dayButtons.map((button) => (button.label.kind === 'literal' ? button.label.text : '?')),
    Array.from({ length: 31 }, (_unused, index) => (index + 1).toString()),
  );
});

test('every step keyboard offers a way out (back and cancel)', () => {
  const steps: ReminderWizardStep[] = [
    'repeat',
    'date',
    'dateGrid',
    'weekday',
    'dayOfMonth',
    'dayOfMonthGrid',
    'time',
    'hour',
    'minute',
    'text',
  ];
  for (const step of steps) {
    const keyboard = buildReminderStepKeyboard({
      state: createStateAt(step, { repeatKind: 'once', dateIso: '2026-12-31', hour: 9 }),
      nowMs,
    });
    const callbackDataList = getCallbackDataList(keyboard);
    assert.ok(callbackDataList.includes(buildReminderBackCallback(wizardId)), `"${step}" needs a back button`);
    assert.ok(callbackDataList.includes(buildReminderCancelCallback(wizardId)), `"${step}" needs a cancel button`);
    for (const callbackData of callbackDataList) {
      assert.ok(checkIsCallbackDataWithinLimit(callbackData), `"${callbackData}" exceeds the cap`);
      assert.ok(parseReminderWizardCallback(callbackData), `"${callbackData}" must be parseable`);
    }
  }
});

// ─── spec assembly ───────────────────────────────────────────────────

test('spec assembly emits the exact cron shape per repeat kind', () => {
  assert.deepEqual(buildReminderSpec({ picks: { repeatKind: 'daily', hour: 9, minute: 5 }, nowMs }), {
    ok: true,
    spec: { kind: 'cron', cronExpr: '5 9 * * *' },
  });
  assert.deepEqual(buildReminderSpec({ picks: { repeatKind: 'weekdays', hour: 18, minute: 30 }, nowMs }), {
    ok: true,
    spec: { kind: 'cron', cronExpr: '30 18 * * 1-5' },
  });
  assert.deepEqual(
    buildReminderSpec({ picks: { repeatKind: 'weekly', weekday: 1, hour: 21, minute: 0 }, nowMs }),
    { ok: true, spec: { kind: 'cron', cronExpr: '0 21 * * 1' } },
  );
  assert.deepEqual(
    buildReminderSpec({ picks: { repeatKind: 'weekly', weekday: 0, hour: 12, minute: 15 }, nowMs }),
    { ok: true, spec: { kind: 'cron', cronExpr: '15 12 * * 0' } },
    'Sunday is cron dow 0, not 7',
  );
  assert.deepEqual(
    buildReminderSpec({ picks: { repeatKind: 'monthly', dayOfMonth: 31, hour: 0, minute: 0 }, nowMs }),
    { ok: true, spec: { kind: 'cron', cronExpr: '0 0 31 * *' } },
  );

  const once = buildReminderSpec({
    picks: { repeatKind: 'once', dateIso: '2026-12-31', hour: 21, minute: 45 },
    nowMs,
  });
  assert.ok(once.ok);
  assert.equal(once.spec.kind, 'once');
  if (once.spec.kind !== 'once') assert.fail('expected a once spec');
  // The stored ISO must round-trip to the intended LOCAL instant.
  const roundTripped = new Date(once.spec.onceAtIso);
  assert.equal(roundTripped.getFullYear(), 2026);
  assert.equal(roundTripped.getMonth(), 11);
  assert.equal(roundTripped.getDate(), 31);
  assert.equal(roundTripped.getHours(), 21);
  assert.equal(roundTripped.getMinutes(), 45);
});

test('a one-shot on an impossible date is reported, never assembled', () => {
  assert.deepEqual(
    buildReminderSpec({ picks: { repeatKind: 'once', dateIso: '2026-02-31', hour: 9, minute: 0 }, nowMs }),
    { ok: false, code: 'invalidDate' },
  );
  assert.deepEqual(
    buildReminderSpec({ picks: { repeatKind: 'once', dateIso: 'tomorrow', hour: 9, minute: 0 }, nowMs }),
    { ok: false, code: 'invalidDate' },
  );
});

// ─── DST: a skipped wall clock blames the TIME, not the date ──────────

/**
 * Europe/Berlin springs forward on 2026-03-29 at 02:00 → 03:00, so 02:30 never
 * happens there that day. Pinned explicitly because the host zone has no DST at all
 * (`Asia/Tbilisi`), which would leave this whole class of bug untested.
 */
const dstSpringForwardZone = 'Europe/Berlin';
const dstSpringForwardDateIso = '2026-03-29';
const dstSkippedHour = 2;
const dstSkippedMinute = 30;
/** Comfortably before the transition, so `pastTime` cannot mask the verdict. */
const beforeDstTransitionMs = Date.UTC(2026, 2, 1, 12, 0, 0);

/**
 * Run `body` with the process timezone pinned, restoring the launched value
 * afterwards. Assigning `process.env.TZ` re-bases `Date` immediately — the same
 * mechanism `/timezone` uses — so this is how a DST transition is exercised from a
 * host zone that has none.
 */
function runInTimezone<T>(timezone: string, body: () => T): T {
  const originalTz = process.env.TZ;
  process.env.TZ = timezone;
  try {
    return body();
  } finally {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  }
}

test('the two causes are told apart: a skipped wall clock is invalidTime, a fake date invalidDate', () => {
  // Conflating them told the operator "that date does not exist" about a perfectly
  // good date, so they re-picked the DAY while the time was what needed changing.
  runInTimezone(dstSpringForwardZone, () => {
    assert.deepEqual(
      createReminderInstant(dstSpringForwardDateIso, dstSkippedHour, dstSkippedMinute),
      { ok: false, code: 'invalidTime' },
    );
    assert.deepEqual(createReminderInstant('2026-02-31', 9, 0), { ok: false, code: 'invalidDate' });
    assert.deepEqual(createReminderInstant('not-a-date', 9, 0), { ok: false, code: 'invalidDate' });

    // The very same day at an hour the clock does reach resolves normally, proving
    // the refusal is about the skipped window and not about the date.
    const resolved = createReminderInstant(dstSpringForwardDateIso, 4, 30);
    assert.ok(resolved.ok, 'a real wall clock on the transition day must still resolve');
    if (!resolved.ok) return;
    assert.equal(resolved.instant.getHours(), 4);
    assert.equal(resolved.instant.getMinutes(), 30);

    assert.deepEqual(
      buildReminderSpec({
        picks: {
          repeatKind: 'once',
          dateIso: dstSpringForwardDateIso,
          hour: dstSkippedHour,
          minute: dstSkippedMinute,
        },
        nowMs: beforeDstTransitionMs,
      }),
      { ok: false, code: 'invalidTime' },
    );
  });
});

test('a DST-skipped time sends the operator to the TIME step, where the hour can be changed', () => {
  // The whole transition hour is skipped, so re-picking a minute inside it could only
  // fail again — leaving them on the minute grid would be a dead end.
  runInTimezone(dstSpringForwardZone, () => {
    const onMinuteGrid = createStateAt('minute', {
      repeatKind: 'once',
      dateIso: dstSpringForwardDateIso,
      hour: dstSkippedHour,
    });
    const tap = applyReminderWizardCallback({
      state: onMinuteGrid,
      callbackData: buildReminderMinuteCallback(wizardId, dstSkippedMinute),
      nowMs: beforeDstTransitionMs,
    });
    assert.equal(tap.kind, 'error');
    if (tap.kind !== 'error') assert.fail('expected an error transition');
    assert.equal(tap.code, 'invalidTime');
    assert.equal(tap.state.step, 'time', 'the minute grid is a dead end for a skipped hour');
    assert.equal(tap.state.hour, null, 'the skipped hour is cleared, not re-offered');
    assert.equal(tap.state.minute, null);
    assert.equal(tap.state.dateIso, dstSpringForwardDateIso, 'the date was fine and is kept');
  });
});

/** Every spec the wizard can produce, over a representative pick grid. */
function getProducibleSpecs(): ScheduleSpec[] {
  const times = [
    { hour: 0, minute: 0 },
    { hour: 9, minute: 5 },
    { hour: 23, minute: 55 },
  ];
  const specs: ScheduleSpec[] = [];
  const pickSets: ReminderSchedulePicks[] = [];
  for (const { hour, minute } of times) {
    pickSets.push({ repeatKind: 'daily', hour, minute });
    pickSets.push({ repeatKind: 'weekdays', hour, minute });
    for (let weekday = 0; weekday <= 6; weekday += 1) {
      pickSets.push({ repeatKind: 'weekly', weekday, hour, minute });
    }
    for (let dayOfMonth = 1; dayOfMonth <= 31; dayOfMonth += 1) {
      pickSets.push({ repeatKind: 'monthly', dayOfMonth, hour, minute });
    }
    for (const offsetDays of [1, 2, 30, 200]) {
      pickSets.push({
        repeatKind: 'once',
        dateIso: formatReminderDateIso(getLocalDateAtDayOffset(nowMs, offsetDays)),
        hour,
        minute,
      });
    }
  }
  for (const picks of pickSets) {
    const result = buildReminderSpec({ picks, nowMs });
    assert.ok(result.ok, `assembly failed for ${JSON.stringify(picks)}`);
    specs.push(result.spec);
  }
  return specs;
}

test('every producible spec is accepted by validateScheduleSpec', () => {
  for (const spec of getProducibleSpecs()) {
    assert.equal(
      validateScheduleSpec(spec, nowMs),
      null,
      `rejected: ${JSON.stringify(spec)}`,
    );
  }
});

test('every producible spec is described in WORDS — never a raw `cron …` fallback', () => {
  for (const spec of getProducibleSpecs()) {
    const description = describeSchedule(spec);
    assert.ok(
      !description.startsWith('cron '),
      `${JSON.stringify(spec)} fell back to the raw cron string: "${description}"`,
    );
  }
  // The exact wordings the wizard's shapes hit in `describeCron`.
  assert.equal(describeSchedule({ kind: 'cron', cronExpr: '5 9 * * *' }), 'daily at 09:05');
  assert.equal(describeSchedule({ kind: 'cron', cronExpr: '30 18 * * 1-5' }), 'weekdays at 18:30');
  assert.equal(describeSchedule({ kind: 'cron', cronExpr: '0 21 * * 1' }), 'weekly on Monday at 21:00');
  assert.equal(describeSchedule({ kind: 'cron', cronExpr: '0 0 31 * *' }), 'monthly on day 31 at 00:00');
});

// ─── descriptor ──────────────────────────────────────────────────────

test('the descriptor round-trips every pick set the wizard can assemble', () => {
  const cases: ReminderSchedulePicks[] = [
    { repeatKind: 'daily', hour: 9, minute: 0 },
    { repeatKind: 'weekdays', hour: 18, minute: 30 },
    { repeatKind: 'weekly', weekday: 3, hour: 18, minute: 0 },
    { repeatKind: 'weekly', weekday: 0, hour: 0, minute: 5 },
    { repeatKind: 'monthly', dayOfMonth: 5, hour: 12, minute: 0 },
    { repeatKind: 'monthly', dayOfMonth: 31, hour: 23, minute: 55 },
    { repeatKind: 'once', dateIso: '2026-12-31', hour: 21, minute: 45 },
  ];
  for (const picks of cases) {
    const result = buildReminderSpec({ picks, nowMs });
    assert.ok(result.ok);
    const descriptor = getReminderScheduleDescriptor(result.spec);
    const expectedTime = `${picks.hour.toString().padStart(2, '0')}:${picks.minute.toString().padStart(2, '0')}`;
    switch (picks.repeatKind) {
      case 'daily':
        assert.deepEqual(descriptor, { kind: 'daily', time: expectedTime });
        break;
      case 'weekdays':
        assert.deepEqual(descriptor, { kind: 'weekdays', time: expectedTime });
        break;
      case 'weekly':
        assert.deepEqual(descriptor, { kind: 'weekly', weekday: picks.weekday, time: expectedTime });
        break;
      case 'monthly':
        assert.deepEqual(descriptor, { kind: 'monthly', dayOfMonth: picks.dayOfMonth, time: expectedTime });
        break;
      case 'once':
        assert.deepEqual(descriptor, { kind: 'once', dateIso: picks.dateIso, time: expectedTime });
        break;
    }
  }
});

test('the descriptor falls back to raw for anything the wizard cannot create', () => {
  // An agent-created `schedule_*` job can carry any cron shape.
  assert.deepEqual(getReminderScheduleDescriptor({ kind: 'cron', cronExpr: '*/7 * * * *' }), {
    kind: 'raw',
    text: '*/7 * * * *',
  });
  assert.deepEqual(getReminderScheduleDescriptor({ kind: 'cron', cronExpr: '0 9 * * 1,3,5' }), {
    kind: 'raw',
    text: '0 9 * * 1,3,5',
  });
  assert.deepEqual(getReminderScheduleDescriptor({ kind: 'cron', cronExpr: '0 9 1 6 *' }), {
    kind: 'raw',
    text: '0 9 1 6 *',
  });
  assert.deepEqual(getReminderScheduleDescriptor({ kind: 'cron', cronExpr: '0 9 * *' }), {
    kind: 'raw',
    text: '0 9 * *',
  });
  // An N-times job expires after its budget — describing it as a plain daily
  // reminder would hide that.
  assert.deepEqual(getReminderScheduleDescriptor({ kind: 'cron', cronExpr: '0 9 * * *', remainingRuns: 3 }), {
    kind: 'raw',
    text: '0 9 * * *',
  });
  assert.deepEqual(getReminderScheduleDescriptor({ kind: 'once', onceAtIso: 'not-a-date' }), {
    kind: 'raw',
    text: 'not-a-date',
  });
});

// ─── list, card and delete ───────────────────────────────────────────

function createRows(count: number): ReminderListRow[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `reminder-${index}-ab12cd`,
    name: `Reminder ${index}`,
    descriptor: { kind: 'daily', time: '09:00' } as const,
  }));
}

test('the hub offers add by default, and the list only when there is something to list', () => {
  const emptyHub = buildReminderHubKeyboard(0);
  assert.deepEqual(getCallbackDataList(emptyHub), ['rmadd']);

  const hub = buildReminderHubKeyboard(3);
  assert.deepEqual(getCallbackDataList(hub), ['rmadd', buildReminderListPageCallback(0)]);
  const listButton = hub[0][1];
  assert.deepEqual(listButton.label, { kind: 'key', key: reminderLabelKeys.hubList, vars: { count: 3 } });
});

test('«add» and «list» share ONE row — the locked hub layout', () => {
  // Side by side, not stacked: «close» is the only other row and the caller appends
  // it, so the hub is two rows tall rather than three.
  const hub = buildReminderHubKeyboard(3);
  assert.equal(hub.length, 1, 'add + list are one row, so the plan has exactly one row');
  assert.deepEqual(
    hub[0].map((button) => (button.label.kind === 'key' ? button.label.key : '?')),
    [reminderLabelKeys.hubAdd, reminderLabelKeys.hubList],
    'add comes first, list second',
  );

  // The conditional buttons collapse WITHIN that row, never into a second one.
  assert.deepEqual(buildReminderHubKeyboard(0).map((row) => row.length), [1]);
  assert.deepEqual(buildReminderHubKeyboard(30, { isAddOffered: false }).map((row) => row.length), [1]);
});

test('with nothing to draw the hub emits NO row at all (an empty row is not a keyboard)', () => {
  // Only reachable through a non-positive cap on an empty thread; Telegram rejects
  // an empty button row, so the plan must be empty rather than `[[]]`.
  assert.deepEqual(buildReminderHubKeyboard(0, { isAddOffered: false }), []);
});

test('at the schedule cap the hub drops «add» but keeps the list', () => {
  // The caller owns the cap comparison (the limit lives in the scheduler store),
  // but the button it suppresses is drawn here — a button whose create can only be
  // rejected is worse than no button.
  const capped = buildReminderHubKeyboard(30, { isAddOffered: false });
  assert.deepEqual(getCallbackDataList(capped), [buildReminderListPageCallback(0)]);
  assert.ok(
    !getCallbackDataList(capped).includes(reminderAddCallback),
    'the add button must be gone at the cap',
  );
});

test('an explicit isAddOffered: true is the same keyboard as the default', () => {
  assert.deepEqual(
    getCallbackDataList(buildReminderHubKeyboard(3, { isAddOffered: true })),
    getCallbackDataList(buildReminderHubKeyboard(3)),
  );
});

test('the list paginates at 8 per page and carries ABSOLUTE row indexes', () => {
  const rows = createRows(20);
  assert.equal(reminderListPageSize, 8);

  const first = buildReminderListPlan(rows, 0);
  assert.equal(first.currentPage, 0);
  assert.equal(first.totalPages, 3);
  assert.equal(first.rows.length, 8);
  assert.equal(first.hasPrev, false);
  assert.equal(first.hasNext, true);
  assert.deepEqual(getCallbackDataList(first.keyboard).slice(0, 8), [
    ...Array.from({ length: 8 }, (_unused, index) => buildReminderCardCallback(index)),
  ]);
  assert.deepEqual(getCallbackDataList(first.keyboard).slice(8), [
    buildReminderListPageCallback(1),
    'rmhub',
  ]);

  // Page 2's first row must carry index 8, not index 0 of the slice.
  const second = buildReminderListPlan(rows, 1);
  assert.equal(second.rows[0].id, rows[8].id);
  assert.equal(second.keyboard[0][0].callbackData, buildReminderCardCallback(8));
  assert.equal(second.hasPrev, true);
  assert.equal(second.hasNext, true);
  assert.deepEqual(getCallbackDataList(second.keyboard).slice(8), [
    buildReminderListPageCallback(0),
    buildReminderListPageCallback(2),
    'rmhub',
  ]);

  const last = buildReminderListPlan(rows, 2);
  assert.equal(last.rows.length, 4);
  assert.equal(last.hasNext, false);
});

test('a list row BUTTON carries the name AND its schedule — planned as parts, for localization', () => {
  // The locked list layout is `[🔔 Pills · every day 09:00]` ON the button, so the
  // row has to plan both halves. It cannot plan a FINISHED caption: the schedule
  // half is a `t()` lookup, and this layer has no `t`.
  const rows: ReminderListRow[] = [
    { id: 'pills-ab12cd', name: 'Pills', descriptor: { kind: 'daily', time: '09:00' } },
    { id: 'rent-ab12cd', name: 'Rent', descriptor: { kind: 'monthly', dayOfMonth: 5, time: '12:00' } },
  ];
  const plan = buildReminderListPlan(rows, 0);
  assert.deepEqual(plan.keyboard[0][0].label, {
    kind: 'listRow',
    name: 'Pills',
    descriptor: { kind: 'daily', time: '09:00' },
  });
  assert.deepEqual(plan.keyboard[1][0].label, {
    kind: 'listRow',
    name: 'Rent',
    descriptor: { kind: 'monthly', dayOfMonth: 5, time: '12:00' },
  });
  // A bare literal would be the name alone again — the deviation this replaced.
  assert.deepEqual(
    plan.keyboard.slice(0, rows.length).map((row) => row[0].label.kind),
    ['listRow', 'listRow'],
  );
});

test('a stale list page is clamped to the last real page instead of rendering nothing', () => {
  const rows = createRows(10);
  const plan = buildReminderListPlan(rows, 999);
  assert.equal(plan.currentPage, plan.totalPages - 1);
  assert.equal(plan.rows.length, 2);
  assert.ok(plan.keyboard.length > 1, 'the clamped page still renders reminder rows above the nav');
});

test('a stale row index resolves to null so the caller can answer "expired"', () => {
  const rows = createRows(3);
  assert.equal(getReminderRowAt(rows, 0)?.id, rows[0].id);
  assert.equal(getReminderRowAt(rows, 3), null);
  assert.equal(getReminderRowAt(rows, -1), null);
  assert.equal(getReminderRowAt(rows, 1.5), null);
  assert.equal(getReminderRowAt([], 0), null);
  assert.equal(buildReminderCardPlan(rows, 3), null);
});

test('a card carries an id-bound delete and a back button to the page its row sat on', () => {
  const rows = createRows(20);
  const card = buildReminderCardPlan(rows, 9);
  assert.ok(card);
  assert.equal(card.row.id, rows[9].id);
  assert.equal(card.listPage, 1);
  assert.deepEqual(getCallbackDataList(card.keyboard), [
    buildReminderDeleteCallback(rows[9].id),
    buildReminderListPageCallback(1),
  ]);
  assert.equal(getReminderCardBackPage(9), 1);
  assert.equal(getReminderCardBackPage(0), 0);
  assert.equal(getReminderCardBackPage(16), 2);
});

test('a delete tap resolves by ID — a removed reminder is «not found», never its neighbour', () => {
  const rows = createRows(5);
  const removedId = rows[3].id;
  assert.deepEqual(getReminderDeleteTarget(rows, removedId), { kind: 'found', row: rows[3] });

  const rowsAfterDelete = rows.filter((row) => row.id !== removedId);
  assert.deepEqual(
    getReminderDeleteTarget(rowsAfterDelete, removedId),
    { kind: 'notFound' },
    'a second tap on an already-deleted reminder must not delete anything',
  );
  // The contrast that makes the id-based resolution load-bearing: an INDEX-based
  // one would have hit a different reminder at the same position.
  assert.equal(getReminderRowAt(rowsAfterDelete, 3)?.id, rows[4].id);

  assert.deepEqual(getReminderDeleteTarget([], removedId), { kind: 'notFound' });
});

// ─── text shortening and name derivation ─────────────────────────────

test('a short body text is the name verbatim, with whitespace collapsed', () => {
  assert.equal(getReminderNameFromText('Buy milk'), 'Buy milk');
  assert.equal(getReminderNameFromText('  Call   mom\n\ntoday  '), 'Call mom today');
  assert.equal(getReminderNameFromText('a'.repeat(reminderNameMaxLength)), 'a'.repeat(reminderNameMaxLength));
});

test('a long body text is cut on a word boundary and ellipsised within the budget', () => {
  const name = getReminderNameFromText('Remember to call the dentist about the appointment tomorrow');
  assert.equal(name, 'Remember to call the dentist about the…');
  assert.ok(name.length <= reminderNameMaxLength);
  assert.ok(!name.includes('appointment'), 'the cut must not keep a partial word');

  // No space to cut at → a hard cut, still inside the budget.
  const single = getReminderNameFromText('b'.repeat(80));
  assert.equal(single.length, reminderNameMaxLength);
  assert.ok(single.endsWith('…'));
});

test('getShortenedText counts the ellipsis INSIDE the budget and prefers a word boundary', () => {
  // The one shortening rule behind the derived name, the wizard's text summary and
  // the list-row caption — three budgets, one cut, so they cannot drift.
  assert.equal(getShortenedText('Buy milk', 20), 'Buy milk', 'inside the budget is verbatim');
  assert.equal(getShortenedText('Buy milk', 8), 'Buy milk', 'exactly the budget is verbatim');
  assert.equal(getShortenedText('Take the evening pills', 12), 'Take the…');
  assert.ok(getShortenedText('Take the evening pills', 12).length <= 12);
  // No space to cut at → a hard cut, still inside the budget.
  assert.equal(getShortenedText('b'.repeat(40), 10), `${'b'.repeat(9)}…`);
  // A budget too small even for the ellipsis yields nothing rather than a stray «…».
  assert.equal(getShortenedText('Pills', 1), '');
  assert.equal(getShortenedText('Pills', 0), '');
  assert.equal(getShortenedText('', 0), '');
});

test('a body text with no letters or digits falls back to a stable name', () => {
  for (const text of ['', '   ', '\n\t ', '!!!', '🎉🎉🎉', '— — —']) {
    assert.equal(getReminderNameFromText(text), reminderNameFallback, `"${text}" must fall back`);
  }
  // Any script counts as usable, not just latin.
  assert.equal(getReminderNameFromText('Позвонить маме'), 'Позвонить маме');
  assert.equal(getReminderNameFromText('🎉 Party at 5'), '🎉 Party at 5');
});
