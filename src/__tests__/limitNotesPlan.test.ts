/**
 * The accounts note's pure planner (`limitNotes/plan.ts`): the interval a topic is under, which shape of the note a conversation
 * gets at which moment (every skip reason, the dedupe, the floor, the clock that restarts at a `claude_profiles` call), the
 * fingerprint of the limits picture and the two texts.
 *
 * Flow-level scenarios of the feature (a check wake carrying the reminder, the hidden tool-result tail, …) belong to the flows of
 * the later scopes; this file owns what only the pure functions can reach: every branch and edge input.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLimitNoteFingerprint,
  buildLimitNoteText,
  checkHasFreshLimitUsage,
  checkIsLimitReminderMinutes,
  decideLimitNote,
  defaultLimitNoteWindows,
  limitNoteMarker,
  limitNoteOrchestrationWindowMs,
  limitNoteMinQuietMs,
  limitNoteSkipReasons,
  limitNoteSummaryFloorMs,
  limitReminderDefaultMinutes,
  limitReminderIntervalOptions,
  limitReminderOffMinutes,
  resolveLimitRemindersMinutes,
  type LimitNoteMoment,
  type LimitNoteRecord,
} from '../limitNotes/plan';
import type { ClaudeLaunchChainScope, ClaudeProfileUsageView, ClaudeProfilesReport, ClaudeUsageSnapshot } from '../utils/claudeUsage';
import { buildClaudeProfilesCreditReport } from '../utils/claudeProfileUsageViews';
import type { OpenCodeProviderUsageRecord } from '../utils/openCodeUsage';

const minuteMs = 60 * 1000;
const hourMs = 60 * minuteMs;
const nowMs = Date.parse('2026-11-21T14:05:00Z');
const inHours = (hours: number, atMs: number = nowMs): string => new Date(atMs + hours * hourMs).toISOString();

function buildUsage(input: { session: number; weekly: number; weeklyResetHours: number | null; atMs?: number; isStale?: boolean }): ClaudeUsageSnapshot {
  const atMs = input.atMs ?? nowMs;
  return {
    fetchedAt: new Date(atMs).toISOString(),
    source: 'api',
    ...(input.isStale === true ? { isStale: true } : {}),
    buckets: [
      { kind: 'session', percent: input.session, resetsAt: inHours(3, atMs), scopeModel: null },
      { kind: 'weekly_all', percent: input.weekly, resetsAt: input.weeklyResetHours === null ? null : inHours(input.weeklyResetHours, atMs), scopeModel: null },
    ],
  };
}

function buildView(name: string, patch: Partial<ClaudeProfileUsageView> = {}): ClaudeProfileUsageView {
  return {
    name,
    configDir: name === 'default' ? null : `/home/user/.charness/claude-profiles/${name}`,
    loggedIn: true,
    email: `${name}@example.com`,
    subscriptionType: 'max',
    usage: buildUsage({ session: 10, weekly: 20, weeklyResetHours: 120 }),
    limitedUntil: null,
    billing: 'subscription',
    creditExhaustedAt: null,
    ...patch,
  };
}

function buildReport(views: readonly ClaudeProfileUsageView[], options: { atMs?: number; chainScope?: ClaudeLaunchChainScope | null } = {}): ClaudeProfilesReport {
  return buildClaudeProfilesCreditReport(views, null, options.atMs ?? nowMs, { chainScope: options.chainScope ?? null });
}

function buildChatGptUsage(percent: number, atMs: number = nowMs, isStale = false): Record<string, OpenCodeProviderUsageRecord> {
  return {
    openai: {
      authKind: 'subscription',
      usage: {
        fetchedAt: new Date(atMs).toISOString(),
        source: 'api',
        ...(isStale ? { isStale: true } : {}),
        buckets: [{ kind: 'weekly_all', percent, resetsAt: inHours(72, atMs), scopeModel: null }],
      },
    },
  };
}

/** `work` resets its week first (1 d 19 h) and is the pick; `default` comes after it (5 d). */
const twoAccounts = (workWeekly = 62): ClaudeProfileUsageView[] => [
  buildView('default', { usage: buildUsage({ session: 10, weekly: 20, weeklyResetHours: 120 }) }),
  buildView('work', { usage: buildUsage({ session: 30, weekly: workWeekly, weeklyResetHours: 43 }) }),
];

