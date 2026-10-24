/**
 * @description `/doctor` line wording: a warning without a hint is the label alone, not `label — `.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { t, checkKeyInAllLangs, localeCodes, getKeyInLang } from '../i18n';
import { formatDoctorLine } from '../utils/doctorLine';

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
