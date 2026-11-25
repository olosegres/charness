/**
 * @description The decision a usage limit leads to, per kind of conversation (`utils/limitSwitchPlan.ts`, wired by `bot.ts`
 * `planFallbackSwitch`): a conversation of another platform — a Jira issue — switches to the next signed-in Claude account on its
 * own, by the very rules a Telegram topic uses (the fallback chain when set, else the ranking by the soonest weekly reset), and
 * touches nothing that is a topic's:
 *
 *   • it switches to a free account — ranked, or named by the chain; an account that is limited, signed out or has no usage is not one;
 *   • with no account free it waits for the Claude account whose limit resets EARLIEST (the chain's Claude rungs, else the signed-in
 *     subscriptions) — the retry kick moves it there; a re-plan from that account, when it refused after all, aims at the next one;
 *   • with auto-switch OFF it WAITS for its own reset: no «switch to …» offer (buttons are a topic's) and no wait aimed elsewhere —
 *     and a wait aimed elsewhere while it was ON, when it is turned OFF before the wait ends, waits again for its own account;
 *   • an OpenCode rung of the chain is never its target, now or at a wait's end (a cross-backend hand-over has no surface there), a
 *     chain with no Claude rung restricts no account, and a conversation that runs on OpenCode has nothing to decide;
 *   • the same inputs for a Telegram topic keep the offer, the OpenCode rungs and the aimed wait.
 *
 * The process-level twin is `jiraFallbackSwitchE2e.test.ts` (the move by itself, the wait aimed at the account that frees first and its
 * resume there, auto switch OFF); the kick's own move is in `apiRetryKick.test.ts` («a limit wait aimed at another rung»).
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkIsLimitSwitchPossible, decideAimedWaitEnd, decideLimitSwitch } from '../utils/limitSwitchPlan';
import type { FallbackChainEntry, FallbackDetection } from '../utils/fallbackChain';
import type { ClaudeProfileUsageView, ClaudeUsageSnapshot } from '../utils/claudeUsage';

const nowMs = Date.parse('2026-11-18T10:00:00.000Z');

function buildUsage(input: { session: number; weekly: number; weeklyResetsAt?: string }): ClaudeUsageSnapshot {
  return {
    fetchedAt: '2026-11-18T09:59:00.000Z',
    source: 'api',
    buckets: [
      { kind: 'session', percent: input.session, resetsAt: '2026-11-18T13:00:00.000Z', scopeModel: null },
      { kind: 'weekly_all', percent: input.weekly, resetsAt: input.weeklyResetsAt ?? '2026-11-22T00:00:00.000Z', scopeModel: null },
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
    usage: buildUsage({ session: 20, weekly: 30 }),
    limitedUntil: null,
    billing: null,
    creditExhaustedAt: null,
    ...patch,
  };
}

function buildDetection(profiles: ClaudeProfileUsageView[], openCodeModels: string[] = [], openCodeLimits: Record<string, string> = {}): FallbackDetection {
  return { claudeProfiles: profiles, openCodeModels, recentOpenCodeModels: [], openCodeLimits };
}

const onDefault: FallbackChainEntry = { backend: 'claude', profile: 'default', model: null };
const limitedDefault = buildProfile('default', { limitedUntil: '2026-11-18T13:00:00.000Z', usage: buildUsage({ session: 100, weekly: 40 }) });
const base = { from: onDefault, chain: [] as FallbackChainEntry[], isAutoSwitchEnabled: true, nowMs };
const onSecond: FallbackChainEntry = { backend: 'claude', profile: 'second', model: null };
const openAiRung: FallbackChainEntry = { backend: 'opencode', providerId: 'openai', modelId: 'gpt-5' };
/** The timeline seen live: the conversation's account comes back in 3 h, the second one in 40 minutes. */
const secondBackAt = '2026-11-18T10:40:00.000Z';
const secondLimitedEarlier = buildProfile('second', { limitedUntil: secondBackAt });

/** The rung a decision that is a WAIT aims it at, its instant as ISO for readable assertions; `null` when it stays on its own reset. */
function readWaitTarget(input: Parameters<typeof decideLimitSwitch>[0]): { entry: FallbackChainEntry; until: string } | null {
  const { plan, waitTarget } = decideLimitSwitch(input);
  assert.deepEqual(plan, { action: 'none' }, 'nothing is free: a wait');
  return waitTarget && { entry: waitTarget.entry, until: new Date(waitTarget.untilMs).toISOString() };
}

