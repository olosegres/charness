/**
 * @description The `/effort` picker as data: General's screen (the instance default, the Claude levels, ✓ on the
 * current default, no «as in General»), and a topic's (the level in force and its source, ✓ on that level,
 * «As in General (<value>)» last — only when the backend can clear a pick). Strings are the i18n keys with their
 * variables, so the test pins what the screen says without depending on a locale.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeEffortLevels } from '../effortLevels';
import { buildEffortLevelCallback, buildEffortPicker, effortLevelCallbackRe, effortSameCallback } from '../utils/effortPickerPlan';

/** A translator that shows which key was asked for and with what: `key{a=1,b=2}`. */
function translate(code: string, vars: Record<string, string | number> = {}): string {
  const rendered = Object.entries(vars).map(([name, value]) => `${name}=${value}`).join(',');
  return rendered ? `${code}{${rendered}}` : code;
}

const topicInput = {
  isGeneral: false as const,
  levels: claudeEffortLevels,
  inForce: 'medium',
  nextStartLevel: null,
  isOwnPick: false,
  instanceDefault: 'medium',
  canClear: true,
};

test('General: the instance default in the text, the Claude levels three to a row, ✓ on the default, nothing to follow', () => {
  const picker = buildEffortPicker({ isGeneral: true, levels: claudeEffortLevels, instanceDefault: 'xhigh' }, translate);
  assert.equal(picker.text, 'effort.general.choose{current=xhigh}');
  assert.deepEqual(picker.rows.map((row) => row.map((button) => button.text)), [
    ['low', 'medium', 'high'],
    ['xhigh ✓', 'max', 'auto'],
    ['ultracode'],
  ]);
  assert.deepEqual(picker.rows.flat().map((button) => button.data), claudeEffortLevels.map(buildEffortLevelCallback));
});

test('a topic that follows General: the level and «as in General», ✓ on the level, the button promises General\'s value', () => {
  const picker = buildEffortPicker(topicInput, translate);
  assert.equal(picker.text, 'effort.choose{current=medium,source=effort.sourceGeneral}');
  assert.equal(picker.rows.flat().filter((button) => button.text.endsWith('✓')).length, 1);
  assert.ok(picker.rows.flat().some((button) => button.text === 'medium ✓'));
  assert.deepEqual(picker.rows.at(-1), [{ text: 'effort.sameAsGeneralButton{level=medium}', data: effortSameCallback }]);
});

test('a topic with its own pick says so, and the ✓ is on the pick — not on General\'s value', () => {
  const picker = buildEffortPicker({ ...topicInput, inForce: 'high', isOwnPick: true, instanceDefault: 'low' }, translate);
  assert.equal(picker.text, 'effort.choose{current=high,source=effort.sourceTopic}');
  assert.ok(picker.rows.flat().some((button) => button.text === 'high ✓'));
  assert.ok(!picker.rows.flat().some((button) => button.text === 'low ✓'));
  assert.deepEqual(picker.rows.at(-1), [{ text: 'effort.sameAsGeneralButton{level=low}', data: effortSameCallback }]);
});

test('a backend that cannot clear a pick gets no «as in General» button', () => {
  const picker = buildEffortPicker({ ...topicInput, canClear: false }, translate);
  assert.ok(!picker.rows.flat().some((button) => button.data === effortSameCallback));
});

test('an OpenCode-style short level list is laid out the same way, and no ✓ appears for a level the model lacks', () => {
  const picker = buildEffortPicker({ ...topicInput, levels: ['high', 'max'], inForce: 'medium' }, translate);
  assert.deepEqual(picker.rows.map((row) => row.map((button) => button.text)).slice(0, 1), [['high', 'max']]);
  assert.ok(!picker.rows.flat().some((button) => button.text.includes('✓')));
});

test('the «as in General» data is not taken by the level-button pattern, and a level\'s data round-trips through it', () => {
  assert.equal(effortLevelCallbackRe.test(effortSameCallback), false, 'the two handlers must stay disjoint');
  assert.equal(effortLevelCallbackRe.exec(buildEffortLevelCallback('xhigh'))?.[1], 'xhigh');
});

test('a running session that keeps the old level says what the next start will use; the ✓ stays on the running level', () => {
  const picker = buildEffortPicker({ ...topicInput, inForce: 'xhigh', nextStartLevel: 'medium', instanceDefault: 'medium' }, translate);
  assert.equal(picker.text, 'effort.chooseNextStart{current=xhigh,next=medium,source=effort.sourceGeneral}');
  assert.ok(picker.rows.flat().some((button) => button.text === 'xhigh ✓'));
  assert.ok(!picker.rows.flat().some((button) => button.text === 'medium ✓'));
});

test('«As in General» names the level the topic will really get — General\'s value rounded to what the model offers', () => {
  // The model stops at high: General\'s xhigh is high for this topic, and the button says so.
  const picker = buildEffortPicker({ ...topicInput, levels: ['low', 'medium', 'high'], inForce: 'high', instanceDefault: 'high' }, translate);
  assert.deepEqual(picker.rows.at(-1), [{ text: 'effort.sameAsGeneralButton{level=high}', data: effortSameCallback }]);
});
