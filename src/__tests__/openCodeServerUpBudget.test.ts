/**
 * `registerOpenCodeServerUpBudgetMs` (`createAdapter.ts`): a test instance's shorter bound on the retries that bring
 * the OpenCode server up (`CHARNESS_TEST_TIMINGS` `openCodeServerUpBudgetMs`) reaches the OpenCode adapter already
 * created; without one the adapter keeps the production 60 s. (An adapter created after the registration gets it in
 * `getAdapter`, the same late-wiring step as every other reader; the OpenCode restart flow runs on it.)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getAdapter, registerOpenCodeServerUpBudgetMs } from '../adapters/createAdapter';
import { OpenCodeAdapter, openCodeServerRestartRetryBudgetMs } from '../adapters/openCodeAdapter';

function getOpenCodeAdapter(): OpenCodeAdapter {
  const adapter = getAdapter('opencode');
  assert.ok(adapter instanceof OpenCodeAdapter);
  return adapter;
}

describe('the OpenCode server-up budget of a test instance', () => {
  it('without a registration the adapter keeps the production budget; a registration reaches the existing adapter', () => {
    const adapter = getOpenCodeAdapter();
    assert.equal(adapter['serverRestartRetryBudgetMs'], openCodeServerRestartRetryBudgetMs);
    const testBudgetMs = 10_000;
    registerOpenCodeServerUpBudgetMs(testBudgetMs);
    assert.equal(adapter['serverRestartRetryBudgetMs'], testBudgetMs);
  });
});
