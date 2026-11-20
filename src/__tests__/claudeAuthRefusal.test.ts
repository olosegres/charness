/**
 * @description An account the CLI cannot run a conversation on, and where the conversation goes instead
 * (`utils/claudeAuthRefusal.ts`, `utils/claudeProfileUsageViews.ts`):
 *
 *   • the launch: a conversation whose account is not signed in (its last probe) or refused by the CLI never starts or resumes
 *     there — it goes to the account `claude_profiles` recommends for a session leaving it (the `/limits` list's accounts, an
 *     API-credit one of it first, then the soonest weekly reset); with no other usable account it stays;
 *   • the move after a refused turn: the account is marked, the pick reads the mark at once, a replayed error marks nothing;
 *   • the mark: counted as signed out by every view, and over only when the account is signed in again (the stored login
 *     changed) — or, for a bare 401 / 403, when a probe after it finds the account signed in; but the same login refused that way
 *     again soon after is held until a new login, and a return by a status check alone is no «signed in again»;
 *   • the log: one line per change of an account's state.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { ClaudeProfileRecord } from '../state';
import {
  buildClaudeAuthRefusalMark,
  checkIsClaudeProfileBackByStatusCheck,
  checkIsClaudeProfileKnownUnusable,
  claudeRejectedRepeatWindowMs,
  getClaudeAuthRefusalEnd,
  getClaudeProfileSignedIn,
  getClaudeProfileUsability,
  listClaudeProfileUsabilityLines,
  readClaudeLoginStamp,
  type ClaudeAuthRefusal,
  type ClaudeProfileUsability,
} from '../utils/claudeAuthRefusal';
import {
  buildClaudeProfileUsageViews,
  pickClaudeProfileInstead,
  planClaudeAuthRefusalMove,
  resolveClaudeProfileForLaunch,
} from '../utils/claudeProfileUsageViews';
import type { ClaudeLaunchChainScope, ClaudeUsageSnapshot } from '../utils/claudeUsage';

const nowMs = Date.parse('2026-11-20T09:00:00.000Z');
const dataDir = '/home/user/.charness';

function buildUsage(input: { session: number; weekly: number; isStale?: boolean; weeklyResetsAt?: string }): ClaudeUsageSnapshot {
  return {
    fetchedAt: '2026-11-20T08:55:00.000Z',
    source: 'api',
    ...(input.isStale ? { isStale: true } : {}),
    buckets: [
      { kind: 'session', percent: input.session, resetsAt: '2026-11-20T12:00:00.000Z', scopeModel: null },
      { kind: 'weekly_all', percent: input.weekly, resetsAt: input.weeklyResetsAt ?? '2026-11-24T00:00:00.000Z', scopeModel: null },
    ],
  };
}

function buildRecord(patch: Partial<ClaudeProfileRecord> = {}): ClaudeProfileRecord {
  return { createdAt: '2026-11-01T00:00:00.000Z', loggedIn: true, subscriptionType: 'max', usage: buildUsage({ session: 2, weekly: 2 }), ...patch };
}

/** The live case: `default` signed out with a stale, nearly full week; one adopted account `second` with room. */
function buildBugRecords(patch: { default?: Partial<ClaudeProfileRecord>; second?: Partial<ClaudeProfileRecord> } = {}): Record<string, ClaudeProfileRecord> {
  return {
    default: buildRecord({ loggedIn: false, usage: buildUsage({ session: 6, weekly: 99, isStale: true, weeklyResetsAt: '2026-11-21T00:00:00.000Z' }), ...patch.default }),
    second: buildRecord({ createdAt: '2026-11-10T00:00:00.000Z', ...patch.second }),
  };
}

function buildContext(records: Record<string, ClaudeProfileRecord>, chainScope: ClaudeLaunchChainScope | null = null) {
  return { views: buildClaudeProfileUsageViews({ dataDir, records }), model: null, nowMs, chainScope };
}

const refusedAt = '2026-11-20T08:00:00.000Z';
const refusal = (reason: ClaudeAuthRefusal['reason'], login?: string): ClaudeAuthRefusal => ({ at: refusedAt, reason, ...(login ? { login } : {}) });

