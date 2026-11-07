/**
 * `utils/claudeUsageRefresher.ts` — the poller: which profiles it polls, what an expired token / a failed
 * fetch / a missing credentials file leave behind, the on-demand max-age gate, the single in-flight poll, and
 * the stream-frame fold that persists only a moved bucket.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeUsageRefresher, refreshClaudeUsageForLaunch, type ClaudeUsageRefresherDeps, type ClaudeUsageRefresherProfile } from '../utils/claudeUsageRefresher';
import type { ClaudeUsageBucket, ClaudeUsageFetchResult, ClaudeUsageSnapshot } from '../utils/claudeUsage';

const session = (percent: number): ClaudeUsageBucket => ({ kind: 'session', percent, resetsAt: '2026-10-12T13:00:00.000Z', scopeModel: null });

function createHarness(options: {
  profiles: ClaudeUsageRefresherProfile[];
  refreshOpenCode?: ClaudeUsageRefresherDeps['refreshOpenCode'];
  tokens?: Record<string, { accessToken: string; expiresAtMs: number | null } | null>;
  fetch?: (token: string, signal: AbortSignal | undefined) => Promise<ClaudeUsageFetchResult>;
  snapshots?: Record<string, ClaudeUsageSnapshot>;
  pollDeadlineMs?: number;
  markOpenCodeStale?: ClaudeUsageRefresherDeps['markOpenCodeStale'];
}) {
  let nowMs = Date.parse('2026-10-12T10:00:00Z');
  const snapshots = new Map<string, ClaudeUsageSnapshot>(Object.entries(options.snapshots ?? {}));
  const saves: Array<[string, ClaudeUsageSnapshot]> = [];
  const fetched: string[] = [];
  const fetchSignals: Array<AbortSignal | undefined> = [];
  const logs: string[] = [];
  const deps: ClaudeUsageRefresherDeps = {
    listProfiles: () => options.profiles,
    getSnapshot: (name) => snapshots.get(name),
    saveSnapshot: (name, snapshot) => { snapshots.set(name, snapshot); saves.push([name, snapshot]); },
    readToken: (configDir) => {
      const key = configDir ?? 'default';
      return options.tokens && key in options.tokens ? options.tokens[key] : { accessToken: `tok-${key}`, expiresAtMs: nowMs + 3_600_000 };
    },
    fetchUsage: async (token, signal) => {
      fetched.push(token);
      fetchSignals.push(signal);
      return options.fetch ? options.fetch(token, signal) : { ok: true, buckets: [session(42)] };
    },
    refreshOpenCode: options.refreshOpenCode,
    markOpenCodeStale: options.markOpenCodeStale,
    pollDeadlineMs: options.pollDeadlineMs,
    now: () => nowMs,
    log: (line) => logs.push(line),
  };
  return { refresher: createClaudeUsageRefresher(deps), snapshots, saves, fetched, fetchSignals, logs, advance: (ms: number) => { nowMs += ms; } };
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

describe('refreshAll and the OpenCode providers', () => {
  it('polls the OpenCode providers beside the profiles, passing the max age on', async () => {
    const asked: Array<{ maxAgeMs?: number; signal?: AbortSignal }> = [];
    const h = createHarness({ profiles: [defaultProfile], refreshOpenCode: async (options) => { asked.push(options); } });
    await h.refresher.refreshAll();
    await h.refresher.refreshAll({ maxAgeMs: 60_000 });
    assert.deepEqual(asked.map(({ maxAgeMs }) => maxAgeMs), [undefined, 60_000]);
    assert.ok(asked.every(({ signal }) => signal instanceof AbortSignal), 'each OpenCode poll carries the signal that cancels it');
    assert.equal(h.fetched.length, 1, 'the Claude profile\'s own gate is untouched: polled on the first call, its fresh snapshot skipped on the second');
  });

  it('a failing OpenCode poll is logged and never keeps the Claude profiles from their snapshots', async () => {
    const h = createHarness({ profiles: [defaultProfile], refreshOpenCode: async () => { throw new Error('auth.json vanished'); } });
    await h.refresher.refreshAll();
    assert.equal(h.snapshots.get('default')?.buckets[0].percent, 42);
    assert.match(h.logs.join('\n'), /OpenCode providers: usage poll threw: auth\.json vanished/);
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

/** Settles with `'hung'` when `task` is still pending after `ms` — a test of "never returns" must fail by assertion, not by hanging the runner. */
async function settleOrHung<T>(task: Promise<T>, ms = 1_000): Promise<T | 'hung'> {
  let timer: NodeJS.Timeout | undefined;
  const hung = new Promise<'hung'>((resolve) => { timer = setTimeout(() => resolve('hung'), ms); });
  try {
    return await Promise.race([task, hung]);
  } finally {
    clearTimeout(timer);
  }
}

