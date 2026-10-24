/**
 * `registerOpenCodeServerUpBudgetMs` (`createAdapter.ts`): a test instance's shorter bound on the retries that bring
 * the OpenCode server up (`CHARNESS_TEST_TIMINGS` `openCodeServerUpBudgetMs`) reaches the OpenCode adapter on both
 * late-wiring paths:
 *   • registered BEFORE the adapter exists — what a real instance does (`bot.ts` registers it at boot, the first
 *     `getAdapter('opencode')` comes later): `getAdapter` hands it to the instance it creates;
 *   • registered again while the adapter exists: the registration reaches that instance.
 * Without a registration the adapter keeps the production 60 s.
 *
 * The order matters and is this file's own: each test file runs in a process of its own, so no other test has created
 * the `opencode` instance before the first step.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getAdapter, registerOpenCodeServerUpBudgetMs } from '../adapters/createAdapter';
import { OpenCodeAdapter, openCodeServerRestartRetryBudgetMs } from '../adapters/openCodeAdapter';

const budgetRegisteredFirstMs = 10_000;
const budgetRegisteredLaterMs = 5_000;

function getOpenCodeAdapter(): OpenCodeAdapter {
  const adapter = getAdapter('opencode');
  assert.ok(adapter instanceof OpenCodeAdapter);
  return adapter;
}

describe('the OpenCode server-up budget of a test instance', () => {
  it('an adapter nobody registered a budget for keeps the production one', () => {
    assert.equal(new OpenCodeAdapter()['serverRestartRetryBudgetMs'], openCodeServerRestartRetryBudgetMs);
  });

  it('registered before the adapter exists, the budget is handed to the instance getAdapter creates', () => {
    registerOpenCodeServerUpBudgetMs(budgetRegisteredFirstMs);
    assert.equal(getOpenCodeAdapter()['serverRestartRetryBudgetMs'], budgetRegisteredFirstMs);
  });

  it('registered while the adapter exists, the budget reaches that instance', () => {
    const adapter = getOpenCodeAdapter();
    registerOpenCodeServerUpBudgetMs(budgetRegisteredLaterMs);
    assert.equal(adapter['serverRestartRetryBudgetMs'], budgetRegisteredLaterMs);
  });
});