describe('the launch: never on an account known not to work', () => {
  it('the live case — `default` not signed in: a new or resumed conversation starts on `second` instead', () => {
    const records = buildBugRecords();
    assert.deepEqual(resolveClaudeProfileForLaunch({ ...buildContext(records), resolved: 'default', record: records.default }), { name: 'second', isMoved: true });
  });

  it('an account the CLI refused counts as not signed in, whatever its last probe said', () => {
    const records = buildBugRecords({ default: { loggedIn: true, usage: buildUsage({ session: 1, weekly: 1 }), authRefusal: refusal('orgDisabled') } });
    assert.deepEqual(resolveClaudeProfileForLaunch({ ...buildContext(records), resolved: 'default', record: records.default }), { name: 'second', isMoved: true });
  });

  it('a usable account stays, even when another one would rank first; one never probed is not known to fail', () => {
    const records = buildBugRecords({ default: { loggedIn: true, usage: buildUsage({ session: 50, weekly: 50 }) } });
    assert.deepEqual(resolveClaudeProfileForLaunch({ ...buildContext(records), resolved: 'default', record: records.default }), { name: 'default', isMoved: false });
    const neverProbed = buildBugRecords({ default: { loggedIn: undefined } });
    assert.deepEqual(resolveClaudeProfileForLaunch({ ...buildContext(neverProbed), resolved: 'default', record: neverProbed.default }), { name: 'default', isMoved: false });
  });

  it('nowhere better to go — the other account signed out too, or kept off by the /limits list — it stays', () => {
    const bothOut = buildBugRecords({ second: { loggedIn: false } });
    assert.deepEqual(resolveClaudeProfileForLaunch({ ...buildContext(bothOut), resolved: 'default', record: bothOut.default }), { name: 'default', isMoved: false });
    const records = buildBugRecords();
    const onlyDefaultListed: ClaudeLaunchChainScope = { enabledNames: new Set(['default']), disabledNames: new Set() };
    assert.deepEqual(resolveClaudeProfileForLaunch({ ...buildContext(records, onlyDefaultListed), resolved: 'default', record: records.default }), { name: 'default', isMoved: false });
    const secondSwitchedOff: ClaudeLaunchChainScope = { enabledNames: new Set(['default']), disabledNames: new Set(['second']) };
    assert.equal(pickClaudeProfileInstead({ ...buildContext(records, secondSwitchedOff), currentProfile: 'default' }), null);
  });

  it('the /limits list first: an API-credit account it holds goes ahead of the subscription; one it does not hold is never picked', () => {
    const records = { ...buildBugRecords(), console: buildRecord({ createdAt: '2026-11-12T00:00:00.000Z', billing: 'api', usage: undefined }) };
    const listed: ClaudeLaunchChainScope = { enabledNames: new Set(['console', 'second']), disabledNames: new Set() };
    assert.equal(pickClaudeProfileInstead({ ...buildContext(records, listed), currentProfile: 'default' }), 'console');
    assert.equal(pickClaudeProfileInstead({ ...buildContext(records), currentProfile: 'default' }), 'second', 'no list: no money is spent unasked');
  });

  it('else the soonest weekly reset among the usable subscriptions — and an agents-only hold does not keep a conversation off', () => {
    const records = {
      ...buildBugRecords(),
      third: buildRecord({ createdAt: '2026-11-11T00:00:00.000Z', usage: buildUsage({ session: 10, weekly: 40, weeklyResetsAt: '2026-11-22T00:00:00.000Z' }) }),
    };
    assert.equal(pickClaudeProfileInstead({ ...buildContext(records), currentProfile: 'default' }), 'third');
    // An API account an agent's unproven stop report holds off AGENTS for an hour: a topic never reads that hold.
    const held = { ...buildBugRecords(), console: buildRecord({ createdAt: '2026-11-12T00:00:00.000Z', billing: 'api', usage: undefined, agentHoldUntil: '2026-11-20T10:00:00.000Z' }) };
    const listed: ClaudeLaunchChainScope = { enabledNames: new Set(['console', 'second']), disabledNames: new Set() };
    assert.equal(pickClaudeProfileInstead({ ...buildContext(held, listed), currentProfile: 'default' }), 'console');
  });
});