const neverSettles = (): Promise<never> => new Promise<never>(() => {});

describe('a poll that never settles must not pin the refresh', () => {
  it('a stuck poll is given up after the poll deadline: the refresh ends and says which poll it gave up on', async () => {
    const h = createHarness({ profiles: [defaultProfile], pollDeadlineMs: 20, fetch: () => neverSettles() });
    assert.notEqual(await settleOrHung(h.refresher.refreshAll()), 'hung', 'the stuck poll is abandoned at its deadline');
    assert.match(h.logs.join('\n'), /default: usage poll did not finish within 0\.02 s/);
  });

  it('every later caller gets out too: ten refreshes joined to a stuck poll all end at its deadline', async () => {
    const h = createHarness({ profiles: [defaultProfile], pollDeadlineMs: 20, fetch: () => neverSettles() });
    const callers = Array.from({ length: 10 }, () => h.refresher.refreshAll({ maxAgeMs: 60_000 }));
    assert.notEqual(await settleOrHung(Promise.all(callers)), 'hung');
  });

  it('a stuck profile does not hold back the others: their snapshots are stored while it is waited for, and its own figures are marked stale', async () => {
    const h = createHarness({
      profiles: [defaultProfile, workProfile],
      pollDeadlineMs: 20,
      fetch: (token) => (token === 'tok-default' ? neverSettles() : Promise.resolve({ ok: true, buckets: [session(33)] })),
    });
    assert.notEqual(await settleOrHung(h.refresher.refreshAll()), 'hung');
    assert.equal(h.snapshots.get('work')?.buckets[0].percent, 33);
    assert.equal(h.snapshots.get('work')?.isStale, undefined);
    assert.equal(h.snapshots.get('default')?.isStale, true, 'the abandoned poll left a stale mark, not a reading that looks current');
    assert.equal(h.snapshots.get('default')?.error, 'usage poll did not finish');
  });

  it('the give-up keeps the last figures and their age, and only marks them stale with the reason', async () => {
    const previous: ClaudeUsageSnapshot = { fetchedAt: '2026-10-12T08:00:00.000Z', source: 'api', buckets: [session(61)] };
    const h = createHarness({ profiles: [defaultProfile], pollDeadlineMs: 20, snapshots: { default: previous }, fetch: () => neverSettles() });
    await settleOrHung(h.refresher.refreshAll());
    assert.deepEqual(h.snapshots.get('default'), { ...previous, isStale: true, error: 'usage poll did not finish' });
  });

  it('a stuck OpenCode poll is given up too: the Claude profiles keep their figures, the OpenCode records are marked stale with the same reason', async () => {
    const markedStale: string[] = [];
    const h = createHarness({ profiles: [defaultProfile], pollDeadlineMs: 20, refreshOpenCode: () => neverSettles(), markOpenCodeStale: (reason) => markedStale.push(reason) });
    assert.notEqual(await settleOrHung(h.refresher.refreshAll()), 'hung');
    assert.equal(h.snapshots.get('default')?.buckets[0].percent, 42);
    assert.match(h.logs.join('\n'), /OpenCode providers: usage poll did not finish within 0\.02 s/);
    assert.deepEqual(markedStale, ['usage poll did not finish']);
  });

  it('refreshOne is bounded the same way (the forced read of the account a limit just stopped) and marks the same stale', async () => {
    const h = createHarness({ profiles: [defaultProfile, workProfile], pollDeadlineMs: 20, fetch: () => neverSettles() });
    assert.notEqual(await settleOrHung(h.refresher.refreshOne('work')), 'hung');
    assert.equal(h.snapshots.get('work')?.isStale, true);
  });

  it('a poll that answers inside its deadline is untouched: no give-up line, no stale mark, the figures are stored', async () => {
    const markedStale: string[] = [];
    const h = createHarness({ profiles: [defaultProfile], pollDeadlineMs: 500, markOpenCodeStale: (reason) => markedStale.push(reason), refreshOpenCode: async () => {} });
    await h.refresher.refreshAll();
    assert.equal(h.snapshots.get('default')?.buckets[0].percent, 42);
    assert.equal(h.snapshots.get('default')?.isStale, undefined);
    assert.deepEqual(h.logs, []);
    assert.deepEqual(markedStale, []);
  });
});

