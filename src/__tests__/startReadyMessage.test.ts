/**
 * @description The capability gate behind one-tap start + the unified typing
 * loader: `getStartReadyMessage` is the pure decision extracted from
 * `startAgentSession`, deciding whether the bot posts a "ready" notice after a
 * session comes up.
 *
 * Load-bearing facts proven here (against the REAL adapter instances, so the
 * `selfGreetsOnStart` flag wiring itself is under test — not a stand-in):
 *   • a self-greeting agent (Claude) → returns `''`: NO `agent.ready` notice,
 *     because the TUI prints its own banner and the typing loader covers the gap.
 *   • OpenCode (HTTP, never self-greets) → returns the generic `agent.ready`
 *     text — without it the user would have no cue the session is up.
 *   • terminal (a bare shell, never self-greets) → returns the shell-specific
 *     `terminal.ready` text, NOT `agent.ready`.
 *   • the `subdir` / `args` interpolation rides through for the non-suppressed
 *     backends.
 *
 * Plus the info block the notice now carries (model + effort + the `/effort`
 * pointer), since "ready" alone named neither of the two settings that decide
 * cost and quality:
 *   • both values known → a model row AND the shared `effort.current_hint` block;
 *   • model unknown → the row still renders, carrying the `model.current_default`
 *     text (the same "default" marker `/status` and `/model` show);
 *   • effort null (a backend with no effort concept) → no effort line at all;
 *   • BOTH null → the block collapses to empty and the notice is byte-identical
 *     to its pre-block text — the regression anchor against a stray blank line.
 *
 * Comparing against the real `t(...)` output (not a hardcoded string) keeps the
 * test locale-independent: it asserts the SAME key+vars the helper resolves.
 *
 * `./startReadyMessage.testSetup` is imported FIRST so `bot.ts`'s boot-time
 * `parseEnv()` finds a token + a valid `WORK_ROOT` before the module evaluates.
 */
import './startReadyMessage.testSetup';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getStartReadyMessage } from '../bot';
import { ClaudeCliAdapter } from '../adapters/claudeCliAdapter';
import { OpenCodeAdapter } from '../adapters/openCodeAdapter';
import { TerminalAdapter } from '../adapters/terminalAdapter';
import { t } from '../i18n';
import { type AgentAdapter } from '../types';

const subdir = 'myProject';
const model = 'anthropic/claude-opus-4-8';
const effort = 'xhigh';

describe('getStartReadyMessage — self-greeting gate', () => {
  it('Claude (self-greeting) → empty string, no ready notice', () => {
    const adapter = new ClaudeCliAdapter();
    assert.equal(adapter.selfGreetsOnStart, true, 'precondition: Claude self-greets');
    assert.equal(
      getStartReadyMessage(adapter, subdir, undefined, model, effort),
      '',
      'a self-greeting agent must NOT get a bot ready notice (its own banner covers it)',
    );
    // Neither args nor a resolved model/effort may resurrect a notice here.
    assert.equal(getStartReadyMessage(adapter, subdir, 'refactor src/bot.ts', model, effort), '');
  });

  it('OpenCode (no self-greet) → the generic agent.ready text', () => {
    const adapter: AgentAdapter = new OpenCodeAdapter();
    assert.notEqual(adapter.selfGreetsOnStart, true, 'precondition: OpenCode does NOT self-greet');
    assert.equal(
      getStartReadyMessage(adapter, subdir, undefined, null, null),
      t('agent.ready', { label: adapter.label, subdir, argsSuffix: '', infoBlock: '' }),
      'OpenCode must keep its ready notice — nothing else greets the user',
    );
  });

  it('terminal (no self-greet) → the shell-specific terminal.ready text', () => {
    const adapter: AgentAdapter = new TerminalAdapter();
    assert.notEqual(adapter.selfGreetsOnStart, true, 'precondition: terminal does NOT self-greet');
    // A shell has neither a model nor an effort level, so the caller passes
    // nulls — but even if it did not, terminal.ready carries no info block.
    const message = getStartReadyMessage(adapter, subdir, undefined, model, effort);
    assert.equal(
      message,
      t('terminal.ready', { label: adapter.label, subdir, argsSuffix: '' }),
      'terminal must use its own ready copy',
    );
    assert.notEqual(
      message,
      t('agent.ready', { label: adapter.label, subdir, argsSuffix: '', infoBlock: '' }),
      'terminal must NOT fall back to the generic agent.ready',
    );
    assert.ok(!message.includes(model), 'a shell has no model — it must not be named');
    assert.ok(!message.includes('/effort'), 'a shell has no effort level — no /effort pointer');
  });

  it('non-self-greeting backends interpolate subdir + args into the notice', () => {
    const adapter = new OpenCodeAdapter();
    const message = getStartReadyMessage(adapter, subdir, 'fix the bug', null, null);
    assert.equal(
      message,
      t('agent.ready', { label: adapter.label, subdir, argsSuffix: ' (fix the bug)', infoBlock: '' }),
    );
    assert.ok(message.includes(subdir), 'the bound subdir must appear in the ready notice');
    assert.ok(message.includes('fix the bug'), 'the start args must appear in the ready notice');
  });
});