describe('the move after a refused turn', () => {
  it('the account the conversation runs on is marked, and the pick already leaves it out (its probe still says signed in)', () => {
    const records = buildBugRecords({ default: { loggedIn: true, usage: buildUsage({ session: 1, weekly: 1 }) } });
    assert.deepEqual(
      planClaudeAuthRefusalMove({ ...buildContext(records), refused: 'default', refusal: refusal('signedOut'), isReplayed: false }),
      { isMarked: true, to: 'second' },
    );
  });

  it('the only account: marked, nowhere to go — the logged-out notice as before', () => {
    const records = { default: buildRecord() };
    assert.deepEqual(
      planClaudeAuthRefusalMove({ ...buildContext(records), refused: 'default', refusal: refusal('orgDisabled'), isReplayed: false }),
      { isMarked: true, to: null },
    );
  });

  it('a refusal replayed from before the boot, or a conversation on no Claude account, marks nothing and moves nothing', () => {
    const records = buildBugRecords({ default: { loggedIn: true } });
    assert.deepEqual(planClaudeAuthRefusalMove({ ...buildContext(records), refused: 'default', refusal: refusal('signedOut'), isReplayed: true }), { isMarked: false, to: null });
    assert.deepEqual(planClaudeAuthRefusalMove({ ...buildContext(records), refused: null, refusal: refusal('signedOut'), isReplayed: false }), { isMarked: false, to: null });
  });

  it('a second refusal moves on from the account it moved to, never back to the first one', () => {
    const records = { ...buildBugRecords({ default: { loggedIn: true, authRefusal: refusal('signedOut') } }), third: buildRecord({ createdAt: '2026-11-12T00:00:00.000Z' }) };
    assert.deepEqual(
      planClaudeAuthRefusalMove({ ...buildContext(records), refused: 'second', refusal: refusal('rejected'), isReplayed: false }),
      { isMarked: true, to: 'third' },
    );
  });
});

describe('the mark', () => {
  it('counts as signed out in every view, and only while it stands', () => {
    const views = buildClaudeProfileUsageViews({ dataDir, records: { default: buildRecord({ authRefusal: refusal('orgDisabled') }), second: buildRecord() } });
    assert.equal(views[0].loggedIn, false);
    assert.deepEqual(views[0].authRefusal, refusal('orgDisabled'));
    assert.equal(views[1].loggedIn, true);
    assert.equal(views[1].authRefusal, undefined);
    assert.equal(getClaudeProfileSignedIn({ loggedIn: true }), true);
    assert.equal(getClaudeProfileSignedIn(undefined), undefined);
    assert.equal(checkIsClaudeProfileKnownUnusable({ loggedIn: undefined }), false);
    assert.equal(checkIsClaudeProfileKnownUnusable({ loggedIn: false }), true);
    assert.equal(checkIsClaudeProfileKnownUnusable({ loggedIn: true, authRefusal: refusal('rejected') }), true);
  });

  it('is over once the account holds another login — a sign-in — whatever the probe says', () => {
    const probedAfter = { loggedIn: true, statusCheckedAt: '2026-11-20T08:30:00.000Z' };
    assert.equal(getClaudeAuthRefusalEnd({ refusal: refusal('signedOut', 'aaaa'), loginStamp: 'bbbb', loggedIn: false, statusCheckedAt: undefined }), 'newLogin');
    assert.equal(getClaudeAuthRefusalEnd({ refusal: refusal('signedOut'), loginStamp: 'bbbb', loggedIn: undefined, statusCheckedAt: undefined }), 'newLogin', 'a folder that held no login now holds one');
    assert.equal(getClaudeAuthRefusalEnd({ refusal: refusal('signedOut', 'aaaa'), loginStamp: 'aaaa', ...probedAfter }), null, 'the same login, however signed in the probe finds it');
    assert.equal(getClaudeAuthRefusalEnd({ refusal: refusal('orgDisabled', 'aaaa'), loginStamp: 'aaaa', ...probedAfter }), null, 'the organization\'s switch is no sign-out the probe would see');
    assert.equal(getClaudeAuthRefusalEnd({ refusal: refusal('signedOut', 'aaaa'), loginStamp: null, ...probedAfter }), null, 'no login at all is not a sign-in');
  });

  it('a bare 401 / 403 also ends with a probe after it that finds the account signed in — not with one before it', () => {
    assert.equal(getClaudeAuthRefusalEnd({ refusal: refusal('rejected', 'aaaa'), loginStamp: 'aaaa', loggedIn: true, statusCheckedAt: '2026-11-20T08:30:00.000Z' }), 'statusCheck');
    assert.equal(getClaudeAuthRefusalEnd({ refusal: refusal('rejected', 'aaaa'), loginStamp: 'aaaa', loggedIn: true, statusCheckedAt: '2026-11-20T07:30:00.000Z' }), null);
    assert.equal(getClaudeAuthRefusalEnd({ refusal: refusal('rejected', 'aaaa'), loginStamp: 'aaaa', loggedIn: false, statusCheckedAt: '2026-11-20T08:30:00.000Z' }), null);
  });
});

