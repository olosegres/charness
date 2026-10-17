/**
 * @description The question before a manual switch between the two backends (`connectors/telegram/commands/
 * backendSwitch.ts`) over its ports (`commandModuleHarness.ts`: a real telegraf instance, recording topic sends and
 * edits). Pinned:
 *
 *   • WIRING — the one pattern the two buttons register under;
 *   • the question is posted with ✅ Continue / ✖️ Cancel;
 *   • ✅ Continue makes the switch (target and the typed message reach the port), edits the question into the outcome
 *     and drops the keyboard; ✖️ Cancel changes nothing and drops it too;
 *   • one-shot: a second tap, a question replaced by a newer one, one left in the history after the topic changed
 *     backend, or one the bot knows nothing about (a restart) only says it is out of date;
 *   • a switch that fails is reported in the same message.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBackendSwitch } from '../connectors/telegram/commands/backendSwitch';
import type { BackendFamily, BackendSwitchTarget } from '../utils/backendSwitchPlan';
import { createCommandHarness, type CommandHarness } from './commandModuleHarness';

let harness: CommandHarness;
let currentFamily: BackendFamily | null = 'opencode';
let switchError: Error | null = null;
const switches: Array<{ target: BackendSwitchTarget; userMessage: string | undefined }> = [];
let feature: ReturnType<typeof createBackendSwitch>;

/** What `/claude` asks for: the account the topic follows, not a pick. */
const toClaude: BackendSwitchTarget = { backend: 'claude', profile: 'default', isProfilePicked: false, model: null };
/** What an account tap asks for: a pick the switch records. */
const toPickedClaude: BackendSwitchTarget = { backend: 'claude', profile: 'work', isProfilePicked: true, model: null };
const toOpenCode: BackendSwitchTarget = { backend: 'opencode', modelLabel: 'openai/gpt-5', model: null };

async function ask(request: { from: BackendFamily; target: BackendSwitchTarget; userMessage?: string }): Promise<number> {
  await feature.askBackendSwitch(harness.key, request);
  return harness.replies.at(-1)!.messageId!;
}

