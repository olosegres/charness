/**
 * The choices of the «limit reminders» setting and the rule that picks the interval a topic is under
 * (`limitNotes/reminderChoices.ts`): General's value, a topic's own, the default, Off, and a stored number no choice names.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkIsLimitReminderChoice,
  checkIsLimitReminderMinutes,
  limitReminderChoices,
  limitReminderDefaultMinutes,
  limitReminderIntervalOptions,
  limitReminderOffMinutes,
  resolveLimitRemindersMinutes,
} from '../limitNotes/reminderChoices';

describe('resolveLimitRemindersMinutes: the interval a topic is under', () => {
  it('nobody chose: the default hour; General\'s choice stands for a topic with none', () => {
    assert.equal(resolveLimitRemindersMinutes(undefined, undefined), limitReminderDefaultMinutes);
    assert.equal(resolveLimitRemindersMinutes(null, null), limitReminderDefaultMinutes, 'a settings.json that says nothing reads as null');
    assert.equal(limitReminderDefaultMinutes, 60);
    assert.equal(resolveLimitRemindersMinutes(120, undefined), 120);
    assert.equal(resolveLimitRemindersMinutes(240, null), 240);
  });

  it('a topic\'s own choice beats General in both directions: its interval over General\'s Off, its Off over General\'s interval', () => {
    assert.equal(resolveLimitRemindersMinutes(120, 240), 240);
    assert.equal(resolveLimitRemindersMinutes(limitReminderOffMinutes, 60), 60);
    assert.equal(resolveLimitRemindersMinutes(60, limitReminderOffMinutes), null);
    assert.equal(resolveLimitRemindersMinutes(limitReminderOffMinutes, undefined), null);
  });

  it('a stored number no choice names counts as no choice at that level', () => {
    assert.equal(resolveLimitRemindersMinutes(120, 90), 120, 'a topic value of 90 min is no choice: General decides');
    assert.equal(resolveLimitRemindersMinutes(45, undefined), limitReminderDefaultMinutes, 'a General value of 45 min is no choice: the default');
    assert.equal(resolveLimitRemindersMinutes(Number.NaN, Number.NaN), limitReminderDefaultMinutes);
  });
});

describe('the choices', () => {
  it('the offered intervals are 1 h, 2 h and 4 h; the stored choices add Off (0) in front', () => {
    assert.deepEqual([...limitReminderIntervalOptions], [60, 120, 240]);
    assert.deepEqual([...limitReminderChoices], [0, 60, 120, 240]);
  });

  it('only an interval passes the interval guard — Off is the picker\'s own button, not an interval', () => {
    assert.equal(checkIsLimitReminderMinutes(120), true);
    assert.equal(checkIsLimitReminderMinutes(limitReminderOffMinutes), false);
    assert.equal(checkIsLimitReminderMinutes(90), false);
    assert.equal(checkIsLimitReminderMinutes(undefined), false);
    assert.equal(checkIsLimitReminderMinutes(null), false);
  });

  it('an interval or Off passes the choice guard, anything else a hand-edited file may hold does not', () => {
    for (const choice of [0, 60, 120, 240]) assert.equal(checkIsLimitReminderChoice(choice), true, `${choice}`);
    for (const stored of [90, -60, 1.5, Number.NaN, 300, undefined, null]) assert.equal(checkIsLimitReminderChoice(stored), false, `${stored}`);
  });
});
