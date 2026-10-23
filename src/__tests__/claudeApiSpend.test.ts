/**
 * @description What an account billed to API credits spent through the bot (`utils/claudeApiSpend.ts`), from the
 * `total_cost_usd` of Claude's stream `result` frames — the CONVERSATION's running cost, restored on `--resume`:
 *
 *   • a turn's spend is the delta against the last total seen for the SAME conversation; a total below it (the CLI
 *     counted from zero again) is the turn's whole; without a baseline only a NEW conversation counts its total — a
 *     resumed one began at a total the bot never saw, so that turn only sets the baseline;
 *   • only an API account has spend, and a turn on it that went through ends its used-up-credits mark;
 *   • the account's spend adds up and keeps the day it began;
 *   • the stream parse reads a non-negative finite `total_cost_usd` and nothing else;
 *   • the amounts and the day as the screens show them: `/accounts` and `/limits` under the account, `/status`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addClaudeApiSpend, computeClaudeTurnCostUsd, formatSpendSinceDay, formatUsd, getClaudeTurnCostOutcome } from '../utils/claudeApiSpend';
import { classifyClaudeStreamMessage, type ClaudeStreamAction } from '../utils/claudeStreamJson';
import { formatClaudeProfileUsageLines } from '../utils/claudeProfileUsageLines';
import { formatThreadStatusAccountLines } from '../utils/threadStatusReport';
import { formatLimitsUsageBlock } from '../utils/limitsBoardPlan';

const nowMs = Date.parse('2026-10-23T10:00:00Z');

describe('a turn\'s spend', () => {
  it('is the delta against the same conversation\'s last total', () => {
    assert.equal(computeClaudeTurnCostUsd({ previous: { sessionId: 's1', totalCostUsd: 1.25 }, sessionId: 's1', totalCostUsd: 1.75, isNewConversation: false }), 0.5);
    // A subscription turn moved the baseline: the API turn after it counts only itself.
    assert.equal(computeClaudeTurnCostUsd({ previous: { sessionId: 's1', totalCostUsd: 0.25 }, sessionId: 's1', totalCostUsd: 0.5, isNewConversation: false }), 0.25);
  });

  it('a total below the baseline means the CLI counted from zero: the total is the turn\'s', () => {
    assert.equal(computeClaudeTurnCostUsd({ previous: { sessionId: 's1', totalCostUsd: 3 }, sessionId: 's1', totalCostUsd: 0.4, isNewConversation: false }), 0.4);
  });

  it('without a baseline of THIS conversation: a new one counts its total, a resumed one only sets the baseline', () => {
    assert.equal(computeClaudeTurnCostUsd({ previous: undefined, sessionId: 's2', totalCostUsd: 0.3, isNewConversation: true }), 0.3);
    assert.equal(computeClaudeTurnCostUsd({ previous: { sessionId: 's1', totalCostUsd: 9 }, sessionId: 's2', totalCostUsd: 0.3, isNewConversation: true }), 0.3);
    assert.equal(computeClaudeTurnCostUsd({ previous: undefined, sessionId: 's2', totalCostUsd: 7.5, isNewConversation: false }), null, 'never a doubled figure');
  });

  it('only an API account has spend; a turn on it that went through ends its used-up mark', () => {
    assert.deepEqual(getClaudeTurnCostOutcome({ billing: 'api', isCreditExhausted: false, isError: false, turnCostUsd: 0.25 }), { spendUsd: 0.25, isCreditMarkCleared: false });
    assert.deepEqual(getClaudeTurnCostOutcome({ billing: 'api', isCreditExhausted: true, isError: false, turnCostUsd: 0.25 }), { spendUsd: 0.25, isCreditMarkCleared: true }, 'the balance is back');
    assert.deepEqual(getClaudeTurnCostOutcome({ billing: 'api', isCreditExhausted: true, isError: true, turnCostUsd: 0 }), { spendUsd: null, isCreditMarkCleared: false }, 'a refused turn proves nothing');
    assert.deepEqual(getClaudeTurnCostOutcome({ billing: 'api', isCreditExhausted: false, isError: false, turnCostUsd: null }), { spendUsd: null, isCreditMarkCleared: false }, 'an unknown cost adds nothing');
    assert.deepEqual(getClaudeTurnCostOutcome({ billing: 'subscription', isCreditExhausted: true, isError: false, turnCostUsd: 1 }), { spendUsd: null, isCreditMarkCleared: false });
    assert.deepEqual(getClaudeTurnCostOutcome({ billing: null, isCreditExhausted: false, isError: false, turnCostUsd: 1 }), { spendUsd: null, isCreditMarkCleared: false });
  });

  it('adds up on the account and keeps the day it began', () => {
    const first = addClaudeApiSpend(undefined, 0.25, '2026-10-20T08:00:00.000Z');
    assert.deepEqual(first, { totalUsd: 0.25, since: '2026-10-20T08:00:00.000Z', lastTurnUsd: 0.25, lastTurnAt: '2026-10-20T08:00:00.000Z' });
    assert.deepEqual(addClaudeApiSpend(first, 1.5, '2026-10-23T09:00:00.000Z'), { totalUsd: 1.75, since: '2026-10-20T08:00:00.000Z', lastTurnUsd: 1.5, lastTurnAt: '2026-10-23T09:00:00.000Z' });
  });
});

describe('the stream parse', () => {
  const turnEnd = (msg: object): Extract<ClaudeStreamAction, { kind: 'turnEnd' }> => {
    const [action] = classifyClaudeStreamMessage(msg as Parameters<typeof classifyClaudeStreamMessage>[0]);
    assert.equal(action?.kind, 'turnEnd');
    return action as Extract<ClaudeStreamAction, { kind: 'turnEnd' }>;
  };

  it('reads total_cost_usd off a result frame, success or error, and nothing malformed', () => {
    assert.equal(turnEnd({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0.4321 }).totalCostUsd, 0.4321);
    assert.equal(turnEnd({ type: 'result', subtype: 'success', is_error: true, result: 'Credit balance is too low', total_cost_usd: 2 }).totalCostUsd, 2);
    assert.equal(turnEnd({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }).totalCostUsd, null);
    assert.equal(turnEnd({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: -1 }).totalCostUsd, null);
    assert.equal(turnEnd({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: '0.4' }).totalCostUsd, null);
  });
});

describe('as the screens show it', () => {
  const spend = { totalUsd: 12.345, since: '2026-10-20T08:00:00.000Z', lastTurnUsd: 0.004, lastTurnAt: '2026-10-23T09:00:00.000Z' };

  it('amounts in dollars and cents, a fraction of a cent as such; the day in the instance zone, the year only when it is not this one', () => {
    assert.equal(formatUsd(12.345), '$12.35');
    assert.equal(formatUsd(0.004), '<$0.01');
    assert.equal(formatUsd(0), '$0.00');
    assert.equal(formatSpendSinceDay('2026-10-20T23:30:00.000Z', 'Europe/Moscow', nowMs), '21.10');
    assert.equal(formatSpendSinceDay('2025-12-31T08:00:00.000Z', 'UTC', nowMs), '31.12.2025');
  });

  it('/accounts and /limits hang the spend under the account, the used-up mark after it', () => {
    assert.deepEqual(formatClaudeProfileUsageLines({ billing: 'api', apiSpend: spend, creditExhaustedAt: '2026-10-23T09:30:00.000Z' }, 'UTC', nowMs), [
      '    💳 $12.35 spent since 20.10 · last turn <$0.01',
      '    💸 API credits used up — top them up, then pick it again',
    ]);
    const block = formatLimitsUsageBlock({
      detection: {
        claudeProfiles: [{ name: 'console', configDir: '/p/console', loggedIn: true, email: null, subscriptionType: null, usage: undefined, limitedUntil: null, billing: 'api', creditExhaustedAt: null, apiSpend: spend }],
        openCodeModels: [], recentOpenCodeModels: [], openCodeLimits: {},
      },
      openCodeProviderUsage: {},
      nowMs,
      timezone: 'UTC',
    });
    assert.equal(block, 'Usage (% used)\nconsole — 💳 API · pay per use\n    💳 $12.35 spent since 20.10 · last turn <$0.01');
  });

  it('/status adds the spend line under an API account — only there', () => {
    const account = { name: 'console', email: 'ops@example.com', loggedIn: true, limitedUntil: null, billing: 'api' as const, apiSpend: spend };
    assert.deepEqual(formatThreadStatusAccountLines({ current: account, pending: null, nowMs }, 'UTC'), [
      'Account: console · ops@example.com · 💳 API',
      '💳 API spend on console: $12.35 since 20.10 (last turn <$0.01)',
    ]);
    assert.deepEqual(
      formatThreadStatusAccountLines({ current: { ...account, billing: 'subscription', name: 'work' }, pending: null, nowMs }, 'UTC'),
      ['Account: work · ops@example.com'],
      'a subscription\'s notional figure is never shown as spend',
    );
  });
});