describe('getStartReadyMessage — model + effort info block', () => {
  const adapter = new OpenCodeAdapter();

  it('model + effort both known → both rows, above the closing line', () => {
    const message = getStartReadyMessage(adapter, subdir, undefined, model, effort);
    assert.equal(
      message,
      t('agent.ready', {
        label: adapter.label,
        subdir,
        argsSuffix: '',
        infoBlock: `${t('agent.ready_model', { model })}\n${t('effort.current_hint', { effort })}\n`,
      }),
    );
    // Load-bearing: the three facts the user asked the notice to carry.
    assert.ok(message.includes(model), `expected the model in "${message}"`);
    assert.ok(message.includes(effort), `expected the effort in "${message}"`);
    assert.ok(message.includes('/effort'), 'the notice must point at /effort to change the level');
  });

  it('model unknown → the row still renders, using the model.current_default text', () => {
    const message = getStartReadyMessage(adapter, subdir, undefined, null, effort);
    assert.equal(
      message,
      t('agent.ready', {
        label: adapter.label,
        subdir,
        argsSuffix: '',
        infoBlock: `${t('agent.ready_model', { model: t('model.current_default') })}\n${t('effort.current_hint', { effort })}\n`,
      }),
    );
    assert.ok(
      message.includes(t('model.current_default')),
      'an unknown model must degrade to the same "default" marker /status and /model show',
    );
  });

  it('effort null (backend without an effort concept) → no effort line, model row kept', () => {
    const message = getStartReadyMessage(adapter, subdir, undefined, model, null);
    assert.equal(
      message,
      t('agent.ready', {
        label: adapter.label,
        subdir,
        argsSuffix: '',
        infoBlock: `${t('agent.ready_model', { model })}\n`,
      }),
    );
    assert.ok(message.includes(model), 'the model row survives without an effort level');
    assert.ok(!message.includes('/effort'), 'no effort level ⇒ no /effort pointer');
  });

  it('both absent → the pre-block text, no stray blank line', () => {
    const message = getStartReadyMessage(adapter, subdir, undefined, null, null);
    // The regression anchor: with nothing to report the notice must be
    // byte-identical to how it read before the block existed.
    assert.equal(
      message,
      `${adapter.label} ready in \`${subdir}\`\nSend a message:`,
    );
    assert.ok(!message.includes('\n\n'), 'an empty info block must not leave a blank line');
  });

  it('no rendered notice ever leaks an unsubstituted placeholder', () => {
    const cases: Array<[string | null, string | null]> = [
      [model, effort],
      [null, effort],
      [model, null],
      [null, null],
    ];
    for (const [caseModel, caseEffort] of cases) {
      const message = getStartReadyMessage(adapter, subdir, 'do it', caseModel, caseEffort);
      for (const placeholder of ['{infoBlock}', '{model}', '{effort}', '{label}', '{subdir}', '{argsSuffix}']) {
        assert.ok(
          !message.includes(placeholder),
          `placeholder ${placeholder} not substituted for model=${caseModel} effort=${caseEffort}: "${message}"`,
        );
      }
    }
  });
});
