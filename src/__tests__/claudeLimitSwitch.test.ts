/**
 * @description Unit tests for {@link ../utils/claudeLimitSwitch} — switching a topic to another Claude account
 * profile on a usage limit: the opt-in toggle (OFF by default), who may take the work over (signed in, not
 * limited, fresh usage with room on the model's windows, never the limited profile itself), the auto / offer /
 * none decision, the limited-until mark, and the button codec with its stale-tap guard.
 *
 * A real usage limit is not inducible on demand, so this table is the proof that the auto-switch can never
 * loop onto an exhausted account and that an old notice's button can never move a topic later.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildClaudeLimitSwitchCallbackData,
  claudeLimitSwitchCallbackPrefix,
  claudeLimitSwitchCallbackRe,
  claudeLimitSwitchMaxOffers,
  decideClaudeLimitSwitch,
  getClaudeLimitSwitchTapDecision,
  parseClaudeLimitSwitchCallbackData,
  pickClaudeLimitSwitchCandidates,
  resolveClaudeAutoSwitchOnLimitEnabled,
  resolveClaudeLimitedUntil,
} from '../utils/claudeLimitSwitch';
import type { ClaudeProfileUsageView, ClaudeUsageSnapshot } from '../utils/claudeUsage';
import { checkIsCallbackDataWithinLimit } from '../utils/modelPickerPlan';

const nowMs = Date.parse('2026-10-12T10:00:00.000Z');

function buildUsage(input: { session: number; weekly: number; fable?: number; isStale?: boolean; resetsAt?: string }): ClaudeUsageSnapshot {
  const resetsAt = input.resetsAt ?? '2026-10-12T13:00:00.000Z';
  return {
    fetchedAt: '2026-10-12T09:59:00.000Z',
    source: 'api',
    isStale: input.isStale,
    buckets: [
      { kind: 'session', percent: input.session, resetsAt, scopeModel: null },
      { kind: 'weekly_all', percent: input.weekly, resetsAt: '2026-10-15T00:00:00.000Z', scopeModel: null },
      ...(input.fable === undefined ? [] : [{ kind: 'weekly_scoped' as const, percent: input.fable, resetsAt: '2026-10-15T00:00:00.000Z', scopeModel: 'Fable' }]),
    ],
  };
}

function buildProfile(name: string, patch: Partial<ClaudeProfileUsageView> = {}): ClaudeProfileUsageView {
  return {
    name,
    configDir: name === 'default' ? null : `/home/user/.telegramCode/claude-profiles/${name}`,
    loggedIn: true,
    email: `${name}@example.com`,
    subscriptionType: 'max',
    usage: buildUsage({ session: 20, weekly: 30, fable: 40 }),
    limitedUntil: null,
    ...patch,
  };
}

test('toggle: OFF when nothing is set — the auto-switch is opt-in', () => {
  assert.equal(resolveClaudeAutoSwitchOnLimitEnabled(undefined, undefined), false);
  assert.equal(resolveClaudeAutoSwitchOnLimitEnabled(true, undefined), true);
  assert.equal(resolveClaudeAutoSwitchOnLimitEnabled(true, false), false, 'a topic override wins');
  assert.equal(resolveClaudeAutoSwitchOnLimitEnabled(false, true), true);
});

test('candidates: the limited profile is never one, the rest are ordered by headroom on the model\'s windows', () => {
  const candidates = pickClaudeLimitSwitchCandidates({
    profiles: [
      buildProfile('default', { usage: buildUsage({ session: 100, weekly: 50, fable: 10 }) }),
      buildProfile('work', { usage: buildUsage({ session: 60, weekly: 20, fable: 5 }) }),
      buildProfile('spare', { usage: buildUsage({ session: 10, weekly: 70, fable: 5 }) }),
    ],
    currentName: 'default',
    model: 'claude-sonnet-4-5',
    nowMs,
  });
  // sonnet drains session + weekly_all: work → max 60 (headroom 40); spare → max 70 (headroom 30).
  assert.deepEqual(candidates, ['work', 'spare']);
});

test('candidates: the model picks the weekly window — Fable ranks on its own window', () => {
  const candidates = pickClaudeLimitSwitchCandidates({
    profiles: [
      buildProfile('default', { usage: buildUsage({ session: 100, weekly: 50, fable: 10 }) }),
      buildProfile('work', { usage: buildUsage({ session: 20, weekly: 10, fable: 90 }) }),
      buildProfile('spare', { usage: buildUsage({ session: 30, weekly: 90, fable: 15 }) }),
    ],
    currentName: 'default',
    model: 'fable',
    nowMs,
  });
  assert.deepEqual(candidates, ['spare', 'work']);
});

test('candidates: signed out, marked limited, stale, unknown usage and no headroom are all out', () => {
  const candidates = pickClaudeLimitSwitchCandidates({
    profiles: [
      buildProfile('default'),
      buildProfile('out', { loggedIn: false }),
      buildProfile('never', { loggedIn: undefined, usage: undefined }),
      buildProfile('marked', { limitedUntil: '2026-10-12T12:00:00.000Z' }),
      buildProfile('stale', { usage: buildUsage({ session: 5, weekly: 5, isStale: true }) }),
      buildProfile('unknown', { usage: undefined }),
      buildProfile('full', { usage: buildUsage({ session: 100, weekly: 5 }) }),
      buildProfile('expiredMark', { limitedUntil: '2026-10-12T09:00:00.000Z', usage: buildUsage({ session: 50, weekly: 5 }) }),
    ],
    currentName: 'default',
    model: 'opus',
    nowMs,
  });
  assert.deepEqual(candidates, ['expiredMark'], 'a mark in the past no longer excludes');
});

test('candidates: the default profile may take over too, when another one is at its limit', () => {
  const candidates = pickClaudeLimitSwitchCandidates({
    profiles: [buildProfile('default'), buildProfile('work')],
    currentName: 'work',
    model: null,
    nowMs,
  });
  assert.deepEqual(candidates, ['default']);
});

test('decision: no candidate → none, whatever the toggle says (the auto-switch never loops)', () => {
  assert.deepEqual(decideClaudeLimitSwitch({ candidates: [], isAutoSwitchEnabled: true }), { action: 'none' });
  assert.deepEqual(decideClaudeLimitSwitch({ candidates: [], isAutoSwitchEnabled: false }), { action: 'none' });
});

test('decision: toggle ON → auto to the best; OFF → an offer capped at the first few', () => {
  assert.deepEqual(decideClaudeLimitSwitch({ candidates: ['a', 'b', 'c'], isAutoSwitchEnabled: true }), { action: 'auto', to: 'a' });
  assert.deepEqual(decideClaudeLimitSwitch({ candidates: ['a', 'b', 'c'], isAutoSwitchEnabled: false }), {
    action: 'offer',
    candidates: ['a', 'b'].slice(0, claudeLimitSwitchMaxOffers),
  });
});

test('limited-until: the error\'s reset wins, else the session window ahead, else the fallback; a later mark is kept', () => {
  const usage = buildUsage({ session: 100, weekly: 10, resetsAt: '2026-10-12T13:00:00.000Z' });
  assert.equal(
    resolveClaudeLimitedUntil({ resetAtMs: Date.parse('2026-10-12T11:30:00.000Z'), usage, existingLimitedUntil: null, nowMs, fallbackMs: 3_600_000 }),
    '2026-10-12T11:30:00.000Z',
  );
  assert.equal(
    resolveClaudeLimitedUntil({ resetAtMs: undefined, usage, existingLimitedUntil: null, nowMs, fallbackMs: 3_600_000 }),
    '2026-10-12T13:00:00.000Z',
  );
  const pastWindow = buildUsage({ session: 100, weekly: 10, resetsAt: '2026-10-12T09:00:00.000Z' });
  assert.equal(
    resolveClaudeLimitedUntil({ resetAtMs: undefined, usage: pastWindow, existingLimitedUntil: null, nowMs, fallbackMs: 3_600_000 }),
    '2026-10-12T11:00:00.000Z',
  );
  assert.equal(
    resolveClaudeLimitedUntil({ resetAtMs: undefined, usage: undefined, existingLimitedUntil: null, nowMs, fallbackMs: 3_600_000 }),
    '2026-10-12T11:00:00.000Z',
  );
  assert.equal(
    resolveClaudeLimitedUntil({ resetAtMs: Date.parse('2026-10-12T11:30:00.000Z'), usage, existingLimitedUntil: '2026-10-12T15:00:00.000Z', nowMs, fallbackMs: 3_600_000 }),
    '2026-10-12T15:00:00.000Z',
  );
});

test('button data: bakes episode and name, round-trips, and the longest name fits Telegram\'s 64-byte cap', () => {
  const longest = 'a'.repeat(32);
  const data = buildClaudeLimitSwitchCallbackData(nowMs, longest);
  assert.ok(data.startsWith(claudeLimitSwitchCallbackPrefix));
  assert.ok(checkIsCallbackDataWithinLimit(data), `${data.length} bytes`);
  assert.deepEqual(parseClaudeLimitSwitchCallbackData(data), { episodeId: nowMs, name: longest });
  assert.deepEqual(parseClaudeLimitSwitchCallbackData(buildClaudeLimitSwitchCallbackData(1, 'default')), { episodeId: 1, name: 'default' });
  assert.ok(claudeLimitSwitchCallbackRe.test(data));
});

test('button data: foreign or malformed data is null', () => {
  assert.equal(parseClaudeLimitSwitchCallbackData('acct_use_work'), null);
  assert.equal(parseClaudeLimitSwitchCallbackData('acsw_x_work'), null);
  assert.equal(parseClaudeLimitSwitchCallbackData('acsw_1_Work'), null);
  assert.equal(parseClaudeLimitSwitchCallbackData('acsw_1_'), null);
});

test('tap: only the open episode\'s button switches; no open offer or another episode is a stale tap', () => {
  assert.equal(getClaudeLimitSwitchTapDecision({ openEpisodeId: nowMs, requestedEpisodeId: nowMs }), 'switch');
  assert.equal(getClaudeLimitSwitchTapDecision({ openEpisodeId: nowMs + 1, requestedEpisodeId: nowMs }), 'expired');
  assert.equal(getClaudeLimitSwitchTapDecision({ openEpisodeId: null, requestedEpisodeId: nowMs }), 'expired');
});
