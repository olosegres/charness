/**
 * @description The pure side of a manual switch between the two agent backends (`utils/backendSwitchPlan.ts`): which
 * switches ask first (the other backend, with a conversation to hand over — nothing else does), how the question is
 * worded in English and that the hand-over sentence is ONE shared line in every language, and the question's two
 * buttons' data.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { localeCodes, runWithLocale, type Locale } from '../i18n';
import {
  backendSwitchCallbackRe,
  backendSwitchCancelCallback,
  backendSwitchContinueCallback,
  buildBackendSwitchQuestion,
  checkNeedsBackendSwitchConfirmation,
  formatBackendSwitchBridgeLabel,
  formatBackendSwitchTarget,
  getBackendFamily,
  getBackendSwitchModelToPin,
} from '../utils/backendSwitchPlan';
import { claudeJsonStreamAdapterName, claudePerTurnAdapterName, openCodeAdapterName } from '../adapters/adapterNames';

const handoverLine = 'The conversation context will be handed over in compacted form.';

describe('getBackendFamily', () => {
  it('knows the Claude backends, OpenCode, and nothing else', () => {
    assert.equal(getBackendFamily('claude'), 'claude');
    assert.equal(getBackendFamily(claudeJsonStreamAdapterName), 'claude');
    assert.equal(getBackendFamily(claudePerTurnAdapterName), 'claude');
    assert.equal(getBackendFamily(openCodeAdapterName), 'opencode');
    assert.equal(getBackendFamily('terminal'), null);
    assert.equal(getBackendFamily(undefined), null);
  });
});

describe('checkNeedsBackendSwitchConfirmation', () => {
  const needs = (currentAdapterName: string | undefined, targetBackend: 'claude' | 'opencode', hasConversation: boolean) =>
    checkNeedsBackendSwitchConfirmation({ currentAdapterName, targetBackend, hasConversation });

  it('asks for the other backend when the current one holds a conversation, in both directions', () => {
    assert.equal(needs(openCodeAdapterName, 'claude', true), true);
    assert.equal(needs(claudeJsonStreamAdapterName, 'opencode', true), true);
    assert.equal(needs('claude', 'opencode', true), true, 'the tmux Claude backend too');
  });

  it('does not ask without a conversation (a fresh topic, nothing to carry), for the same backend, or for a shell / no agent', () => {
    assert.equal(needs(openCodeAdapterName, 'claude', false), false);
    assert.equal(needs(claudeJsonStreamAdapterName, 'claude', true), false, 'a flip between Claude backends is no hand-over');
    assert.equal(needs(openCodeAdapterName, 'opencode', true), false);
    assert.equal(needs('terminal', 'claude', true), false);
    assert.equal(needs(undefined, 'opencode', true), false);
  });
});

describe('the question (English)', () => {
  it('OpenCode → Claude names the account; Claude → OpenCode names the model; an unknown model is just OpenCode', () => {
    assert.equal(
      buildBackendSwitchQuestion({ from: 'opencode', target: { backend: 'claude', profile: 'default', isProfilePicked: false, model: null } }),
      `🔁 Switch this topic from OpenCode to Claude «default»?\n${handoverLine}`,
    );
    assert.equal(
      buildBackendSwitchQuestion({ from: 'claude', target: { backend: 'opencode', modelLabel: 'openai/gpt-5', model: null } }),
      `🔁 Switch this topic from Claude to OpenCode openai/gpt-5?\n${handoverLine}`,
    );
    assert.equal(
      buildBackendSwitchQuestion({ from: 'claude', target: { backend: 'opencode', modelLabel: null, model: null } }),
      `🔁 Switch this topic from Claude to OpenCode?\n${handoverLine}`,
    );
  });

  it('the buttons\' data is constant and matches the one pattern', () => {
    assert.equal(backendSwitchContinueCallback, 'bsw_ok');
    assert.equal(backendSwitchCancelCallback, 'bsw_no');
    assert.ok(backendSwitchCallbackRe.test('bsw_ok') && backendSwitchCallbackRe.test('bsw_no'));
    assert.ok(!backendSwitchCallbackRe.test('bsw_ok_1'));
  });
});

describe('a target that names a model', () => {
  const pickedClaude = { backend: 'claude', profile: 'work', isProfilePicked: true, model: 'sonnet' } as const;
  const pickedOpenCode = { backend: 'opencode', modelLabel: 'openrouter/gpt-5-mini', model: { providerId: 'openrouter', modelId: 'gpt-5-mini' } } as const;

  it('the question names the Claude model after the account and the OpenCode model by its label', () => {
    assert.equal(formatBackendSwitchTarget(pickedClaude), 'Claude «work» (sonnet)');
    assert.equal(
      buildBackendSwitchQuestion({ from: 'claude', target: pickedOpenCode }),
      `🔁 Switch this topic from Claude to OpenCode openrouter/gpt-5-mini?\n${handoverLine}`,
    );
  });

  it('the context bridge names the model the same way a chain rung is labelled', () => {
    assert.equal(formatBackendSwitchBridgeLabel(pickedClaude), 'Claude · work · sonnet');
    assert.equal(formatBackendSwitchBridgeLabel(pickedOpenCode), 'OpenCode · openrouter/gpt-5-mini');
    assert.equal(formatBackendSwitchBridgeLabel({ backend: 'claude', profile: 'work', isProfilePicked: true, model: null }), 'Claude · work');
  });

  it('the switch pins a picked model after the move and leaves a model nobody picked alone', () => {
    assert.equal(getBackendSwitchModelToPin(pickedClaude), 'sonnet');
    assert.equal(getBackendSwitchModelToPin(pickedOpenCode), 'openrouter/gpt-5-mini');
    assert.equal(getBackendSwitchModelToPin({ backend: 'claude', profile: 'work', isProfilePicked: false, model: null }), null);
    assert.equal(getBackendSwitchModelToPin({ backend: 'opencode', modelLabel: 'openai/gpt-5', model: null }), null, 'a label for the question only: nothing to pin');
  });
});

for (const locale of localeCodes) {
  describe(`the question in ${locale}`, () => {
    it('names both sides once, carries the shared hand-over line and has no placeholder left', () => {
      const text = runWithLocale(locale as Locale, () => buildBackendSwitchQuestion({ from: 'opencode', target: { backend: 'claude', profile: 'default', isProfilePicked: false, model: null } }));
      assert.equal(text.split('«default»').length - 1, 1, text);
      assert.ok(text.includes('OpenCode') && text.includes('Claude'), text);
      assert.ok(!/\{\w+\}/.test(text), text);
      const note = runWithLocale(locale as Locale, () => formatBackendSwitchTarget({ backend: 'opencode', modelLabel: null, model: null }));
      assert.equal(note, 'OpenCode');
    });
  });
}

describe('the hand-over line is one shared text', () => {
  it('Russian reads «Контекст разговора будет передан в сжатом виде.»', () => {
    const text = runWithLocale('ru', () => buildBackendSwitchQuestion({ from: 'opencode', target: { backend: 'claude', profile: 'default', isProfilePicked: false, model: null } }));
    assert.ok(text.endsWith('\nКонтекст разговора будет передан в сжатом виде.'), text);
  });
});
