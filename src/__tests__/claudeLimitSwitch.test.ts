/**
 * @description Unit tests for {@link ../utils/claudeLimitSwitch} — the within-Claude account ranking a usage
 * limit falls back to when no fallback chain is configured (`utils/fallbackChain.ts` holds the chain, the
 * decision and the buttons): the opt-in toggle (OFF by default), who may take the work over (signed in, not
 * limited, fresh usage with room on the model's windows, never the limited profile itself) and the
 * limited-until mark.
 *
 * A real usage limit is not inducible on demand, so this table is the proof that the ranking can never name an
 * exhausted account.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  pickClaudeLimitSwitchCandidates,
  resolveClaudeAutoSwitchOnLimitEnabled,
  resolveClaudeLimitedUntil,
} from '../utils/claudeLimitSwitch';
import type { ClaudeProfileUsageView, ClaudeUsageSnapshot } from '../utils/claudeUsage';

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
    configDir: name === 'default' ? null : `/home/user/.charness/claude-profiles/${name}`,
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

test('candidates: Fable ranks on the shared windows AND its own, another model on the shared ones only', () => {
  const profiles = [
    buildProfile('default', { usage: buildUsage({ session: 100, weekly: 50, fable: 10 }) }),
    buildProfile('work', { usage: buildUsage({ session: 20, weekly: 10, fable: 90 }) }),
    buildProfile('spare', { usage: buildUsage({ session: 30, weekly: 60, fable: 15 }) }),
    buildProfile('sharedFull', { usage: buildUsage({ session: 5, weekly: 100, fable: 5 }) }),
  ];
  const forFable = pickClaudeLimitSwitchCandidates({ profiles, currentName: 'default', model: 'fable', nowMs });
  assert.deepEqual(forFable, ['spare', 'work'], 'work is at 90 % on Fable\'s window, spare at 60 % on the shared weekly; sharedFull has no room on the shared weekly window Fable drains too');
  const forOpus = pickClaudeLimitSwitchCandidates({ profiles, currentName: 'default', model: 'opus', nowMs });
  assert.deepEqual(forOpus, ['work', 'spare'], 'opus never touches Fable\'s window; sharedFull is out for it as well');
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
