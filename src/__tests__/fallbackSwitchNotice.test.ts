/**
 * @description The notices a usage-limit switch posts (`utils/fallbackSwitchNotice.ts`), pinned in English and in every
 * other locale. The wording rules:
 *
 *   • one short sentence: WHAT hit its limit, WHERE the topic continues, when the limit resets, the switch-back
 *     command — and every name once (a label never appears twice);
 *   • a Claude account is «name»; the model appears only when the switch CHANGES it (an alias against the running
 *     id is the same model: `opus` against `claude-opus-5-5[1m]`);
 *   • an OpenCode rung says `OpenCode provider/model`, a Claude rung reached from another backend `Claude «name»`;
 *   • the switch-back command is `/accounts` in every case — never `/model`, `/claude` or `/opencode`, which move
 *     the topic somewhere else;
 *   • an unknown reset drops the reset clause and keeps the command;
 *   • the deferred notice names the move that waits for the end of the answer.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { localeCodes, runWithLocale, type Locale } from '../i18n';
import { buildFallbackDeferredNotice, buildFallbackSwitchedNotice } from '../utils/fallbackSwitchNotice';
import { getFallbackModelToPin, type FallbackChainEntry } from '../utils/fallbackChain';

const claude = (profile: string, model: string | null = null): Extract<FallbackChainEntry, { backend: 'claude' }> => ({ backend: 'claude', profile, model });
const openCode = (providerId: string, modelId: string): FallbackChainEntry => ({ backend: 'opencode', providerId, modelId });

const resetTime = '2026-10-18 01:00';
/** What the running session reports: the full id, not the alias the chain keeps. */
const runningOpus = 'claude-opus-5-5[1m]';

describe('buildFallbackSwitchedNotice (English)', () => {
  it('Claude → Claude: the account that hit the limit, the account the topic continues on, the reset and /accounts', () => {
    assert.equal(
      buildFallbackSwitchedNotice({ from: claude('default', runningOpus), to: claude('work', 'opus'), resetTime, runningModel: runningOpus }),
      '🔁 Account «default» hit its usage limit — this topic continues on «work». The limit resets 2026-10-18 01:00; switch back: /accounts',
    );
  });

  it('names the model only when the switch changes it: `opus` against the running `claude-opus-5-5[1m]` is not a change', () => {
    const from = claude('default', runningOpus);
    const sameModel = buildFallbackSwitchedNotice({ from, to: claude('work', 'opus'), resetTime, runningModel: runningOpus });
    assert.ok(!sameModel.includes('(opus)'), sameModel);
    const otherModel = buildFallbackSwitchedNotice({ from, to: claude('work', 'sonnet'), resetTime, runningModel: runningOpus });
    assert.equal(
      otherModel,
      '🔁 Account «default» hit its usage limit — this topic continues on «work» (sonnet). The limit resets 2026-10-18 01:00; switch back: /accounts',
    );
  });

  it('a rung that keeps the topic\'s model, or a session whose model is unknown, never invents one', () => {
    const from = claude('default');
    assert.ok(!buildFallbackSwitchedNotice({ from, to: claude('work'), resetTime, runningModel: runningOpus }).includes('('));
    // Unknown running model: the rung's pin WILL be applied (nothing says the session already runs it), so it is named.
    assert.ok(buildFallbackSwitchedNotice({ from, to: claude('work', 'sonnet'), resetTime, runningModel: null }).includes('«work» (sonnet)'));
  });

  it('reset unknown: the reset clause is dropped, the switch-back command stays', () => {
    assert.equal(
      buildFallbackSwitchedNotice({ from: claude('default'), to: claude('work'), resetTime: null, runningModel: runningOpus }),
      '🔁 Account «default» hit its usage limit — this topic continues on «work». Switch back: /accounts',
    );
  });

  it('Claude → OpenCode: the target says OpenCode and its model', () => {
    assert.equal(
      buildFallbackSwitchedNotice({ from: claude('default'), to: openCode('openai', 'gpt-5'), resetTime, runningModel: runningOpus }),
      '🔁 Account «default» hit its usage limit — this topic continues on OpenCode openai/gpt-5. The limit resets 2026-10-18 01:00; switch back: /accounts',
    );
  });

  it('OpenCode → OpenCode: the model that hit the limit, the model the topic continues on', () => {
    assert.equal(
      buildFallbackSwitchedNotice({ from: openCode('openai', 'gpt-5'), to: openCode('google', 'gemini-2.5-pro'), resetTime: null, runningModel: null }),
      '🔁 Model «openai/gpt-5» hit its usage limit — this topic continues on OpenCode google/gemini-2.5-pro. Switch back: /accounts',
    );
  });

  it('OpenCode → Claude: with no account on the left the target says Claude, and a pinned model is named', () => {
    assert.equal(
      buildFallbackSwitchedNotice({ from: openCode('openai', 'gpt-5'), to: claude('work', 'opus'), resetTime, runningModel: null }),
      '🔁 Model «openai/gpt-5» hit its usage limit — this topic continues on Claude «work» (opus). The limit resets 2026-10-18 01:00; switch back: /accounts',
    );
  });

  it('the rung that hit the limit is unknown: a plain limit sentence, still the target and the command', () => {
    assert.equal(
      buildFallbackSwitchedNotice({ from: null, to: claude('work'), resetTime: null, runningModel: null }),
      '🔁 A usage limit was reached — this topic continues on Claude «work». Switch back: /accounts',
    );
  });
});

