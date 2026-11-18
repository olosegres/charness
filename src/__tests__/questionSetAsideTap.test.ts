/**
 * @description A tap on a set-aside question's button (`qs_<record id>_<option index>`), through the REAL module
 * (`connectors/telegram/commands/questionSetAside.ts`) on a real telegraf instance (`commandModuleHarness.ts`): what the person is
 * told by the toast and in the topic when two taps meet.
 *
 *   • a second tap on a one-question record while the first answer is still on its way answers nothing in the toast alone: the topic
 *     shows the first answer and no notice beside it that would read as «your answer was not sent», and the agent hears of one answer;
 *   • a tap after the record is over answers nothing in the toast too;
 *   • a tap whose button is not on the record's message answers nothing.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createQuestionSetAside } from '../connectors/telegram/commands/questionSetAside';
import type { LatePromptOutcome } from '../utils/promptDelivery';
import type { OpenCodeQuestion, SetAsideQuestionRecord } from '../types';
import { enDict } from '../i18n/en';
import { keyToString } from '../sessionKey';
import { createSerialQueue } from '../utils/serialQueue';
import { createCommandHarness, type CommandHarness } from './commandModuleHarness';

const question: OpenCodeQuestion = { question: 'Push the fix to main now, or wait for the review?', header: 'Deploy', options: [{ label: 'Push now' }, { label: 'Wait for the review' }] };
const recordMessageId = 600;
const record: SetAsideQuestionRecord = { id: '1', messageId: recordMessageId, questions: [question], answers: [null], lateFromIndex: 0, askedAt: 1, setAsideAt: 2 };

let harness: CommandHarness;
/** The late-answer messages the agent was sent, and the one the test still holds back. */
let delivered: string[] = [];
let releaseDelivery: () => void = () => {};
let isDeliveryHeld = false;

function getLastToast(): string | undefined {
  return harness.fakeTelegram.callbackAnswers.at(-1);
}

describe('a tap on a set-aside question, through the module', () => {
  before(async () => {
    harness = await createCommandHarness();
    const queue = createSerialQueue();
    const setAside = createQuestionSetAside({
      ...harness.core,
      getState: () => harness.state,
      pendingQuestions: new Map(),
      getThreadAdapter: () => ({}),
      runQuestionLifecycleOp: (_key, op) => queue.run(op),
      setPendingQuestion: () => {},
      clearPendingQuestion: () => {},
      releasePendingQuestionToSetAside: async () => {},
      editQuestionMessageWithNote: async () => true,
      closeQuestionMessage: async () => true,
      unpinMessage: async () => {},
      pinMessageSilently: async () => true,
      sendQuestionMessage: async () => null,
      deliverLateAnswer: async (_key, text): Promise<LatePromptOutcome> => {
        delivered.push(text);
        if (isDeliveryHeld) await new Promise<void>((resolve) => { releaseDelivery = resolve; });
        return 'forwarded';
      },
      markNeedsNewMessage: () => {},
      getQuestionWaitChoice: () => 'thirtyMinutes',
      shortenedWaitMs: undefined,
      postQuestionAnew: () => {},
    });
    setAside.registerQuestionSetAsideCallbacks(harness.core.bot);
  });

  after(async () => {
    await harness.stop();
  });

  beforeEach(async () => {
    delivered = [];
    isDeliveryHeld = false;
    harness.replies.length = 0;
    harness.fakeTelegram.callbackAnswers.length = 0;
    await harness.state.setSetAsideQuestions(harness.key, [record]);
  });

  it('a second tap while the first answer is still on its way answers nothing in the toast alone — no notice beside the first answer', async () => {
    isDeliveryHeld = true;
    const first = harness.tapButton(recordMessageId, 'qs_1_0');
    await waitUntil('the first answer to reach the agent', () => delivered.length === 1);

    await harness.tapButton(recordMessageId, 'qs_1_1');

    assert.equal(getLastToast(), enDict['cb.no_pending_question'], 'the toast says there is nothing to answer');
    assert.deepEqual(harness.replies, [], 'and the topic is told nothing: a notice would read as «your answer was not sent»');
    releaseDelivery();
    await first;
    assert.equal(delivered.length, 1, 'the agent heard of ONE answer');
    assert.ok(delivered[0].includes('Answer: Push now'), delivered[0]);
  });

  it('a tap after the record is over answers nothing in the toast, and nothing reaches the agent', async () => {
    await harness.tapButton(recordMessageId, 'qs_1_0');
    assert.equal(delivered.length, 1);
    assert.deepEqual(harness.state.getSetAsideQuestions()[keyToString(harness.key)] ?? [], [], 'the record is over');

    await harness.tapButton(recordMessageId, 'qs_1_1');

    assert.equal(getLastToast(), enDict['cb.no_pending_question']);
    assert.equal(delivered.length, 1);
    assert.deepEqual(harness.replies, []);
  });

  it('a tap on a message that is not the record\'s answers nothing', async () => {
    await harness.tapButton(recordMessageId + 1, 'qs_1_0');

    assert.equal(getLastToast(), enDict['cb.no_pending_question']);
    assert.deepEqual(delivered, []);
  });

  it('a tap on the open question is answered with its label, and the agent gets the answer', async () => {
    await harness.tapButton(recordMessageId, 'qs_1_1');

    assert.equal(getLastToast(), 'Wait for the review');
    assert.equal(delivered.length, 1);
    assert.ok(delivered[0].includes('Answer: Wait for the review'), delivered[0]);
  });
});

async function waitUntil(description: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
