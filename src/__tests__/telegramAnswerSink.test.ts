/**
 * @description Telegram's basic answer sink (`connectors/telegram/answerSink.ts`):
 * an answer is one item through the recorded message-send path, and its result
 * is reported, not swallowed; a wake-up alert is posted, pinned with a
 * notification and unpinned on release.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { keyToString } from '../sessionKey';
import { createTelegramAnswerSink, type TelegramAnswerSinkDeps } from '../connectors/telegram/answerSink';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { releaseClosedRequestAlert, type AnswerSinks, type RequestAnswerDelivery } from '../platform/answerSink';
import type { SendMessagesToThreadOptions, SendMessagesToThreadResult } from '../utils/messageSendService';

const topicKey = makeTelegramKey(-1001234567890, 42);
const alertMessageId = 555;

/** Sink deps whose alert primitives are unused unless a test overrides them. */
function createDeps(overrides: Partial<TelegramAnswerSinkDeps>): TelegramAnswerSinkDeps {
  return {
    sendMessages: async () => ({ ok: true, summary: 'unused', undeliveredCount: 0 }),
    postAlert: async () => null,
    pinMessage: async () => false,
    unpinMessage: async () => {},
    ...overrides,
  };
}
const delivery: RequestAnswerDelivery = {
  requestId: 'req_AbCd1234',
  kind: 'final',
  body: '**Done.**',
  origin: { kind: 'message', attributes: {} },
  isRequestOpen: true,
};

describe('createTelegramAnswerSink', () => {
  it('sends the body as its own message to the conversation and reports success', async () => {
    const calls: Array<{ threadKey: string; options: SendMessagesToThreadOptions }> = [];
    const sink = createTelegramAnswerSink(createDeps({
      sendMessages: async (threadKey, options) => {
        calls.push({ threadKey, options });
        return { ok: true, summary: 'Delivered 1 message.', undeliveredCount: 0 };
      },
    }));

    assert.deepEqual(await sink.deliverAnswer(topicKey, delivery), { ok: true });
    assert.deepEqual(calls, [{ threadKey: keyToString(topicKey), options: { messages: ['**Done.**'] } }]);
  });

  it('reports a partial delivery as a success with a warning, so the agent knows part is missing', async () => {
    const summary = 'Delivered 2 of 3 messages to the topic (1 failed to send).';
    const partial: SendMessagesToThreadResult = { ok: true, summary, undeliveredCount: 1 };
    const sink = createTelegramAnswerSink(createDeps({ sendMessages: async () => partial }));

    assert.deepEqual(await sink.deliverAnswer(topicKey, delivery), { ok: true, warning: summary });
  });

  it('reports a failed send as an error', async () => {
    const failed: SendMessagesToThreadResult = { ok: false, error: 'chat not found' };
    const sink = createTelegramAnswerSink(createDeps({ sendMessages: async () => failed }));

    assert.deepEqual(await sink.deliverAnswer(topicKey, delivery), { ok: false, error: 'chat not found' });
  });

  it('posts the alert naming the request, pins it, and hands its id back as the alert handle', async () => {
    const posted: Array<{ requestId: string; reason: string }> = [];
    const pinned: number[] = [];
    const sink = createTelegramAnswerSink(createDeps({
      postAlert: async (_key, requestId, reason) => {
        posted.push({ requestId, reason });
        return alertMessageId;
      },
      pinMessage: async (_key, messageId) => {
        pinned.push(messageId);
        return true;
      },
    }));

    const result = await sink.deliverAlert(topicKey, {
      requestId: 'req_AbCd1234', reason: 'silentTurns', origin: { kind: 'message', attributes: {} },
    });

    assert.deepEqual(result, { ok: true, alertRef: alertMessageId.toString() });
    assert.deepEqual(posted, [{ requestId: 'req_AbCd1234', reason: 'silentTurns' }]);
    assert.deepEqual(pinned, [alertMessageId]);
  });

  it('an alert that could not be pinned still stands, with nothing to release; a failed post is an error', async () => {
    const unpinnable = createTelegramAnswerSink(createDeps({ postAlert: async () => alertMessageId }));
    const alert = { requestId: 'req_AbCd1234', reason: 'wakeCap' as const, origin: { kind: 'message' as const, attributes: {} } };
    assert.deepEqual(await unpinnable.deliverAlert(topicKey, alert), { ok: true });

    const unsendable = createTelegramAnswerSink(createDeps({}));
    assert.equal((await unsendable.deliverAlert(topicKey, alert)).ok, false);
  });

  it('releasing a closed request\'s alert unpins exactly that message', async () => {
    const unpinned: number[] = [];
    const sink = createTelegramAnswerSink(createDeps({ unpinMessage: async (_key, messageId) => { unpinned.push(messageId); } }));
    const sinks: AnswerSinks = new Map([['telegram', sink]]);
    const closed = {
      id: 'req_AbCd1234',
      origin: { kind: 'message' as const, attributes: {} },
      createdAt: 1,
      progressAnswerCount: 0,
      silentTurnCount: 2,
      wakeCount: 1,
      isWakeStopped: true,
      conversationKey: keyToString(topicKey),
      closedAt: 2,
      closeReason: 'final' as const,
    };

    releaseClosedRequestAlert(sinks, closed);
    releaseClosedRequestAlert(sinks, { ...closed, alertRef: alertMessageId.toString() });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(unpinned, [alertMessageId]);
  });
});
