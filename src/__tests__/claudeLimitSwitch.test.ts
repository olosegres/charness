/**
 * @description Unit tests for {@link ../utils/claudeLimitSwitch} — the within-Claude account ranking a usage
 * limit falls back to when no fallback chain is configured (`utils/fallbackChain.ts` holds the chain, the
 * decision and the buttons): the toggle (ON by default), who may take the work over (signed in, not
 * limited, fresh usage with room on the model's windows and the five-hour window below the launch ceiling,
 * never the limited profile itself), in what order (the soonest weekly reset first) and the limited-until mark.
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

const defaultWeeklyResetsAt = '2026-10-15T00:00:00.000Z';

function buildUsage(input: { session: number; weekly: number; fable?: number; isStale?: boolean; resetsAt?: string; weeklyResetsAt?: string; fableResetsAt?: string }): ClaudeUsageSnapshot {
  const resetsAt = input.resetsAt ?? '2026-10-12T13:00:00.000Z';
  const weeklyResetsAt = input.weeklyResetsAt ?? defaultWeeklyResetsAt;
  return {
    fetchedAt: '2026-10-12T09:59:00.000Z',
    source: 'api',
    isStale: input.isStale,
    buckets: [
      { kind: 'session', percent: input.session, resetsAt, scopeModel: null },
      { kind: 'weekly_all', percent: input.weekly, resetsAt: weeklyResetsAt, scopeModel: null },
      ...(input.fable === undefined ? [] : [{ kind: 'weekly_scoped' as const, percent: input.fable, resetsAt: input.fableResetsAt ?? weeklyResetsAt, scopeModel: 'Fable' }]),
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
    billing: null,
    creditExhaustedAt: null,
    ...patch,
  };
}

test('toggle: ON when nothing is set — an explicit OFF is kept', () => {
  assert.equal(resolveClaudeAutoSwitchOnLimitEnabled(undefined, undefined), true);
  assert.equal(resolveClaudeAutoSwitchOnLimitEnabled(false, undefined), false, 'an instance where it was turned off stays off');
  assert.equal(resolveClaudeAutoSwitchOnLimitEnabled(true, false), false, 'a topic override wins');
  assert.equal(resolveClaudeAutoSwitchOnLimitEnabled(false, true), true);
});

test('candidates: the limited profile is never one, the rest are ordered by the soonest weekly reset — not by headroom', () => {
  const candidates = pickClaudeLimitSwitchCandidates({
    profiles: [
      buildProfile('default', { usage: buildUsage({ session: 100, weekly: 50, fable: 10 }) }),
      buildProfile('roomy', { usage: buildUsage({ session: 10, weekly: 5, weeklyResetsAt: '2026-10-18T00:00:00.000Z' }) }),
      buildProfile('soon', { usage: buildUsage({ session: 60, weekly: 70, weeklyResetsAt: '2026-10-13T00:00:00.000Z' }) }),
      buildProfile('middle', { usage: buildUsage({ session: 20, weekly: 30, weeklyResetsAt: '2026-10-15T00:00:00.000Z' }) }),
    ],
    currentName: 'default',
    model: 'claude-sonnet-4-5',
    nowMs,
  });
  assert.deepEqual(candidates, ['soon', 'middle', 'roomy'], 'roomy has the most headroom but resets a week out: spend what burns first');
});

test('candidates: a tie on the weekly reset goes to the lower five-hour percent, then the input order', () => {
  const candidates = pickClaudeLimitSwitchCandidates({
    profiles: [
      buildProfile('default'),
      buildProfile('busy', { usage: buildUsage({ session: 60, weekly: 20 }) }),
      buildProfile('quiet', { usage: buildUsage({ session: 10, weekly: 70 }) }),
      buildProfile('quietToo', { usage: buildUsage({ session: 10, weekly: 40 }) }),
    ],
    currentName: 'default',
    model: 'opus',
    nowMs,
  });
  assert.deepEqual(candidates, ['quiet', 'quietToo', 'busy']);
});

test('candidates: Fable ranks on the earlier of the shared and its own weekly reset, another model on the shared one only', () => {
  const profiles = [
    buildProfile('default', { usage: buildUsage({ session: 100, weekly: 50, fable: 10 }) }),
    buildProfile('ownWindow', { usage: buildUsage({ session: 20, weekly: 10, fable: 90, weeklyResetsAt: '2026-10-17T00:00:00.000Z', fableResetsAt: '2026-10-13T00:00:00.000Z' }) }),
    buildProfile('shared', { usage: buildUsage({ session: 30, weekly: 60, fable: 15, weeklyResetsAt: '2026-10-15T00:00:00.000Z' }) }),
    buildProfile('sharedFull', { usage: buildUsage({ session: 5, weekly: 100, fable: 5, weeklyResetsAt: '2026-10-12T20:00:00.000Z' }) }),
    buildProfile('fableFull', { usage: buildUsage({ session: 5, weekly: 5, fable: 100, weeklyResetsAt: '2026-10-16T00:00:00.000Z' }) }),
  ];
  const forFable = pickClaudeLimitSwitchCandidates({ profiles, currentName: 'default', model: 'fable', nowMs });
  assert.deepEqual(forFable, ['ownWindow', 'shared'], 'ownWindow\'s Fable window resets first; sharedFull and fableFull have no room on a window Fable drains');
  const forOpus = pickClaudeLimitSwitchCandidates({ profiles, currentName: 'default', model: 'opus', nowMs });
  assert.deepEqual(forOpus, ['shared', 'fableFull', 'ownWindow'], 'opus never touches Fable\'s window: fableFull is in, sharedFull is out');
});

test('candidates: an account whose five-hour window is at the 90 % ceiling is left out', () => {
  const profiles = [
    buildProfile('default'),
    buildProfile('atCeiling', { usage: buildUsage({ session: 90, weekly: 5, weeklyResetsAt: '2026-10-13T00:00:00.000Z' }) }),
    buildProfile('below', { usage: buildUsage({ session: 89, weekly: 5, weeklyResetsAt: '2026-10-14T00:00:00.000Z' }) }),
  ];
  assert.deepEqual(pickClaudeLimitSwitchCandidates({ profiles, currentName: 'default', model: 'opus', nowMs }), ['below']);
});

test('candidates: a window whose reset has passed since the reading counts as empty — rolled to its next period', () => {
  const profiles = [
    buildProfile('default'),
    buildProfile('rolledOver', { usage: buildUsage({ session: 100, weekly: 100, resetsAt: '2026-10-12T09:00:00.000Z', weeklyResetsAt: '2026-10-12T09:30:00.000Z' }) }),
  ];
  assert.deepEqual(pickClaudeLimitSwitchCandidates({ profiles, currentName: 'default', model: 'opus', nowMs }), ['rolledOver']);
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
