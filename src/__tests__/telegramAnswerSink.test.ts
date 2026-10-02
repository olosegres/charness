/**
 * @description Telegram's basic answer sink (`connectors/telegram/answerSink.ts`):
 * an answer is one item through the recorded message-send path, and its result
 * is reported, not swallowed.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { keyToString } from '../sessionKey';
import { createTelegramAnswerSink } from '../connectors/telegram/answerSink';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import type { RequestAnswerDelivery } from '../platform/answerSink';
import type { SendMessagesToThreadOptions, SendMessagesToThreadResult } from '../utils/messageSendService';

const topicKey = makeTelegramKey(-1001234567890, 42);
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
    const sink = createTelegramAnswerSink({
      sendMessages: async (threadKey, options) => {
        calls.push({ threadKey, options });
        return { ok: true, summary: 'Delivered 1 message.', undeliveredCount: 0 };
      },
    });

    assert.deepEqual(await sink.deliverAnswer(topicKey, delivery), { ok: true });
    assert.deepEqual(calls, [{ threadKey: keyToString(topicKey), options: { messages: ['**Done.**'] } }]);
  });

  it('reports a partial delivery as a success with a warning, so the agent knows part is missing', async () => {
    const summary = 'Delivered 2 of 3 messages to the topic (1 failed to send).';
    const partial: SendMessagesToThreadResult = { ok: true, summary, undeliveredCount: 1 };
    const sink = createTelegramAnswerSink({ sendMessages: async () => partial });

    assert.deepEqual(await sink.deliverAnswer(topicKey, delivery), { ok: true, warning: summary });
  });

  it('reports a failed send as an error', async () => {
    const failed: SendMessagesToThreadResult = { ok: false, error: 'chat not found' };
    const sink = createTelegramAnswerSink({ sendMessages: async () => failed });

    assert.deepEqual(await sink.deliverAnswer(topicKey, delivery), { ok: false, error: 'chat not found' });
  });
});