describe('resolveLimitRemindersMinutes: the interval a topic is under', () => {
  it('nobody chose: the default hour; General\'s choice stands for a topic with none', () => {
    assert.equal(resolveLimitRemindersMinutes(undefined, undefined), limitReminderDefaultMinutes);
    assert.equal(limitReminderDefaultMinutes, 60);
    assert.equal(resolveLimitRemindersMinutes(120, undefined), 120);
    assert.equal(resolveLimitRemindersMinutes(240, undefined), 240);
  });

  it('a topic\'s own choice beats General in both directions: its interval over General\'s Off, its Off over General\'s interval', () => {
    assert.equal(resolveLimitRemindersMinutes(120, 240), 240);
    assert.equal(resolveLimitRemindersMinutes(limitReminderOffMinutes, 60), 60);
    assert.equal(resolveLimitRemindersMinutes(60, limitReminderOffMinutes), null);
    assert.equal(resolveLimitRemindersMinutes(limitReminderOffMinutes, undefined), null);
  });

  it('a stored number no choice names counts as no choice at that level', () => {
    assert.equal(resolveLimitRemindersMinutes(120, 90), 120, 'a topic value of 90 min is no choice: General decides');
    assert.equal(resolveLimitRemindersMinutes(45, undefined), limitReminderDefaultMinutes, 'a General value of 45 min is no choice: the default');
    assert.equal(resolveLimitRemindersMinutes(Number.NaN, Number.NaN), limitReminderDefaultMinutes);
  });

  it('the offered intervals are 1 h, 2 h and 4 h, and only they pass the guard', () => {
    assert.deepEqual([...limitReminderIntervalOptions], [60, 120, 240]);
    assert.equal(checkIsLimitReminderMinutes(120), true);
    assert.equal(checkIsLimitReminderMinutes(limitReminderOffMinutes), false, 'Off is the picker\'s own button, not an interval');
    assert.equal(checkIsLimitReminderMinutes(90), false);
    assert.equal(checkIsLimitReminderMinutes(undefined), false);
  });
});

