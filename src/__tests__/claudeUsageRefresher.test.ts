/**
 * `utils/claudeUsageRefresher.ts` — the poller: which profiles it polls, what an expired token / a failed
 * fetch / a missing credentials file leave behind, the on-demand max-age gate, the single in-flight poll, and
 * the stream-frame fold that persists only a moved bucket.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeUsageRefresher, type ClaudeUsageRefresherDeps, type ClaudeUsageRefresherProfile } from '../utils/claudeUsageRefresher';
import type { ClaudeUsageBucket, ClaudeUsageFetchResult, ClaudeUsageSnapshot } from '../utils/claudeUsage';

const session = (percent: number): ClaudeUsageBucket => ({ kind: 'session', percent, resetsAt: '2026-10-12T13:00:00.000Z', scopeModel: null });

function createHarness(options: {
  profiles: ClaudeUsageRefresherProfile[];
  tokens?: Record<string, { accessToken: string; expiresAtMs: number | null } | null>;
  fetch?: (token: string) => Promise<ClaudeUsageFetchResult>;
  snapshots?: Record<string, ClaudeUsageSnapshot>;
}) {
  let nowMs = Date.parse('2026-10-12T10:00:00Z');
  const snapshots = new Map<string, ClaudeUsageSnapshot>(Object.entries(options.snapshots ?? {}));
  const saves: Array<[string, ClaudeUsageSnapshot]> = [];
  const fetched: string[] = [];
  const logs: string[] = [];
  const deps: ClaudeUsageRefresherDeps = {
    listProfiles: () => options.profiles,
    getSnapshot: (name) => snapshots.get(name),
    saveSnapshot: (name, snapshot) => { snapshots.set(name, snapshot); saves.push([name, snapshot]); },
    readToken: (configDir) => {
      const key = configDir ?? 'default';
      return options.tokens && key in options.tokens ? options.tokens[key] : { accessToken: `tok-${key}`, expiresAtMs: nowMs + 3_600_000 };
    },
    fetchUsage: async (token) => {
      fetched.push(token);
      return options.fetch ? options.fetch(token) : { ok: true, buckets: [session(42)] };
    },
    now: () => nowMs,
    log: (line) => logs.push(line),
  };
  return { refresher: createClaudeUsageRefresher(deps), snapshots, saves, fetched, logs, advance: (ms: number) => { nowMs += ms; } };
}

const defaultProfile: ClaudeUsageRefresherProfile = { name: 'default', configDir: null, loggedIn: true };
const workProfile: ClaudeUsageRefresherProfile = { name: 'work', configDir: '/p/work', loggedIn: true };

describe('refreshAll', () => {
  it('polls every profile not known to be signed out, with its own token, and stores an api snapshot', async () => {
    const h = createHarness({ profiles: [defaultProfile, workProfile, { name: 'out', configDir: '/p/out', loggedIn: false }] });
    await h.refresher.refreshAll();
    assert.deepEqual(h.fetched.sort(), ['tok-/p/work', 'tok-default']);
    assert.deepEqual(h.saves.map(([name, snapshot]) => [name, snapshot.source, snapshot.buckets[0].percent]), [['default', 'api', 42], ['work', 'api', 42]]);
    assert.equal(h.snapshots.has('out'), false);
  });

  it('an expired token is never sent: the snapshot is marked stale (token expired) once; a missing credentials file marks a fresh snapshot stale too', async () => {
    const h = createHarness({
      profiles: [defaultProfile, workProfile],
      tokens: { default: { accessToken: 'old', expiresAtMs: Date.parse('2026-10-12T09:00:00Z') }, '/p/work': null },
      snapshots: { work: { fetchedAt: '2026-10-12T09:00:00.000Z', source: 'api', buckets: [session(10)] } },
    });
    await h.refresher.refreshAll();
    await h.refresher.refreshAll();
    assert.deepEqual(h.fetched, []);
    assert.deepEqual(h.saves.map(([name, snapshot]) => [name, snapshot.isStale, snapshot.error]), [['default', true, 'token expired'], ['work', true, 'not signed in']]);
    assert.deepEqual(h.snapshots.get('work')?.buckets, [session(10)], 'the last figures are kept');
  });

  it('a failed fetch keeps the last buckets, marks them stale with the reason and logs one line', async () => {
    const h = createHarness({
      profiles: [defaultProfile],
      fetch: async () => ({ ok: false, error: 'http 500', isAuthError: false }),
      snapshots: { default: { fetchedAt: '2026-10-12T09:00:00.000Z', source: 'api', buckets: [session(10)] } },
    });
    await h.refresher.refreshAll();
    const snapshot = h.snapshots.get('default')!;
    assert.equal(snapshot.isStale, true);
    assert.equal(snapshot.error, 'http 500');
    assert.deepEqual(snapshot.buckets, [session(10)]);
    assert.equal(h.logs.length, 1);
    assert.match(h.logs[0], /default: usage poll failed \(http 500\)/);
  });

  it('with maxAgeMs only a snapshot older than that (or stale, or absent) is polled; a later stale mark makes it due again', async () => {
    const h = createHarness({ profiles: [defaultProfile, workProfile] });
    await h.refresher.refreshAll();
    h.fetched.length = 0;
    await h.refresher.refreshAll({ maxAgeMs: 60_000 });
    assert.deepEqual(h.fetched, [], 'both snapshots are seconds old');
    h.advance(61_000);
    await h.refresher.refreshAll({ maxAgeMs: 60_000 });
    assert.equal(h.fetched.length, 2);
  });

  it('one poll in flight at a time: a second call while one runs awaits the same poll', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = createHarness({ profiles: [defaultProfile], fetch: async () => { await gate; return { ok: true, buckets: [session(1)] }; } });
    const first = h.refresher.refreshAll();
    const second = h.refresher.refreshAll();
    release();
    await Promise.all([first, second]);
    assert.equal(h.fetched.length, 1);
  });

  it('refreshOne polls just that profile; an unknown name is a no-op', async () => {
    const h = createHarness({ profiles: [defaultProfile, workProfile] });
    await h.refresher.refreshOne('work');
    await h.refresher.refreshOne('nobody');
    assert.deepEqual(h.fetched, ['tok-/p/work']);
  });
});

describe('noteStreamWindows', () => {
  it('folds a frame into the profile snapshot as a stream read and persists only when a bucket moved', () => {
    const h = createHarness({ profiles: [defaultProfile] });
    const windows = [{ name: 'five_hour', utilization: 0.81, resetsAtMs: 1791810000000 }, { name: 'unknown_window', utilization: 0.5, resetsAtMs: null }];
    h.refresher.noteStreamWindows('default', windows);
    h.refresher.noteStreamWindows('default', windows);
    h.refresher.noteStreamWindows('default', windows);
    assert.equal(h.saves.length, 1, 'the same figures three times are one write');
    assert.equal(h.saves[0][1].source, 'stream');
    assert.deepEqual(h.saves[0][1].buckets.map((bucket) => [bucket.kind, bucket.percent]), [['session', 81]]);
    h.refresher.noteStreamWindows('default', [{ name: 'five_hour', utilization: 0.82, resetsAtMs: 1791810000000 }]);
    assert.equal(h.saves.length, 2);
    h.refresher.noteStreamWindows('default', [{ name: 'unknown_window', utilization: 0.9, resetsAtMs: null }]);
    assert.equal(h.saves.length, 2, 'a frame with no known window writes nothing');
  });

  it('a stream read after an api read keeps the windows the frame did not carry', async () => {
    const h = createHarness({ profiles: [defaultProfile], fetch: async () => ({ ok: true, buckets: [session(42), { kind: 'weekly_all', percent: 70, resetsAt: null, scopeModel: null }] }) });
    await h.refresher.refreshAll();
    h.refresher.noteStreamWindows('default', [{ name: 'five_hour', utilization: 0.5, resetsAtMs: 1791810000000 }]);
    assert.deepEqual(h.snapshots.get('default')!.buckets.map((bucket) => [bucket.kind, bucket.percent]), [['session', 50], ['weekly_all', 70]]);
  });
});

describe('the timer', () => {
  it('start arms an unref\'d interval that polls; stop clears it; start twice keeps one', async () => {
    const h = createHarness({ profiles: [defaultProfile] });
    h.refresher.start(5);
    h.refresher.start(5);
    await new Promise((resolve) => setTimeout(resolve, 30));
    h.refresher.stop();
    const polls = h.fetched.length;
    assert.ok(polls >= 1 && polls <= 7, `polled ${polls} times in ~30 ms at 5 ms — one timer, not two`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(h.fetched.length, polls, 'nothing after stop');
  });
});
