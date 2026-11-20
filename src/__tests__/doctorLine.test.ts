/**
 * @description `/doctor` line wording: a warning without a hint is the label alone, not `label — `.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { t, checkKeyInAllLangs, localeCodes, getKeyInLang } from '../i18n';
import { formatDoctorLine, getPrivacyDoctorLine } from '../utils/doctorLine';
import { enDict } from '../i18n/en';

test('an ok line is the label behind a check mark', () => {
  assert.equal(formatDoctorLine({ status: 'ok', label: 'tmux found' }, t), '✅ tmux found');
});

test('a warning with a hint reads label — hint', () => {
  assert.equal(formatDoctorLine({ status: 'warn', label: 'claude CLI installed', hint: 'not found' }, t), '⚠️ claude CLI installed — not found');
});

test('a warning without a hint is the label alone — no dangling dash', () => {
  assert.equal(formatDoctorLine({ status: 'warn', label: 'previous state was corrupted' }, t), '⚠️ previous state was corrupted');
  assert.equal(formatDoctorLine({ status: 'warn', label: 'previous state was corrupted', hint: '' }, t), '⚠️ previous state was corrupted');
});

test('a failure reads label — hint', () => {
  assert.equal(formatDoctorLine({ status: 'fail', label: 'can_manage_topics granted', hint: 'grant it' }, t), '❌ can_manage_topics granted — grant it');
});

test('doctor.warnWithoutHint exists in every locale and keeps the {label} placeholder', () => {
  assert.ok(checkKeyInAllLangs('doctor.warnWithoutHint'));
  for (const locale of localeCodes) {
    assert.ok(getKeyInLang(locale, 'doctor.warnWithoutHint')?.includes('{label}'), `doctor.warnWithoutHint in ${locale} lost the {label} placeholder`);
  }
});

test('an admin bot gets no privacy line: Telegram sends a group admin every message, so the flag decides nothing', () => {
  assert.equal(getPrivacyDoctorLine({ isBotAdmin: true, canReadAllGroupMessages: false }, t), null);
  assert.equal(getPrivacyDoctorLine({ isBotAdmin: true, canReadAllGroupMessages: true }, t), null);
});

test('a bot that is not an admin is checked on the privacy flag: off is fine, on fails with the BotFather hint', () => {
  const hint = t('doctor.privacy_hint');
  assert.deepEqual(getPrivacyDoctorLine({ isBotAdmin: false, canReadAllGroupMessages: true }, t), { status: 'ok', label: t('doctor.privacy_off'), hint });
  assert.deepEqual(getPrivacyDoctorLine({ isBotAdmin: false, canReadAllGroupMessages: false }, t), { status: 'fail', label: t('doctor.privacy_off'), hint });
  assert.equal(getPrivacyDoctorLine({ isBotAdmin: false, canReadAllGroupMessages: undefined }, t)?.status, 'fail', 'a flag Telegram did not report is not taken as «off»');
});

test('the privacy hint offers making the bot an admin first, BotFather second — in every locale', () => {
  assert.ok(enDict['doctor.privacy_hint'].startsWith('Make the bot a group admin — or @BotFather'));
  for (const locale of localeCodes) {
    const hint = getKeyInLang(locale, 'doctor.privacy_hint');
    assert.ok(hint?.includes('/setprivacy'), `doctor.privacy_hint in ${locale} still names the BotFather route`);
    assert.ok(locale === 'en' || hint !== enDict['doctor.privacy_hint'], `doctor.privacy_hint in ${locale} is translated`);
    assert.ok(!hint?.startsWith('@BotFather'), `doctor.privacy_hint in ${locale} puts the admin advice before the BotFather route`);
  }
});