describe('decideLimitNote: which shape of the note, at which moment', () => {
  const orchestratingRecord: LimitNoteRecord = { lastOrchestratedAt: nowMs - hourMs, lastNoteAt: nowMs - 70 * minuteMs, fingerprint: 'rec=old' };
  const decide = (patch: { moment?: LimitNoteMoment; record?: LimitNoteRecord | undefined; intervalMs?: number | null; fingerprint?: string; hasFreshUsage?: boolean; quietMs?: number | null } = {}) =>
    decideLimitNote({
      moment: 'turnStart',
      record: orchestratingRecord,
      intervalMs: hourMs,
      fingerprint: 'rec=new',
      hasFreshUsage: true,
      quietMs: null,
      nowMs,
      ...patch,
    });

  describe('the gates both shapes share', () => {
    it('a conversation that never orchestrated gets nothing at any moment', () => {
      for (const moment of ['turnStart', 'midTurn', 'sendResult'] as const) {
        assert.deepEqual(decide({ moment, record: undefined, quietMs: 10 * hourMs }), { shape: null, skipReasons: [limitNoteSkipReasons.notOrchestrating] });
        assert.deepEqual(decide({ moment, record: { lastNoteAt: nowMs - 5 * hourMs }, quietMs: 10 * hourMs }), { shape: null, skipReasons: [limitNoteSkipReasons.notOrchestrating] }, 'notes alone never make a conversation orchestrate');
      }
    });

    it('orchestrating lasts 7 days from the last call or watch: the boundary still counts, a second later does not', () => {
      const lastOrchestratedAt = nowMs - limitNoteOrchestrationWindowMs;
      assert.equal(decide({ record: { lastOrchestratedAt } }).shape, 'reminder');
      assert.deepEqual(decide({ record: { lastOrchestratedAt: lastOrchestratedAt - 1000 } }), { shape: null, skipReasons: [limitNoteSkipReasons.notOrchestrating] });
    });

    it('Off (no interval) stops every note, the change summary included', () => {
      assert.deepEqual(decide({ intervalMs: null }), { shape: null, skipReasons: [limitNoteSkipReasons.off] });
      assert.deepEqual(decide({ intervalMs: null, moment: 'sendResult' }), { shape: null, skipReasons: [limitNoteSkipReasons.off] });
      assert.deepEqual(decide({ intervalMs: null, moment: 'turnStart', quietMs: 10 * hourMs }), { shape: null, skipReasons: [limitNoteSkipReasons.off] });
    });

    it('without a fresh figure there is no note', () => {
      assert.deepEqual(decide({ hasFreshUsage: false }), { shape: null, skipReasons: [limitNoteSkipReasons.noFreshUsage] });
      assert.deepEqual(decide({ hasFreshUsage: false, moment: 'sendResult' }), { shape: null, skipReasons: [limitNoteSkipReasons.noFreshUsage] });
    });

    it('every gate that holds is named at once, so one log line says all of them', () => {
      assert.deepEqual(decide({ record: undefined, intervalMs: null, hasFreshUsage: false }).skipReasons, [
        limitNoteSkipReasons.notOrchestrating,
        limitNoteSkipReasons.off,
        limitNoteSkipReasons.noFreshUsage,
      ]);
    });
  });

  describe('the reminder', () => {
    it('comes at a turn start and mid-turn once the interval has passed since the last note', () => {
      assert.deepEqual(decide({ moment: 'turnStart' }), { shape: 'reminder', skipReasons: [] });
      assert.deepEqual(decide({ moment: 'midTurn' }), { shape: 'reminder', skipReasons: [] });
    });

    it('is not due before the interval, and the boundary itself is due', () => {
      const lastNoteAt = nowMs - 59 * minuteMs;
      assert.equal(decide({ record: { ...orchestratingRecord, lastNoteAt }, moment: 'midTurn' }).shape, null);
      assert.deepEqual(decide({ record: { ...orchestratingRecord, lastNoteAt }, moment: 'midTurn' }).skipReasons, [limitNoteSkipReasons.notDue, limitNoteSkipReasons.noSummaryAtMoment]);
      assert.equal(decide({ record: { ...orchestratingRecord, lastNoteAt: nowMs - hourMs }, moment: 'midTurn' }).shape, 'reminder');
    });

    it('follows the chosen interval: 70 min is due at 1 h and not at 2 h or 4 h', () => {
      assert.equal(decide({ intervalMs: hourMs }).shape, 'reminder');
      assert.equal(decide({ intervalMs: 2 * hourMs }).shape, null);
      assert.equal(decide({ intervalMs: 4 * hourMs }).shape, null);
    });

    it('the clock starts at the last note of EITHER shape: a summary 10 min ago holds the reminder back', () => {
      const afterSummary: LimitNoteRecord = { ...orchestratingRecord, lastNoteAt: nowMs - 10 * minuteMs, fingerprint: 'rec=new' };
      assert.equal(decide({ record: afterSummary, moment: 'midTurn' }).shape, null);
      assert.equal(decide({ record: afterSummary, moment: 'turnStart' }).shape, null);
    });

    it('a `claude_profiles` call restarts the clock — looking is what the reminder asks for', () => {
      const recentlyLooked: LimitNoteRecord = { ...orchestratingRecord, lastNoteAt: nowMs - 5 * hourMs, lastProfilesCallAt: nowMs - 10 * minuteMs };
      assert.equal(decide({ record: recentlyLooked, moment: 'midTurn' }).shape, null, 'the call 10 min ago beats the note 5 h ago');
      assert.equal(decide({ record: { ...recentlyLooked, lastProfilesCallAt: nowMs - 61 * minuteMs }, moment: 'midTurn' }).shape, 'reminder');
      const lookedLongAgo: LimitNoteRecord = { ...orchestratingRecord, lastNoteAt: nowMs - 10 * minuteMs, lastProfilesCallAt: nowMs - 3 * hourMs };
      assert.equal(decide({ record: lookedLongAgo, moment: 'midTurn' }).shape, null, 'the note 10 min ago beats the call 3 h ago');
    });

    it('an orchestrator that was never reminded and never looked is due at once', () => {
      assert.deepEqual(decide({ record: { lastOrchestratedAt: nowMs - minuteMs }, moment: 'midTurn' }), { shape: 'reminder', skipReasons: [] });
    });

    it('a send result carries no reminder, however overdue', () => {
      const decision = decide({ moment: 'sendResult', fingerprint: orchestratingRecord.fingerprint });
      assert.deepEqual(decision, { shape: null, skipReasons: [limitNoteSkipReasons.noReminderAtMoment, limitNoteSkipReasons.unchanged] });
    });
  });

  describe('the change summary', () => {
    const justNoted: LimitNoteRecord = { ...orchestratingRecord, lastNoteAt: nowMs - 40 * minuteMs };

    it('rides a send result when the picture changed and the floor has passed', () => {
      assert.deepEqual(decide({ moment: 'sendResult', record: justNoted }), { shape: 'summary', skipReasons: [] });
    });

    it('rides a turn start after 30 min of quiet — the woken session — and not before', () => {
      assert.deepEqual(decide({ moment: 'turnStart', record: justNoted, quietMs: limitNoteMinQuietMs }), { shape: 'summary', skipReasons: [] });
      const notQuiet = decide({ moment: 'turnStart', record: justNoted, quietMs: limitNoteMinQuietMs - 1 });
      assert.deepEqual(notQuiet, { shape: null, skipReasons: [limitNoteSkipReasons.notDue, limitNoteSkipReasons.notQuiet] });
      assert.deepEqual(decide({ moment: 'turnStart', record: justNoted, quietMs: null }).skipReasons, [limitNoteSkipReasons.notDue, limitNoteSkipReasons.notQuiet], 'an unknown quiet period counts as not quiet');
    });

    it('never rides a running turn', () => {
      const decision = decide({ moment: 'midTurn', record: justNoted, quietMs: 10 * hourMs });
      assert.deepEqual(decision, { shape: null, skipReasons: [limitNoteSkipReasons.notDue, limitNoteSkipReasons.noSummaryAtMoment] });
    });

    it('stays silent when nothing changed since the last note — at a send and at a wake', () => {
      const unchanged = { fingerprint: justNoted.fingerprint };
      assert.deepEqual(decide({ moment: 'sendResult', record: justNoted, ...unchanged }).skipReasons, [limitNoteSkipReasons.noReminderAtMoment, limitNoteSkipReasons.unchanged]);
      assert.deepEqual(decide({ moment: 'turnStart', record: justNoted, quietMs: 3 * hourMs, ...unchanged }).skipReasons, [limitNoteSkipReasons.notDue, limitNoteSkipReasons.unchanged]);
    });

    it('a record without a fingerprint (a fresh context) counts as changed', () => {
      const { fingerprint: _forgotten, ...freshContext } = justNoted;
      assert.equal(decide({ moment: 'sendResult', record: freshContext }).shape, 'summary');
    });

    it('two changes 10 min apart give ONE summary: the floor holds the second back, and lifts at 30 min', () => {
      const afterFirst: LimitNoteRecord = { ...orchestratingRecord, lastNoteAt: nowMs - 10 * minuteMs, fingerprint: 'rec=first' };
      assert.deepEqual(decide({ moment: 'sendResult', record: afterFirst, fingerprint: 'rec=second' }), {
        shape: null,
        skipReasons: [limitNoteSkipReasons.noReminderAtMoment, limitNoteSkipReasons.summaryFloor],
      });
      assert.equal(decide({ moment: 'sendResult', record: { ...afterFirst, lastNoteAt: nowMs - limitNoteSummaryFloorMs }, fingerprint: 'rec=second' }).shape, 'summary', 'the floor is a minimum gap: exactly 30 min is allowed');
      assert.equal(decide({ moment: 'sendResult', record: { ...afterFirst, lastNoteAt: nowMs - limitNoteSummaryFloorMs + 1 }, fingerprint: 'rec=second' }).shape, null);
    });

    it('a summary with no note on record at all is not held by the floor', () => {
      assert.equal(decide({ moment: 'sendResult', record: { lastOrchestratedAt: nowMs - hourMs } }).shape, 'summary');
    });
  });

  describe('both due together', () => {
    it('the reminder alone: it carries the figures the summary would, so the summary is dropped, not queued', () => {
      const bothDue = { moment: 'turnStart' as const, quietMs: 2 * hourMs, fingerprint: 'rec=new' };
      assert.deepEqual(decide(bothDue), { shape: 'reminder', skipReasons: [] });
    });
  });

  describe('the windows can be shortened for a test', () => {
    it('the minimum quiet period, the floor and the orchestration window follow the injected ones', () => {
      const windows = { minQuietMs: minuteMs, summaryFloorMs: 2 * minuteMs, orchestrationWindowMs: hourMs };
      const record: LimitNoteRecord = { lastOrchestratedAt: nowMs - 30 * minuteMs, lastNoteAt: nowMs - 10 * minuteMs, fingerprint: 'rec=old' };
      const shortened = (patch: { quietMs?: number | null; record?: LimitNoteRecord; intervalMs?: number } = {}) =>
        decideLimitNote({ moment: 'turnStart', record, intervalMs: 20 * minuteMs, fingerprint: 'rec=new', hasFreshUsage: true, quietMs: minuteMs, nowMs, windows, ...patch });
      assert.equal(shortened().shape, 'summary');
      assert.equal(shortened({ quietMs: minuteMs - 1 }).shape, null);
      assert.equal(shortened({ record: { ...record, lastNoteAt: nowMs - minuteMs } }).shape, null);
      assert.equal(shortened({ record: { ...record, lastOrchestratedAt: nowMs - hourMs - 1 } }).shape, null);
    });

    it('the defaults are 30 min quiet, a 30 min floor and 7 days', () => {
      assert.deepEqual(defaultLimitNoteWindows, { minQuietMs: 30 * minuteMs, summaryFloorMs: 30 * minuteMs, orchestrationWindowMs: 7 * 24 * hourMs });
    });
  });
});

