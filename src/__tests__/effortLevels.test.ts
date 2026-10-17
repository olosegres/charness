/**
 * @description Catalog unit tests for the Claude `/effort` level set — the
 * pure-function pieces of the /effort feature. OpenCode effort levels are
 * the live model's variants (no pure helper to unit-test); they're covered
 * by the adapter against `GET /config/providers`.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  claudeEffortLevels,
  getClaudeAvailableLevels,
  checkIsClaudeEffortLevel,
  defaultEffortLevel,
  clampEffortToAvailable,
  getEffortAmongLevels,
  getInstanceDefaultEffort,
  getThreadEffortView,
  setInstanceDefaultEffortReader,
} from '../effortLevels';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';

// ── Claude canonical catalog ────────────────────────────────────────────────

test('claudeEffortLevels — exactly the verified set, in display order', () => {
  // The exact order matters: it's the order the picker buttons appear in
  // and the order the unit-test below relies on. Locked against the
  // research baseline (verified `claude 2.1.158`).
  assert.deepEqual(
    [...claudeEffortLevels],
    ['low', 'medium', 'high', 'xhigh', 'max', 'auto', 'ultracode'],
  );
});

test('getClaudeAvailableLevels returns a mutable copy of the canonical list', () => {
  const a = getClaudeAvailableLevels();
  const b = getClaudeAvailableLevels();
  assert.deepEqual(a, b);
  assert.notEqual(a, b, 'callers must not share the same array instance');
  // Mutation of a returned copy must not affect the next call.
  a.push('garbage');
  assert.deepEqual(getClaudeAvailableLevels(), [...claudeEffortLevels]);
});

test('checkIsClaudeEffortLevel — accept canonical, reject anything else', () => {
  for (const level of claudeEffortLevels) {
    assert.ok(checkIsClaudeEffortLevel(level), `expected ${level} to be valid`);
  }
  // Empty, uppercase, common typos, opencode-only labels (`none`/`minimal`).
  for (const bad of ['', 'HIGH', 'highest', 'none', 'minimal', 'xxhigh', ' high', 'high ']) {
    assert.ok(!checkIsClaudeEffortLevel(bad), `expected "${bad}" to be rejected`);
  }
});

// ── Default level + clamp ───────────────────────────────────────────────────

test('defaultEffortLevel is medium', () => {
  assert.equal(defaultEffortLevel, 'medium');
});

// ── The instance default (settings.json) ────────────────────────────────────

test('getInstanceDefaultEffort — no reader registered: the code fallback', () => {
  assert.equal(getInstanceDefaultEffort(), defaultEffortLevel);
});

test('getInstanceDefaultEffort — the registered reader wins, and null falls back to the code default; read per call', () => {
  try {
    let fileSays: 'high' | null = 'high';
    setInstanceDefaultEffortReader(() => fileSays);
    assert.equal(getInstanceDefaultEffort(), 'high');
    fileSays = null;
    assert.equal(getInstanceDefaultEffort(), defaultEffortLevel, 'a hand edit that removes the field applies to the next read');
  } finally {
    setInstanceDefaultEffortReader(() => null);
  }
});

test('getThreadEffortView — the RUNNING session\'s level wins; the next start\'s level rides along only when it differs', () => {
  const key = makeTelegramKey(-1001111111111, 9);
  const stateOf = (running: string | null, nextStart: string) => ({ getEffortState: () => ({ running, nextStart }) });
  assert.deepEqual(getThreadEffortView(stateOf('xhigh', 'medium'), key), { level: 'xhigh', nextStartLevel: 'medium' }, 'the default changed under the running session');
  assert.deepEqual(getThreadEffortView(stateOf('medium', 'medium'), key), { level: 'medium', nextStartLevel: null }, 'nothing to say when they agree');
  assert.deepEqual(getThreadEffortView(stateOf(null, 'low'), key), { level: 'low', nextStartLevel: null }, 'no running session (or an unknown level): what the next start will use');
});

test('getThreadEffortView — null for a backend with no effort concept, and for a thread whose model offers no levels', () => {
  assert.equal(getThreadEffortView({}, makeTelegramKey(-1001111111111, 9)), null);
  assert.equal(getThreadEffortView({ getEffortState: () => null }, makeTelegramKey(-1001111111111, 9)), null);
});

test('getEffortAmongLevels — the level itself when offered, else the nearest the model has, else the level as it is', () => {
  assert.equal(getEffortAmongLevels('xhigh', ['low', 'medium', 'high', 'xhigh', 'max']), 'xhigh');
  assert.equal(getEffortAmongLevels('xhigh', ['high', 'max']), 'high');
  assert.equal(getEffortAmongLevels('ultracode', ['low', 'medium', 'high']), 'high');
  assert.equal(getEffortAmongLevels('auto', ['low', 'medium', 'high']), 'auto', 'auto sends no variant: there is no nearer level to name');
  assert.equal(getEffortAmongLevels('medium', []), 'medium', 'a model with no variants: the level is left as it is');
});

test('clampEffortToAvailable — xhigh against full opus-4-8 set is kept', () => {
  assert.equal(
    clampEffortToAvailable('xhigh', ['low', 'medium', 'high', 'xhigh', 'max']),
    'xhigh',
  );
});

test('clampEffortToAvailable — no xhigh → highest below it (high), not max', () => {
  // sonnet/haiku-style sets that stop at high/max: xhigh isn't there, so the
  // closest level at-or-below xhigh wins. high (rank 3) ≤ xhigh, max (rank 5) >.
  assert.equal(clampEffortToAvailable('xhigh', ['high', 'max']), 'high');
});

test('clampEffortToAvailable — opus-4-5 style [low,medium,high] → high', () => {
  assert.equal(clampEffortToAvailable('xhigh', ['low', 'medium', 'high']), 'high');
});

test('clampEffortToAvailable — empty available → null (no effort concept)', () => {
  assert.equal(clampEffortToAvailable('xhigh', []), null);
});

test('clampEffortToAvailable — none-prefixed set still resolves to high', () => {
  assert.equal(clampEffortToAvailable('xhigh', ['none', 'low', 'medium', 'high']), 'high');
});

test('clampEffortToAvailable — only-max set → max (closest above when none below)', () => {
  // max (rank 5) is the only known variant and it is ABOVE xhigh, so it is
  // returned as the closest-above fallback.
  assert.equal(clampEffortToAvailable('xhigh', ['max']), 'max');
});

test('clampEffortToAvailable — only-unknown variants → null', () => {
  assert.equal(clampEffortToAvailable('xhigh', ['weird']), null);
});

test('clampEffortToAvailable — ultracode is the model\'s HIGHEST variant, whatever its set (it must never fall to the lowest)', () => {
  assert.equal(clampEffortToAvailable('ultracode', ['low', 'medium', 'high', 'xhigh', 'max']), 'max');
  assert.equal(clampEffortToAvailable('ultracode', ['high', 'max']), 'max');
  assert.equal(clampEffortToAvailable('ultracode', ['low', 'medium', 'high']), 'high');
  assert.equal(clampEffortToAvailable('ultracode', ['none', 'low']), 'low');
  assert.equal(clampEffortToAvailable('ultracode', ['max']), 'max');
  assert.equal(clampEffortToAvailable('ultracode', ['weird']), null, 'no known variant: no effort concept');
});

test('clampEffortToAvailable — auto sends NO variant, whatever the model offers', () => {
  assert.equal(clampEffortToAvailable('auto', ['low', 'medium', 'high', 'xhigh', 'max']), null);
  assert.equal(clampEffortToAvailable('auto', ['high', 'max']), null);
  assert.equal(clampEffortToAvailable('auto', []), null);
});
