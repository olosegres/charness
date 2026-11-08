/**
 * @description The limit rules of a Claude account billed to a Claude Console organization's API credits — its limit
 * is the balance, not a window:
 *
 *   • «Credit balance is too low» is a usage limit flagged `isBalanceExhausted` with no reset, whatever status code or
 *     retry hint rides along (no wait refills a balance); an API rate limit (429, per minute) stays a short retry;
 *   • the ranking (`claude_profiles`' `recommended`, `charness claude-profiles --best`) names an API account for a new agent
 *     ONLY when the operator's `/limits` list holds it as an enabled rung (then FIRST); with no such list it never does, even
 *     with nothing else eligible; one out of credits is not eligible at all;
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
import { buildClaudeProfilesReport, getClaudeLaunchPick, type ClaudeProfileUsageView, type ClaudeUsageSnapshot } from '../utils/claudeUsage';
import { addClaudeApiCreditToReport, buildClaudeProfileUsageView, buildClaudeProfilesCreditReport } from '../utils/claudeProfileUsageViews';
import { claudeApiAgentStopHoldMs, claudeApiAgentStopProbeTimeoutMs, getApiProfileStoppedByAgent, verifyClaudeApiAgentStop, type ClaudeApiAgentStopPorts } from '../utils/claudeApiAgentStop';
import { probeClaudeApiCredit, type ClaudeApiCreditProbeOutcome } from '../utils/claudeApiCreditRecheck';
import { pickClaudeLimitSwitchCandidates } from '../utils/claudeLimitSwitch';
import {
  getClaudeLaunchChainScope,
  getFallbackEntryAvailability,
  pickEarliestResetRung,
  pickFallbackCandidates,
  proposeFallbackChain,
  type FallbackChainEntry,
  type FallbackDetection,
} from '../utils/fallbackChain';
import { claudeLaunchRefreshBudgetMs, createClaudeUsageRefresher } from '../utils/claudeUsageRefresher';
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

/** The view of an API account whose refusal (an hour ago) is OLDER than the operator's figure: built the way the command line builds it, off a record. */
function buildClaudeProfileUsageViewsForTest(anchor: { remainingUsd: number; anchoredAt: string }): ClaudeProfileUsageView {
  return buildClaudeProfileUsageView({
    dataDir: '/home/user/.charness',
    name: 'console',
    record: { createdAt: '2026-10-01T00:00:00.000Z', loggedIn: true, billing: 'api', creditExhaustedAt: new Date(Date.parse(anchor.anchoredAt) - 3_600_000).toISOString() },
    creditAnchor: anchor,
  });
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

describe('ranking: an API account is picked for a new agent only when the /limits list holds it', () => {
  it('with no list, a subscription with headroom wins; an API account is listed with its billing but never picked', () => {
    const report = buildClaudeProfilesReport([buildView('default', { usage: buildUsage(80) }), apiView()], null, nowMs);
    assert.equal(report.recommended, 'default');
    const api = report.profiles.find((entry) => entry.name === 'console');
    assert.equal(api?.billing, 'api');
    assert.equal(api?.isEligible, true, 'it could run — it is just never the advice');
    assert.equal(api?.isRecommended, false);
    assert.equal(api?.headroomPercent, null, 'no windows, no headroom figure');
  });

  it('with no list, even with every subscription limited, the advice is none rather than the metered account', () => {
    const report = buildClaudeProfilesReport([buildView('default', { limitedUntil: inHours(5) }), apiView()], 'fable', nowMs);
    assert.equal(report.recommended, null);
  });

  it('an account out of credits is not eligible', () => {
    const report = buildClaudeProfilesReport([apiView({ creditExhaustedAt: inHours(-1) })], null, nowMs);
    assert.equal(report.profiles[0].isEligible, false);
    assert.equal(report.profiles[0].creditExhaustedAt, inHours(-1));
  });

  it('with the account in the list it is recommended FIRST — before a subscription that resets sooner — and the report says so', () => {
    const chainScope = getClaudeLaunchChainScope([claudeRung('default'), claudeRung('console')]);
    const report = buildClaudeProfilesCreditReport([buildView('default', { usage: buildUsage(10) }), apiView()], null, nowMs, { chainScope });
    assert.equal(report.recommended, 'console');
    assert.equal(report.pickReason, 'apiCreditFirst');
    assert.deepEqual(report.profiles.map((entry) => [entry.name, entry.isRecommended, entry.chainExclusion]), [['default', false, null], ['console', true, null]]);
  });

  it('the draft\'s left-out API rung keeps agents off the account; the operator including the rung opens it', () => {
    const detection = buildDetection([buildView('default'), apiView()]);
    const drafted = getClaudeLaunchChainScope(proposeFallbackChain(detection));
    const views = detection.claudeProfiles;
    assert.equal(getClaudeLaunchPick({ profiles: views, model: null, nowMs, chainScope: drafted }).pick, 'default');
    assert.deepEqual(buildClaudeProfilesReport(views, null, nowMs, { chainScope: drafted }).profiles.map((entry) => entry.chainExclusion), [null, 'switchedOff']);
    const included = getClaudeLaunchChainScope(proposeFallbackChain(detection, [claudeRung('default'), claudeRung('console')]));
    assert.equal(getClaudeLaunchPick({ profiles: views, model: null, nowMs, chainScope: included }).pick, 'console');
  });

  it('an API account whose credit ran out by the expiry day the operator gave is not put first; with the day still ahead it is', () => {
    const chainScope = getClaudeLaunchChainScope([claudeRung('default'), claudeRung('console')]);
    const views = (expiresOn: string): ClaudeProfileUsageView[] => [
      buildView('default', { usage: buildUsage(10) }),
      apiView({ creditAnchor: { remainingUsd: 50, grantUsd: 100, anchoredAt: inHours(-24 * 30), expiresOn } }),
    ];
    const expired = buildClaudeProfilesCreditReport(views('2026-10-20'), null, nowMs, { chainScope });
    assert.equal(expired.recommended, 'default', 'the day the operator gave is over: the subscription');
    assert.equal(expired.pickReason, 'soonestWeeklyReset');
    assert.deepEqual(expired.profiles.map((entry) => [entry.name, entry.remainingEstimateUsd, entry.isRecommended]), [['default', null, true], ['console', 0, false]]);
    assert.equal(buildClaudeProfilesCreditReport(views('2026-10-31'), null, nowMs, { chainScope }).recommended, 'console', 'the day is still ahead: first');
    assert.equal(buildClaudeProfilesCreditReport(views('2026-10-23'), null, nowMs, { chainScope }).recommended, 'console', 'the expiry day itself still counts');
    // The pick itself takes the set from its caller (the credit module is out of its reach).
    assert.equal(getClaudeLaunchPick({ profiles: views('2026-10-31'), model: null, nowMs, chainScope, expiredApiNames: new Set(['console']) }).pick, 'default');
  });

  describe('an agent\'s stop report on an API account is checked, never believed', () => {
    const stopQuery = { currentProfile: 'console', isStoppedByLimit: true };

    it('only a reported stop on an unmarked, not yet held API account is checked', () => {
      const views = [buildView('default'), apiView()];
      assert.equal(getApiProfileStoppedByAgent(views, stopQuery, nowMs), 'console');
      assert.equal(getApiProfileStoppedByAgent(views, { currentProfile: 'console', isStoppedByLimit: false }, nowMs), null, 'a plain resume is no stop');
      assert.equal(getApiProfileStoppedByAgent(views, { currentProfile: 'default', isStoppedByLimit: true }, nowMs), null, 'a subscription has windows and its own limit handling');
      assert.equal(getApiProfileStoppedByAgent(views, { currentProfile: null, isStoppedByLimit: true }, nowMs), null);
      assert.equal(getApiProfileStoppedByAgent(views, { currentProfile: 'gone', isStoppedByLimit: true }, nowMs), null, 'an unknown account is nothing to check');
      assert.equal(getApiProfileStoppedByAgent([buildView('default'), apiView({ creditExhaustedAt: inHours(-1) })], stopQuery, nowMs), null, 'already marked used up');
      assert.equal(getApiProfileStoppedByAgent([buildView('default'), apiView({ limitedUntil: inHours(1) })], stopQuery, nowMs), null, 'already held off by an earlier report: no second probe');
      assert.equal(getApiProfileStoppedByAgent([buildView('default'), apiView({ limitedUntil: inHours(-1) })], stopQuery, nowMs), 'console', 'a hold that has run out checks again');
    });

    /** Fake ports: records the order of everything the check does and answers the probe with `outcome`. */
    function buildStopHarness(options: { outcome: ClaudeApiCreditProbeOutcome; apiKey?: string | null }) {
      const events: string[] = [];
      const probeTimeouts: number[] = [];
      const logs: string[] = [];
      const warnings: string[] = [];
      const ports: ClaudeApiAgentStopPorts = {
        nowMs: () => nowMs,
        readApiKey: () => (options.apiKey === undefined ? 'sk-ant-api03-test-key' : options.apiKey),
        probe: async (_apiKey, timeoutMs) => {
          events.push('probe');
          probeTimeouts.push(timeoutMs);
          return options.outcome;
        },
        markRechecked: (name, atIso) => events.push(`rechecked ${name} ${atIso}`),
        markUsedUp: (name, atIso) => events.push(`usedUp ${name} ${atIso}`),
        holdOff: (name, untilIso) => events.push(`holdOff ${name} ${untilIso}`),
        log: (line) => logs.push(line),
        warn: (line) => warnings.push(line),
      };
      return { ports, events, probeTimeouts, logs, warnings };
    }
    const nowIso = new Date(nowMs).toISOString();
    const heldUntilIso = new Date(nowMs + claudeApiAgentStopHoldMs).toISOString();

    it('a refusal for the balance marks the credit used up — after the attempt is recorded, with one log line', async () => {
      const harness = buildStopHarness({ outcome: { kind: 'stillUsedUp' } });
      assert.equal(await verifyClaudeApiAgentStop('console', harness.ports), 'markedUsedUp');
      assert.deepEqual(harness.events, [`rechecked console ${nowIso}`, 'probe', `usedUp console ${nowIso}`]);
      assert.equal(harness.logs.length, 1);
      assert.match(harness.logs[0], /^\[credit\] console: an agent reported a stop and the API refuses the account for its balance — marked used up$/);
    });

    it('the API answering the account (the stop was something else) only holds it off agents for an hour — no used-up mark', async () => {
      const harness = buildStopHarness({ outcome: { kind: 'renewed' } });
      assert.equal(await verifyClaudeApiAgentStop('console', harness.ports), 'heldOff');
      assert.deepEqual(harness.events, [`rechecked console ${nowIso}`, 'probe', `holdOff console ${heldUntilIso}`]);
      assert.equal(claudeApiAgentStopHoldMs, 3_600_000);
      assert.match(harness.logs.join('\n'), /the API answers the account — the balance is not the cause; kept off agents for 1 h/);
    });

    it('a check without a conclusion, or without a key the bot can read, holds the account off for the hour and marks nothing', async () => {
      const inconclusive = buildStopHarness({ outcome: { kind: 'inconclusive', reason: 'timeout' } });
      assert.equal(await verifyClaudeApiAgentStop('console', inconclusive.ports), 'heldOff');
      assert.deepEqual(inconclusive.events, [`rechecked console ${nowIso}`, 'probe', `holdOff console ${heldUntilIso}`]);
      assert.match(inconclusive.logs.join('\n'), /no answer about the balance \(timeout\)/);

      const keyless = buildStopHarness({ outcome: { kind: 'stillUsedUp' }, apiKey: null });
      assert.equal(await verifyClaudeApiAgentStop('console', keyless.ports), 'heldOff');
      assert.deepEqual(keyless.events, [`rechecked console ${nowIso}`, `holdOff console ${heldUntilIso}`], 'no key, no request, no mark: it can never be lifted by a recheck either');
      assert.match(keyless.logs.join('\n'), /can read no API key for the account/);

      const modelGone = buildStopHarness({ outcome: { kind: 'modelNotFound' } });
      assert.equal(await verifyClaudeApiAgentStop('console', modelGone.ports), 'heldOff');
      assert.equal(modelGone.warnings.length, 1, 'a probe whose model is gone is a warning, not a log line');
      assert.ok(!modelGone.events.some((event) => event.startsWith('usedUp')));
    });

    it('the probe has a timeout of its own, shorter than the 10 s the answer may take', async () => {
      const harness = buildStopHarness({ outcome: { kind: 'stillUsedUp' } });
      await verifyClaudeApiAgentStop('console', harness.ports);
      assert.deepEqual(harness.probeTimeouts, [claudeApiAgentStopProbeTimeoutMs]);
      assert.ok(claudeApiAgentStopProbeTimeoutMs < claudeLaunchRefreshBudgetMs, `${claudeApiAgentStopProbeTimeoutMs} ms must fit inside ${claudeLaunchRefreshBudgetMs} ms`);
    });

    it('through the real probe: a per-minute rate limit (the stop that was misread as a balance) is NOT a used-up credit; the balance refusal is', async () => {
      const respond = (status: number, body: string) => async () => ({ status, text: async () => body });
      const run = async (fetchImpl: ReturnType<typeof respond>) => {
        const harness = buildStopHarness({ outcome: { kind: 'renewed' } });
        harness.ports.probe = (apiKey, timeoutMs) => probeClaudeApiCredit(apiKey, { fetchImpl, timeoutMs });
        return { result: await verifyClaudeApiAgentStop('console', harness.ports), events: harness.events };
      };
      const rateLimited = await run(respond(429, '{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your organization\'s rate limit of 30,000 input tokens per minute."}}'));
      assert.equal(rateLimited.result, 'heldOff');
      assert.ok(!rateLimited.events.some((event) => event.startsWith('usedUp')), 'a rate limit never marks the credit used up');
      const overloaded = await run(respond(529, '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'));
      assert.equal(overloaded.result, 'heldOff');
      const refused = await run(respond(400, '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'));
      assert.equal(refused.result, 'markedUsedUp');
    });

    it('the held-off account is skipped by the next NEW worker and comes back first once the hour is over', () => {
      const chainScope = getClaudeLaunchChainScope([claudeRung('console'), claudeRung('default')]);
      const held = [buildView('default'), apiView({ limitedUntil: heldUntilIso })];
      assert.equal(getClaudeLaunchPick({ profiles: held, model: null, nowMs, chainScope }).pick, 'default', 'inside the hour: the subscription');
      assert.equal(getClaudeLaunchPick({ profiles: held, model: null, nowMs: nowMs + claudeApiAgentStopHoldMs + 1, chainScope }).pick, 'console', 'after it: the API account again');
      const used = [buildView('default'), apiView({ creditExhaustedAt: nowIso })];
      assert.equal(getClaudeLaunchPick({ profiles: used, model: null, nowMs, chainScope }).pick, 'default', 'marked used up: the subscription');
    });
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

  it('an API rung the operator put in the list is a rung like any: a limit moves a topic onto it (nothing refuses it or marks it 🚫)', () => {
    const detection = buildDetection([buildView('default', { limitedUntil: inHours(5) }), apiView()]);
    const chain = [claudeRung('default'), claudeRung('console')];
    assert.deepEqual(pickFallbackCandidates({ chain, current: claudeRung('default'), detection, nowMs }), [claudeRung('console')]);
    assert.deepEqual(pickFallbackCandidates({ chain: [claudeRung('default'), { ...claudeRung('console'), disabled: true }], current: claudeRung('default'), detection, nowMs }), [], 'only a rung the operator left out (the draft\'s default for an API account) is refused');
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
      'Usage (% used)\nconsole — 💳 API · pay per use\n    🎁 API credit probably used up — top it up, then pick the account again',
    );
  });

  it('/accounts hangs only the credit line under an API row (its row already says how it pays): «probably used up» after a refusal', () => {
    assert.deepEqual(formatClaudeProfileUsageLines({ billing: 'api', creditExhaustedAt: null }, 'UTC', nowMs), []);
    assert.deepEqual(formatClaudeProfileUsageLines({ billing: 'api', creditExhaustedAt: inHours(-1) }, 'UTC', nowMs), ['    🎁 API credit probably used up — top it up, then pick the account again']);
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

  it('`charness claude-profiles` says the account pays per use and is offered to agents only when the /limits list holds it', () => {
    const report = buildClaudeProfilesCreditReport([apiView({ creditExhaustedAt: inHours(-1) })], null, nowMs);
    assert.equal(
      formatClaudeProfileCliLine(report.profiles[0], nowMs),
      '✗ console  /home/user/.charness/claude-profiles/console  console@example.com API billing (pay per use; offered to agents only when the /limits list holds it)  no windows  CREDITS PROBABLY USED UP',
    );
    const unlisted = buildClaudeProfilesCreditReport([apiView()], null, nowMs, { chainScope: getClaudeLaunchChainScope([claudeRung('default')]) });
    assert.match(formatClaudeProfileCliLine(unlisted.profiles[0], nowMs), /no windows {2}NOT OFFERED: not in the \/limits list$/);
  });
});

describe('what the bot can tell of an API account\'s credit, for an agent and for the command line', () => {
  const anchor = { remainingUsd: 67.71, grantUsd: 200, anchoredAt: inHours(-2), expiresOn: '2026-10-31' };
  const entryOf = (view: ClaudeProfileUsageView) => buildClaudeProfilesCreditReport([view], null, nowMs).profiles[0];

  it('the report entry carries spentUsd, remainingEstimateUsd, expiresOn, probablyUsedUp and renewedAt from the operator\'s figure', () => {
    const entry = entryOf(apiView({ creditAnchor: anchor, creditSpend: { since: anchor.anchoredAt, usd: 6.51 } }));
    assert.deepEqual(
      [entry.spentUsd, entry.remainingEstimateUsd, entry.expiresOn, entry.probablyUsedUp, entry.renewedAt],
      [6.51, 61.2, '2026-10-31', false, null],
    );
  });

  it('with no figure it carries the spend since the first counted turn and no remainder', () => {
    const entry = entryOf(apiView({ apiSpend: { totalUsd: 12.34, since: inHours(-30), lastTurnUsd: 0.25, lastTurnAt: inHours(-1) } }));
    assert.deepEqual([entry.spentUsd, entry.remainingEstimateUsd, entry.expiresOn, entry.probablyUsedUp, entry.renewedAt], [12.34, null, null, false, null]);
  });

  it('says probablyUsedUp after a refusal, and after a renewal the renewal instant, the last grant and no expiry', () => {
    assert.equal(entryOf(apiView({ creditAnchor: anchor, creditExhaustedAt: inHours(-1) })).probablyUsedUp, true);
    const renewed = entryOf(apiView({ creditAnchor: anchor, creditRenewedAt: inHours(-1), creditSpend: { since: inHours(-1), usd: 0.25 } }));
    assert.deepEqual([renewed.renewedAt, renewed.remainingEstimateUsd, renewed.expiresOn, renewed.spentUsd, renewed.probablyUsedUp], [inHours(-1), 199.75, null, 0.25, false]);
  });

  it('the report builder itself leaves the credit fields empty (it is loaded by the connector guards and must not reach the credit module); the fill adds them for the API accounts it has views for, and leaves an entry without a view as it is', () => {
    const view = apiView({ creditAnchor: anchor });
    const bare = buildClaudeProfilesReport([view], null, nowMs);
    assert.deepEqual([bare.profiles[0].spentUsd, bare.profiles[0].remainingEstimateUsd, bare.profiles[0].probablyUsedUp], [null, null, false]);
    const filled = addClaudeApiCreditToReport(bare, [view], nowMs);
    assert.equal(filled.profiles[0].remainingEstimateUsd, 67.71);
    assert.deepEqual(addClaudeApiCreditToReport(bare, [], nowMs).profiles, bare.profiles);
  });

  it('the composer every shown report goes through is the pick of the bare builder with the credit fields filled — nothing else differs', () => {
    const views = [buildView('default', { usage: buildUsage(30) }), apiView({ creditAnchor: anchor, creditExhaustedAt: inHours(-1) })];
    const options = { currentProfile: 'default', excludedNames: new Set<string>() };
    const bare = buildClaudeProfilesReport(views, 'sonnet', nowMs, options);
    const composed = buildClaudeProfilesCreditReport(views, 'sonnet', nowMs, options);
    assert.deepEqual(composed, addClaudeApiCreditToReport(bare, views, nowMs));
    assert.deepEqual([composed.recommended, composed.pickReason], [bare.recommended, bare.pickReason], 'the pick is the builder\'s');
    assert.equal(composed.profiles[1].probablyUsedUp, true);
    assert.equal(bare.profiles[1].probablyUsedUp, false, 'the bare builder stays credit-free');
  });

  it('has no spend to tell for an API account that has not been counted at all, and says only that it is probably used up when it was refused', () => {
    const entry = entryOf(apiView({ creditExhaustedAt: inHours(-1) }));
    assert.deepEqual([entry.spentUsd, entry.remainingEstimateUsd, entry.probablyUsedUp], [null, null, true]);
    assert.deepEqual([entryOf(apiView()).spentUsd, entryOf(apiView()).probablyUsedUp], [null, false]);
  });

  it('an expired credit with a pending refusal is STILL reported probablyUsedUp — the refusal the exclusion reads, not the line — with its expiry', () => {
    const expiredAnchor = { ...anchor, expiresOn: '2026-10-20' };
    const entry = entryOf(apiView({ creditAnchor: expiredAnchor, creditExhaustedAt: inHours(-1) }));
    assert.deepEqual([entry.probablyUsedUp, entry.expiresOn, entry.remainingEstimateUsd], [true, '2026-10-20', 0]);
    assert.equal(entry.isEligible, false, 'and the account stays out of the ranking, as the report says');
    assert.equal(entryOf(apiView({ creditAnchor: expiredAnchor })).probablyUsedUp, false, 'expired alone is not a refusal');
  });

  it('a refusal the operator acted on is NOT reported as used up: the account is usable, the remainder is unknown, the renewal awaits', () => {
    const entry = entryOf(apiView({ creditAnchor: anchor, creditSpend: { since: anchor.anchoredAt, usd: 66 }, creditUnconfirmedSince: inHours(-1) }));
    assert.deepEqual([entry.probablyUsedUp, entry.remainingEstimateUsd, entry.spentUsd, entry.renewedAt, entry.isEligible], [false, null, 66, null, true]);
  });

  it('is empty for an account that is not billed to API credits — whatever stray figure it carries', () => {
    const entry = entryOf(buildView('work', { creditAnchor: anchor, creditSpend: { since: anchor.anchoredAt, usd: 1 }, creditExhaustedAt: inHours(-1) }));
    assert.deepEqual([entry.spentUsd, entry.remainingEstimateUsd, entry.expiresOn, entry.probablyUsedUp, entry.renewedAt], [null, null, null, false, null]);
  });

  it('the command line prints the same parts after «no windows»', () => {
    const line = formatClaudeProfileCliLine(entryOf(apiView({ creditAnchor: anchor, creditSpend: { since: anchor.anchoredAt, usd: 6.51 } })), nowMs);
    assert.match(line, /no windows {2}\$6\.51 spent via the bot {2}≈ \$61\.20 left {2}expires 2026-10-31$/);
    const renewed = formatClaudeProfileCliLine(entryOf(apiView({ creditAnchor: anchor, creditRenewedAt: '2026-10-23T09:00:00.000Z', creditSpend: { since: '2026-10-23T09:00:00.000Z', usd: 0 } })), nowMs);
    assert.match(renewed, /no windows {2}\$0\.00 spent via the bot {2}≈ \$200\.00 left {2}renewed ≈ 2026-10-23$/);
    assert.match(formatClaudeProfileCliLine(entryOf(apiView({ creditExhaustedAt: inHours(-1) })), nowMs), /no windows {2}CREDITS PROBABLY USED UP$/);
  });

  it('a figure the operator gave after a refusal they had acted on ends that too in the view', () => {
    const view = buildClaudeProfileUsageView({
      dataDir: '/home/user/.charness',
      name: 'console',
      record: { createdAt: '2026-10-01T00:00:00.000Z', billing: 'api', creditUnconfirmedSince: new Date(Date.parse(anchor.anchoredAt) - 3_600_000).toISOString() },
      creditAnchor: anchor,
    });
    assert.equal(view.creditUnconfirmedSince, undefined);
    assert.equal(entryOf(view).remainingEstimateUsd, 67.71);
    const newer = buildClaudeProfileUsageView({
      dataDir: '/home/user/.charness',
      name: 'console',
      record: { createdAt: '2026-10-01T00:00:00.000Z', billing: 'api', creditUnconfirmedSince: new Date(Date.parse(anchor.anchoredAt) + 3_600_000).toISOString() },
      creditAnchor: anchor,
    });
    assert.ok(newer.creditUnconfirmedSince, 'a refusal AFTER the figure stays');
  });

  it('a figure the operator gave after the refusal ends the mark in the view too — for a reader of state.json alone', () => {
    const views = buildClaudeProfileUsageViewsForTest(anchor);
    assert.equal(views.creditExhaustedAt, null);
    assert.equal(entryOf(views).probablyUsedUp, false);
    assert.equal(entryOf(views).isEligible, true, 'and the account is no longer out of the ranking');
  });
});