describe('checkHasFreshLimitUsage', () => {
  it('an account whose snapshot was re-read is a fresh figure', () => {
    assert.equal(checkHasFreshLimitUsage(buildReport(twoAccounts())), true);
  });

  it('only stale snapshots, no snapshot, or no account: nothing fresh', () => {
    const stale = buildUsage({ session: 10, weekly: 20, weeklyResetHours: 120, isStale: true });
    assert.equal(checkHasFreshLimitUsage(buildReport([buildView('default', { usage: stale }), buildView('work', { usage: stale })])), false);
    assert.equal(checkHasFreshLimitUsage(buildReport([buildView('default', { usage: undefined })])), false);
    assert.equal(checkHasFreshLimitUsage(buildReport([])), false);
  });

  it('one fresh account among stale ones is enough; a signed-out account\'s figure is not', () => {
    const stale = buildUsage({ session: 10, weekly: 20, weeklyResetHours: 120, isStale: true });
    assert.equal(checkHasFreshLimitUsage(buildReport([buildView('default', { usage: stale }), buildView('work')])), true);
    assert.equal(checkHasFreshLimitUsage(buildReport([buildView('default', { loggedIn: false })])), false);
  });

  it('an account the /limits list keeps off agents does not count', () => {
    const chainScope: ClaudeLaunchChainScope = { enabledNames: new Set(['default']), disabledNames: new Set() };
    const stale = buildUsage({ session: 10, weekly: 20, weeklyResetHours: 120, isStale: true });
    assert.equal(checkHasFreshLimitUsage(buildReport([buildView('default', { usage: stale }), buildView('work')], { chainScope })), false, 'work is fresh but not offered');
  });

  it('an API-billed account the list holds has no windows by design and counts as a figure', () => {
    const chainScope: ClaudeLaunchChainScope = { enabledNames: new Set(['console']), disabledNames: new Set() };
    assert.equal(checkHasFreshLimitUsage(buildReport([buildView('console', { billing: 'api', usage: undefined })], { chainScope })), true);
  });
});