describe('a poll that was given up on', () => {
  it('is cancelled: its request gets an aborted signal at the deadline', async () => {
    const h = createHarness({ profiles: [defaultProfile], pollDeadlineMs: 20, fetch: () => neverSettles() });
    await settleOrHung(h.refresher.refreshAll());
    assert.equal(h.fetchSignals.length, 1);
    assert.equal(h.fetchSignals[0]?.aborted, true);
  });

  it('never saves, even when the request ignores the cancel and settles late: a newer reading is not overwritten', async () => {
    let release!: (result: ClaudeUsageFetchResult) => void;
    const h = createHarness({ profiles: [defaultProfile], pollDeadlineMs: 20, fetch: () => new Promise<ClaudeUsageFetchResult>((resolve) => { release = resolve; }) });
    await settleOrHung(h.refresher.refreshAll());
    h.refresher.noteStreamWindows('default', [{ name: 'five_hour', utilization: 0.81, resetsAtMs: 1791810000000 }]);
    const newer = h.snapshots.get('default');
    assert.equal(newer?.buckets[0].percent, 81);
    const savesBefore = h.saves.length;
    release({ ok: true, buckets: [session(99)] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(h.saves.length, savesBefore, 'the late answer wrote nothing');
    assert.deepEqual(h.snapshots.get('default'), newer);
  });

  it('is not stacked on: refreshes during a systematic hang start no second poll of the profile, while the other profiles are polled as usual', async () => {
    const h = createHarness({
      profiles: [defaultProfile, workProfile],
      pollDeadlineMs: 20,
      fetch: (token) => (token === 'tok-default' ? neverSettles() : Promise.resolve({ ok: true, buckets: [session(5)] })),
    });
    for (let round = 0; round < 5; round += 1) await settleOrHung(h.refresher.refreshAll());
    await settleOrHung(h.refresher.refreshOne('default'));
    assert.equal(h.fetched.filter((token) => token === 'tok-default').length, 1, 'one pending poll of the stuck profile, however many refreshes ask');
    assert.equal(h.fetched.filter((token) => token === 'tok-/p/work').length, 5, 'the healthy profile is polled every time');
  });

  it('and the OpenCode providers are not stacked on either: one pending poll at a time', async () => {
    let started = 0;
    const h = createHarness({ profiles: [], pollDeadlineMs: 20, refreshOpenCode: () => { started += 1; return neverSettles(); } });
    for (let round = 0; round < 4; round += 1) await settleOrHung(h.refresher.refreshAll());
    assert.equal(started, 1);
  });

  it('frees the profile when it finally settles: the next refresh polls afresh, and one line says how long it took', async () => {
    let release!: (result: ClaudeUsageFetchResult) => void;
    let calls = 0;
    const h = createHarness({
      profiles: [defaultProfile],
      pollDeadlineMs: 20,
      fetch: () => (++calls === 1 ? new Promise<ClaudeUsageFetchResult>((resolve) => { release = resolve; }) : Promise.resolve({ ok: true, buckets: [session(7)] })),
    });
    await settleOrHung(h.refresher.refreshAll());
    h.advance(45_000);
    release({ ok: true, buckets: [session(99)] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(h.logs.join('\n'), /default: the abandoned usage poll finished after 45\.0 s; its answer was dropped/);
    await settleOrHung(h.refresher.refreshAll());
    assert.equal(calls, 2);
    assert.equal(h.snapshots.get('default')?.buckets[0].percent, 7);
  });

  it('logs its failure when it arrives after the deadline, with how long it took — a late error is not swallowed', async () => {
    let fail!: (error: Error) => void;
    const h = createHarness({ profiles: [defaultProfile], pollDeadlineMs: 20, fetch: () => new Promise<ClaudeUsageFetchResult>((_resolve, reject) => { fail = reject; }) });
    await settleOrHung(h.refresher.refreshAll());
    h.advance(50_000);
    fail(new Error('socket exploded'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const log = h.logs.join('\n');
    assert.match(log, /default: usage poll threw: socket exploded/);
    assert.match(log, /default: the abandoned usage poll failed after 50\.0 s/);
  });

  it('a poll that fails inside its deadline is logged once and has no "abandoned" line; refreshOne logs its failure instead of throwing', async () => {
    const h = createHarness({ profiles: [defaultProfile, workProfile], fetch: async () => { throw new Error('boom'); } });
    await h.refresher.refreshAll();
    assert.equal(h.logs.filter((line) => line.includes('usage poll threw: boom')).length, 2);
    assert.ok(!h.logs.some((line) => line.includes('abandoned')));
    await h.refresher.refreshOne('work');
    assert.equal(h.logs.filter((line) => line.includes('work: usage poll threw: boom')).length, 2);
  });
});

describe('refreshClaudeUsageForLaunch', () => {
  const maxAgeMs = 60_000;
  const freshSnapshot = (): ClaudeUsageSnapshot => ({ fetchedAt: '2026-10-12T09:59:30.000Z', source: 'api', buckets: [session(10)] });

  it('a resume that was NOT stopped by a limit reads only what is older than the cache allows', async () => {
    const h = createHarness({ profiles: [defaultProfile, workProfile], snapshots: { default: freshSnapshot(), work: freshSnapshot() } });
    await refreshClaudeUsageForLaunch(h.refresher, { currentProfile: 'work', isStoppedByLimit: false, maxAgeMs });
    assert.deepEqual(h.fetched, [], 'both snapshots are younger than a minute');
  });

  it('a session stopped by a limit has its account re-read first and at once, even though its snapshot is fresh; the rest follows the cache', async () => {
    const h = createHarness({ profiles: [defaultProfile, workProfile], snapshots: { work: freshSnapshot() } });
    await refreshClaudeUsageForLaunch(h.refresher, { currentProfile: 'work', isStoppedByLimit: true, maxAgeMs });
    assert.deepEqual(h.fetched, ['tok-/p/work', 'tok-default'], 'work is forced first; default has no snapshot and is due');
    assert.equal(h.snapshots.get('work')?.buckets[0].percent, 42, 'the forced read replaced the cached figure');
  });

  it('a refresh that never ends does not hold the answer: it is given up at the budget, one line says so, and the cached figures are answered', async () => {
    const logs: string[] = [];
    const stuck = { refreshOne: () => neverSettles(), refreshAll: () => neverSettles() };
    const outcome = await settleOrHung(refreshClaudeUsageForLaunch(stuck, { currentProfile: 'work', isStoppedByLimit: true, maxAgeMs, budgetMs: 20, log: (line) => logs.push(line) }));
    assert.notEqual(outcome, 'hung');
    assert.equal(logs.length, 1);
    assert.match(logs[0], /claude_profiles: the usage refresh did not finish within 0\.02 s; answering from the cached figures/);
  });

  it('a refresh that is done inside the budget logs nothing', async () => {
    const logs: string[] = [];
    const h = createHarness({ profiles: [defaultProfile, workProfile] });
    await refreshClaudeUsageForLaunch(h.refresher, { currentProfile: null, isStoppedByLimit: false, maxAgeMs, budgetMs: 500, log: (line) => logs.push(line) });
    assert.equal(h.fetched.length, 2);
    assert.deepEqual(logs, []);
  });

  it('the budget covers the whole launch refresh, the forced read of the stopped account and the rest together; what is left runs on in the background', async () => {
    const order: string[] = [];
    const logs: string[] = [];
    const slowRefresher = {
      refreshOne: async () => { order.push('one'); await new Promise((resolve) => setTimeout(resolve, 40)); },
      refreshAll: async () => { order.push('all'); },
    };
    await refreshClaudeUsageForLaunch(slowRefresher, { currentProfile: 'work', isStoppedByLimit: true, maxAgeMs, budgetMs: 15, log: (line) => logs.push(line) });
    assert.deepEqual(order, ['one'], 'the budget ran out inside the first step');
    assert.equal(logs.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(order, ['one', 'all'], 'the refresh was given up on, not cancelled');
  });

  it('a refresh that throws is logged and the answer still comes from the cached figures', async () => {
    const logs: string[] = [];
    const broken = { refreshOne: async () => {}, refreshAll: async () => { throw new Error('profile list unreadable'); } };
    await refreshClaudeUsageForLaunch(broken, { currentProfile: null, isStoppedByLimit: false, maxAgeMs, budgetMs: 500, log: (line) => logs.push(line) });
    assert.deepEqual(logs, ['[usage] claude_profiles: the usage refresh threw: profile list unreadable']);
  });

  it('nothing to force without a current profile, or for a name that is no profile', async () => {
    const withoutCurrent = createHarness({ profiles: [defaultProfile, workProfile], snapshots: { default: freshSnapshot(), work: freshSnapshot() } });
    await refreshClaudeUsageForLaunch(withoutCurrent.refresher, { currentProfile: null, isStoppedByLimit: true, maxAgeMs });
    assert.deepEqual(withoutCurrent.fetched, []);
    const unknown = createHarness({ profiles: [defaultProfile, workProfile], snapshots: { default: freshSnapshot(), work: freshSnapshot() } });
    await refreshClaudeUsageForLaunch(unknown.refresher, { currentProfile: 'gone', isStoppedByLimit: true, maxAgeMs });
    assert.deepEqual(unknown.fetched, []);
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