describe('a bare 401 / 403 that keeps coming: no swing between «refused» and «usable» every hour', () => {
  const hourMs = 60 * 60_000;
  const firstAtMs = Date.parse('2026-11-20T08:00:00.000Z');
  const forbidden = 'API Error: 403 {"type":"error","error":{"type":"permission_error"}}';
  const mark = (input: { nowMs: number; login?: string | null; reason?: ClaudeAuthRefusal['reason']; endedAt?: string; endedLogin?: string }): ClaudeAuthRefusal => buildClaudeAuthRefusalMark({
    reason: input.reason ?? 'rejected',
    login: input.login === undefined ? 'aaaa' : input.login,
    detail: forbidden,
    nowMs: input.nowMs,
    endedByStatusCheck: input.endedAt === undefined ? undefined : { at: input.endedAt, ...(input.endedLogin !== undefined ? { login: input.endedLogin } : {}) },
  });

  it('the first refusal may end by a status check; the same login refused again within the window is held until a new login', () => {
    const first = mark({ nowMs: firstAtMs });
    assert.deepEqual(first, { at: '2026-11-20T08:00:00.000Z', reason: 'rejected', login: 'aaaa', detail: forbidden });
    // The hourly probe finds it «signed in»: the refusal ends, by a status check.
    const endedAt = new Date(firstAtMs + hourMs).toISOString();
    assert.equal(getClaudeAuthRefusalEnd({ refusal: first, loginStamp: 'aaaa', loggedIn: true, statusCheckedAt: endedAt }), 'statusCheck');
    // The next conversation on it is refused again: held.
    const second = mark({ nowMs: firstAtMs + 2 * hourMs, endedAt, endedLogin: 'aaaa' });
    assert.equal(second.isHeldUntilNewLogin, true);
    // Every later probe finds it «signed in» again — and changes nothing.
    for (let hour = 3; hour <= 24; hour += 1) {
      assert.equal(getClaudeAuthRefusalEnd({ refusal: second, loginStamp: 'aaaa', loggedIn: true, statusCheckedAt: new Date(firstAtMs + hour * hourMs).toISOString() }), null, `hour ${hour}`);
    }
    assert.equal(getClaudeAuthRefusalEnd({ refusal: second, loginStamp: 'bbbb', loggedIn: true, statusCheckedAt: endedAt }), 'newLogin', 'a sign-in ends it');
  });

  it('not held: another login, a repeat past the window, a refusal the CLI named, or no earlier end at all', () => {
    const endedAt = new Date(firstAtMs).toISOString();
    assert.equal(mark({ nowMs: firstAtMs + hourMs, endedAt, endedLogin: 'aaaa', login: 'bbbb' }).isHeldUntilNewLogin, undefined, 'another login');
    assert.equal(mark({ nowMs: firstAtMs + claudeRejectedRepeatWindowMs, endedAt, endedLogin: 'aaaa' }).isHeldUntilNewLogin, undefined, 'past the window');
    assert.equal(mark({ nowMs: firstAtMs + hourMs, endedAt, endedLogin: 'aaaa', reason: 'signedOut' }).isHeldUntilNewLogin, undefined, 'a named refusal never ends by a probe anyway');
    assert.equal(mark({ nowMs: firstAtMs + hourMs }).isHeldUntilNewLogin, undefined);
    assert.equal(mark({ nowMs: firstAtMs + hourMs, endedAt, login: null }).isHeldUntilNewLogin, true, 'no login stamp either time is the same login');
  });

  it('an account back by a status check alone is said so in the log — only within the window, and never while a refusal stands', () => {
    const ended = { at: new Date(firstAtMs).toISOString(), login: 'aaaa' };
    assert.equal(checkIsClaudeProfileBackByStatusCheck({ authRefusalEndedByStatusCheck: ended }, firstAtMs + hourMs), true);
    assert.equal(checkIsClaudeProfileBackByStatusCheck({ authRefusalEndedByStatusCheck: ended }, firstAtMs + claudeRejectedRepeatWindowMs), false);
    assert.equal(checkIsClaudeProfileBackByStatusCheck({ authRefusalEndedByStatusCheck: ended, authRefusal: refusal('rejected', 'aaaa') }, firstAtMs + hourMs), false);
    assert.equal(checkIsClaudeProfileBackByStatusCheck({}, firstAtMs), false);
    assert.deepEqual(
      listClaudeProfileUsabilityLines({ previous: new Map([['work', 'rejected']]), current: new Map([['work', 'usable']]), getInstead: () => null, backByStatusCheck: new Set(['work']) }),
      ['[accounts] profile work: usable again — a status check found it signed in after the API refused it (401/403); the same refusal again holds it until a new sign-in'],
    );
  });
});