describe('decideLimitSwitch: a Jira conversation (no Telegram)', () => {
  const jira = { ...base, isTelegram: false };

  it('switches to a free account — the ranking when no chain is set', () => {
    const { plan, waitTarget } = decideLimitSwitch({ ...jira, detection: buildDetection([limitedDefault, buildProfile('second')]) });
    assert.deepEqual(plan, { action: 'auto', to: { backend: 'claude', profile: 'second', model: null } });
    assert.equal(waitTarget, null);
  });

  it('takes the soonest weekly reset first among several free accounts', () => {
    const { plan } = decideLimitSwitch({
      ...jira,
      detection: buildDetection([
        limitedDefault,
        buildProfile('late', { usage: buildUsage({ session: 5, weekly: 5, weeklyResetsAt: '2026-11-24T00:00:00.000Z' }) }),
        buildProfile('soon', { usage: buildUsage({ session: 50, weekly: 60, weeklyResetsAt: '2026-11-19T00:00:00.000Z' }) }),
      ]),
    });
    assert.deepEqual(plan, { action: 'auto', to: { backend: 'claude', profile: 'soon', model: null } });
  });

  it('follows the operator\'s chain when it names Claude accounts (its order, not the ranking)', () => {
    const { plan } = decideLimitSwitch({
      ...jira,
      chain: [{ backend: 'claude', profile: 'late', model: 'sonnet' }, { backend: 'claude', profile: 'soon', model: null }],
      detection: buildDetection([
        limitedDefault,
        buildProfile('late', { usage: buildUsage({ session: 5, weekly: 5, weeklyResetsAt: '2026-11-24T00:00:00.000Z' }) }),
        buildProfile('soon', { usage: buildUsage({ session: 50, weekly: 60, weeklyResetsAt: '2026-11-19T00:00:00.000Z' }) }),
      ]),
    });
    assert.deepEqual(plan, { action: 'auto', to: { backend: 'claude', profile: 'late', model: 'sonnet' } });
  });

  it('skips an account that is limited, signed out, used up or not yet known, and the one it runs on', () => {
    const { plan } = decideLimitSwitch({
      ...jira,
      detection: buildDetection([
        limitedDefault,
        buildProfile('limited', { limitedUntil: '2026-11-18T15:00:00.000Z' }),
        buildProfile('out', { loggedIn: false }),
        buildProfile('broke', { creditExhaustedAt: '2026-11-17T00:00:00.000Z' }),
        buildProfile('unprobed', { loggedIn: undefined }),
        buildProfile('nousage', { usage: undefined }),
      ]),
    });
    assert.deepEqual(plan, { action: 'none' }, 'nothing is free: the wait for the reset stands');
  });

  it('with no account free, waits for the account that resets first — the signed-in subscriptions when no chain is set', () => {
    const detection = buildDetection([
      limitedDefault,
      secondLimitedEarlier,
      buildProfile('metered', { billing: 'api', limitedUntil: '2026-11-18T10:10:00.000Z' }),
      buildProfile('out', { loggedIn: false, limitedUntil: '2026-11-18T10:05:00.000Z' }),
    ]);
    // The API account and the signed-out one come back sooner still: neither ends a wait.
    assert.deepEqual(readWaitTarget({ ...jira, detection }), { entry: onSecond, until: secondBackAt }, 'the wait ends when the second account is back, not in 3 h');
  });

  it('with no account free, waits for the chain\'s Claude rung that resets first', () => {
    const detection = buildDetection([limitedDefault, secondLimitedEarlier, buildProfile('third', { limitedUntil: '2026-11-18T10:20:00.000Z' })]);
    const chain: FallbackChainEntry[] = [{ backend: 'claude', profile: 'second', model: 'sonnet' }];
    assert.deepEqual(readWaitTarget({ ...jira, chain, detection }), { entry: chain[0], until: secondBackAt }, 'the list is the word: the account it leaves out is never waited for');
  });

  it('stays on its own reset when its own account comes back first, or within a minute of the first', () => {
    const later = buildDetection([limitedDefault, buildProfile('second', { limitedUntil: '2026-11-18T13:30:00.000Z' })]);
    assert.equal(readWaitTarget({ ...jira, detection: later }), null);
    const nearTie = buildDetection([limitedDefault, buildProfile('second', { limitedUntil: '2026-11-18T12:59:30.000Z' })]);
    assert.equal(readWaitTarget({ ...jira, detection: nearTie }), null, 'no needless move for half a minute');
  });

  it('with auto-switch OFF, waits for its own reset: no offer — its buttons are a topic\'s — and no wait aimed at an account that frees first', () => {
    const free = decideLimitSwitch({ ...jira, isAutoSwitchEnabled: false, detection: buildDetection([limitedDefault, buildProfile('second')]) });
    assert.deepEqual(free, { plan: { action: 'none' }, waitTarget: null });
    const earlier = decideLimitSwitch({ ...jira, isAutoSwitchEnabled: false, detection: buildDetection([limitedDefault, secondLimitedEarlier]) });
    assert.deepEqual(earlier, { plan: { action: 'none' }, waitTarget: null });
  });

  it('never waits for an OpenCode rung, however early it comes back', () => {
    const openCodeBackAt = '2026-11-18T10:05:00.000Z';
    const detection = buildDetection([limitedDefault, secondLimitedEarlier], ['openai/gpt-5'], { 'openai/gpt-5': openCodeBackAt });
    const chain: FallbackChainEntry[] = [openAiRung, onSecond];
    assert.deepEqual(readWaitTarget({ ...jira, chain, detection }), { entry: onSecond, until: secondBackAt }, 'the Claude account, not the OpenCode model back 35 minutes earlier');
    const onlyOpenCode = buildDetection([limitedDefault], ['openai/gpt-5'], { 'openai/gpt-5': openCodeBackAt });
    assert.equal(readWaitTarget({ ...jira, chain: [openAiRung], detection: onlyOpenCode }), null, 'its own reset: the list names no other Claude account');
    // The same inputs in a topic: the OpenCode model is the rung that comes back first.
    assert.deepEqual(readWaitTarget({ ...base, isTelegram: true, chain, detection }), { entry: openAiRung, until: openCodeBackAt });
  });

  it('an account whose reset turned out wrong (it refused at the resume): the plan from it moves on, or waits for the next to come back', () => {
    // The wait moved the conversation onto «second», which refused with a new reset (marked by the caller): `default` is back first now.
    const secondRefused = buildProfile('second', { limitedUntil: '2026-11-18T14:00:00.000Z' });
    assert.deepEqual(readWaitTarget({ ...jira, from: onSecond, detection: buildDetection([limitedDefault, secondRefused]) }), { entry: onDefault, until: '2026-11-18T13:00:00.000Z' });
    // A third account with room by then takes the conversation over at once.
    const third = buildProfile('third');
    assert.deepEqual(decideLimitSwitch({ ...jira, from: onSecond, detection: buildDetection([limitedDefault, secondRefused, third]) }).plan, { action: 'auto', to: { backend: 'claude', profile: 'third', model: null } });
  });

  it('never moves to an OpenCode rung of the chain; a chain with no Claude rung restricts no account', () => {
    const detection = buildDetection([limitedDefault, buildProfile('second')], ['openai/gpt-5']);
    const openCodeFirst: FallbackChainEntry[] = [{ backend: 'opencode', providerId: 'openai', modelId: 'gpt-5' }, { backend: 'claude', profile: 'second', model: null }];
    assert.deepEqual(decideLimitSwitch({ ...jira, chain: openCodeFirst, detection }).plan, { action: 'auto', to: { backend: 'claude', profile: 'second', model: null } }, 'the Claude rung, past the OpenCode one');
    const openCodeOnly: FallbackChainEntry[] = [{ backend: 'opencode', providerId: 'openai', modelId: 'gpt-5' }];
    assert.deepEqual(decideLimitSwitch({ ...jira, chain: openCodeOnly, detection }).plan, { action: 'auto', to: { backend: 'claude', profile: 'second', model: null } }, 'no Claude rung in the list: the ranking');
  });

  it('a chain whose only Claude rung is disabled leaves it waiting, whatever else is signed in', () => {
    const { plan } = decideLimitSwitch({
      ...jira,
      chain: [{ backend: 'claude', profile: 'second', model: null, disabled: true }],
      detection: buildDetection([limitedDefault, buildProfile('second'), buildProfile('third')]),
    });
    assert.deepEqual(plan, { action: 'none' }, 'the operator\'s list is the word on which accounts may be used');
  });
});

