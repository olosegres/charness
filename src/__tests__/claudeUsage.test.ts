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
import {
  buildBucketsFromRateLimitWindows,
  buildClaudeProfileUsageViews,
  buildClaudeProfilesReport,
  checkClaudeUsageBucketsChanged,
  checkIsClaudeTokenExpired,
  fetchClaudeUsage,
  formatClaudeUsageBucket,
  formatClaudeUsageResetAt,
  getRelevantClaudeUsageKinds,
  markClaudeUsageSnapshotStale,
  mergeClaudeUsageSnapshot,
  parseClaudeUsageResponse,
  readClaudeOAuthToken,
  readClaudeProfileRecordsFromStateFile,
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
    name, configDir: name === 'default' ? null : `/data/profiles/${name}`, loggedIn: true, email: `${name}@example.com`, subscriptionType: 'max', usage, limitedUntil: null, ...extra,
  });

  it('Fable looks at the Fable window + the session window; another model at the shared weekly + the session window', () => {
    assert.deepEqual(getRelevantClaudeUsageKinds('fable'), ['session', 'weekly_scoped']);
    assert.deepEqual(getRelevantClaudeUsageKinds('claude-fable-5-1'), ['session', 'weekly_scoped']);
    assert.deepEqual(getRelevantClaudeUsageKinds('opus'), ['session', 'weekly_all']);
    assert.deepEqual(getRelevantClaudeUsageKinds(null), ['session', 'weekly_all']);
  });

  it('recommends the most headroom on the relevant windows, so the same two profiles rank differently per model', () => {
    const profiles = [view('default', snapshot(81, 76, 33)), view('work', snapshot(10, 90, 5))];
    const forFable = buildClaudeProfilesReport(profiles, 'fable', nowMs);
    assert.equal(forFable.recommended, 'work', 'Fable: work has 90 % headroom on its session window and 95 % on Fable → min 90; default min 19');
    assert.deepEqual(forFable.profiles.map((entry) => [entry.name, entry.headroomPercent, entry.isRecommended]), [['default', 19, false], ['work', 90, true]]);
    const forOpus = buildClaudeProfilesReport(profiles, 'opus', nowMs);
    assert.equal(forOpus.recommended, 'default', 'Opus: work is at 90 % on the shared weekly window (headroom 10), default at 81 % session (headroom 19)');
    assert.deepEqual(forOpus.relevantBuckets, ['session', 'weekly_all']);
    assert.equal(forOpus.profiles[0].configDir, null, 'the default profile launches with no CLAUDE_CONFIG_DIR');
    assert.equal(forOpus.profiles[1].configDir, '/data/profiles/work');
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

  it('a corporate seat without a Fable window is ranked on its session window alone for Fable', () => {
    const corporate = view('corp', snapshot(5, 5, null), { subscriptionType: 'team' });
    const report = buildClaudeProfilesReport([view('default', snapshot(81, 76, 33)), corporate], 'fable', nowMs);
    assert.equal(report.recommended, 'corp');
    assert.equal(report.profiles[1].kind, 'corporate');
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

  it('readClaudeProfileRecordsFromStateFile reads the registry off state.json and tolerates a missing or broken file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-'));
    try {
      assert.deepEqual(readClaudeProfileRecordsFromStateFile(dir), {});
      fs.writeFileSync(path.join(dir, 'state.json'), '{not json');
      assert.deepEqual(readClaudeProfileRecordsFromStateFile(dir), {});
      fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ claudeProfiles: { work: { createdAt: '2026-10-01T00:00:00Z', loggedIn: true }, broken: { loggedIn: true } }, other: 1 }));
      assert.deepEqual(Object.keys(readClaudeProfileRecordsFromStateFile(dir)), ['work']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

  it('a bucket renders as percent → reset, a missing one as a dash', () => {
    assert.equal(formatClaudeUsageBucket({ kind: 'session', percent: 81, resetsAt: '2026-10-12T13:00:00Z', scopeModel: null }, 'UTC', nowMs), '81% → 13:00');
    assert.equal(formatClaudeUsageBucket(null, 'UTC', nowMs), '—');
  });
});