describe('buildLimitNoteFingerprint: what counts as a change of the picture', () => {
  const fingerprintOf = (views: readonly ClaudeProfileUsageView[], openCodeUsage: Record<string, OpenCodeProviderUsageRecord> = {}, options: { atMs?: number; chainScope?: ClaudeLaunchChainScope | null } = {}): string =>
    buildLimitNoteFingerprint(buildReport(views, options), openCodeUsage, options.atMs ?? nowMs);

  it('names the recommended account, each offered account in 10-point steps and the ChatGPT step', () => {
    assert.equal(fingerprintOf(twoAccounts(), buildChatGptUsage(40)), 'rec=work|default:2uo|work:6uo|gpt=4');
  });

  it('moves with a 10-point step of an account\'s weekly use — and only then', () => {
    const base = fingerprintOf(twoAccounts(60));
    assert.equal(fingerprintOf(twoAccounts(69)), base, '60 → 69 is the same step');
    assert.notEqual(fingerprintOf(twoAccounts(70)), base, '60 → 70 crosses a step');
    assert.notEqual(fingerprintOf(twoAccounts(59)), base, '60 → 59 crosses a step downwards too');
  });

  it('moves with the account that would be recommended', () => {
    const before = buildReport(twoAccounts());
    const afterViews = [twoAccounts()[0], buildView('work', { usage: buildUsage({ session: 30, weekly: 62, weeklyResetHours: 200 }) })];
    const after = buildReport(afterViews);
    assert.equal(before.recommended, 'work');
    assert.equal(after.recommended, 'default', 'work\'s week now resets after default\'s');
    assert.notEqual(buildLimitNoteFingerprint(before, {}, nowMs), buildLimitNoteFingerprint(after, {}, nowMs));
  });

  it('moves when an account turns limited, and when it turns usable again', () => {
    const [defaultView, workView] = twoAccounts();
    const healthy = fingerprintOf([defaultView, workView]);
    const limited = fingerprintOf([defaultView, { ...workView, limitedUntil: inHours(2) }]);
    assert.notEqual(limited, healthy);
    assert.match(limited, /work:6xo/, 'the account is marked not usable');
    assert.equal(fingerprintOf([defaultView, { ...workView, limitedUntil: inHours(-1) }]), healthy, 'a mark that has run out is no longer a limit');
  });

  it('moves when a five-hour window crosses the 90 % launch ceiling, not below it', () => {
    const withSession = (session: number) => [buildView('default'), buildView('work', { usage: buildUsage({ session, weekly: 62, weeklyResetHours: 43 }) })];
    assert.equal(fingerprintOf(withSession(30)), fingerprintOf(withSession(89)), 'five-hour use below the ceiling is not part of the picture');
    assert.notEqual(fingerprintOf(withSession(89)), fingerprintOf(withSession(90)));
    assert.match(fingerprintOf(withSession(95)), /work:6uf/);
  });

  it('moves with the ChatGPT weekly use in 10-point steps, and when ChatGPT shows up', () => {
    const base = fingerprintOf(twoAccounts(), buildChatGptUsage(40));
    assert.equal(fingerprintOf(twoAccounts(), buildChatGptUsage(49)), base);
    assert.notEqual(fingerprintOf(twoAccounts(), buildChatGptUsage(50)), base);
    assert.notEqual(fingerprintOf(twoAccounts(), {}), base);
    assert.match(fingerprintOf(twoAccounts(), {}), /gpt=-$/);
  });

  it('a stale figure is its own state (`?`), so a refresh after it reads as a change', () => {
    const stale = buildUsage({ session: 30, weekly: 62, weeklyResetHours: 43, isStale: true });
    const withStale = fingerprintOf([buildView('default'), buildView('work', { usage: stale })]);
    assert.match(withStale, /work:\?uo/);
    assert.notEqual(withStale, fingerprintOf(twoAccounts(62)));
    assert.match(fingerprintOf(twoAccounts(), buildChatGptUsage(40, nowMs, true)), /gpt=\?$/);
  });

  it('a window that has reset since it was read reads as 0 %, like the screens', () => {
    const readLongAgo = nowMs - 10 * hourMs;
    const views = [buildView('default', { usage: buildUsage({ session: 10, weekly: 80, weeklyResetHours: 5, atMs: readLongAgo }) })];
    assert.match(fingerprintOf(views), /default:0uo/, 'the weekly window ended 5 h after it was read: 80 % no longer stands');
  });

  it('an API account has no weekly step (`-`) and no account of the /limits list\'s exclusions is named', () => {
    const chainScope: ClaudeLaunchChainScope = { enabledNames: new Set(['console', 'default']), disabledNames: new Set() };
    const views = [buildView('default'), buildView('work'), buildView('console', { billing: 'api', usage: undefined })];
    const fingerprint = fingerprintOf(views, {}, { chainScope });
    assert.match(fingerprint, /console:-uo/);
    assert.doesNotMatch(fingerprint, /work:/, '`work` is not in the list: agents never go there');
    assert.match(fingerprint, /^rec=console\|/, 'API credit goes first');
  });

  it('nothing usable: `rec=none`', () => {
    const views = [buildView('default', { limitedUntil: inHours(2) })];
    assert.match(fingerprintOf(views), /^rec=none\|default:2xo\|/);
  });
});

