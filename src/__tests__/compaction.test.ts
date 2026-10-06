/**
 * @description The compaction flow (`connectors/telegram/commands/compaction.ts`) wired to ports
 * (`commandModuleHarness.ts`: a real telegraf instance against the fake Bot API, the real state store,
 * recording topic sends). The default Claude backend has no running session here, so what is pinned is what
 * needs none:
 *
 *   • WIRING — the three commands and the six buttons the module registers, in order;
 *   • the compact-on-idle switch as the General topic uses it — the instance-wide default: the picker, the
 *     typed form, a button tap that persists, answers and re-renders the ✓;
 *   • the picker's summary row — the same `/compact_summary` setting, OFF until turned on;
 *   • a regular topic without a session is told the switch needs one, and the hooks the bot's prompt and
 *     output paths call are harmless on such a topic.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCompaction } from '../connectors/telegram/commands/compaction';
import { keyToString } from '../sessionKey';
import { createCommandHarness, harnessThreadId, type CommandHarness } from './commandModuleHarness';

const waitStepMs = 25;
const waitTimeoutMs = 10_000;

let harness: CommandHarness;
let compaction: ReturnType<typeof createCompaction>;
/** Whether the topic under test is General — the instance-wide switch — or a regular topic. */
let isGeneralTopic = false;

async function waitUntil(description: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + waitTimeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, waitStepMs));
  }
}

