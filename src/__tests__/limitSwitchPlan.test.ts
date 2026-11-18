/**
 * @description The decision a usage limit leads to, per kind of conversation (`utils/limitSwitchPlan.ts`, wired by `bot.ts`
 * `planFallbackSwitch`): a conversation of another platform — a Jira issue — switches to the next signed-in Claude account on its
 * own, by the very rules a Telegram topic uses (the fallback chain when set, else the ranking by the soonest weekly reset), and
 * touches nothing that is a topic's:
 *
 *   • it switches to a free account — ranked, or named by the chain; an account that is limited, signed out or has no usage is not one;
 *   • with auto-switch OFF it WAITS (no «switch to …» offer — buttons are a topic's), with no account free it waits, and neither
 *     aims the wait at another rung (the retry kick moves only a Telegram topic there);
 *   • an OpenCode rung of the chain is never its target (a cross-backend hand-over has no surface there), a chain with no Claude
 *     rung restricts no account, and a conversation that runs on OpenCode has nothing to decide;
 *   • the same inputs for a Telegram topic keep the offer, the OpenCode rungs and the aimed wait.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkIsLimitSwitchPossible, decideLimitSwitch } from '../utils/limitSwitchPlan';
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

function buildDetection(profiles: ClaudeProfileUsageView[], openCodeModels: string[] = []): FallbackDetection {
  return { claudeProfiles: profiles, openCodeModels, recentOpenCodeModels: [], openCodeLimits: {} };
}

const onDefault: FallbackChainEntry = { backend: 'claude', profile: 'default', model: null };
const limitedDefault = buildProfile('default', { limitedUntil: '2026-11-18T13:00:00.000Z', usage: buildUsage({ session: 100, weekly: 40 }) });
const base = { from: onDefault, chain: [] as FallbackChainEntry[], isAutoSwitchEnabled: true, nowMs };

describe('decideLimitSwitch: a Jira conversation (no Telegram)', () => {
  const jira = { ...base, isTelegram: false };

  it('switches to a free account — the ranking when no chain is set', () => {
    const { plan, waitRungs } = decideLimitSwitch({ ...jira, detection: buildDetection([limitedDefault, buildProfile('second')]) });
    assert.deepEqual(plan, { action: 'auto', to: { backend: 'claude', profile: 'second', model: null } });
    assert.deepEqual(waitRungs, []);
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

  it('waits when no account is free, and aims the wait at no other rung', () => {
    const { plan, waitRungs } = decideLimitSwitch({
      ...jira,
      detection: buildDetection([limitedDefault, buildProfile('second', { limitedUntil: '2026-11-18T12:00:00.000Z' })]),
    });
    assert.deepEqual(plan, { action: 'none' });
    assert.deepEqual(waitRungs, [], 'the retry kick moves only a Telegram topic to the rung that resets first');
  });

  it('waits with auto-switch OFF: no offer — its buttons are a topic\'s', () => {
    const { plan, waitRungs } = decideLimitSwitch({ ...jira, isAutoSwitchEnabled: false, detection: buildDetection([limitedDefault, buildProfile('second')]) });
    assert.deepEqual(plan, { action: 'none' });
    assert.deepEqual(waitRungs, []);
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

  it('with nothing free, the wait may be aimed at the rungs of the chain, else at the signed-in subscriptions', () => {
    const detection = buildDetection([
      limitedDefault,
      buildProfile('second', { limitedUntil: '2026-11-18T12:00:00.000Z' }),
      buildProfile('metered', { billing: 'api' }),
      buildProfile('out', { loggedIn: false }),
    ]);
    const implicit = decideLimitSwitch({ ...telegram, detection });
    assert.deepEqual(implicit.plan, { action: 'none' });
    assert.deepEqual(implicit.waitRungs.map((rung) => (rung.backend === 'claude' ? rung.profile : rung.providerId)), ['default', 'second'], 'no API account, no signed-out one');
    const chain: FallbackChainEntry[] = [{ backend: 'claude', profile: 'second', model: null }];
    assert.deepEqual(decideLimitSwitch({ ...telegram, chain, detection }).waitRungs, chain);
  });
});

describe('checkIsLimitSwitchPossible', () => {
  it('a Telegram topic: any rung; another platform: a Claude account only', () => {
    const openCode: FallbackChainEntry = { backend: 'opencode', providerId: 'openai', modelId: 'gpt-5' };
    assert.equal(checkIsLimitSwitchPossible(true, onDefault), true);
    assert.equal(checkIsLimitSwitchPossible(true, openCode), true);
    assert.equal(checkIsLimitSwitchPossible(false, onDefault), true);
    assert.equal(checkIsLimitSwitchPossible(false, openCode), false);
  });
});
