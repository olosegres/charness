/**
 * `utils/claudeUsage.ts` — the per-profile usage model: the endpoint's response, the stream frames' windows,
 * the snapshot merge, the ranking behind `claude_profiles` and the human formats. Fixtures are the shapes
 * MEASURED on 2026-10-12 (one GET under the default profile, live `rate_limit_event` frames), ids and
 * emails replaced.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { formatClaudeProfileCliLine } from '../cli/claudeProfiles';
import {
  buildBucketsFromRateLimitWindows,
  buildClaudeProfileUsageView,
  buildClaudeProfileUsageViews,
  buildClaudeProfilesReport,
  checkClaudeUsageBucketsChanged,
  checkHasHeadroomForClaudeModel,
  checkIsClaudeUsageExhausted,
  checkIsClaudeModelClearOfLimit,
  checkIsClaudeProfileLaunchable,
  checkIsClaudeTokenExpired,
  describeClaudeLaunchOutcome,
  fetchClaudeUsage,
  getClaudeProfileRecordsFromState,
  formatClaudeUsageBucket,
  formatClaudeUsageRelativeReset,
  formatClaudeUsageResetAt,
  getClaudeLaunchPick,
  getRelevantClaudeUsageKinds,
  markClaudeUsageSnapshotStale,
  mergeClaudeUsageSnapshot,
  parseClaudeUsageResponse,
  readClaudeOAuthToken,
  sortClaudeProfilesByLaunchRank,
  type ClaudeProfileUsageView,
  type ClaudeUsageSnapshot,
} from '../utils/claudeUsage';

const measuredResponse = {
  five_hour: { utilization: 81.0, resets_at: '2026-10-12T13:00:00.132600+00:00' },
  seven_day: { utilization: 76.0, resets_at: '2026-10-17T21:00:00.132620+00:00' },
  seven_day_opus: null,
  limits: [
    { kind: 'session', group: 'session', percent: 81, severity: 'warning', resets_at: '2026-10-12T13:00:00.132600+00:00', scope: null, is_active: true },
    { kind: 'weekly_all', group: 'weekly', percent: 76, severity: 'warning', resets_at: '2026-10-17T21:00:00.132620+00:00', scope: null, is_active: false },
    { kind: 'weekly_scoped', group: 'weekly', percent: 33, severity: 'normal', resets_at: '2026-10-17T21:00:00.132770+00:00', scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false },
    { kind: 'something_new', percent: 5 },
  ],
};

const nowMs = Date.parse('2026-10-12T10:00:00Z');

describe('parseClaudeUsageResponse', () => {
  it('reads the three windows off limits[], the scoped one with its model, and drops kinds it does not know', () => {
    assert.deepEqual(parseClaudeUsageResponse(measuredResponse), [
      { kind: 'session', percent: 81, resetsAt: '2026-10-12T13:00:00.132Z', scopeModel: null },
      { kind: 'weekly_all', percent: 76, resetsAt: '2026-10-17T21:00:00.132Z', scopeModel: null },
      { kind: 'weekly_scoped', percent: 33, resetsAt: '2026-10-17T21:00:00.132Z', scopeModel: 'Fable' },
    ]);
  });

  it('falls back to the top-level five_hour / seven_day objects when limits[] is absent', () => {
    const { limits: _limits, ...older } = measuredResponse;
    assert.deepEqual(parseClaudeUsageResponse(older).map((bucket) => [bucket.kind, bucket.percent]), [['session', 81], ['weekly_all', 76]]);
  });

  it('is empty for anything that is not the usage object', () => {
    assert.deepEqual(parseClaudeUsageResponse(null), []);
    assert.deepEqual(parseClaudeUsageResponse([1]), []);
    assert.deepEqual(parseClaudeUsageResponse({ limits: 'x' }), []);
  });
});

describe('buildBucketsFromRateLimitWindows', () => {
  it('maps the CLI window names — seven_day_overage_included is the Fable window — scaling utilization to percent', () => {
    const buckets = buildBucketsFromRateLimitWindows([
      { name: 'five_hour', utilization: 0.81, resetsAtMs: 1791810000000 },
      { name: 'seven_day', utilization: 0.75, resetsAtMs: 1792270800000 },
      { name: 'seven_day_overage_included', utilization: 0.33, resetsAtMs: 1792270800000 },
      { name: 'some_future_window', utilization: 0.1, resetsAtMs: null },
    ]);
    assert.deepEqual(buckets, [
      { kind: 'session', percent: 81, resetsAt: '2026-10-12T13:00:00.000Z', scopeModel: null },
      { kind: 'weekly_all', percent: 75, resetsAt: '2026-10-17T21:00:00.000Z', scopeModel: null },
      { kind: 'weekly_scoped', percent: 33, resetsAt: '2026-10-17T21:00:00.000Z', scopeModel: 'Fable' },
    ]);
  });
});

describe('the snapshot', () => {
  const api = parseClaudeUsageResponse(measuredResponse);

  it('an api read replaces the set; a stream read upserts only the windows it carries and keeps the rest', () => {
    const first = mergeClaudeUsageSnapshot(undefined, api, 'api', nowMs);
    assert.equal(first.buckets.length, 3);
    assert.equal(first.fetchedAt, new Date(nowMs).toISOString());
    const stream = mergeClaudeUsageSnapshot(first, buildBucketsFromRateLimitWindows([{ name: 'five_hour', utilization: 0.9, resetsAtMs: 1791810000000 }]), 'stream', nowMs + 1000);
    assert.deepEqual(stream.buckets.map((bucket) => [bucket.kind, bucket.percent]), [['session', 90], ['weekly_all', 76], ['weekly_scoped', 33]]);
    assert.equal(stream.source, 'stream');
    const again = mergeClaudeUsageSnapshot(stream, api.slice(0, 1), 'api', nowMs + 2000);
    assert.equal(again.buckets.length, 1, 'the endpoint answer is authoritative');
  });

  it('a stale mark keeps the old buckets and the reason; a changed-check sees stale or moved buckets only', () => {
    const fresh = mergeClaudeUsageSnapshot(undefined, api, 'api', nowMs);
    const stale = markClaudeUsageSnapshotStale(fresh, 'token expired', nowMs + 5000);
    assert.equal(stale.isStale, true);
    assert.equal(stale.error, 'token expired');
    assert.equal(stale.fetchedAt, fresh.fetchedAt, 'the figures are still the old read');
    assert.deepEqual(stale.buckets, fresh.buckets);
    assert.equal(checkClaudeUsageBucketsChanged(fresh, api), false, 'the same figures again are no change');
    assert.equal(checkClaudeUsageBucketsChanged(fresh, [{ ...api[0], percent: 82 }]), true);
    assert.equal(checkClaudeUsageBucketsChanged(stale, api), true, 'a stale snapshot takes any fresh figure');
    assert.equal(checkClaudeUsageBucketsChanged(undefined, api), true);
    assert.equal(markClaudeUsageSnapshotStale(undefined, 'not signed in', nowMs).buckets.length, 0);
  });
});

describe('the ranking (claude_profiles)', () => {
  const snapshot = (session: number, weekly: number, fable: number | null): ClaudeUsageSnapshot => ({
    fetchedAt: new Date(nowMs).toISOString(),
    source: 'api',
    buckets: [
      { kind: 'session', percent: session, resetsAt: null, scopeModel: null },
      { kind: 'weekly_all', percent: weekly, resetsAt: null, scopeModel: null },
      ...(fable === null ? [] : [{ kind: 'weekly_scoped' as const, percent: fable, resetsAt: null, scopeModel: 'Fable' }]),
    ],
  });
  const view = (name: string, usage: ClaudeUsageSnapshot | undefined, extra: Partial<ClaudeProfileUsageView> = {}): ClaudeProfileUsageView => ({
    name, configDir: name === 'default' ? null : `/data/profiles/${name}`, loggedIn: true, email: `${name}@example.com`, subscriptionType: 'max', usage, limitedUntil: null, billing: null, creditExhaustedAt: null, ...extra,
  });

  it('the session and shared weekly windows bound EVERY model; Fable additionally drains its own weekly window', () => {
    assert.deepEqual(getRelevantClaudeUsageKinds('fable'), ['session', 'weekly_all', 'weekly_scoped']);
    assert.deepEqual(getRelevantClaudeUsageKinds('claude-fable-5-1'), ['session', 'weekly_all', 'weekly_scoped']);
    assert.deepEqual(getRelevantClaudeUsageKinds('opus'), ['session', 'weekly_all']);
    assert.deepEqual(getRelevantClaudeUsageKinds(null), ['session', 'weekly_all']);
  });

  it('the report keeps the headroom figures per model, while the pick follows the weekly reset (see the launch pick below)', () => {
    const profiles = [view('default', snapshot(10, 20, 95)), view('work', snapshot(30, 40, 10))];
    const forFable = buildClaudeProfilesReport(profiles, 'fable', nowMs);
    assert.deepEqual(forFable.profiles.map((entry) => [entry.name, entry.headroomPercent]), [['default', 5], ['work', 60]], 'Fable: default is at 95 % on Fable\'s own window, work at 40 % on the shared weekly');
    assert.deepEqual(forFable.relevantBuckets, ['session', 'weekly_all', 'weekly_scoped']);
    const forOpus = buildClaudeProfilesReport(profiles, 'opus', nowMs);
    assert.deepEqual(forOpus.profiles.map((entry) => entry.headroomPercent), [80, 60], 'Opus never touches Fable\'s window');
    assert.deepEqual(forOpus.relevantBuckets, ['session', 'weekly_all']);
    assert.equal(forOpus.profiles[0].configDir, null, 'the default profile launches with no CLAUDE_CONFIG_DIR');
    assert.equal(forOpus.profiles[1].configDir, '/data/profiles/work');
    assert.equal(forOpus.recommended, 'default', 'no reset known on either: the lower five-hour percent decides');
    assert.deepEqual(forOpus.profiles.map((entry) => entry.isRecommended), [true, false]);
    assert.equal(forOpus.pickReason, 'soonestWeeklyReset');
    assert.equal(forOpus.nextAvailable, null);
  });

  it('an exhausted SHARED weekly window stops a Fable launch too (Fable drains it as well); only an exhausted Fable window is Fable\'s alone', () => {
    const sharedExhausted = view('sharedFull', snapshot(10, 100, 5));
    const fableExhausted = view('fableFull', snapshot(10, 20, 100));
    const forFable = buildClaudeProfilesReport([sharedExhausted, fableExhausted], 'fable', nowMs);
    assert.deepEqual(forFable.profiles.map((entry) => [entry.name, entry.isEligible]), [['sharedFull', false], ['fableFull', false]], 'both stop Fable');
    const forSonnet = buildClaudeProfilesReport([sharedExhausted, fableExhausted], 'sonnet', nowMs);
    assert.deepEqual(forSonnet.profiles.map((entry) => [entry.name, entry.isEligible]), [['sharedFull', false], ['fableFull', true]], 'sonnet is stopped by the shared window only');
  });

  it('skips signed-out, limited and exhausted profiles; unknown usage ranks after any known one; none eligible → null', () => {
    const profiles = [
      view('default', snapshot(100, 20, 0)),
      view('out', snapshot(0, 0, 0), { loggedIn: false }),
      view('limited', snapshot(0, 0, 0), { limitedUntil: new Date(nowMs + 60_000).toISOString() }),
      view('was-limited', snapshot(50, 50, 50), { limitedUntil: new Date(nowMs - 60_000).toISOString() }),
      view('unknown', undefined),
    ];
    const report = buildClaudeProfilesReport(profiles, 'sonnet', nowMs);
    assert.equal(report.recommended, 'was-limited', 'an expired mark no longer counts');
    assert.deepEqual(report.profiles.map((entry) => [entry.name, entry.isEligible]), [['default', false], ['out', false], ['limited', false], ['was-limited', true], ['unknown', true]]);
    assert.equal(report.profiles[4].headroomPercent, null);
    assert.equal(buildClaudeProfilesReport([view('unknown', undefined)], 'sonnet', nowMs).recommended, 'unknown', 'unknown usage alone is still a usable account');
    assert.equal(buildClaudeProfilesReport(profiles.slice(0, 3), 'sonnet', nowMs).recommended, null);
  });

  it('a corporate seat without a Fable window is ranked on its session and shared weekly windows for Fable', () => {
    const corporate = view('corp', snapshot(5, 5, null), { subscriptionType: 'team' });
    const report = buildClaudeProfilesReport([view('default', snapshot(81, 76, 33)), corporate], 'fable', nowMs);
    assert.equal(report.recommended, 'corp');
    assert.equal(report.profiles[1].kind, 'corporate');
  });
});

describe('the launch pick (getClaudeLaunchPick)', () => {
  const hours = (count: number): string => new Date(nowMs + count * 3_600_000).toISOString();
  const days = (count: number): string => hours(count * 24);
  const usage = (input: {
    session: number;
    weekly: number;
    weeklyResetsAt: string | null;
    sessionResetsAt?: string | null;
    fable?: number;
    fableResetsAt?: string | null;
  }): ClaudeUsageSnapshot => ({
    fetchedAt: new Date(nowMs).toISOString(),
    source: 'api',
    buckets: [
      { kind: 'session', percent: input.session, resetsAt: input.sessionResetsAt === undefined ? hours(2) : input.sessionResetsAt, scopeModel: null },
      { kind: 'weekly_all', percent: input.weekly, resetsAt: input.weeklyResetsAt, scopeModel: null },
      ...(input.fable === undefined ? [] : [{ kind: 'weekly_scoped' as const, percent: input.fable, resetsAt: input.fableResetsAt === undefined ? input.weeklyResetsAt : input.fableResetsAt, scopeModel: 'Fable' }]),
    ],
  });
  const view = (name: string, snapshot: ClaudeUsageSnapshot | undefined, extra: Partial<ClaudeProfileUsageView> = {}): ClaudeProfileUsageView => ({
    name, configDir: `/data/profiles/${name}`, loggedIn: true, email: `${name}@example.com`, subscriptionType: 'max', usage: snapshot, limitedUntil: null, billing: null, creditExhaustedAt: null, ...extra,
  });
  const pick = (profiles: ClaudeProfileUsageView[], extra: Partial<Parameters<typeof getClaudeLaunchPick>[0]> = {}) =>
    getClaudeLaunchPick({ profiles, model: 'sonnet', nowMs, ...extra });

  describe('a new agent', () => {
    it('goes to the account whose weekly window resets soonest, whatever its headroom', () => {
      const soon = view('soon', usage({ session: 10, weekly: 60, weeklyResetsAt: days(1) }));
      const late = view('late', usage({ session: 0, weekly: 10, weeklyResetsAt: days(5) }));
      assert.deepEqual(pick([late, soon]), { pick: 'soon', reason: 'soonestWeeklyReset', nextAvailable: null });
    });

    it('moves to a farther reset only when the five-hour window is at the 90 % launch ceiling', () => {
      const late = view('late', usage({ session: 0, weekly: 10, weeklyResetsAt: days(5) }));
      assert.equal(pick([view('soon', usage({ session: 92, weekly: 60, weeklyResetsAt: days(1) })), late]).pick, 'late');
      assert.equal(pick([view('soon', usage({ session: 90, weekly: 60, weeklyResetsAt: days(1) })), late]).pick, 'late', 'the ceiling itself is out');
      assert.equal(pick([view('soon', usage({ session: 89, weekly: 60, weeklyResetsAt: days(1) })), late]).pick, 'soon', 'just below it is in');
    });

    it('a weekly window at 100 % takes the account out; Fable\'s own window at 100 % takes out Fable only', () => {
      const late = view('late', usage({ session: 0, weekly: 10, weeklyResetsAt: days(5), fable: 5 }));
      assert.equal(pick([view('soon', usage({ session: 0, weekly: 100, weeklyResetsAt: days(1), fable: 5 })), late]).pick, 'late');
      const fableFull = view('soon', usage({ session: 0, weekly: 60, weeklyResetsAt: days(1), fable: 100 }));
      assert.equal(pick([fableFull, late], { model: 'fable' }).pick, 'late', 'Fable drains its own window');
      assert.equal(pick([fableFull, late], { model: 'sonnet' }).pick, 'soon', 'sonnet never touches it');
    });

    it('Fable ranks on the earlier of the shared and its own weekly reset', () => {
      const split = view('split', usage({ session: 0, weekly: 20, weeklyResetsAt: days(4), fable: 20, fableResetsAt: days(1) }));
      const even = view('even', usage({ session: 0, weekly: 20, weeklyResetsAt: days(2), fable: 20, fableResetsAt: days(2) }));
      assert.equal(pick([even, split], { model: 'fable' }).pick, 'split', 'Fable: the Fable-only window resets in 1 d');
      assert.equal(pick([even, split], { model: 'sonnet' }).pick, 'even', 'sonnet: only the shared window (4 d vs 2 d) counts');
    });

    it('a window whose reset has passed counts as 0 % and rolls to the next period', () => {
      const lateOk = view('late', usage({ session: 0, weekly: 10, weeklyResetsAt: days(8) }));
      // Read 100 % an hour before its reset passed: since then it is a fresh week, resetting 7 d − 1 h from now.
      const staleFull = view('stale', usage({ session: 95, weekly: 100, weeklyResetsAt: hours(-1), sessionResetsAt: hours(-1) }));
      assert.deepEqual(pick([lateOk, staleFull]), { pick: 'stale', reason: 'soonestWeeklyReset', nextAvailable: null });
      const earlier = view('earlier', usage({ session: 0, weekly: 10, weeklyResetsAt: days(6) }));
      assert.equal(pick([staleFull, earlier]).pick, 'earlier', 'its rolled reset (6 d 23 h) ranks after a reset in 6 d');
      // Several periods behind: rolled by whole weeks until it lies ahead.
      const longStale = view('long', usage({ session: 0, weekly: 100, weeklyResetsAt: days(-15) }));
      const ranked = sortClaudeProfilesByLaunchRank([view('d6', usage({ session: 0, weekly: 0, weeklyResetsAt: days(6.5) })), longStale], 'sonnet', nowMs);
      assert.deepEqual(ranked.map((profile) => profile.name), ['long', 'd6'], 'a reset 15 d ago rolls three weeks forward to +6 d, before the +6.5 d one');
    });

    it('an unknown reset ranks after every known one, no snapshot at all last', () => {
      const known = view('known', usage({ session: 50, weekly: 50, weeklyResetsAt: days(6) }));
      const unknownReset = view('unknown', usage({ session: 0, weekly: 0, weeklyResetsAt: null }));
      const noSnapshot = view('none', undefined);
      assert.deepEqual(
        sortClaudeProfilesByLaunchRank([noSnapshot, unknownReset, known], 'sonnet', nowMs).map((profile) => profile.name),
        ['known', 'unknown', 'none'],
      );
      assert.equal(pick([noSnapshot]).pick, 'none', 'an account nobody has read is still usable when it is the only one');
    });

    it('resets within 60 s count as one moment — the lower five-hour percent wins, then the input order', () => {
      const a = view('a', usage({ session: 40, weekly: 10, weeklyResetsAt: new Date(nowMs + 3 * 24 * 3_600_000).toISOString() }));
      const b = view('b', usage({ session: 10, weekly: 10, weeklyResetsAt: new Date(nowMs + 3 * 24 * 3_600_000 + 45_000).toISOString() }));
      assert.equal(pick([a, b]).pick, 'b', '45 s apart: a tie, b has the lower five-hour percent');
      const c = view('c', usage({ session: 10, weekly: 10, weeklyResetsAt: new Date(nowMs + 3 * 24 * 3_600_000 + 61_000).toISOString() }));
      assert.equal(pick([a, c]).pick, 'a', '61 s apart: not a tie, the sooner reset wins');
      const d = view('d', usage({ session: 40, weekly: 10, weeklyResetsAt: new Date(nowMs + 3 * 24 * 3_600_000 + 30_000).toISOString() }));
      assert.equal(pick([d, a]).pick, 'd', 'a full tie keeps the input order');
    });

    it('never picks an account billed to API credits, nor one switched off in the /limits list', () => {
      const api = view('console', undefined, { billing: 'api', subscriptionType: null });
      const switchedOff = view('off', usage({ session: 0, weekly: 0, weeklyResetsAt: days(1) }));
      const later = view('later', usage({ session: 0, weekly: 0, weeklyResetsAt: days(6) }));
      assert.equal(pick([api, switchedOff, later], { excludedNames: new Set(['off']) }).pick, 'later');
      assert.equal(pick([api, switchedOff]).pick, 'off');
      assert.deepEqual(pick([api], { excludedNames: new Set() }), { pick: null, reason: 'none', nextAvailable: null });
    });

    it('skips signed-out, limited and out-of-credits accounts', () => {
      const ok = view('ok', usage({ session: 0, weekly: 0, weeklyResetsAt: days(6) }));
      const soon = usage({ session: 0, weekly: 0, weeklyResetsAt: days(1) });
      const profiles = [
        view('out', soon, { loggedIn: false }),
        view('limited', soon, { limitedUntil: hours(3) }),
        view('credits', soon, { creditExhaustedAt: hours(-1) }),
        view('expiredMark', soon, { limitedUntil: hours(-1) }),
        ok,
      ];
      assert.equal(pick(profiles).pick, 'expiredMark', 'a mark in the past no longer excludes');
      assert.equal(pick(profiles.slice(0, 3)).pick, null);
    });
  });

  describe('a warm session', () => {
    const warm = view('warm', usage({ session: 95, weekly: 80, weeklyResetsAt: days(6) }));
    const sooner = view('sooner', usage({ session: 0, weekly: 0, weeklyResetsAt: days(1) }));

    it('stays on its account — the launch ceiling does not apply to it', () => {
      assert.deepEqual(pick([sooner, warm], { currentProfile: 'warm' }), { pick: 'warm', reason: 'warm', nextAvailable: null });
    });

    it('leaves an account that is at 100 % on a window the model drains, marked limited, signed out or out of credits — by the new-agent rule, reported as a move', () => {
      const full = view('warm', usage({ session: 100, weekly: 80, weeklyResetsAt: days(6) }));
      assert.deepEqual(pick([sooner, full], { currentProfile: 'warm' }), { pick: 'sooner', reason: 'movedFromUnavailable', nextAvailable: null });
      for (const patch of [{ limitedUntil: hours(2) }, { loggedIn: false }, { creditExhaustedAt: hours(-1) }]) {
        const result = pick([sooner, view('warm', warm.usage, patch)], { currentProfile: 'warm' });
        assert.deepEqual([result.pick, result.reason], ['sooner', 'movedFromUnavailable'], JSON.stringify(patch));
      }
    });

    it('Fable\'s own window at 100 % moves a Fable session, not a sonnet one', () => {
      const fableFull = view('warm', usage({ session: 10, weekly: 20, weeklyResetsAt: days(6), fable: 100 }));
      assert.equal(pick([sooner, fableFull], { currentProfile: 'warm', model: 'fable' }).pick, 'sooner');
      assert.equal(pick([sooner, fableFull], { currentProfile: 'warm', model: 'sonnet' }).pick, 'warm');
    });

    it('stopped by a limit: left out whatever its figures say, the session goes to the new-agent pick', () => {
      const fortyPercent = view('warm', usage({ session: 40, weekly: 40, weeklyResetsAt: hours(5) }));
      assert.deepEqual(
        pick([fortyPercent, view('other', usage({ session: 0, weekly: 0, weeklyResetsAt: days(6) }))], { currentProfile: 'warm', isStoppedByLimit: true }),
        { pick: 'other', reason: 'movedFromLimited', nextAvailable: null },
      );
    });

    it('stays on an API-billed account that still has credits (the spend was approved); not on one out of credits', () => {
      const api = view('console', undefined, { billing: 'api', subscriptionType: null });
      assert.deepEqual(pick([sooner, api], { currentProfile: 'console' }), { pick: 'console', reason: 'warm', nextAvailable: null });
      const broke = view('console', undefined, { billing: 'api', subscriptionType: null, creditExhaustedAt: hours(-1) });
      assert.equal(pick([sooner, broke], { currentProfile: 'console' }).pick, 'sooner');
    });

    it('an unknown current account (removed, a typo) is a new agent', () => {
      assert.deepEqual(pick([warm, sooner], { currentProfile: 'gone' }), { pick: 'sooner', reason: 'soonestWeeklyReset', nextAvailable: null });
      assert.equal(pick([warm, sooner], { currentProfile: 'gone', isStoppedByLimit: true }).reason, 'soonestWeeklyReset', 'nothing to move away from');
      assert.equal(describeClaudeLaunchOutcome(buildClaudeProfilesReport([warm, sooner], 'sonnet', nowMs, { currentProfile: 'gone' }), 'gone'), 'soonest weekly reset');
    });

    it('stays on its account although it is switched off in the /limits list', () => {
      assert.equal(pick([sooner, warm], { currentProfile: 'warm', excludedNames: new Set(['warm']) }).pick, 'warm');
    });
  });

  describe('nothing usable', () => {
    it('is null with the account and instant that frees up first', () => {
      const sessionFull = view('a', usage({ session: 95, weekly: 10, weeklyResetsAt: days(4), sessionResetsAt: hours(3) }));
      const sessionFuller = view('b', usage({ session: 100, weekly: 10, weeklyResetsAt: days(4), sessionResetsAt: hours(1) }));
      assert.deepEqual(pick([sessionFull, sessionFuller]), { pick: null, reason: 'none', nextAvailable: { profile: 'b', at: hours(1) } });
    });

    it('an account blocked by a weekly window frees up at its reset — and at the later of its blockers', () => {
      const weeklyFull = view('weekly', usage({ session: 0, weekly: 100, weeklyResetsAt: days(2) }));
      const both = view('both', usage({ session: 100, weekly: 100, weeklyResetsAt: days(1), sessionResetsAt: hours(2) }));
      assert.deepEqual(pick([weeklyFull]).nextAvailable, { profile: 'weekly', at: days(2) });
      assert.deepEqual(pick([weeklyFull, both]).nextAvailable, { profile: 'both', at: days(1) });
      const marked = view('marked', usage({ session: 100, weekly: 0, weeklyResetsAt: days(4), sessionResetsAt: hours(1) }), { limitedUntil: hours(6) });
      assert.deepEqual(pick([marked]).nextAvailable, { profile: 'marked', at: hours(6) }, 'the limited mark outlasts the session window');
    });

    it('never names an account that does not come back on its own, or whose blocker has no reset', () => {
      const signedOut = view('out', undefined, { loggedIn: false });
      const api = view('console', undefined, { billing: 'api', subscriptionType: null });
      const credits = view('credits', undefined, { creditExhaustedAt: hours(-1) });
      const switchedOff = view('off', usage({ session: 100, weekly: 0, weeklyResetsAt: days(1), sessionResetsAt: hours(1) }));
      const noReset = view('noReset', usage({ session: 100, weekly: 0, weeklyResetsAt: days(1), sessionResetsAt: null }));
      assert.deepEqual(pick([signedOut, api, credits, switchedOff, noReset], { excludedNames: new Set(['off']) }), { pick: null, reason: 'none', nextAvailable: null });
    });

    it('a session stopped by a limit whose figures show a blocker is named at that blocker\'s reset', () => {
      const stopped = view('stopped', usage({ session: 100, weekly: 0, weeklyResetsAt: days(4), sessionResetsAt: hours(2) }));
      const farther = view('farther', usage({ session: 100, weekly: 0, weeklyResetsAt: days(4), sessionResetsAt: hours(4) }));
      assert.equal(pick([stopped, farther], { currentProfile: 'stopped', isStoppedByLimit: true }).nextAvailable?.profile, 'stopped');
    });

    it('a session stopped by a limit whose figures lag it (no blocker) frees up at its five-hour reset — a single account is not left without a time to come back', () => {
      const lagging = view('stopped', usage({ session: 40, weekly: 0, weeklyResetsAt: days(4), sessionResetsAt: hours(3) }));
      assert.deepEqual(
        pick([lagging], { currentProfile: 'stopped', isStoppedByLimit: true }),
        { pick: null, reason: 'none', nextAvailable: { profile: 'stopped', at: hours(3) } },
        'the only account, stopped by a limit its figures do not show',
      );
      const farther = view('farther', usage({ session: 100, weekly: 0, weeklyResetsAt: days(4), sessionResetsAt: hours(4) }));
      assert.deepEqual(pick([lagging, farther], { currentProfile: 'stopped', isStoppedByLimit: true }).nextAvailable, { profile: 'stopped', at: hours(3) }, 'the earlier of the two');
      const laggingLater = view('stopped', usage({ session: 40, weekly: 0, weeklyResetsAt: days(4), sessionResetsAt: hours(6) }));
      assert.deepEqual(pick([laggingLater, farther], { currentProfile: 'stopped', isStoppedByLimit: true }).nextAvailable, { profile: 'farther', at: hours(4) });
    });

    it('the five-hour fallback is rolled forward when that reset has passed, and needs a known reset; it is for the stopped account only', () => {
      const passed = view('stopped', usage({ session: 40, weekly: 0, weeklyResetsAt: days(4), sessionResetsAt: hours(-1) }));
      assert.deepEqual(pick([passed], { currentProfile: 'stopped', isStoppedByLimit: true }).nextAvailable, { profile: 'stopped', at: hours(4) }, 'a reset an hour ago rolls to +5 h − 1 h');
      const noReset = view('stopped', usage({ session: 40, weekly: 0, weeklyResetsAt: days(4), sessionResetsAt: null }));
      assert.equal(pick([noReset], { currentProfile: 'stopped', isStoppedByLimit: true }).nextAvailable, null, 'no reset, no time');
      assert.equal(pick([view('stopped', undefined)], { currentProfile: 'stopped', isStoppedByLimit: true }).nextAvailable, null, 'no snapshot, no time');
      // Without the stop flag the same account is usable by its figures: it is the pick, not a "next".
      assert.equal(pick([view('stopped', usage({ session: 40, weekly: 0, weeklyResetsAt: days(4), sessionResetsAt: hours(3) }))]).pick, 'stopped');
    });
  });

  describe('the report', () => {
    it('marks the pick and carries the reason and nextAvailable; an API account is recommended only to its warm session', () => {
      const soon = view('soon', usage({ session: 0, weekly: 0, weeklyResetsAt: days(1) }));
      const late = view('late', usage({ session: 0, weekly: 0, weeklyResetsAt: days(5) }));
      const report = buildClaudeProfilesReport([late, soon], 'sonnet', nowMs);
      assert.equal(report.recommended, 'soon');
      assert.deepEqual(report.profiles.map((entry) => [entry.name, entry.isRecommended]), [['late', false], ['soon', true]], 'the entries keep the input order');
      assert.equal(report.pickReason, 'soonestWeeklyReset');
      const warmReport = buildClaudeProfilesReport([late, soon], 'sonnet', nowMs, { currentProfile: 'late' });
      assert.equal(warmReport.recommended, 'late');
      assert.equal(warmReport.pickReason, 'warm');
      const none = buildClaudeProfilesReport([view('full', usage({ session: 100, weekly: 0, weeklyResetsAt: days(1), sessionResetsAt: hours(2) }))], 'sonnet', nowMs);
      assert.equal(none.recommended, null);
      assert.equal(none.pickReason, 'none');
      assert.deepEqual(none.nextAvailable, { profile: 'full', at: hours(2) });
      const api = view('console', undefined, { billing: 'api', subscriptionType: null });
      assert.equal(buildClaudeProfilesReport([soon, api], 'sonnet', nowMs).recommended, 'soon');
      assert.equal(buildClaudeProfilesReport([soon, api], 'sonnet', nowMs, { currentProfile: 'console' }).recommended, 'console');
    });

    it('the first line of an answer says why: stays, moved (stopped on a limit / can no longer run), soonest reset, or none usable with the next account', () => {
      const soon = view('soon', usage({ session: 0, weekly: 0, weeklyResetsAt: days(1) }));
      const late = view('late', usage({ session: 0, weekly: 0, weeklyResetsAt: days(5) }));
      const words = (options: Parameters<typeof buildClaudeProfilesReport>[3]) => describeClaudeLaunchOutcome(buildClaudeProfilesReport([soon, late], 'sonnet', nowMs, options), options?.currentProfile ?? null);
      assert.equal(words({}), 'soonest weekly reset');
      assert.equal(words({ currentProfile: 'late' }), 'stays on the warm account');
      assert.equal(words({ currentProfile: 'late', isStoppedByLimit: true }), 'moved: late stopped on a limit');
      assert.equal(describeClaudeLaunchOutcome(buildClaudeProfilesReport([soon, view('late', usage({ session: 100, weekly: 0, weeklyResetsAt: days(5) }))], 'sonnet', nowMs, { currentProfile: 'late' }), 'late'), 'moved: late can no longer run');
      const full = view('full', usage({ session: 100, weekly: 0, weeklyResetsAt: days(1), sessionResetsAt: hours(2) }));
      assert.equal(describeClaudeLaunchOutcome(buildClaudeProfilesReport([full], 'sonnet', nowMs), null), `none usable — next: full at ${hours(2)}`);
      assert.equal(describeClaudeLaunchOutcome(buildClaudeProfilesReport([view('out', undefined, { loggedIn: false })], 'sonnet', nowMs), null), 'none usable — no account names a time it frees up');
    });

    it('isEligible keeps its strict meaning: the figures as recorded, no ceiling, no roll-forward', () => {
      const ninetyFive = view('hot', usage({ session: 95, weekly: 10, weeklyResetsAt: days(1) }));
      const stale = view('stale', usage({ session: 0, weekly: 100, weeklyResetsAt: hours(-1) }));
      const report = buildClaudeProfilesReport([ninetyFive, stale], 'sonnet', nowMs);
      assert.deepEqual(report.profiles.map((entry) => entry.isEligible), [true, false]);
      assert.equal(checkIsClaudeProfileLaunchable(ninetyFive, 'sonnet', nowMs), false, 'over the launch ceiling');
      assert.equal(checkIsClaudeProfileLaunchable(stale, 'sonnet', nowMs), true, 'its week has rolled over since');
    });
  });
});

describe('the views off the registry and the state file', () => {
  it('default first (its hidden record when present), then the added profiles in creation order, each with its directory', () => {
    const views = buildClaudeProfileUsageViews({
      dataDir: '/tmp/data',
      records: {
        later: { createdAt: '2026-10-02T00:00:00Z', loggedIn: true, email: 'b@example.com', subscriptionType: 'pro' },
        default: { createdAt: '2026-10-03T00:00:00Z', loggedIn: true, email: 'a@example.com', subscriptionType: 'max', limitedUntil: '2026-10-12T13:00:00Z' },
        earlier: { createdAt: '2026-10-01T00:00:00Z' },
      },
    });
    assert.deepEqual(views.map((entry) => [entry.name, entry.configDir, entry.email, entry.limitedUntil]), [
      ['default', null, 'a@example.com', '2026-10-12T13:00:00Z'],
      ['earlier', '/tmp/data/claude-profiles/earlier', null, null],
      ['later', '/tmp/data/claude-profiles/later', 'b@example.com', null],
    ]);
    assert.equal(buildClaudeProfileUsageViews({ dataDir: '/tmp/data', records: {} })[0].name, 'default', 'default is always listed');
  });

  it('hands an API account its credit figure (the operator\'s anchor by name) and the spend the bot counted since it', () => {
    const creditAnchor = { remainingUsd: 67.71, grantUsd: 200, anchoredAt: '2026-11-07T08:00:00.000Z' };
    const creditSpend = { anchoredAt: creditAnchor.anchoredAt, usd: 1.5 };
    const views = buildClaudeProfileUsageViews({
      dataDir: '/tmp/data',
      records: {
        api: { createdAt: '2026-10-02T00:00:00Z', billing: 'api', creditSpend },
        plain: { createdAt: '2026-10-03T00:00:00Z' },
      },
      creditAnchors: { api: creditAnchor },
    });
    const byName = Object.fromEntries(views.map((view) => [view.name, view]));
    assert.deepEqual([byName.api.creditAnchor, byName.api.creditSpend], [creditAnchor, creditSpend]);
    assert.equal('creditAnchor' in byName.plain, false, 'an account without a figure has none');
    assert.equal('creditSpend' in byName.plain, false);
    assert.equal('creditAnchor' in buildClaudeProfileUsageViews({ dataDir: '/tmp/data', records: { api: { createdAt: '2026-10-02T00:00:00Z' } } })[1], false, 'no anchors given at all');
  });

  it('builds ONE profile\'s view the very way the list does — what /accounts and /limits both render', () => {
    const creditAnchor = { remainingUsd: 5, anchoredAt: '2026-11-07T08:00:00.000Z' };
    const record = { createdAt: '2026-10-02T00:00:00Z', billing: 'api' as const, creditSpend: { anchoredAt: creditAnchor.anchoredAt, usd: 1 } };
    const [listed] = buildClaudeProfileUsageViews({ dataDir: '/tmp/data', records: { api: record }, creditAnchors: { api: creditAnchor } }).filter((view) => view.name === 'api');
    assert.deepEqual(buildClaudeProfileUsageView({ dataDir: '/tmp/data', name: 'api', record, creditAnchor }), listed);
    assert.equal(buildClaudeProfileUsageView({ dataDir: '/tmp/data', name: 'nobody', record: undefined }).billing, null, 'a name nothing was recorded for is a plain view');
  });

  it('getClaudeProfileRecordsFromState picks the registry out of a state file already read: entries without a creation time are dropped, a missing or odd registry is empty', () => {
    assert.deepEqual(getClaudeProfileRecordsFromState({}), {});
    assert.deepEqual(getClaudeProfileRecordsFromState({ claudeProfiles: 'nope' }), {});
    assert.deepEqual(getClaudeProfileRecordsFromState({ claudeProfiles: ['work'] }), {});
    const state = { claudeProfiles: { work: { createdAt: '2026-10-01T00:00:00Z', loggedIn: true }, broken: { loggedIn: true }, text: 'x' }, other: 1 };
    assert.deepEqual(Object.keys(getClaudeProfileRecordsFromState(state)), ['work']);
  });
});

describe('the token', () => {
  it('reads claudeAiOauth off .credentials.json in the profile dir (the home dir for default), null when absent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cred-'));
    try {
      assert.equal(readClaudeOAuthToken(dir), null);
      assert.equal(readClaudeOAuthToken(null, dir), null);
      fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-test', refreshToken: 'r', expiresAt: 1791818162950, subscriptionType: 'max' } }));
      assert.deepEqual(readClaudeOAuthToken(dir), { accessToken: 'sk-ant-test', expiresAtMs: 1791818162950 });
      assert.deepEqual(readClaudeOAuthToken(null, dir), { accessToken: 'sk-ant-test', expiresAtMs: 1791818162950 }, 'default → the home .claude dir');
      fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: '' } }));
      assert.equal(readClaudeOAuthToken(dir), null, 'an empty token is no token');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('expiry: past or at expiresAt is expired; no expiresAt is live', () => {
    assert.equal(checkIsClaudeTokenExpired({ accessToken: 'x', expiresAtMs: nowMs }, nowMs), true);
    assert.equal(checkIsClaudeTokenExpired({ accessToken: 'x', expiresAtMs: nowMs + 1 }, nowMs), false);
    assert.equal(checkIsClaudeTokenExpired({ accessToken: 'x', expiresAtMs: null }, nowMs), false);
  });
});

describe('fetchClaudeUsage', () => {
  it('sends the bearer + oauth beta header, parses a 200, classes 401/403 as auth errors, never throws', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = (status: number, body: unknown) => async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, headers: init.headers });
      return { status, json: async () => body };
    };
    const ok = await fetchClaudeUsage('tok', { fetchImpl: fetchImpl(200, measuredResponse) });
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.buckets.length, 3);
    assert.equal(seen[0].url, 'https://api.anthropic.com/api/oauth/usage');
    assert.equal(seen[0].headers.Authorization, 'Bearer tok');
    assert.equal(seen[0].headers['anthropic-beta'], 'oauth-2025-04-20');
    assert.deepEqual(await fetchClaudeUsage('tok', { fetchImpl: fetchImpl(401, {}) }), { ok: false, error: 'http 401', isAuthError: true });
    assert.deepEqual(await fetchClaudeUsage('tok', { fetchImpl: fetchImpl(500, {}) }), { ok: false, error: 'http 500', isAuthError: false });
    assert.deepEqual(await fetchClaudeUsage('tok', { fetchImpl: fetchImpl(200, {}) }), { ok: false, error: 'no limits in the response', isAuthError: false });
    const thrown = await fetchClaudeUsage('tok', { fetchImpl: async () => { throw new Error('ECONNRESET'); } });
    assert.deepEqual(thrown, { ok: false, error: 'ECONNRESET', isAuthError: false });
  });

  it('a caller\'s signal cancels the request itself: the fetch gets an aborted signal, the answer is "cancelled" (not a timeout), and an already-aborted signal sends nothing', async () => {
    const caller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const hanging = async (_url: string, init: { signal: AbortSignal }) => {
      seenSignal = init.signal;
      return new Promise<never>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      });
    };
    const pending = fetchClaudeUsage('tok', { fetchImpl: hanging, signal: caller.signal });
    assert.equal(seenSignal?.aborted, false);
    caller.abort();
    const outcome = await Promise.race([pending, new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 500))]);
    assert.deepEqual(outcome, { ok: false, error: 'cancelled', isAuthError: false });
    assert.equal(seenSignal?.aborted, true, 'the abort reached the request');

    let calls = 0;
    const counting = async () => { calls += 1; return { status: 200, json: async () => ({}) }; };
    assert.deepEqual(await fetchClaudeUsage('tok', { fetchImpl: counting, signal: caller.signal }), { ok: false, error: 'cancelled', isAuthError: false });
    assert.equal(calls, 0, 'nothing is sent for a poll that was cancelled before it started');
  });

  it('without a caller signal the 15 s timeout alone ends a hung request, still as "timeout"', async () => {
    const hanging = async (_url: string, init: { signal: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    });
    assert.deepEqual(await fetchClaudeUsage('tok', { fetchImpl: hanging, timeoutMs: 20 }), { ok: false, error: 'timeout', isAuthError: false });
  });
});

describe('the human formats', () => {
  it('a reset instant is a time today, a weekday + time within the week, a date beyond — in the given zone', () => {
    const zone = 'Europe/Kyiv'; // UTC+3 in October 2026
    assert.equal(formatClaudeUsageResetAt('2026-10-12T13:00:00Z', zone, nowMs), '16:00');
    assert.equal(formatClaudeUsageResetAt('2026-10-12T12:59:59.900Z', zone, nowMs), '16:00', 'sub-second jitter below the boundary rounds to the minute');
    assert.equal(formatClaudeUsageResetAt('2026-10-12T13:00:00.402Z', zone, nowMs), '16:00');
    assert.equal(formatClaudeUsageResetAt('2026-10-17T21:00:00Z', zone, nowMs), 'Sun 00:00');
    assert.equal(formatClaudeUsageResetAt('2026-11-05T07:59:00Z', zone, nowMs), '05.11 09:59');
    assert.equal(formatClaudeUsageResetAt(null, zone, nowMs), '?');
    assert.equal(formatClaudeUsageResetAt('garbage', zone, nowMs), '?');
    assert.equal(formatClaudeUsageResetAt('2026-10-12T23:30:00Z', 'UTC', nowMs), '23:30', 'same day in UTC');
    assert.equal(formatClaudeUsageResetAt('2026-10-12T23:30:00Z', zone, nowMs), 'Tue 02:30', 'already tomorrow in Kyiv');
  });

  it('a bucket renders as percent, a space and the relative reset (no arrow), a missing one as a dash', () => {
    assert.equal(formatClaudeUsageBucket({ kind: 'session', percent: 81, resetsAt: '2026-10-12T13:00:00Z', scopeModel: null }, nowMs), `81% ${formatClaudeUsageRelativeReset('2026-10-12T13:00:00Z', nowMs)}`);
    assert.equal(formatClaudeUsageBucket(null, nowMs), '—');
  });

  it('a relative reset keeps the two largest units, minutes only under an hour', () => {
    const at = (minutes: number) => new Date(nowMs + minutes * 60_000).toISOString();
    assert.equal(formatClaudeUsageRelativeReset(at(30), nowMs), '🔄 in 30m');
    assert.equal(formatClaudeUsageRelativeReset(at(0), nowMs), '🔄 in 1m', 'never «0m»');
    assert.equal(formatClaudeUsageRelativeReset(at(59), nowMs), '🔄 in 59m');
    assert.equal(formatClaudeUsageRelativeReset(at(60), nowMs), '🔄 in 1h');
    assert.equal(formatClaudeUsageRelativeReset(at(125), nowMs), '🔄 in 2h', 'minutes are dropped from an hour up');
    assert.equal(formatClaudeUsageRelativeReset(at(23 * 60 + 50), nowMs), '🔄 in 1d', '23h50m is a day');
    assert.equal(formatClaudeUsageRelativeReset(at(2 * 1440 + 60), nowMs), '🔄 in 2d 1h');
    assert.equal(formatClaudeUsageRelativeReset(at(2 * 1440 + 10), nowMs), '🔄 in 2d', 'zero hours are dropped');
    assert.equal(formatClaudeUsageRelativeReset(null, nowMs), '?');
    assert.equal(formatClaudeUsageRelativeReset('garbage', nowMs), '?');
    assert.equal(
      formatClaudeUsageRelativeReset(at(2 * 1440 + 60), nowMs, { pattern: '🔄 через {time}', day: 'д', hour: 'ч', minute: 'м' }),
      '🔄 через 2д 1ч',
    );
  });

  it('an unknown reset takes the fallback (the weekly window for the 5h one)', () => {
    const weekly = new Date(nowMs + 2 * 86_400_000).toISOString();
    const session = { kind: 'session' as const, percent: 10, resetsAt: null, scopeModel: null };
    assert.equal(formatClaudeUsageBucket(session, nowMs, { fallbackResetsAt: weekly }), '10% 🔄 in 2d');
    assert.equal(formatClaudeUsageBucket(session, nowMs), '10%', 'with no reset at all it is the bare percent, never a «?» after the number');
    const known = { ...session, resetsAt: new Date(nowMs + 3_600_000).toISOString() };
    assert.equal(formatClaudeUsageBucket(known, nowMs, { fallbackResetsAt: weekly }), '10% 🔄 in 1h', 'a known reset wins');
  });
});

describe('the claude-profiles CLI line', () => {
  it('shows relative resets and the weekly reset in place of an unknown 5h one', () => {
    const entry = {
      name: 'work', configDir: '/d/work', email: 'w@example.com', kind: 'personal', subscriptionType: 'max', loggedIn: true,
      buckets: [
        { kind: 'session', percent: 12, resetsAt: null, scopeModel: null },
        { kind: 'weekly_all', percent: 40, resetsAt: new Date(nowMs + 49 * 3_600_000).toISOString(), scopeModel: null },
      ],
      usageFetchedAt: null, isUsageStale: false, limitedUntil: null, creditExhaustedAt: null, billing: null, isEligible: true, headroomPercent: 60, isRecommended: true,
    } as const;
    const line = formatClaudeProfileCliLine({ ...entry, buckets: [...entry.buckets] }, nowMs);
    assert.match(line, /5h 12% 🔄 in 2d 1h · week 40% 🔄 in 2d 1h$/, 'an account with no Fable window says nothing about Fable');
    const withFable = formatClaudeProfileCliLine({
      ...entry,
      buckets: [...entry.buckets, { kind: 'weekly_scoped', percent: 3, resetsAt: new Date(nowMs + 49 * 3_600_000).toISOString(), scopeModel: 'Fable' }],
    }, nowMs);
    assert.match(withFable, /week 40% 🔄 in 2d 1h · Fable 3% 🔄 in 2d 1h$/);
  });
});

describe('checkIsClaudeUsageExhausted — does the reading SHOW a window at 100 % for the model', () => {
  const snapshotOf = (session: number, weekly: number): ClaudeUsageSnapshot => ({
    fetchedAt: '2026-10-12T09:59:00.000Z',
    source: 'api',
    buckets: [
      { kind: 'session', percent: session, resetsAt: '2026-10-12T13:00:00.000Z', scopeModel: null },
      { kind: 'weekly_all', percent: weekly, resetsAt: '2026-10-17T21:00:00.000Z', scopeModel: null },
    ],
  });

  const readAtMs = Date.parse('2026-10-12T10:00:00.000Z');

  it('a window the model drains at 100 % is exhausted; a reading below that, or none at all, is not proof', () => {
    assert.equal(checkIsClaudeUsageExhausted(snapshotOf(100, 20), 'sonnet', readAtMs), true);
    assert.equal(checkIsClaudeUsageExhausted(snapshotOf(10, 100), 'opus', readAtMs), true);
    assert.equal(checkIsClaudeUsageExhausted(snapshotOf(84, 40), 'sonnet', readAtMs), false, 'the 429 also comes at 84 % — the reading does not confirm it');
    assert.equal(checkIsClaudeUsageExhausted(undefined, 'sonnet', readAtMs), false, 'unknown is not exhausted');
  });

  it('an out-of-date reading proves nothing: a window whose reset is past, or a snapshot marked stale', () => {
    // The session window of snapshotOf resets at 13:00Z.
    assert.equal(checkIsClaudeUsageExhausted(snapshotOf(100, 20), 'sonnet', Date.parse('2026-10-12T13:00:00.000Z')), false, 'the 100 % window has reset since');
    assert.equal(checkIsClaudeUsageExhausted({ ...snapshotOf(100, 20), isStale: true }, 'sonnet', readAtMs), false, 'a stale snapshot is last known, not now');
  });
});

describe('checkHasHeadroomForClaudeModel — is a model clear of an exhausted window', () => {
  const snapshotOf = (session: number, weekly: number, fable?: number): ClaudeUsageSnapshot => ({
    fetchedAt: '2026-10-12T09:59:00.000Z',
    source: 'api',
    buckets: [
      { kind: 'session', percent: session, resetsAt: '2026-10-12T13:00:00.000Z', scopeModel: null },
      { kind: 'weekly_all', percent: weekly, resetsAt: '2026-10-17T21:00:00.000Z', scopeModel: null },
      ...(fable === undefined ? [] : [{ kind: 'weekly_scoped' as const, percent: fable, resetsAt: '2026-10-17T21:00:00.000Z', scopeModel: 'Fable' }]),
    ],
  });

  it('a Fable-only weekly limit stops Fable but not sonnet or opus', () => {
    const fableLimited = snapshotOf(10, 20, 100);
    assert.equal(checkHasHeadroomForClaudeModel(fableLimited, 'fable'), false);
    assert.equal(checkHasHeadroomForClaudeModel(fableLimited, 'claude-fable-5-1'), false, 'the running id counts as Fable too');
    assert.equal(checkHasHeadroomForClaudeModel(fableLimited, 'sonnet'), true);
    assert.equal(checkHasHeadroomForClaudeModel(fableLimited, 'opus'), true);
  });

  it('an exhausted session or shared weekly window stops EVERY model, Fable included (Fable drains both)', () => {
    for (const model of ['fable', 'sonnet', 'opus']) {
      assert.equal(checkHasHeadroomForClaudeModel(snapshotOf(100, 20, 10), model), false, `session, ${model}`);
      assert.equal(checkHasHeadroomForClaudeModel(snapshotOf(10, 100, 10), model), false, `shared weekly, ${model}`);
    }
  });

  it('a window the snapshot lacks, or no snapshot, is unknown — and unknown is taken to be covered by the limit', () => {
    assert.equal(checkHasHeadroomForClaudeModel(snapshotOf(10, 20), 'fable'), false, 'no Fable window recorded');
    assert.equal(checkHasHeadroomForClaudeModel(undefined, 'sonnet'), false);
    assert.equal(checkHasHeadroomForClaudeModel({ ...snapshotOf(10, 20), buckets: [] }, 'sonnet'), false);
  });

  it('a stale snapshot still counts: its last figures are the best there are', () => {
    assert.equal(checkHasHeadroomForClaudeModel({ ...snapshotOf(10, 20, 100), isStale: true, error: 'token expired' }, 'sonnet'), true);
  });

  it('a model draining the windows the limited one drains is covered by the limit, however far the figures lag behind it', () => {
    const lagging = snapshotOf(10, 20, 40);
    assert.equal(checkIsClaudeModelClearOfLimit(lagging, 'claude-fable-5-1', 'fable'), false, 'the very model that hit the limit');
    assert.equal(checkIsClaudeModelClearOfLimit(lagging, 'claude-sonnet-4-5', 'opus'), false, 'sonnet and opus drain the same windows');
    assert.equal(checkIsClaudeModelClearOfLimit(lagging, 'claude-sonnet-4-5', 'fable'), false, 'Fable drains the windows sonnet ran out of too');
    assert.equal(checkIsClaudeModelClearOfLimit(lagging, null, 'fable'), true, 'the limited model unknown: the figures decide');
  });

  it('a model draining FEWER windows than the limited one (a non-Fable model after Fable) is judged by the figures', () => {
    assert.equal(checkIsClaudeModelClearOfLimit(snapshotOf(10, 20, 100), 'claude-fable-5-1', 'sonnet'), true, 'only Fable\'s own window ran out');
    assert.equal(checkIsClaudeModelClearOfLimit(snapshotOf(10, 20, 40), 'claude-fable-5-1', 'sonnet'), true, 'figures lagging, but nothing says otherwise');
    assert.equal(checkIsClaudeModelClearOfLimit(snapshotOf(100, 20, 100), 'claude-fable-5-1', 'opus'), false, 'the session window stops every model');
    assert.equal(checkIsClaudeModelClearOfLimit(snapshotOf(10, 100, 40), 'claude-fable-5-1', 'opus'), false, 'so does the shared weekly window');
    assert.equal(checkIsClaudeModelClearOfLimit(undefined, 'claude-fable-5-1', 'opus'), false, 'no figures: the limit is taken to cover it');
  });
});
