/**
 * @description The limit rules of a Claude account billed to a Claude Console organization's API credits — its limit
 * is the balance, not a window:
 *
 *   • «Credit balance is too low» is a usage limit flagged `isBalanceExhausted` with no reset, whatever status code or
 *     retry hint rides along (no wait refills a balance); an API rate limit (429, per minute) stays a short retry;
 *   • the ranking (`claude_profiles`' `recommended`, `charness claude-profiles --best`) NEVER names an API account,
 *     even with nothing else eligible; one out of credits is not eligible at all;
 *   • the within-Claude switch candidates leave API accounts out whatever figures they carry;
 *   • the chain: an account out of credits is `exhausted` (never a candidate, never the end of a wait — it has no
 *     reset); the draft lists API accounts LAST and left out of automatic switching, unless the chain being replaced
 *     had one included;
 *   • the usage poller never polls an API account;
 *   • what the screens say: the `/limits` board row and usage block, the `/accounts` lines, `/status`, the CLI line.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAgentApiError } from '../apiErrorRetry';
import { buildClaudeProfilesReport, type ClaudeProfileUsageView, type ClaudeUsageSnapshot } from '../utils/claudeUsage';
import { pickClaudeLimitSwitchCandidates } from '../utils/claudeLimitSwitch';
import {
  getFallbackEntryAvailability,
  pickEarliestResetRung,
  pickFallbackCandidates,
  proposeFallbackChain,
  type FallbackChainEntry,
  type FallbackDetection,
} from '../utils/fallbackChain';
import { createClaudeUsageRefresher } from '../utils/claudeUsageRefresher';
import { buildLimitsBoardRows, formatLimitsUsageBlock } from '../utils/limitsBoardPlan';
import { formatClaudeProfileUsageLines } from '../utils/claudeProfileUsageLines';
import { formatThreadStatusAccountLines } from '../utils/threadStatusReport';
import { formatClaudeProfileCliLine } from '../cli/claudeProfiles';

const nowMs = Date.parse('2026-10-23T10:00:00Z');
const inHours = (hours: number): string => new Date(nowMs + hours * 3_600_000).toISOString();

function buildUsage(percent: number): ClaudeUsageSnapshot {
  return {
    fetchedAt: new Date(nowMs).toISOString(),
    source: 'api',
    buckets: [
      { kind: 'session', percent, resetsAt: inHours(3), scopeModel: null },
      { kind: 'weekly_all', percent, resetsAt: inHours(48), scopeModel: null },
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
    usage: buildUsage(20),
    limitedUntil: null,
    billing: 'subscription',
    creditExhaustedAt: null,
    ...patch,
  };
}

const apiView = (patch: Partial<ClaudeProfileUsageView> = {}): ClaudeProfileUsageView =>
  buildView('console', { subscriptionType: null, usage: undefined, billing: 'api', ...patch });

function buildDetection(claudeProfiles: ClaudeProfileUsageView[], openCodeModels: string[] = []): FallbackDetection {
  return { claudeProfiles, openCodeModels, recentOpenCodeModels: [], openCodeLimits: {} };
}

const claudeRung = (profile: string, extra: Partial<Extract<FallbackChainEntry, { backend: 'claude' }>> = {}): FallbackChainEntry =>
  ({ backend: 'claude', profile, model: null, ...extra });

describe('classification: the balance is no window', () => {
  it('«Credit balance is too low» is a usage limit with a used-up balance and no reset', () => {
    assert.deepEqual(classifyAgentApiError('Credit balance is too low', nowMs), { kind: 'usageLimit', isBalanceExhausted: true });
    assert.deepEqual(
      classifyAgentApiError('API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}', nowMs),
      { kind: 'usageLimit', isBalanceExhausted: true },
    );
  });

  it('a status code or a retry hint riding along does not make it a hiccup, nor gives it a reset', () => {
    assert.deepEqual(classifyAgentApiError('429 Credit balance is too low — try again in 30 seconds', nowMs), { kind: 'usageLimit', isBalanceExhausted: true });
  });

  it('an API rate limit stays a short retry, and a window limit is no balance', () => {
    assert.deepEqual(
      classifyAgentApiError('API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your organization\'s rate limit of 30,000 input tokens per minute."}}', nowMs),
      { kind: 'transient' },
    );
    assert.equal(classifyAgentApiError('Overloaded (529)', nowMs)?.kind, 'transient');
    const window = classifyAgentApiError('You\'ve hit your session limit · resets 3pm (UTC)', nowMs);
    assert.equal(window?.kind, 'usageLimit');
    assert.equal(window?.isBalanceExhausted, undefined);
  });
});

describe('ranking: an API account is never recommended', () => {
  it('a subscription with headroom wins; an API account is listed with its billing but never recommended', () => {
    const report = buildClaudeProfilesReport([buildView('default', { usage: buildUsage(90) }), apiView()], null, nowMs);
    assert.equal(report.recommended, 'default');
    const api = report.profiles.find((entry) => entry.name === 'console');
    assert.equal(api?.billing, 'api');
    assert.equal(api?.isEligible, true, 'it could run — it is just never the advice');
    assert.equal(api?.isRecommended, false);
    assert.equal(api?.headroomPercent, null, 'no windows, no headroom figure');
  });

  it('even with every subscription limited, the advice is none rather than the metered account', () => {
    const report = buildClaudeProfilesReport([buildView('default', { limitedUntil: inHours(5) }), apiView()], 'fable', nowMs);
    assert.equal(report.recommended, null);
  });

  it('an account out of credits is not eligible', () => {
    const report = buildClaudeProfilesReport([apiView({ creditExhaustedAt: inHours(-1) })], null, nowMs);
    assert.equal(report.profiles[0].isEligible, false);
    assert.equal(report.profiles[0].creditExhaustedAt, inHours(-1));
  });

  it('the within-Claude switch never offers an API account, whatever figures it carries', () => {
    const candidates = pickClaudeLimitSwitchCandidates({
      profiles: [buildView('default', { usage: buildUsage(100) }), apiView({ usage: buildUsage(0) }), buildView('work', { usage: buildUsage(50) })],
      currentName: 'default',
      model: null,
      nowMs,
    });
    assert.deepEqual(candidates, ['work']);
  });
});

describe('the fallback chain', () => {
  it('an account out of credits is exhausted — no candidate, and no end of a wait (it has no reset)', () => {
    const detection = buildDetection([buildView('default', { limitedUntil: inHours(30) }), apiView({ creditExhaustedAt: inHours(-1) }), buildView('work', { limitedUntil: inHours(5) })]);
    assert.deepEqual(getFallbackEntryAvailability(claudeRung('console'), detection, nowMs), { status: 'exhausted' });
    assert.deepEqual(getFallbackEntryAvailability(claudeRung('console'), buildDetection([apiView()]), nowMs), { status: 'available' }, 'with credits it is a rung like any');
    const chain = [claudeRung('work'), claudeRung('console')];
    assert.deepEqual(pickFallbackCandidates({ chain, current: claudeRung('default'), detection, nowMs }), []);
    // The topic ran on the API account when its credits ran out: the wait ends on the rung that comes back first.
    assert.deepEqual(pickEarliestResetRung({ chain: [claudeRung('default'), ...chain], current: claudeRung('console'), detection, nowMs }), {
      entry: claudeRung('work'), untilMs: Date.parse(inHours(5)), isCurrent: false,
    });
  });

  it('the draft lists API accounts LAST — after OpenCode — and left out of automatic switching', () => {
    const detection = buildDetection([buildView('default'), apiView(), buildView('work')], ['openai/gpt-5']);
    assert.deepEqual(proposeFallbackChain(detection), [
      claudeRung('default'),
      claudeRung('work'),
      { backend: 'opencode', providerId: 'openai', modelId: 'gpt-5' },
      { ...claudeRung('console'), disabled: true },
    ]);
  });

  it('a rebuild keeps an API rung the operator included, and leaves out a signed-out one', () => {
    const detection = buildDetection([buildView('default'), apiView()]);
    assert.deepEqual(proposeFallbackChain(detection, [claudeRung('default'), claudeRung('console', { model: 'sonnet' })]), [claudeRung('default'), claudeRung('console')]);
    assert.deepEqual(proposeFallbackChain(detection, [{ ...claudeRung('console'), disabled: true }]), [claudeRung('default'), { ...claudeRung('console'), disabled: true }]);
    assert.deepEqual(proposeFallbackChain(buildDetection([buildView('default'), apiView({ loggedIn: false })])), [claudeRung('default')]);
  });
});

describe('the usage poller', () => {
  it('never polls an API account (no windows; its token would only be refused)', async () => {
    const tokensRead: Array<string | null> = [];
    const refresher = createClaudeUsageRefresher({
      listProfiles: () => [
        { name: 'default', configDir: null, loggedIn: true, billing: 'subscription' },
        { name: 'console', configDir: '/p/console', loggedIn: true, billing: 'api' },
      ],
      getSnapshot: () => undefined,
      saveSnapshot: () => {},
      readToken: (configDir) => {
        tokensRead.push(configDir);
        return { accessToken: 'tok', expiresAtMs: null };
      },
      fetchUsage: async () => ({ ok: true, buckets: [{ kind: 'session', percent: 1, resetsAt: null, scopeModel: null }] }),
      now: () => nowMs,
      log: () => {},
    });
    await refresher.refreshAll();
    await refresher.refreshOne('console');
    assert.deepEqual(tokensRead, [null]);
  });
});

describe('what the screens say', () => {
  it('the /limits board marks the metered account; its usage block says how it pays and when its credits are used up', () => {
    const detection = buildDetection([buildView('default', { usage: undefined }), apiView({ creditExhaustedAt: inHours(-1) })]);
    const rows = buildLimitsBoardRows({ detection, current: claudeRung('console'), words: { claude: 'Claude', openCode: 'OpenCode' } });
    assert.deepEqual(rows.map((row) => row.label), ['Claude · default', '✓ Claude · console 💳']);
    assert.equal(
      formatLimitsUsageBlock({ detection, openCodeProviderUsage: {}, nowMs, timezone: 'UTC' }),
      'Usage (% used)\nconsole — 💳 API · pay per use\n    💸 API credits used up — top them up, then pick it again',
    );
  });

  it('/accounts hangs only the used-up mark under an API row (its row already says how it pays)', () => {
    assert.deepEqual(formatClaudeProfileUsageLines({ billing: 'api', creditExhaustedAt: null }, 'UTC', nowMs), []);
    assert.deepEqual(formatClaudeProfileUsageLines({ billing: 'api', creditExhaustedAt: inHours(-1) }, 'UTC', nowMs), ['    💸 API credits used up — top them up, then pick it again']);
  });

  it('/status marks the metered account and its used-up credits', () => {
    const lines = formatThreadStatusAccountLines({
      current: { name: 'console', email: 'ops@example.com', loggedIn: true, limitedUntil: null, billing: 'api', creditExhaustedAt: inHours(-1) },
      pending: null,
      nowMs,
    }, 'UTC');
    assert.deepEqual(lines, ['Account: console · ops@example.com · 💳 API · 💸 credits used up']);
  });

  it('a used-up mark that landed on a subscription account shows on /accounts and /status too (it keeps the account out of the chain)', () => {
    const usage = { fetchedAt: inHours(-1), source: 'api' as const, isStale: false, buckets: [] };
    assert.deepEqual(formatClaudeProfileUsageLines({ billing: 'subscription', usage, creditExhaustedAt: inHours(-1) }, 'UTC', nowMs), ['    💸 API credits used up — top them up, then pick it again']);
    assert.deepEqual(formatClaudeProfileUsageLines({ billing: null, creditExhaustedAt: null }, 'UTC', nowMs), []);
    const lines = formatThreadStatusAccountLines({
      current: { name: 'default', email: 'me@example.com', loggedIn: true, limitedUntil: null, billing: 'subscription', creditExhaustedAt: inHours(-1) },
      pending: null,
      nowMs,
    }, 'UTC');
    assert.deepEqual(lines, ['Account: default · me@example.com · 💸 credits used up']);
  });

  it('`charness claude-profiles` says the account pays per use and is never recommended', () => {
    const report = buildClaudeProfilesReport([apiView({ creditExhaustedAt: inHours(-1) })], null, nowMs);
    assert.equal(
      formatClaudeProfileCliLine(report.profiles[0], nowMs),
      '✗ console  /home/user/.charness/claude-profiles/console  console@example.com API billing (pay per use, never recommended)  no windows  CREDITS USED UP',
    );
  });
});