describe('backendSwitch: the question over its ports', () => {
  before(async () => {
    harness = await createCommandHarness();
    feature = createBackendSwitch({
      ...harness.core,
      getCurrentFamily: () => currentFamily,
      performBackendSwitch: async (_key, target, options) => {
        switches.push({ target, userMessage: options.userMessage });
        if (switchError) throw switchError;
      },
    });
    feature.registerBackendSwitchCallbacks();
  });

  after(async () => {
    await harness.stop();
  });

  it('registers its two buttons under one pattern', () => {
    assert.deepEqual(harness.registeredActionPatterns, [String(/^bsw_(ok|no)$/)]);
  });

  it('posts the question with ✅ Continue and ✖️ Cancel', async () => {
    const messageId = await ask({ from: 'opencode', target: toClaude });
    const question = harness.replies.at(-1);
    assert.equal(question?.messageId, messageId);
    assert.equal(question?.text, '🔁 Switch this topic from OpenCode to Claude «default»?\nThe conversation context will be handed over in compacted form.');
    assert.deepEqual(harness.getKeyboardLabels(question), [['✅ Continue', '✖️ Cancel']]);
    assert.deepEqual(harness.getKeyboardData(question), [['bsw_ok', 'bsw_no']]);
  });

  it('✅ Continue makes the switch with its target and the typed message, then edits the question into the outcome with no keyboard', async () => {
    currentFamily = 'claude';
    switches.length = 0;
    const messageId = await ask({ from: 'claude', target: toOpenCode, userMessage: 'fix the flaky test' });
    await harness.tapButton(messageId, 'bsw_ok');
    assert.deepEqual(switches, [{ target: toOpenCode, userMessage: 'fix the flaky test' }]);
    const edits = harness.edits.filter((edit) => edit.messageId === messageId);
    assert.deepEqual(edits.map((edit) => edit.text), ['🔁 Switching this topic to OpenCode openai/gpt-5…', '🔁 Switched this topic to OpenCode openai/gpt-5.']);
    for (const edit of edits) assert.deepEqual(harness.getKeyboardData(edit), [], 'the keyboard is consumed');
  });

  it('a second tap on the same question only says it is out of date and switches nothing more', async () => {
    currentFamily = 'opencode';
    switches.length = 0;
    const messageId = await ask({ from: 'opencode', target: toClaude });
    await harness.tapButton(messageId, 'bsw_ok');
    await harness.tapButton(messageId, 'bsw_ok');
    assert.equal(switches.length, 1);
    assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), 'This question is out of date — nothing was switched.');
  });

  it('✖️ Cancel changes nothing, names where the topic stays and drops the keyboard', async () => {
    currentFamily = 'opencode';
    switches.length = 0;
    const messageId = await ask({ from: 'opencode', target: toClaude });
    await harness.tapButton(messageId, 'bsw_no');
    assert.equal(switches.length, 0);
    const edit = harness.edits.filter((candidate) => candidate.messageId === messageId).at(-1);
    assert.equal(edit?.text, '✖️ Cancelled — this topic stays on OpenCode.');
    assert.deepEqual(harness.getKeyboardData(edit), []);
    await harness.tapButton(messageId, 'bsw_ok');
    assert.equal(switches.length, 0, 'a cancelled question cannot be continued');
  });

  it('a newer question retires the older one of the topic', async () => {
    currentFamily = 'opencode';
    switches.length = 0;
    const older = await ask({ from: 'opencode', target: toClaude });
    const newer = await ask({ from: 'opencode', target: toPickedClaude });
    await harness.tapButton(older, 'bsw_ok');
    assert.equal(switches.length, 0, 'the older keyboard is out of date');
    await harness.tapButton(newer, 'bsw_ok');
    assert.deepEqual(switches.map((entry) => entry.target), [toPickedClaude], 'the picked account reaches the switch as a pick');
  });

  it('a tap from ANOTHER chat on the same message id neither acts on nor deletes this chat\'s question', async () => {
    currentFamily = 'opencode';
    switches.length = 0;
    const messageId = await ask({ from: 'opencode', target: toPickedClaude });
    await harness.asForeignChat(() => harness.tapButton(messageId, 'bsw_ok'));
    assert.equal(switches.length, 0, 'the other chat has no such question');
    assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), 'This question is out of date — nothing was switched.');
    await harness.tapButton(messageId, 'bsw_ok');
    assert.deepEqual(switches.map((entry) => entry.target), [toPickedClaude], 'this chat\'s question is still there');
  });

  it('a question left in the history after the topic changed backend by other means is out of date', async () => {
    currentFamily = 'opencode';
    switches.length = 0;
    const messageId = await ask({ from: 'opencode', target: toClaude });
    currentFamily = 'claude'; // the operator typed /claude meanwhile (and confirmed another question, say)
    await harness.tapButton(messageId, 'bsw_ok');
    assert.equal(switches.length, 0);
    currentFamily = 'opencode';
  });

  it('a tap on a message the bot has no question for (an old keyboard, a restart) is out of date', async () => {
    switches.length = 0;
    await harness.tapButton(98765, 'bsw_ok');
    assert.equal(switches.length, 0);
    assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), 'This question is out of date — nothing was switched.');
  });

  it('a switch that fails is reported in the same message', async () => {
    currentFamily = 'opencode';
    switchError = new Error('the OpenCode server is down');
    try {
      const messageId = await ask({ from: 'opencode', target: toClaude });
      await harness.tapButton(messageId, 'bsw_ok');
      const last = harness.edits.filter((edit) => edit.messageId === messageId).at(-1);
      assert.equal(last?.text, '⚠️ Switching to Claude «default» failed: the OpenCode server is down');
    } finally {
      switchError = null;
    }
  });
});