describe('decideLimitSwitch: a Telegram topic keeps everything', () => {
  const telegram = { ...base, isTelegram: true };

  it('switches, offers with auto-switch OFF, and keeps the OpenCode rungs', () => {
    const detection = buildDetection([limitedDefault, buildProfile('second')], ['openai/gpt-5']);
    assert.equal(decideLimitSwitch({ ...telegram, detection }).plan.action, 'auto');
    const offered = decideLimitSwitch({ ...telegram, isAutoSwitchEnabled: false, detection }).plan;
    assert.equal(offered.action, 'offer');
    const openCodeFirst: FallbackChainEntry[] = [{ backend: 'opencode', providerId: 'openai', modelId: 'gpt-5' }];
    assert.deepEqual(decideLimitSwitch({ ...telegram, chain: openCodeFirst, detection }).plan, { action: 'auto', to: openCodeFirst[0] });
  });

  it('with nothing free, the wait is aimed at the rung of the chain back first, else at the signed-in subscription back first', () => {
    const detection = buildDetection([
      limitedDefault,
      buildProfile('second', { limitedUntil: '2026-11-18T12:00:00.000Z' }),
      buildProfile('third', { limitedUntil: '2026-11-18T11:00:00.000Z' }),
      buildProfile('metered', { billing: 'api', limitedUntil: '2026-11-18T10:30:00.000Z' }),
      buildProfile('out', { loggedIn: false, limitedUntil: '2026-11-18T10:20:00.000Z' }),
    ]);
    assert.deepEqual(readWaitTarget({ ...telegram, detection }), { entry: { backend: 'claude', profile: 'third', model: null }, until: '2026-11-18T11:00:00.000Z' }, 'no API account, no signed-out one, though they come back sooner');
    const chain: FallbackChainEntry[] = [{ backend: 'claude', profile: 'second', model: null }];
    assert.deepEqual(readWaitTarget({ ...telegram, chain, detection }), { entry: chain[0], until: '2026-11-18T12:00:00.000Z' }, 'the chain names the accounts');
  });
});

