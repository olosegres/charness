/**
 * @description The display-mode commands (`connectors/telegram/commands/displayModes.ts`) wired to
 * ports (`commandModuleHarness.ts`: a real telegraf instance against the fake Bot API, the real state
 * store, recording topic sends). Two things are pinned:
 *
 *   • WIRING — which commands and which buttons the module registers, and in which order (a
 *     telegraf `action` earlier in the chain would shadow a later one with an overlapping pattern);
 *   • BEHAVIOUR through that wiring — a typed mode and a button tap persist per topic, a tap
 *     answers its callback and re-renders the picker's keyboard, and a view that turns requests
 *     off closes the topic's open request.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDisplayModes, formatTopicView } from '../connectors/telegram/commands/displayModes';
import { createCommandHarness, harnessThreadId, type CommandHarness } from './commandModuleHarness';

const expectedCommandNames = ['thinking', 'tool_results', 'subagent', 'verbosity'];
const expectedActionPatterns = ['/^think_(.+)$/', '/^toolres_(.+)$/', '/^subag_(.+)$/', '/^verb_(.+)$/', '/^view_(.+)$/'];
const waitStepMs = 25;
const waitTimeoutMs = 10_000;

let harness: CommandHarness;

async function waitUntil(description: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + waitTimeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, waitStepMs));
  }
}

describe('displayModes: the display-mode commands over their ports', () => {
  before(async () => {
    harness = await createCommandHarness();
    const displayModes = createDisplayModes(harness.core);
    displayModes.registerDisplayModeCommands();
    displayModes.registerDisplayModeCallbacks();
  });

  after(async () => {
    await harness.stop();
  });

  it('registers its four commands and its five buttons, in the order the bot has always had', () => {
    assert.deepEqual(harness.registeredCommandNames, expectedCommandNames);
    assert.deepEqual(harness.registeredActionPatterns, expectedActionPatterns);
  });

  it('a typed mode persists per topic and is acknowledged; an unknown word is refused', async () => {
    await harness.runCommand('thinking', 'full');
    assert.equal(harness.state.getDisplayPrefs(harness.key).thinking, 'full');
    assert.match(harness.replies.at(-1)?.text ?? '', /Thinking mode: full/);

    await harness.runCommand('tool_results', 'short');
    assert.equal(harness.state.getDisplayPrefs(harness.key).toolResults, 'short');
    await harness.runCommand('subagent', 'short');
    assert.equal(harness.state.getDisplayPrefs(harness.key).subagent, 'short');

    const repliesBefore = harness.replies.length;
    await harness.runCommand('thinking', 'loud');
    assert.equal(harness.replies.length, repliesBefore + 1);
    assert.match(harness.replies.at(-1)?.text ?? '', /`loud` is not valid/);
    assert.equal(harness.state.getDisplayPrefs(harness.key).thinking, 'full', 'a refused word changes nothing');
  });

  it('/verbosity with a level writes all three preferences; with a view it writes the view', async () => {
    await harness.runCommand('verbosity', 'minimal');
    const prefs = harness.state.getDisplayPrefs(harness.key);
    assert.deepEqual([prefs.thinking, prefs.toolResults, prefs.subagent], ['minimal', 'minimal', 'minimal']);

    await harness.runCommand('verbosity', 'answers');
    assert.equal(harness.state.getDisplayPrefs(harness.key).view, 'answers');
    assert.match(harness.replies.at(-1)?.text ?? '', new RegExp(formatTopicView('answers')));
  });

  it('a tap on a mode button persists it, answers the tap and re-renders the picker with the ✓ moved', async () => {
    const picker = harness.fakeTelegram.pushOperatorMessage(harnessThreadId, 'picker');
    const answersBefore = harness.fakeTelegram.callbackAnswers.length;

    await harness.tapButton(picker, 'think_short');
    assert.equal(harness.state.getDisplayPrefs(harness.key).thinking, 'short');
    assert.equal(harness.fakeTelegram.callbackAnswers.length, answersBefore + 1, 'the tap was answered');
    await waitUntil('the picker keyboard to be re-rendered', () => (harness.fakeTelegram.getMessage(picker)?.reply_markup?.inline_keyboard[0] ?? []).length === 3);
    const labels = harness.fakeTelegram.getMessage(picker)?.reply_markup?.inline_keyboard[0].map((button) => button.text);
    assert.deepEqual(labels, ['minimal', 'short ✓', 'full']);
  });

  it('a tap with an unknown mode is answered as an error and changes nothing', async () => {
    const answersBefore = harness.fakeTelegram.callbackAnswers.length;
    await harness.tapButton(harness.fakeTelegram.pushOperatorMessage(harnessThreadId, 'picker 2'), 'think_loud');
    assert.equal(harness.fakeTelegram.callbackAnswers.length, answersBefore + 1);
    assert.match(harness.fakeTelegram.callbackAnswers.at(-1) ?? '', /^Error:/);
    assert.equal(harness.state.getDisplayPrefs(harness.key).thinking, 'short');
  });

  it('switching the view to the full stream closes the topic\'s open request; a view with requests on does not', async () => {
    const message = harness.fakeTelegram.pushOperatorMessage(harnessThreadId, 'picker 3');

    await harness.tapButton(message, 'view_streamAnswers');
    assert.equal(harness.state.getDisplayPrefs(harness.key).view, 'streamAnswers');
    assert.deepEqual(harness.cancelledRequestKeys, [], 'requests stay on: nothing is cancelled');

    await harness.tapButton(message, 'view_stream');
    assert.equal(harness.state.getDisplayPrefs(harness.key).view, 'stream');
    assert.deepEqual(harness.cancelledRequestKeys, [harness.key]);
  });
});