describe('buildFallbackDeferredNotice (English)', () => {
  it('the move waits for the end of the current answer; no reset, no model, no command', () => {
    assert.equal(
      buildFallbackDeferredNotice(claude('default', runningOpus), claude('work', 'sonnet')),
      '🔁 Account «default» hit its usage limit — this topic moves to «work» when the current answer ends.',
    );
  });
});

describe('getFallbackModelToPin', () => {
  it('an alias is the running model when the running id contains it (case-insensitive)', () => {
    assert.equal(getFallbackModelToPin(claude('work', 'opus'), runningOpus), null);
    assert.equal(getFallbackModelToPin(claude('work', 'Fable'), 'claude-fable-5-1'), null);
  });

  it('pins a different alias, and one the session cannot be shown to run', () => {
    assert.equal(getFallbackModelToPin(claude('work', 'sonnet'), runningOpus), 'sonnet');
    assert.equal(getFallbackModelToPin(claude('work', 'opus'), null), 'opus');
  });

  it('pins nothing for a rung without a model and for an OpenCode rung', () => {
    assert.equal(getFallbackModelToPin(claude('work'), runningOpus), null);
    assert.equal(getFallbackModelToPin(openCode('openai', 'gpt-5'), null), null);
  });
});

type SwitchedNoticeInput = Parameters<typeof buildFallbackSwitchedNotice>[0];

/** Every case once, with the names each must write exactly once. */
const noticeCases: Array<{ name: string; input: SwitchedNoticeInput; names: string[] }> = [
  { name: 'claude → claude, reset', input: { from: claude('default'), to: claude('work', 'sonnet'), resetTime, runningModel: runningOpus }, names: ['«default»', '«work»', 'sonnet'] },
  { name: 'claude → claude, no reset', input: { from: claude('default'), to: claude('work', 'sonnet'), resetTime: null, runningModel: runningOpus }, names: ['«default»', '«work»', 'sonnet'] },
  { name: 'claude → opencode', input: { from: claude('default'), to: openCode('openai', 'gpt-5'), resetTime, runningModel: runningOpus }, names: ['«default»', 'OpenCode openai/gpt-5'] },
  { name: 'opencode → opencode', input: { from: openCode('openai', 'gpt-5'), to: openCode('google', 'gemini-2.5-pro'), resetTime: null, runningModel: null }, names: ['«openai/gpt-5»', 'OpenCode google/gemini-2.5-pro'] },
  { name: 'opencode → claude', input: { from: openCode('openai', 'gpt-5'), to: claude('work', 'opus'), resetTime, runningModel: null }, names: ['«openai/gpt-5»', 'Claude «work»', 'opus'] },
  { name: 'unknown source', input: { from: null, to: claude('work'), resetTime: null, runningModel: null }, names: ['Claude «work»'] },
];

const countOccurrences = (text: string, part: string): number => text.split(part).length - 1;

for (const locale of localeCodes) {
  describe(`every notice in ${locale}`, () => {
    const run = <T>(fn: () => T): T => runWithLocale(locale as Locale, fn);

    it('writes every name once, the switch-back command /accounts and no other command, and no placeholder is left', () => {
      for (const { name, input, names } of noticeCases) {
        const text = run(() => buildFallbackSwitchedNotice(input));
        for (const part of names) assert.equal(countOccurrences(text, part), 1, `${name}: «${part}» once in ${text}`);
        assert.ok(text.includes('/accounts'), `${name}: names /accounts in ${text}`);
        for (const other of ['/model', '/claude', '/opencode']) assert.ok(!text.includes(other), `${name}: no ${other} in ${text}`);
        assert.equal(text.includes(resetTime), input.resetTime !== null, `${name}: the reset time appears exactly when it is known: ${text}`);
        assert.ok(!/\{\w+\}/.test(text), `${name}: no unresolved placeholder in ${text}`);
        assert.ok(!text.includes('?'), `${name}: no unknown-label question mark in ${text}`);
      }
    });

    it('the deferred notice names both accounts once and promises no model, reset or command', () => {
      const text = run(() => buildFallbackDeferredNotice(claude('default'), claude('work', 'sonnet')));
      assert.equal(countOccurrences(text, '«default»'), 1, text);
      assert.equal(countOccurrences(text, '«work»'), 1, text);
      assert.ok(!text.includes('sonnet') && !text.includes('/accounts') && !/\{\w+\}/.test(text), text);
    });
  });
}