describe('decideAimedWaitEnd: the end of a wait aimed at another account', () => {
  const ownBackMs = Date.parse('2026-11-18T13:00:00.000Z');
  const atEnd = { ownLimitedUntilMs: ownBackMs, nowMs };

  it('moves the conversation while the automatic switch is ON, and a topic whatever it says', () => {
    assert.deepEqual(decideAimedWaitEnd({ ...atEnd, isTelegram: false, isAutoSwitchEnabled: true }), { action: 'move' });
    assert.deepEqual(decideAimedWaitEnd({ ...atEnd, isTelegram: true, isAutoSwitchEnabled: false }), { action: 'move' }, 'a topic\'s aimed wait is armed with the switch OFF too');
  });

  it('a Jira issue whose switch was turned OFF meanwhile stays: it waits again for its own account, not a resume into its limit', () => {
    assert.deepEqual(decideAimedWaitEnd({ ...atEnd, isTelegram: false, isAutoSwitchEnabled: false }), { action: 'waitOwnReset', untilMs: ownBackMs });
  });

  it('…and resumes on its own account at once when that one names no reset ahead', () => {
    for (const ownLimitedUntilMs of [null, nowMs - 1, Number.NaN]) {
      assert.deepEqual(decideAimedWaitEnd({ isTelegram: false, isAutoSwitchEnabled: false, ownLimitedUntilMs, nowMs }), { action: 'resumeHere' }, String(ownLimitedUntilMs));
    }
  });
});

describe('checkIsLimitSwitchPossible', () => {
  it('a Telegram topic: any rung; another platform: a Claude account only — to leave, and to move onto', () => {
    assert.equal(checkIsLimitSwitchPossible(true, onDefault), true);
    assert.equal(checkIsLimitSwitchPossible(true, openAiRung), true);
    assert.equal(checkIsLimitSwitchPossible(false, onDefault), true);
    assert.equal(checkIsLimitSwitchPossible(false, openAiRung), false);
  });
});
