/**
 * The screens of `/limits_reminders` as pure data (`utils/limitRemindersScreenPlan.ts`): the codec of the picker's buttons, the picker of
 * General and of a topic, the confirmation a tap turns it into, the label of the `/limits` row — and the same screens in EVERY locale
 * (the strings exist, no placeholder is left, the buttons' data never depends on the language).
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { localeCodes, runWithLocale, t } from '../i18n';
import { enDict } from '../i18n/en';
import { limitReminderChoices } from '../limitNotes/reminderChoices';
import {
  buildLimitRemindersCallbackData,
  buildLimitRemindersConfirmation,
  buildLimitRemindersRowLabel,
  buildLimitRemindersScreen,
  formatLimitRemindersValue,
  limitRemindersCallbackRe,
  parseLimitRemindersCallbackData,
  type LimitRemindersPick,
} from '../utils/limitRemindersScreenPlan';

const labelsOf = (screen: ReturnType<typeof buildLimitRemindersScreen>): string[][] => screen.rows.map((row) => row.map((button) => button.label));
const dataOf = (screen: ReturnType<typeof buildLimitRemindersScreen>): string[][] => screen.rows.map((row) => row.map((button) => button.data));

describe('the callback codec', () => {
  it('every pick has its own data: lrm_<minutes>, Off as lrm_0, «as General» as lrm_g — and it is parsed back to the same pick', () => {
    const picks: LimitRemindersPick[] = [60, 120, 240, 0, 'general'];
    assert.deepEqual(picks.map(buildLimitRemindersCallbackData), ['lrm_60', 'lrm_120', 'lrm_240', 'lrm_0', 'lrm_g']);
    for (const pick of picks) assert.equal(parseLimitRemindersCallbackData(buildLimitRemindersCallbackData(pick)), pick);
  });

  it('the pattern matches exactly the buttons the picker offers and nothing a hand-made callback could carry', () => {
    for (const data of ['lrm_g', ...limitReminderChoices.map((choice) => `lrm_${choice}`)]) assert.match(data, limitRemindersCallbackRe);
    for (const data of ['lrm_', 'lrm_90', 'lrm_600', 'lrm_-60', 'lrm_g0', 'lrm_60 ', ' lrm_60', 'lrm_gg', 'lrm_1e2', 'qw_60', 'lim_rem']) {
      assert.doesNotMatch(data, limitRemindersCallbackRe, data);
      assert.equal(parseLimitRemindersCallbackData(data), null, data);
    }
  });

  it('a button\'s data fits Telegram\'s 64 bytes by far', () => {
    for (const choice of limitReminderChoices) assert.ok(Buffer.byteLength(buildLimitRemindersCallbackData(choice)) <= 64);
  });
});

describe('the picker', () => {
  it('General, nothing chosen: «every 1 h (default)» and ✓ on 1 h', () => {
    const screen = buildLimitRemindersScreen({ isGeneral: true, generalChoice: null, ownChoice: undefined });
    assert.equal(screen.text, ['🔔 Limit reminders to agents', enDict['limitReminders.explanationText'], 'Now: every 1 h (default)'].join('\n\n'));
    assert.deepEqual(labelsOf(screen), [['1 h ✓', '2 h', '4 h', 'Off']]);
    assert.deepEqual(dataOf(screen), [['lrm_60', 'lrm_120', 'lrm_240', 'lrm_0']]);
  });

  it('General, a chosen interval or Off: no «(default)», the mark follows the value; a topic\'s own choice is ignored there', () => {
    assert.ok(buildLimitRemindersScreen({ isGeneral: true, generalChoice: 60, ownChoice: undefined }).text.endsWith('Now: every 1 h'), 'chosen 1 h is no default');
    const four = buildLimitRemindersScreen({ isGeneral: true, generalChoice: 240, ownChoice: 120 });
    assert.deepEqual(labelsOf(four), [['1 h', '2 h', '4 h ✓', 'Off']]);
    const off = buildLimitRemindersScreen({ isGeneral: true, generalChoice: 0, ownChoice: undefined });
    assert.ok(off.text.endsWith('Now: off'));
    assert.deepEqual(labelsOf(off), [['1 h', '2 h', '4 h', 'Off ✓']]);
  });

  it('a topic that follows General: «as General (…)» with General\'s value (the default included), ✓ on «As General» only', () => {
    const screen = buildLimitRemindersScreen({ isGeneral: false, generalChoice: null, ownChoice: undefined });
    assert.equal(screen.text, ['🔔 Limit reminders to agents — this topic', enDict['limitReminders.explanationText'], 'Now: as General (every 1 h)'].join('\n\n'));
    assert.deepEqual(labelsOf(screen), [['As General ✓'], ['1 h', '2 h', '4 h', 'Off']]);
    assert.deepEqual(dataOf(screen), [['lrm_g'], ['lrm_60', 'lrm_120', 'lrm_240', 'lrm_0']]);
    assert.ok(buildLimitRemindersScreen({ isGeneral: false, generalChoice: 0, ownChoice: undefined }).text.endsWith('Now: as General (off)'));
  });

  it('a topic with its own choice: that value, ✓ on it, none on «As General»', () => {
    const screen = buildLimitRemindersScreen({ isGeneral: false, generalChoice: 240, ownChoice: 0 });
    assert.ok(screen.text.endsWith('Now: off'));
    assert.deepEqual(labelsOf(screen), [['As General'], ['1 h', '2 h', '4 h', 'Off ✓']]);
  });
});

describe('the confirmation and the row', () => {
  it('General: «(all topics without their own choice)»; a topic: «(this topic)»; a topic back on General: «as General — …»', () => {
    assert.equal(buildLimitRemindersConfirmation({ isGeneral: true, generalChoice: 120, ownChoice: undefined, pick: 120 }), '🔔 Limit reminders: every 2 h (all topics without their own choice).');
    assert.equal(buildLimitRemindersConfirmation({ isGeneral: true, generalChoice: 0, ownChoice: undefined, pick: 0 }), '🔔 Limit reminders: off (all topics without their own choice).');
    assert.equal(buildLimitRemindersConfirmation({ isGeneral: false, generalChoice: null, ownChoice: 120, pick: 120 }), '🔔 Limit reminders: every 2 h (this topic).');
    assert.equal(buildLimitRemindersConfirmation({ isGeneral: false, generalChoice: 240, ownChoice: undefined, pick: 'general' }), '🔔 Limit reminders: as General — every 4 h (this topic).');
    assert.equal(buildLimitRemindersConfirmation({ isGeneral: false, generalChoice: null, ownChoice: undefined, pick: 'general' }), '🔔 Limit reminders: as General — every 1 h (this topic).', 'General says nothing: the default');
  });

  it('the /limits row is the value in force, the way the notes resolve it: own beats General, General beats the default, Off reads «off»', () => {
    assert.equal(buildLimitRemindersRowLabel({ generalChoice: null, ownChoice: undefined }), '🔔 Reminders: every 1 h');
    assert.equal(buildLimitRemindersRowLabel({ generalChoice: 240, ownChoice: undefined }), '🔔 Reminders: every 4 h');
    assert.equal(buildLimitRemindersRowLabel({ generalChoice: 240, ownChoice: 0 }), '🔔 Reminders: off');
    assert.equal(buildLimitRemindersRowLabel({ generalChoice: 0, ownChoice: 120 }), '🔔 Reminders: every 2 h');
    assert.equal(formatLimitRemindersValue(null), 'off');
    assert.equal(formatLimitRemindersValue(60), 'every 1 h');
  });
});

describe('in every locale', () => {
  const keys = Object.keys(enDict).filter((key) => key.startsWith('limitReminders.') || key === 'limits.remindersRowLabel');

  it('the strings exist (15 of them), and a language that is not English says them in its own words', () => {
    assert.equal(keys.length, 15);
    for (const locale of localeCodes) {
      for (const key of keys) {
        const text = runWithLocale(locale, () => t(key as keyof typeof enDict));
        assert.ok(text.trim().length > 0, `${locale} ${key}`);
        if (locale !== 'en' && key === 'limitReminders.explanationText') assert.notEqual(text, enDict['limitReminders.explanationText'], `${locale}: the explanation is translated`);
      }
    }
  });

  it('every screen renders with no placeholder left, the same buttons and the same data as English — only the words change', () => {
    const scopes = [
      { isGeneral: true, generalChoice: null, ownChoice: undefined },
      { isGeneral: true, generalChoice: 0, ownChoice: undefined },
      { isGeneral: false, generalChoice: 120, ownChoice: undefined },
      { isGeneral: false, generalChoice: null, ownChoice: 0 },
    ] as const;
    for (const scope of scopes) {
      const english = runWithLocale('en', () => buildLimitRemindersScreen(scope));
      for (const locale of localeCodes) {
        const screen = runWithLocale(locale, () => buildLimitRemindersScreen(scope));
        assert.deepEqual(dataOf(screen), dataOf(english), `${locale}: the data never depends on the language`);
        const everyLabel = labelsOf(screen).flat();
        assert.equal(everyLabel.length, labelsOf(english).flat().length, `${locale}: the same number of buttons`);
        for (const text of [screen.text, ...everyLabel]) assert.doesNotMatch(text, /[{}]/, `${locale}: ${text}`);
        assert.equal(everyLabel.filter((label) => label.endsWith(' ✓')).length, 1, `${locale}: exactly one ✓`);
        assert.ok(screen.text.startsWith('🔔'), `${locale}: the title keeps its mark`);
      }
    }
  });

  it('the confirmations and the row render with no placeholder left, naming the value', () => {
    for (const locale of localeCodes) {
      runWithLocale(locale, () => {
        const texts = [
          buildLimitRemindersConfirmation({ isGeneral: true, generalChoice: 120, ownChoice: undefined, pick: 120 }),
          buildLimitRemindersConfirmation({ isGeneral: false, generalChoice: null, ownChoice: 240, pick: 240 }),
          buildLimitRemindersConfirmation({ isGeneral: false, generalChoice: 240, ownChoice: undefined, pick: 'general' }),
          buildLimitRemindersConfirmation({ isGeneral: false, generalChoice: null, ownChoice: 0, pick: 0 }),
          buildLimitRemindersRowLabel({ generalChoice: 120, ownChoice: undefined }),
          buildLimitRemindersRowLabel({ generalChoice: null, ownChoice: 0 }),
        ];
        for (const text of texts) assert.doesNotMatch(text, /[{}]/, `${locale}: ${text}`);
        assert.ok(texts[0].includes('2'), `${locale}: the interval is named: ${texts[0]}`);
        assert.ok(texts[4].startsWith('🔔'), `${locale}: the row keeps its bell`);
      });
    }
  });
});