describe('readClaudeLoginStamp', () => {
  let root: string;
  before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-login-stamp-')); });
  after(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const writeCredentials = (dir: string, oauth: Record<string, unknown>): void => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }));
  };

  it('a hash of the stored login: the refresh token outlives a renewed access token, a new sign-in changes it', () => {
    const dir = path.join(root, 'work');
    writeCredentials(dir, { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: 1 });
    const first = readClaudeLoginStamp(dir, root);
    assert.match(first ?? '', /^[0-9a-f]{16}$/);
    assert.ok(!(first ?? '').includes('refresh'), 'the secret itself never comes out');
    writeCredentials(dir, { accessToken: 'access-2', refreshToken: 'refresh-1', expiresAt: 2 });
    assert.equal(readClaudeLoginStamp(dir, root), first, 'the CLI renewing its access token is the same login');
    writeCredentials(dir, { accessToken: 'access-3', refreshToken: 'refresh-2', expiresAt: 3 });
    assert.notEqual(readClaudeLoginStamp(dir, root), first, 'a sign-in again');
  });

  it('a pasted API key counts as the login of an API account; a folder with neither has no stamp', () => {
    const dir = path.join(root, 'console');
    fs.mkdirSync(dir, { recursive: true });
    assert.equal(readClaudeLoginStamp(dir, root), null);
    fs.writeFileSync(path.join(dir, 'charness-api-key'), `sk-ant-api03-${'a'.repeat(40)}\n`);
    assert.match(readClaudeLoginStamp(dir, root) ?? '', /^[0-9a-f]{16}$/);
  });

  it('`default` is read from the home folder\'s `.claude`', () => {
    const home = path.join(root, 'home');
    assert.equal(readClaudeLoginStamp(null, home), null);
    writeCredentials(path.join(home, '.claude'), { accessToken: 'access-home', refreshToken: 'refresh-home' });
    assert.match(readClaudeLoginStamp(null, home) ?? '', /^[0-9a-f]{16}$/);
  });
});

describe('the log: one line per change of an account\'s state', () => {
  const lines = (previous: Array<[string, ClaudeProfileUsability]>, current: Array<[string, ClaudeProfileUsability]>, instead: string | null = 'second'): string[] =>
    listClaudeProfileUsabilityLines({ previous: new Map(previous), current: new Map(current), getInstead: () => instead });

  it('an account found signed out — where new sessions go, or that none can take them', () => {
    assert.deepEqual(lines([], [['default', 'notSignedIn'], ['second', 'usable']]), ['[accounts] profile default: not signed in — new sessions go to second']);
    assert.deepEqual(lines([], [['default', 'notSignedIn']], null), ['[accounts] profile default: not signed in — no other account can take new sessions']);
  });

  it('a refusal says why; a state that holds says nothing again; a sign-in again says so once', () => {
    assert.deepEqual(lines([['default', 'usable']], [['default', 'orgDisabled']]), [
      '[accounts] profile default: refused by the CLI: its organization disabled Claude subscription access in Claude Code — new sessions go to second',
    ]);
    assert.deepEqual(lines([['default', 'orgDisabled']], [['default', 'orgDisabled']]), []);
    assert.deepEqual(lines([['default', 'notSignedIn']], [['default', 'signedOut']]).length, 1, 'refused on a turn after the probe found it out: a new state');
    assert.deepEqual(lines([['default', 'signedOut']], [['default', 'usable']]), ['[accounts] profile default: signed in again — usable for new sessions']);
  });

  it('the state of a record: a refusal names its reason, a sign-out its own, anything else is usable', () => {
    assert.equal(getClaudeProfileUsability({ loggedIn: true, authRefusal: refusal('rejected') }), 'rejected');
    assert.equal(getClaudeProfileUsability({ loggedIn: false }), 'notSignedIn');
    assert.equal(getClaudeProfileUsability({ loggedIn: undefined }), 'usable');
    assert.equal(getClaudeProfileUsability(undefined), 'usable');
  });
});
