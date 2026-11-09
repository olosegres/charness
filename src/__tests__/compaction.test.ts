/**
 * @description The compaction flow (`connectors/telegram/commands/compaction.ts`) wired to ports
 * (`commandModuleHarness.ts`: a real telegraf instance against the fake Bot API, the real state store,
 * recording topic sends). The default Claude backend has no running session here, so what is pinned is what
 * needs none:
 *
 *   • WIRING — the four commands, the ten switch buttons and the re-ask buttons the module registers, in order
 *     (the re-asked question itself is `reAskedQuestion.test.ts`);
 *   • the compact-on-idle switch as the General topic uses it — the instance-wide default: the picker, the
 *     typed form, a button tap that persists, answers and re-renders the ✓;
 *   • the picker's summary row — the same `/compact_summary` setting, OFF until turned on — and its self-review row — the same
 *     `/compact_self_review` setting, ON until turned off;
 *   • `/compact_self_review` itself: the picker, the typed form, the General default and a topic's own switch, and the flags the
 *     CLI's and OpenCode's own compactions read following each of them;
 *   • a regular topic without a session is told the switch needs one, and the hooks the bot's prompt and
 *     output paths call are harmless on such a topic.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { getThreadAdapter } from '../adapters/createAdapter';
import { createCompaction } from '../connectors/telegram/commands/compaction';
import { keyToString } from '../sessionKey';
import { createCommandHarness, harnessThreadId, type CommandHarness } from './commandModuleHarness';

const waitStepMs = 25;
const waitTimeoutMs = 10_000;

let harness: CommandHarness;
let compaction: ReturnType<typeof createCompaction>;
/** Whether the topic under test is General — the instance-wide switch — or a regular topic. */
let isGeneralTopic = false;
/** How many button taps the fake Bot API had answered when each topic reply was posted. */
const callbackAnswersAtReply: number[] = [];

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
      compactSelfReviewFlagDirs: harness.compactSelfReviewFlagDirs,
      replyToThread: async (key, text, extra) => {
        callbackAnswersAtReply.push(harness.fakeTelegram.callbackAnswers.length);
        return harness.core.replyToThread(key, text, extra);
      },
      checkIsGeneral: () => isGeneralTopic,
      startTypingLoader: () => {},
      forwardPromptToAgent: async () => {},
      pendingQuestions: new Map(),
      clearPendingQuestion: () => {},
      closeQuestionMessage: async () => true,
      idleWindowMs: 55 * 60 * 1000,
      checkIsLimitWaitArmed: () => false,
      suspendThreadSession: async () => {},
      resumeSleepingSessionForCompaction: async () => false,
      getThreadAdapter,
      deliverLabel: async () => 'forwarded',
      resumeSleepingSessionForPrompt: async () => false,
      checkIsStarting: () => false,
      closeOrphanQuestionMessage: async () => true,
      notePersonActivity: () => {},
    });
    compaction.registerCompactionCommands();
    compaction.registerCompactionCallbacks();
  });

  after(async () => {
    await harness.stop();
  });

  it('registers /compact /compact_on_idle /compact_summary /compact_self_review, the ten switch buttons and the re-ask buttons, in order', () => {
    assert.deepEqual(harness.registeredCommandNames, ['compact', 'compact_on_idle', 'compact_summary', 'compact_self_review']);
    assert.deepEqual(harness.registeredActionPatterns, [
      'coi_on', 'coi_off', 'coi_sum_on', 'coi_sum_off', 'coi_sr_on', 'coi_sr_off', 'csum_on', 'csum_off', 'csr_on', 'csr_off', String(/^reask_(\d+)$/),
    ]);
  });

  it('a regular topic without a session is told the switch needs one', async () => {
    await harness.runCommand('compact_on_idle');
    assert.match(harness.replies.at(-1)?.text ?? '', /active agent session/);
    assert.deepEqual(harness.getKeyboardData(harness.replies.at(-1)), [], 'no picker for a switch that cannot apply');
  });

  it('in General the bare command shows the instance-wide switch, the summary row and the self-review row', async () => {
    isGeneralTopic = true;
    await harness.runCommand('compact_on_idle');
    const picker = harness.replies.at(-1);
    assert.deepEqual(harness.getKeyboardData(picker), [['coi_on', 'coi_off'], ['coi_sum_on', 'coi_sum_off'], ['coi_sr_on', 'coi_sr_off']]);
    assert.match(picker?.text ?? '', /: ON\n/, 'the instance-wide default is on until somebody turns it off');
    assert.match(picker?.text ?? '', /Summary after a compaction: OFF/, 'the summary is off until somebody turns it on');
    assert.match(picker?.text ?? '', /Agent self-review: ON/, 'the self-review is on until somebody turns it off');
    const markup = (picker?.extra as { reply_markup?: { inline_keyboard: Array<Array<{ text: string }>> } } | undefined)?.reply_markup;
    assert.ok(markup?.inline_keyboard[1]?.[1]?.text.endsWith('✓'), 'the ✓ sits on «Hide summary»');
    assert.ok(markup?.inline_keyboard[2]?.[0]?.text.endsWith('✓'), 'the ✓ sits on «Show self-review»');
    assert.ok(!markup?.inline_keyboard[2]?.[1]?.text.endsWith('✓'));
  });

  it('in General a tap on the summary row sets the same switch /compact_summary shows', async () => {
    const picker = harness.fakeTelegram.pushOperatorMessage(harnessThreadId, 'idle picker');
    await harness.tapButton(picker, 'coi_sum_on');
    assert.equal(harness.state.getCompactSummaryGlobalDefault(), true);
    assert.match(harness.replies.at(-1)?.text ?? '', /Compaction summary: ON for ALL topics/);
    await waitUntil('both picker rows to be re-rendered', () => {
      const rows = harness.fakeTelegram.getMessage(picker)?.reply_markup?.inline_keyboard ?? [];
      return rows.length === 3 && (rows[1]?.[0]?.text.endsWith('✓') ?? false);
    });

    await harness.tapButton(picker, 'coi_sum_off');
    assert.equal(harness.state.getCompactSummaryGlobalDefault(), false);
  });

  it('a switch tap is answered before its confirmation waits in the paced send queue', async () => {
    // A late answer (the queue held by a 429) throws, and the keyboard re-render after it never ran.
    const picker = harness.fakeTelegram.pushOperatorMessage(harnessThreadId, 'idle picker');
    for (const callbackData of ['coi_sum_on', 'coi_sum_off', 'csum_on', 'csum_off', 'coi_sr_off', 'coi_sr_on', 'csr_off', 'csr_on']) {
      const answersBeforeTap = harness.fakeTelegram.callbackAnswers.length;
      await harness.tapButton(picker, callbackData);
      assert.equal(callbackAnswersAtReply.at(-1), answersBeforeTap + 1, `${callbackData} confirmed after its answer`);
    }
    assert.equal(harness.state.getCompactSummaryGlobalDefault(), false);
    assert.equal(harness.state.getCompactSelfReviewGlobalDefault(), true);
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

  it('in General the self-review row of the idle picker sets the same switch /compact_self_review shows, and re-renders its ✓', async () => {
    isGeneralTopic = true;
    const picker = harness.fakeTelegram.pushOperatorMessage(harnessThreadId, 'idle picker 2');
    await harness.tapButton(picker, 'coi_sr_off');
    assert.equal(harness.state.getCompactSelfReviewGlobalDefault(), false);
    assert.match(harness.replies.at(-1)?.text ?? '', /Agent self-review on compaction: OFF for ALL topics/);
    await waitUntil('the self-review row to show «Hide self-review» checked', () => {
      const rows = harness.fakeTelegram.getMessage(picker)?.reply_markup?.inline_keyboard ?? [];
      return rows.length === 3 && (rows[2]?.[1]?.text.endsWith('✓') ?? false) && !(rows[2]?.[0]?.text.endsWith('✓') ?? true);
    });

    await harness.tapButton(picker, 'coi_sr_on');
    assert.equal(harness.state.getCompactSelfReviewGlobalDefault(), true);
  });

  it('in General /compact_self_review shows the instance-wide switch (ON until turned off), and its typed form and buttons persist it', async () => {
    isGeneralTopic = true;
    await harness.runCommand('compact_self_review');
    const picker = harness.replies.at(-1);
    assert.deepEqual(harness.getKeyboardData(picker), [['csr_on', 'csr_off']]);
    assert.match(picker?.text ?? '', /default for ALL topics: ON/);
    assert.deepEqual(harness.getKeyboardLabels(picker), [['Enable ✓', 'Disable']]);

    await harness.runCommand('compact_self_review', 'off');
    assert.equal(harness.state.getCompactSelfReviewGlobalDefault(), false);
    assert.match(harness.replies.at(-1)?.text ?? '', /Agent self-review on compaction: OFF for ALL topics/);
    await harness.runCommand('compact_self_review');
    assert.match(harness.replies.at(-1)?.text ?? '', /default for ALL topics: OFF/);
    assert.deepEqual(harness.getKeyboardLabels(harness.replies.at(-1)), [['Enable', 'Disable ✓']]);

    const pickerMessage = harness.fakeTelegram.pushOperatorMessage(harnessThreadId, 'self-review picker');
    await harness.tapButton(pickerMessage, 'csr_on');
    assert.equal(harness.state.getCompactSelfReviewGlobalDefault(), true);
    await waitUntil('the self-review picker keyboard to be re-rendered', () => (harness.fakeTelegram.getMessage(pickerMessage)?.reply_markup?.inline_keyboard[0] ?? [])[0]?.text.endsWith('✓') ?? false);
    await harness.tapButton(pickerMessage, 'csr_off');
    assert.equal(harness.state.getCompactSelfReviewGlobalDefault(), false);
    await harness.runCommand('compact_self_review', 'on');
    assert.equal(harness.state.getCompactSelfReviewGlobalDefault(), true);
  });

  it('in a regular topic without a session /compact_self_review still sets that topic\'s own switch and leaves the default alone', async () => {
    isGeneralTopic = false;
    await harness.runCommand('compact_self_review');
    assert.match(harness.replies.at(-1)?.text ?? '', /in this topic: ON/);
    await harness.runCommand('compact_self_review', 'off');
    assert.equal(harness.state.checkIsCompactSelfReviewEnabled(harness.key), false, 'this topic\'s override is off');
    assert.equal(harness.state.getCompactSelfReviewGlobalDefault(), true, 'the instance-wide default is untouched');
    assert.match(harness.replies.at(-1)?.text ?? '', /Agent self-review on compaction: OFF for this topic/);
    await harness.runCommand('compact_self_review');
    assert.match(harness.replies.at(-1)?.text ?? '', /in this topic: OFF/);

    const pickerMessage = harness.fakeTelegram.pushOperatorMessage(harnessThreadId, 'self-review picker 2');
    await harness.tapButton(pickerMessage, 'csr_on');
    assert.equal(harness.state.checkIsCompactSelfReviewEnabled(harness.key), true);
    assert.equal(harness.state.getCompactSelfReviewOverride(harness.key), true, 'an explicit override, not the default showing through');
  });

  it('the flags the CLI\'s and OpenCode\'s own compactions read follow the switch: the topic\'s own sessions, then every topic when General changes the default', async () => {
    const otherKey = { ...harness.key, thread: '222' };
    await harness.state.setAgent(harness.key, { name: 'claude', claudeSessionId: 'claude-session-a' });
    await harness.state.setOpenCodeSessionId(harness.key, 'ses_a');
    await harness.state.setAgent(otherKey, { name: 'claude', claudeSessionId: 'claude-session-b' });
    const { claudeOffDir, openCodeOffDir } = harness.compactSelfReviewFlagDirs;
    const listFlags = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

    isGeneralTopic = false;
    await harness.runCommand('compact_self_review', 'off');
    assert.deepEqual(listFlags(claudeOffDir), ['claude-session-a'], 'the topic\'s Claude session is flagged, the other topic\'s is not');
    assert.deepEqual(listFlags(openCodeOffDir), ['ses_a'], 'and so is its OpenCode session');
    await harness.runCommand('compact_self_review', 'on');
    assert.deepEqual([listFlags(claudeOffDir), listFlags(openCodeOffDir)], [[], []], 'switched back on: the flags are gone');

    // General: every topic that follows the default is flagged; a topic with an ON override of its own is not
    // (this topic's override is ON from the step above, the other topic has none).
    isGeneralTopic = true;
    await harness.runCommand('compact_self_review', 'off');
    assert.deepEqual(listFlags(claudeOffDir), ['claude-session-b'], 'the topic that follows the default is flagged, the one with its own ON override is not');
    await harness.state.setCompactSelfReviewOverride(harness.key, false);
    compaction.syncAllCompactSelfReviewFlags();
    assert.deepEqual(listFlags(claudeOffDir), ['claude-session-a', 'claude-session-b'], 'an explicit OFF override is flagged under any default');
    await harness.runCommand('compact_self_review', 'on');
    assert.deepEqual(listFlags(claudeOffDir), ['claude-session-a'], 'the default is ON again: only the explicit OFF override keeps its flag');
    isGeneralTopic = false;

    // A session that starts later (a new id for the topic) is flagged by the per-thread sync the session start calls.
    await harness.state.setClaudeSessionId(harness.key, 'claude-session-new');
    compaction.syncThreadCompactSelfReviewFlags(harness.key);
    assert.ok(listFlags(claudeOffDir).includes('claude-session-new'), 'a topic that is OFF gets its new session flagged at once');
    await harness.runCommand('compact_self_review', 'on');
    assert.deepEqual(listFlags(claudeOffDir), ['claude-session-a'], 'switching the topic on clears the flag of its CURRENT session; an id it left stays until the topic meets it again');
  });

  it('the flags follow a topic\'s PARKED sessions too, and the boot sync removes the Claude flags no OFF topic owns any more — the shared OpenCode folder is left alone', async () => {
    isGeneralTopic = false;
    const { claudeOffDir, openCodeOffDir } = harness.compactSelfReviewFlagDirs;
    const listFlags = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
    // The step before left the topic ON with an id it had left; a flag of a topic that no longer exists; one of another instance's OpenCode session.
    fs.writeFileSync(path.join(claudeOffDir, 'claude-of-a-gone-topic'), '');
    fs.mkdirSync(openCodeOffDir, { recursive: true });
    fs.writeFileSync(path.join(openCodeOffDir, 'ses_of_another_instance'), '');
    compaction.syncAllCompactSelfReviewFlags();
    assert.deepEqual(listFlags(claudeOffDir), [], 'every topic is ON: no Claude flag is owned, the stale ones are gone');
    assert.deepEqual(listFlags(openCodeOffDir), ['ses_of_another_instance'], 'the OpenCode folder is shared with other instances: a flag this instance does not know stays');

    // The topic went from OpenCode to Claude and back: the other family's id is parked, and its flag follows the setting.
    await harness.state.setClaudeSessionId(harness.key, 'claude-session-current');
    await harness.state.setOpenCodeSessionId(harness.key, 'ses_current');
    await harness.state.setParkedSession(harness.key, { adapterName: 'opencode', claudeSessionId: 'claude-session-parked', opencodeSessionId: 'ses_parked', parkedAt: '2026-11-09T00:00:00.000Z' });
    await harness.runCommand('compact_self_review', 'off');
    assert.deepEqual(listFlags(claudeOffDir), ['claude-session-current', 'claude-session-parked'], 'the parked Claude id is flagged with the current one');
    assert.deepEqual(listFlags(openCodeOffDir), ['ses_current', 'ses_of_another_instance', 'ses_parked']);

    // A boot while the topic is OFF keeps what it owns and drops what it does not.
    fs.writeFileSync(path.join(claudeOffDir, 'claude-left-by-new'), '');
    compaction.syncAllCompactSelfReviewFlags();
    assert.deepEqual(listFlags(claudeOffDir), ['claude-session-current', 'claude-session-parked']);

    await harness.runCommand('compact_self_review', 'on');
    assert.deepEqual(listFlags(claudeOffDir), [], 'switched on: the parked id\'s flag goes with the current one');
    assert.deepEqual(listFlags(openCodeOffDir), ['ses_of_another_instance']);
    await harness.state.setParkedSession(harness.key, null);
  });

  it('the hooks the prompt, output and lifecycle paths call are harmless on a topic with no session', () => {
    assert.equal(compaction.checkIsThreadCompacting(harness.key), false);
    compaction.noteThreadActivity(harness.key);
    compaction.noteThreadUserActivity(harness.key);
    compaction.markThreadTurnProducedOutput(harness.key);
    compaction.clearThreadCompaction(harness.key);
    assert.equal(compaction.threadsCompacting.has(keyToString(harness.key)), false);
  });
});
