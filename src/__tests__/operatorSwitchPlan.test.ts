/**
 * @description The route of an operator's own pick (`utils/operatorSwitchPlan.ts`): every branch of the one decision
 * the `/limits` rows, the `/accounts` rows, the model pages and `/accounts use` share.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FallbackChainEntry } from '../utils/fallbackChain';
import { decideOperatorSwitch, type OperatorSwitchInput } from '../utils/operatorSwitchPlan';

const claude = (profile: string, model: string | null = null): FallbackChainEntry => ({ backend: 'claude', profile, model });
const openCode = (providerId: string, modelId: string): FallbackChainEntry => ({ backend: 'opencode', providerId, modelId });

/** A pick on a quiet topic that runs Claude on «perf» and holds a conversation. */
function decide(overrides: Partial<OperatorSwitchInput>): ReturnType<typeof decideOperatorSwitch> {
  return decideOperatorSwitch({
    isUsageLimitWaitArmed: false,
    from: claude('perf'),
    to: claude('work'),
    currentFamily: 'claude',
    hasConversation: true,
    ...overrides,
  });
}

describe('decideOperatorSwitch', () => {
  it('a pick on the backend the topic runs keeps the conversation: Claude → another account, OpenCode → another model', () => {
    assert.equal(decide({}), 'sameFamily');
    assert.equal(decide({ from: openCode('openai', 'gpt-5'), to: openCode('openrouter', 'gpt-5-mini'), currentFamily: 'opencode' }), 'sameFamily');
  });

  it('the same account with another Claude model (the ✓ row\'s page) is still the same backend', () => {
    assert.equal(decide({ to: claude('perf', 'opus') }), 'sameFamily');
  });

  it('the other backend asks first when the agent being left holds a conversation, and switches at once when it holds none', () => {
    assert.equal(decide({ to: openCode('openai', 'gpt-5'), hasConversation: true }), 'askFirst');
    assert.equal(decide({ to: openCode('openai', 'gpt-5'), hasConversation: false }), 'switchNow');
    assert.equal(decide({ from: openCode('openai', 'gpt-5'), to: claude('work'), currentFamily: 'opencode', hasConversation: true }), 'askFirst');
    assert.equal(decide({ from: openCode('openai', 'gpt-5'), to: claude('work'), currentFamily: 'opencode', hasConversation: false }), 'switchNow');
  });

  it('an OpenCode topic on the server\'s default model (no rung) is still on OpenCode', () => {
    assert.equal(decide({ from: null, to: openCode('openai', 'gpt-5'), currentFamily: 'opencode' }), 'sameFamily');
    assert.equal(decide({ from: null, to: claude('work'), currentFamily: 'opencode', hasConversation: true }), 'askFirst');
  });

  it('a topic with no agent or a shell has nothing to hand over: a Claude pick is only recorded, an OpenCode pick starts OpenCode on it', () => {
    assert.equal(decide({ from: null, currentFamily: null, to: claude('work'), hasConversation: false }), 'sameFamily');
    assert.equal(decide({ from: null, currentFamily: null, to: openCode('openai', 'gpt-5'), hasConversation: false }), 'switchNow');
  });

  it('while a usage-limit wait is armed a pick that leaves the limited account or model is the limit move, whatever the backend, with no question', () => {
    assert.equal(decide({ isUsageLimitWaitArmed: true }), 'limitMove');
    assert.equal(decide({ isUsageLimitWaitArmed: true, to: openCode('openai', 'gpt-5'), hasConversation: true }), 'limitMove', 'across backends too: the question is skipped');
    assert.equal(decide({ isUsageLimitWaitArmed: true, from: openCode('openai', 'gpt-5'), to: openCode('openai', 'gpt-5-mini'), currentFamily: 'opencode' }), 'limitMove', 'another model of the limited OpenCode provider');
    assert.equal(decide({ isUsageLimitWaitArmed: true, from: null, to: openCode('openai', 'gpt-5'), currentFamily: 'opencode' }), 'limitMove', 'an OpenCode topic whose model is unknown');
  });

  it('a pick that stays on the limited account (another Claude model) or model is not a move even with a wait armed', () => {
    assert.equal(decide({ isUsageLimitWaitArmed: true, to: claude('perf', 'opus') }), 'sameFamily');
    assert.equal(decide({ isUsageLimitWaitArmed: true, from: openCode('openai', 'gpt-5'), to: openCode('openai', 'gpt-5'), currentFamily: 'opencode' }), 'sameFamily');
  });

  it('a wait armed on a topic with no agent moves nothing: there is no process to continue', () => {
    assert.equal(decide({ isUsageLimitWaitArmed: true, from: null, currentFamily: null, to: claude('work') }), 'sameFamily');
  });
  it('a pick of another model of the SAME limited Claude account is the limit move only when the limit does not cover that model; inside the limit it just changes the model and the wait stays', () => {
    const armedSameAccount = { isUsageLimitWaitArmed: true, from: claude('perf', 'claude-fable-5-1'), to: claude('perf', 'sonnet') };
    assert.equal(decide({ ...armedSameAccount, isPickBeyondLimit: true }), 'limitMove', 'a Fable-only limit and the pick is sonnet: the work continues');
    assert.equal(decide({ ...armedSameAccount, isPickBeyondLimit: false }), 'sameFamily', 'the pick is still inside the limit: only the model changes');
    assert.equal(decide(armedSameAccount), 'sameFamily', 'unknown scope is inside the limit');
  });

  it('without a wait armed the scope of a limit decides nothing', () => {
    assert.equal(decide({ to: claude('perf', 'sonnet'), isPickBeyondLimit: true }), 'sameFamily');
  });
});