describe('compaction: the compaction flow over its ports', () => {
  before(async () => {
    harness = await createCommandHarness();
    compaction = createCompaction({
      ...harness.core,
      checkIsGeneral: () => isGeneralTopic,
      startTypingLoader: () => {},
      forwardPromptToAgent: async () => {},
      pendingQuestions: new Map(),
      clearPendingQuestion: () => {},
      idleWindowMs: 55 * 60 * 1000,
      checkIsLimitWaitArmed: () => false,
      suspendThreadSession: async () => {},
      resumeSleepingSessionForCompaction: async () => false,
    });
    compaction.registerCompactionCommands();
    compaction.registerCompactionCallbacks();
  });

  after(async () => {
    await harness.stop();
  });

  it('registers /compact /compact_on_idle /compact_summary and the six switch buttons, in order', () => {
    assert.deepEqual(harness.registeredCommandNames, ['compact', 'compact_on_idle', 'compact_summary']);
    assert.deepEqual(harness.registeredActionPatterns, ['coi_on', 'coi_off', 'coi_sum_on', 'coi_sum_off', 'csum_on', 'csum_off']);
  });

  it('a regular topic without a session is told the switch needs one', async () => {
    await harness.runCommand('compact_on_idle');
    assert.match(harness.replies.at(-1)?.text ?? '', /active agent session/);
    assert.deepEqual(harness.getKeyboardData(harness.replies.at(-1)), [], 'no picker for a switch that cannot apply');
  });

  it('in General the bare command shows the instance-wide switch and the summary row', async () => {
    isGeneralTopic = true;
    await harness.runCommand('compact_on_idle');
    const picker = harness.replies.at(-1);
    assert.deepEqual(harness.getKeyboardData(picker), [['coi_on', 'coi_off'], ['coi_sum_on', 'coi_sum_off']]);
    assert.match(picker?.text ?? '', /: ON\n/, 'the instance-wide default is on until somebody turns it off');
    assert.match(picker?.text ?? '', /Summary after a compaction: OFF/, 'the summary is off until somebody turns it on');
    const markup = (picker?.extra as { reply_markup?: { inline_keyboard: Array<Array<{ text: string }>> } } | undefined)?.reply_markup;
    assert.ok(markup?.inline_keyboard[1]?.[1]?.text.endsWith('✓'), 'the ✓ sits on «Hide summary»');
  });

  it('in General a tap on the summary row sets the same switch /compact_summary shows', async () => {
    const picker = harness.fakeTelegram.pushOperatorMessage(harnessThreadId, 'idle picker');
    await harness.tapButton(picker, 'coi_sum_on');
    assert.equal(harness.state.getCompactSummaryGlobalDefault(), true);
    assert.match(harness.replies.at(-1)?.text ?? '', /Compaction summary: ON for ALL topics/);
    await waitUntil('both picker rows to be re-rendered', () => {
      const rows = harness.fakeTelegram.getMessage(picker)?.reply_markup?.inline_keyboard ?? [];
      return rows.length === 2 && (rows[1]?.[0]?.text.endsWith('✓') ?? false);
    });

    await harness.tapButton(picker, 'coi_sum_off');
    assert.equal(harness.state.getCompactSummaryGlobalDefault(), false);
  });

  it('in General the typed form persists the instance-wide default', async () => {
    await harness.runCommand('compact_on_idle', 'off');
    assert.equal(harness.state.getCompactOnIdleGlobalDefault(), false);
    await harness.runCommand('compact_on_idle', 'on');
    assert.equal(harness.state.getCompactOnIdleGlobalDefault(), true);
    await harness.runCommand('compact_on_idle', 'off');
    assert.equal(harness.state.getCompactOnIdleGlobalDefault(), false);
  });

  it('in General a tap on «Enable» persists the default, answers the tap and re-renders the picker', async () => {
    const picker = harness.fakeTelegram.pushOperatorMessage(harnessThreadId, 'picker');
    const answersBefore = harness.fakeTelegram.callbackAnswers.length;
    await harness.tapButton(picker, 'coi_on');
    assert.equal(harness.fakeTelegram.callbackAnswers.length, answersBefore + 1, 'the tap was answered');
    assert.equal(harness.state.getCompactOnIdleGlobalDefault(), true);
    await waitUntil('the picker keyboard to be re-rendered', () => (harness.fakeTelegram.getMessage(picker)?.reply_markup?.inline_keyboard[0] ?? []).length === 2);

    await harness.tapButton(picker, 'coi_off');
    assert.equal(harness.state.getCompactOnIdleGlobalDefault(), false);
  });

  it('in a regular topic a tap sets that topic\'s own switch and leaves the default alone', async () => {
    isGeneralTopic = false;
    const picker = harness.fakeTelegram.pushOperatorMessage(harnessThreadId, 'picker 2');
    await harness.tapButton(picker, 'coi_on');
    assert.equal(harness.state.checkIsCompactOnIdleEnabled(harness.key), true, 'this topic\'s override is on');
    assert.equal(harness.state.getCompactOnIdleGlobalDefault(), false, 'the instance-wide default is untouched');
    assert.match(harness.replies.at(-1)?.text ?? '', /this topic/i);

    await harness.tapButton(picker, 'coi_off');
    assert.equal(harness.state.checkIsCompactOnIdleEnabled(harness.key), false);
  });

  it('in General /compact_summary shows the instance-wide switch, and its typed form and buttons persist it', async () => {
    isGeneralTopic = true;
    await harness.runCommand('compact_summary');
    const picker = harness.replies.at(-1);
    assert.deepEqual(harness.getKeyboardData(picker), [['csum_on', 'csum_off']]);
    assert.match(picker?.text ?? '', /\bOFF\b/, 'the summary post is off until somebody turns it on');

    await harness.runCommand('compact_summary', 'on');
    assert.equal(harness.state.getCompactSummaryGlobalDefault(), true);

    const pickerMessage = harness.fakeTelegram.pushOperatorMessage(harnessThreadId, 'summary picker');
    await harness.tapButton(pickerMessage, 'csum_off');
    assert.equal(harness.state.getCompactSummaryGlobalDefault(), false);
    await waitUntil('the summary picker keyboard to be re-rendered', () => (harness.fakeTelegram.getMessage(pickerMessage)?.reply_markup?.inline_keyboard[0] ?? []).length === 2);
  });

  it('in a regular topic without a session /compact_summary still sets that topic\'s own switch', async () => {
    isGeneralTopic = false;
    await harness.runCommand('compact_summary', 'on');
    assert.equal(harness.state.checkIsCompactSummaryEnabled(harness.key), true, 'this topic\'s override is on');
    assert.equal(harness.state.getCompactSummaryGlobalDefault(), false, 'the instance-wide default is untouched');
  });

  it('the hooks the prompt, output and lifecycle paths call are harmless on a topic with no session', () => {
    assert.equal(compaction.checkIsThreadCompacting(harness.key), false);
    compaction.noteThreadActivity(harness.key);
    compaction.noteThreadUserActivity(harness.key);
    compaction.markThreadTurnProducedOutput(harness.key);
    compaction.clearThreadCompaction(harness.key);
    assert.equal(compaction.threadsCompacting.has(keyToString(harness.key)), false);
    assert.equal(compaction.reAskedQuestionOptions.has(keyToString(harness.key)), false);
  });
});
