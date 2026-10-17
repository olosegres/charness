/**
 * @description The pure rules behind the «back» button of `/accounts` (`utils/fallbackReturn.ts`): what a persisted
 * rung reads back as (a Claude rung keeps the model id the session reported, a malformed one is none), the button's
 * `callback_data` (under Telegram's 64 bytes, bound to the rung it names) and which manual changes of a topic make
 * the remembered rung stale.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFallbackReturnCallback,
  checkIsFallbackReturnCurrent,
  checkIsFallbackReturnForgotten,
  decideFallbackReturnAfterSwitch,
  fallbackReturnCallbackRe,
  normaliseFallbackReturn,
} from '../utils/fallbackReturn';
import type { FallbackChainEntry } from '../utils/fallbackChain';

const claudeRung: FallbackChainEntry = { backend: 'claude', profile: 'default', model: 'claude-opus-5-5[1m]' };
const openCodeRung: FallbackChainEntry = { backend: 'opencode', providerId: 'openai', modelId: 'gpt-5' };

describe('normaliseFallbackReturn', () => {
  it('keeps a Claude rung with the model id the session reported (a chain alias pattern would refuse it)', () => {
    assert.deepEqual(normaliseFallbackReturn(claudeRung), claudeRung);
    assert.deepEqual(normaliseFallbackReturn({ backend: 'claude', profile: 'work' }), { backend: 'claude', profile: 'work', model: null });
  });

  it('keeps an OpenCode rung', () => {
    assert.deepEqual(normaliseFallbackReturn(openCodeRung), openCodeRung);
  });

  it('an unusable model becomes «keep the topic\'s model»; an unusable account or shape is no rung at all', () => {
    assert.deepEqual(normaliseFallbackReturn({ backend: 'claude', profile: 'work', model: 42 }), { backend: 'claude', profile: 'work', model: null });
    assert.deepEqual(normaliseFallbackReturn({ backend: 'claude', profile: 'work', model: 'x'.repeat(101) }), { backend: 'claude', profile: 'work', model: null });
    for (const broken of [null, undefined, 'default', 7, {}, { backend: 'claude' }, { backend: 'claude', profile: 'Not A Slug' }, { backend: 'opencode', providerId: 'openai' }, { backend: 'terminal' }]) {
      assert.equal(normaliseFallbackReturn(broken), null, JSON.stringify(broken));
    }
  });
});

describe('the «back» button\'s callback data', () => {
  it('is acct_ret_ + the rung\'s revision, under 64 bytes, and round-trips through its pattern', () => {
    for (const rung of [claudeRung, openCodeRung]) {
      const data = buildFallbackReturnCallback(rung);
      assert.ok(Buffer.byteLength(data) <= 64, data);
      const match = fallbackReturnCallbackRe.exec(data);
      assert.ok(match, data);
      assert.equal(checkIsFallbackReturnCurrent(rung, match[1]), true);
    }
  });

  it('names ONE rung: a tap whose revision is not the remembered rung\'s (another rung, or none) is stale', () => {
    const revision = fallbackReturnCallbackRe.exec(buildFallbackReturnCallback(claudeRung))?.[1] ?? '';
    assert.equal(checkIsFallbackReturnCurrent(openCodeRung, revision), false, 'another rung is remembered now');
    assert.equal(checkIsFallbackReturnCurrent({ ...claudeRung, profile: 'work' }, revision), false);
    assert.equal(checkIsFallbackReturnCurrent(null, revision), false, 'nothing is remembered any more');
    assert.equal(fallbackReturnCallbackRe.test('acct_ret_zzzzzzzz'), false);
    assert.equal(fallbackReturnCallbackRe.test('acct_back'), false);
  });
});

describe('checkIsFallbackReturnForgotten: which manual changes make the remembered rung stale', () => {
  const pick = (outcome: 'inactive' | 'unchanged' | 'respawned' | 'deferred' | 'restartRequired', isClaudeBackend: boolean) =>
    checkIsFallbackReturnForgotten({ kind: 'accountPick', outcome, isClaudeBackend });

  it('an account pick that moves the session — now or when the answer ends — forgets it', () => {
    assert.equal(pick('respawned', true), true);
    assert.equal(pick('deferred', true), true);
    assert.equal(pick('restartRequired', true), true);
  });

  it('a pick on a sleeping Claude topic (taken at the next resume) forgets it; a pick that changed nothing, or only recorded itself on an OpenCode topic, does not', () => {
    assert.equal(pick('inactive', true), true);
    assert.equal(pick('unchanged', true), false);
    assert.equal(pick('inactive', false), false);
  });

  it('any model pick forgets it', () => {
    assert.equal(checkIsFallbackReturnForgotten({ kind: 'modelPick' }), true);
  });

  it('a switch to another agent forgets it; a flip between the two Claude backends (same conversation) does not', () => {
    assert.equal(checkIsFallbackReturnForgotten({ kind: 'backendSwitch', isSameConversation: false }), true);
    assert.equal(checkIsFallbackReturnForgotten({ kind: 'backendSwitch', isSameConversation: true }), false);
  });
});

describe('decideFallbackReturnAfterSwitch: what a limit switch does to the remembered rung', () => {
  const home: FallbackChainEntry = { backend: 'claude', profile: 'default', model: null };
  const fallback: FallbackChainEntry = { backend: 'claude', profile: 'work', model: null };

  it('remembers the rung the topic left', () => {
    assert.deepEqual(decideFallbackReturnAfterSwitch({ remembered: null, from: home, to: fallback }), { action: 'remember', rung: home });
    assert.deepEqual(decideFallbackReturnAfterSwitch({ remembered: openCodeRung, from: home, to: fallback }), { action: 'remember', rung: home }, 'the latest rung left replaces an older one');
  });

  it('forgets it when the switch lands on the remembered rung — the topic is home, the rung it left is a fallback', () => {
    assert.deepEqual(decideFallbackReturnAfterSwitch({ remembered: home, from: fallback, to: home }), { action: 'forget' });
    assert.deepEqual(decideFallbackReturnAfterSwitch({ remembered: home, from: fallback, to: { ...home, model: 'sonnet' } }), { action: 'forget' }, 'the account is what a Claude rung is');
    assert.deepEqual(decideFallbackReturnAfterSwitch({ remembered: openCodeRung, from: home, to: openCodeRung }), { action: 'forget' });
    assert.deepEqual(decideFallbackReturnAfterSwitch({ remembered: home, from: null, to: home }), { action: 'forget' }, 'even when the rung it left is unknown');
  });

  it('keeps what is remembered when the rung the topic left is unknown', () => {
    assert.deepEqual(decideFallbackReturnAfterSwitch({ remembered: home, from: null, to: fallback }), { action: 'keep' });
    assert.deepEqual(decideFallbackReturnAfterSwitch({ remembered: null, from: null, to: fallback }), { action: 'keep' });
  });
});
