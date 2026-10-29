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
import type { OpenCodeQuestion, ReAskedQuestionRecord } from '../types';
import type { QuestionEnd } from '../openCodeQuestionFlow';
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
/** What the compaction module asked the bot to close, through its `closeQuestionMessage` port. */
const closedQuestionMessages: Array<{ messageId: number; closing: QuestionEnd }> = [];

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
      replyToThread: async (key, text, extra) => {
        callbackAnswersAtReply.push(harness.fakeTelegram.callbackAnswers.length);
        return harness.core.replyToThread(key, text, extra);
      },
      checkIsGeneral: () => isGeneralTopic,
      startTypingLoader: () => {},
      forwardPromptToAgent: async () => {},
      pendingQuestions: new Map(),
      clearPendingQuestion: () => {},
      closeQuestionMessage: async (_key, messageId, _question, ending) => {
        closedQuestionMessages.push({ messageId, closing: ending });
        return true;
      },
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

  it('a switch tap is answered before its confirmation waits in the paced send queue', async () => {
    // A late answer (the queue held by a 429) throws, and the keyboard re-render after it never ran.
    const picker = harness.fakeTelegram.pushOperatorMessage(harnessThreadId, 'idle picker');
    for (const callbackData of ['coi_sum_on', 'coi_sum_off', 'csum_on', 'csum_off']) {
      const answersBeforeTap = harness.fakeTelegram.callbackAnswers.length;
      await harness.tapButton(picker, callbackData);
      assert.equal(callbackAnswersAtReply.at(-1), answersBeforeTap + 1, `${callbackData} confirmed after its answer`);
    }
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
    assert.equal(compaction.peekReAskedQuestion(harness.key), undefined);
  });

  describe('the question the idle compaction re-asked', () => {
    const reAskedQuestion: OpenCodeQuestion = { question: 'Which way?', header: 'Way', options: [{ label: 'Short' }, { label: 'Long' }] };
    const savedRecord: ReAskedQuestionRecord = { messageId: 4321, question: reAskedQuestion };

    /** A re-asked question as the boot (or the post, once its send resolved) leaves it: in memory and in the saved state. */
    async function seedReAskedQuestion(): Promise<void> {
      await harness.state.setReAskedQuestion(harness.key, savedRecord);
      compaction.restoreReAskedQuestion(harness.key, savedRecord);
      closedQuestionMessages.length = 0;
    }

    it('a restored question is the one a tap works on', async () => {
      await seedReAskedQuestion();
      assert.deepEqual(compaction.peekReAskedQuestion(harness.key)?.question, reAskedQuestion);
      assert.equal(compaction.peekReAskedQuestion(harness.key)?.messageId, 4321);
      compaction.clearThreadCompaction(harness.key);
      await waitUntil('the saved record to be dropped', () => harness.state.getReAskedQuestions()[keyToString(harness.key)] === undefined);
    });

    it('a tap takes it out of memory AND of the saved state, and closes nothing: its answer is written there', async () => {
      await seedReAskedQuestion();
      const taken = compaction.takeReAskedQuestion(harness.key);
      assert.equal(taken?.messageId, 4321);
      assert.equal(compaction.peekReAskedQuestion(harness.key), undefined);
      await waitUntil('the saved record to be dropped', () => harness.state.getReAskedQuestions()[keyToString(harness.key)] === undefined);

      // The end of the conversation after the tap finds nothing to close: the answer is never overwritten.
      compaction.closeReAskedQuestion(harness.key);
      assert.deepEqual(closedQuestionMessages, []);
    });

    it('a tap whose label reached no session puts it back, in memory and in the saved state, unless a newer one is there', async () => {
      await seedReAskedQuestion();
      const taken = compaction.takeReAskedQuestion(harness.key);
      assert.ok(taken);
      assert.equal(compaction.putBackReAskedQuestion(harness.key, taken), true, 'put back');
      assert.equal(compaction.peekReAskedQuestion(harness.key), taken);
      await waitUntil('the record to be saved again', () => harness.state.getReAskedQuestions()[keyToString(harness.key)]?.messageId === 4321);

      const newer = { question: reAskedQuestion, messageId: 9999, predecessorMessageId: null, isPredecessorClosed: true, ending: null };
      assert.equal(compaction.putBackReAskedQuestion(harness.key, newer), false, 'and told so when a record is already there: the tapped message is no longer the question that waits');
      assert.equal(compaction.peekReAskedQuestion(harness.key), taken, 'a record that is there is not replaced');
      compaction.closeReAskedQuestion(harness.key);
    });

    it('a record started by the idle compaction is saved at once, flagged as not posted, on the message the question waited in', async () => {
      closedQuestionMessages.length = 0;
      const started = compaction.startReAskedQuestion(harness.key, reAskedQuestion, 777);
      assert.equal(started.messageId, null, 'no re-ask message yet');
      assert.equal(compaction.peekReAskedQuestion(harness.key), started);
      await waitUntil('the record to be saved', () => harness.state.getReAskedQuestions()[keyToString(harness.key)]?.isPosted === false);
      assert.deepEqual(harness.state.getReAskedQuestions()[keyToString(harness.key)], { messageId: 777, question: reAskedQuestion, isPosted: false });
      compaction.takeReAskedQuestion(harness.key);
      await waitUntil('the saved record to be dropped', () => harness.state.getReAskedQuestions()[keyToString(harness.key)] === undefined);
    });

    it('a question that never had a message leaves nothing to save', async () => {
      const started = compaction.startReAskedQuestion(harness.key, reAskedQuestion, null);
      assert.equal(harness.state.getReAskedQuestions()[keyToString(harness.key)], undefined);
      compaction.takeReAskedQuestion(harness.key);
      assert.ok(started);
    });

    it('closing a record before its re-ask is posted ends the message the question waited in, once', async () => {
      closedQuestionMessages.length = 0;
      compaction.startReAskedQuestion(harness.key, reAskedQuestion, 777);
      compaction.closeReAskedQuestion(harness.key);
      await waitUntil('the close to be asked of the bot', () => closedQuestionMessages.length === 1);
      assert.deepEqual(closedQuestionMessages, [{ messageId: 777, closing: 'unanswered' }]);
      await waitUntil('the saved record to be dropped', () => harness.state.getReAskedQuestions()[keyToString(harness.key)] === undefined);
      compaction.closeReAskedQuestion(harness.key);
      assert.equal(closedQuestionMessages.length, 1, 'and nothing more the second time');
    });

    it('a number that answers a record writes the answer on the message it waited in, and on a re-ask once it is known', async () => {
      closedQuestionMessages.length = 0;
      const started = compaction.startReAskedQuestion(harness.key, reAskedQuestion, 777);
      const taken = compaction.takeReAskedQuestion(harness.key, { answer: 'Long' });
      assert.equal(taken, started);
      assert.deepEqual(taken.ending, { answer: 'Long' }, 'the ending is set at the take: a re-ask that lands meanwhile ends the same way');
      await compaction.endReAskedQuestion(harness.key, taken);
      assert.deepEqual(closedQuestionMessages, [{ messageId: 777, closing: { answer: 'Long' } }]);

      // The re-ask landed afterwards: its own message gets the answer too, the predecessor is not written twice.
      taken.messageId = 888;
      await compaction.endReAskedQuestion(harness.key, taken);
      assert.deepEqual(closedQuestionMessages.slice(1), [{ messageId: 888, closing: { answer: 'Long' } }]);
    });

    it('a record put back after a number reached no session is open again, without the ending', async () => {
      const started = compaction.startReAskedQuestion(harness.key, reAskedQuestion, 777);
      const taken = compaction.takeReAskedQuestion(harness.key, { answer: 'Long' });
      assert.ok(taken);
      assert.equal(compaction.putBackReAskedQuestion(harness.key, taken), true);
      assert.equal(taken.ending, null);
      assert.equal(compaction.peekReAskedQuestion(harness.key), started);
      await waitUntil('the unposted record to be saved again', () => harness.state.getReAskedQuestions()[keyToString(harness.key)]?.isPosted === false);
      compaction.takeReAskedQuestion(harness.key);
    });

    it('the end of the conversation closes its message once as unanswered and forgets the record', async () => {
      await seedReAskedQuestion();
      compaction.closeReAskedQuestion(harness.key);
      await waitUntil('the close to be asked of the bot', () => closedQuestionMessages.length === 1);
      assert.deepEqual(closedQuestionMessages, [{ messageId: 4321, closing: 'unanswered' }]);
      assert.equal(compaction.peekReAskedQuestion(harness.key), undefined);
      await waitUntil('the saved record to be dropped', () => harness.state.getReAskedQuestions()[keyToString(harness.key)] === undefined);

      compaction.closeReAskedQuestion(harness.key);
      compaction.clearThreadCompaction(harness.key);
      assert.equal(closedQuestionMessages.length, 1, 'closing again closes nothing more');
    });
  });
});