describe('buildLimitNoteText', () => {
  const chatGptWeekly40 = buildChatGptUsage(40);

  it('the reminder: the pick with its week and five-hour figures, the next account, the ChatGPT window, the instruction', () => {
    const text = buildLimitNoteText('reminder', buildReport(twoAccounts()), chatGptWeekly40, 'UTC', nowMs);
    assert.equal(text, [
      '[Accounts · 14:05] Next new Claude worker → work: week 62 % used, resets in 1 d 19 h; 5 h 30 %.',
      'Then default (week 20 %, resets in 5 d). ChatGPT: week 40 %, resets in 3 d.',
      'Call claude_profiles right before your next launch or resume — the pick moves as limits fill and reset. No reply is needed.',
    ].join('\n'));
    assert.ok(text.startsWith(limitNoteMarker));
  });

  it('the summary: one line of the same figures, marked as a change, with no instruction', () => {
    const laterMs = Date.parse('2026-11-21T16:40:00Z');
    const views = [
      buildView('default', { usage: buildUsage({ session: 10, weekly: 20, weeklyResetHours: 120, atMs: laterMs }) }),
      buildView('work', { usage: buildUsage({ session: 30, weekly: 71, weeklyResetHours: 40, atMs: laterMs }) }),
    ];
    const text = buildLimitNoteText('summary', buildReport(views, { atMs: laterMs }), buildChatGptUsage(55, laterMs), 'UTC', laterMs);
    assert.equal(text, '[Accounts · 16:40 · changed] work 71 % (resets in 1 d 16 h) → next new worker; default 20 % (5 d); ChatGPT 55 % (3 d).');
    assert.equal(text.includes('\n'), false);
    assert.equal(text.includes('claude_profiles'), false, 'the summary leaves the instruction out');
  });

  it('the clock in the header is the instance zone\'s', () => {
    const text = buildLimitNoteText('summary', buildReport(twoAccounts()), {}, 'Asia/Tbilisi', nowMs);
    assert.ok(text.startsWith('[Accounts · 18:05 · changed]'), text);
  });

  it('names at most three Claude accounts: the pick and the next two in launch rank (the soonest weekly reset first)', () => {
    const views = [
      buildView('default', { usage: buildUsage({ session: 10, weekly: 20, weeklyResetHours: 120 }) }),
      buildView('work', { usage: buildUsage({ session: 30, weekly: 62, weeklyResetHours: 43 }) }),
      buildView('spare', { usage: buildUsage({ session: 5, weekly: 10, weeklyResetHours: 160 }) }),
      buildView('later', { usage: buildUsage({ session: 5, weekly: 10, weeklyResetHours: 20 }) }),
    ];
    const report = buildReport(views);
    assert.equal(report.recommended, 'later');
    const text = buildLimitNoteText('reminder', report, {}, 'UTC', nowMs);
    assert.match(text, /→ later:/);
    assert.match(text, /Then work \(week 62 %, resets in 1 d 19 h\), default \(week 20 %, resets in 5 d\)\./, 'work (43 h) before default (120 h); spare (160 h) is the fourth account and is left out');
    assert.doesNotMatch(text, /spare/);
  });

  it('an account without room in its five-hour window is not offered as the next one', () => {
    const views = [
      buildView('default', { usage: buildUsage({ session: 95, weekly: 20, weeklyResetHours: 30 }) }),
      buildView('work', { usage: buildUsage({ session: 30, weekly: 62, weeklyResetHours: 43 }) }),
      buildView('third', { usage: buildUsage({ session: 30, weekly: 10, weeklyResetHours: 100 }) }),
    ];
    const text = buildLimitNoteText('reminder', buildReport(views), {}, 'UTC', nowMs);
    assert.match(text, /→ work:/);
    assert.match(text, /Then third \(/);
    assert.doesNotMatch(text, /default/);
  });

  it('a stale figure reads «usage unknown», for the pick, the next account and ChatGPT alike', () => {
    const stale = buildUsage({ session: 30, weekly: 62, weeklyResetHours: 43, isStale: true });
    const views = [buildView('default', { usage: stale }), buildView('work')];
    const reminder = buildLimitNoteText('reminder', buildReport(views), buildChatGptUsage(40, nowMs, true), 'UTC', nowMs);
    assert.match(reminder, /→ default: usage unknown\./);
    assert.match(reminder, /Then work \(week 20 %, resets in 5 d\)\. ChatGPT: usage unknown\./);
    const summary = buildLimitNoteText('summary', buildReport(views), buildChatGptUsage(40, nowMs, true), 'UTC', nowMs);
    assert.match(summary, /default usage unknown → next new worker; work 20 % \(5 d\); ChatGPT usage unknown\.$/);
  });

  it('no ChatGPT record (or one with no usage) leaves the ChatGPT sentence out', () => {
    const withoutChatGptUsage: Record<string, OpenCodeProviderUsageRecord>[] = [{}, { openai: { authKind: 'apiKey' } }];
    for (const openCodeUsage of withoutChatGptUsage) {
      assert.doesNotMatch(buildLimitNoteText('reminder', buildReport(twoAccounts()), openCodeUsage, 'UTC', nowMs), /ChatGPT/);
      assert.doesNotMatch(buildLimitNoteText('summary', buildReport(twoAccounts()), openCodeUsage, 'UTC', nowMs), /ChatGPT/);
    }
  });

  it('one account and nothing else: no «Then» sentence', () => {
    const text = buildLimitNoteText('reminder', buildReport([buildView('default')]), {}, 'UTC', nowMs);
    assert.equal(text.split('\n').length, 2, 'the pick line and the instruction');
    assert.doesNotMatch(text, /Then/);
  });

  it('a window that has reset since it was read shows 0 % with no countdown', () => {
    const views = [buildView('default', { usage: buildUsage({ session: 10, weekly: 80, weeklyResetHours: 5, atMs: nowMs - 10 * hourMs }) })];
    const text = buildLimitNoteText('reminder', buildReport(views), {}, 'UTC', nowMs);
    assert.match(text, /→ default: week 0 % used; 5 h 0 %\./, text);
  });

  it('a weekly window that names no reset shows the percent alone', () => {
    const views = [buildView('default', { usage: buildUsage({ session: 10, weekly: 33, weeklyResetHours: null }) })];
    assert.match(buildLimitNoteText('reminder', buildReport(views), {}, 'UTC', nowMs), /→ default: week 33 % used; 5 h 10 %\./);
    assert.match(buildLimitNoteText('summary', buildReport(views), {}, 'UTC', nowMs), / default 33 % → next new worker\.$/);
  });

  it('an API account the list holds goes first and says so, with the credit estimate when the bot has one', () => {
    const chainScope: ClaudeLaunchChainScope = { enabledNames: new Set(['console', 'default']), disabledNames: new Set() };
    const anchor = { remainingUsd: 61.2, anchoredAt: inHours(-1) };
    const apiView = { ...buildView('console', { billing: 'api', usage: undefined }), creditAnchor: anchor };
    const report = buildReport([buildView('default'), apiView], { chainScope });
    assert.equal(report.recommended, 'console');
    const reminder = buildLimitNoteText('reminder', report, {}, 'UTC', nowMs);
    assert.match(reminder, /→ console: API credit \(≈ \$61\.20 left\)\./);
    assert.match(reminder, /Then default \(week 20 %, resets in 5 d\)\./);
    assert.match(buildLimitNoteText('summary', report, {}, 'UTC', nowMs), /console API credit \(≈ \$61\.20 left\) → next new worker; default 20 % \(5 d\)\.$/);
  });

  it('nothing usable: says so and, when an account names a time, what frees up first', () => {
    const views = [buildView('default', { limitedUntil: inHours(3) })];
    const report = buildReport(views);
    assert.equal(report.recommended, null);
    assert.match(buildLimitNoteText('reminder', report, {}, 'UTC', nowMs), /^\[Accounts · 14:05\] No Claude account can take a new worker now; default frees up in 3 h\.\n/);
    assert.match(buildLimitNoteText('summary', report, {}, 'UTC', nowMs), /\] no Claude account can take a new worker now\.$/);
    const noTime = buildReport([buildView('default', { loggedIn: false })]);
    assert.match(buildLimitNoteText('reminder', noTime, {}, 'UTC', nowMs), /No Claude account can take a new worker now\.\n/);
  });

  it('the notes stay short: about 60 tokens for the reminder, 35 for the summary (a word is under 2 tokens)', () => {
    const reminder = buildLimitNoteText('reminder', buildReport(twoAccounts()), chatGptWeekly40, 'UTC', nowMs);
    const summary = buildLimitNoteText('summary', buildReport(twoAccounts()), chatGptWeekly40, 'UTC', nowMs);
    assert.ok(reminder.length < 400, `${reminder.length} characters`);
    assert.ok(summary.length < 160, `${summary.length} characters`);
  });
});
