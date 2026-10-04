/**
 * @description Telegram's answer sink (`connectors/telegram/answerSink.ts`):
 * an answer is one item through the recorded message-send path, and its result
 * is reported, not swallowed; every delivered answer is pinned (its first
 * message) and the previous answer's pin is released, with the latest pinned
 * answer remembered per conversation (S8); a wake-up alert is posted, pinned
 * with a notification and unpinned on release.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { keyToString } from '../sessionKey';
import { createTelegramAnswerSink, type TelegramAnswerSinkDeps } from '../connectors/telegram/answerSink';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { releaseRequestAlert, type AnswerSinks, type RequestAnswerDelivery } from '../platform/answerSink';
import type { SendMessagesToThreadOptions, SendMessagesToThreadResult } from '../utils/messageSendService';

const topicKey = makeTelegramKey(-1001234567890, 42);
const alertMessageId = 555;

/** Sink deps whose primitives are inert unless a test overrides them: no pin lands, nothing is remembered. */
function createDeps(overrides: Partial<TelegramAnswerSinkDeps>): TelegramAnswerSinkDeps {
  return {
    sendMessages: async () => ({ ok: true, summary: 'unused', undeliveredCount: 0, sentMessageIds: [] }),
    postAlert: async () => null,
    pinMessage: async () => false,
    unpinMessage: async () => {},
    getAnswerPinMessageId: () => undefined,
    setAnswerPinMessageId: async () => {},
    ...overrides,
  };
}

/**
 * A recording pin store plus pin/unpin primitives: what the sink pinned and unpinned, in order, and the
 * remembered latest answer. `isPinAccepted` false makes every pin fail, as a lost `can_pin_messages` would.
 */
function createPinRecorder(initialPinnedId?: number, isPinAccepted = true) {
  const events: string[] = [];
  let remembered = initialPinnedId;
  const deps: Partial<TelegramAnswerSinkDeps> = {
    pinMessage: async (_key, messageId) => {
      events.push(`pin ${messageId}`);
      return isPinAccepted;
    },
    unpinMessage: async (_key, messageId) => {
      events.push(`unpin ${messageId}`);
    },
    getAnswerPinMessageId: () => remembered,
    setAnswerPinMessageId: async (_key, messageId) => {
      events.push(`remember ${messageId}`);
      remembered = messageId ?? undefined;
    },
  };
  return { deps, events, getRemembered: () => remembered };
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
        return { ok: true, summary: 'Delivered 1 message.', undeliveredCount: 0, sentMessageIds: [101] };
      },
    }));

    assert.deepEqual(await sink.deliverAnswer(topicKey, delivery), { ok: true });
    assert.deepEqual(calls, [{ threadKey: keyToString(topicKey), options: { messages: ['**Done.**'] } }]);
  });

  it('reports a partial delivery as a success with a warning, so the agent knows part is missing', async () => {
    const summary = 'Delivered 2 of 3 messages to the topic (1 failed to send).';
    const partial: SendMessagesToThreadResult = { ok: true, summary, undeliveredCount: 1, sentMessageIds: [101, 103] };
    const sink = createTelegramAnswerSink(createDeps({ sendMessages: async () => partial }));

    assert.deepEqual(await sink.deliverAnswer(topicKey, delivery), { ok: true, warning: summary });
  });

  it('pins the FIRST message of a delivered answer and remembers it as the latest pinned answer', async () => {
    const pins = createPinRecorder();
    const sink = createTelegramAnswerSink(createDeps({
      sendMessages: async () => ({ ok: true, summary: 'Delivered 2 messages.', undeliveredCount: 0, sentMessageIds: [101, 102] }),
      ...pins.deps,
    }));

    assert.deepEqual(await sink.deliverAnswer(topicKey, delivery), { ok: true });
    assert.deepEqual(pins.events, ['pin 101', 'remember 101']);
  });

  it('a new answer takes the pin over: the previous answer is unpinned AFTER the new pin is up', async () => {
    const pins = createPinRecorder(77);
    const sink = createTelegramAnswerSink(createDeps({
      sendMessages: async () => ({ ok: true, summary: 'Delivered 1 message.', undeliveredCount: 0, sentMessageIds: [101] }),
      ...pins.deps,
    }));

    await sink.deliverAnswer(topicKey, { ...delivery, isRequestOpen: false });
    assert.deepEqual(pins.events, ['pin 101', 'unpin 77', 'remember 101'], 'a late answer to a closed request is pinned like any other');
    assert.equal(pins.getRemembered(), 101);
  });

  it('a pin that fails leaves the previous answer pinned and remembered — nothing was replaced', async () => {
    const pins = createPinRecorder(77, false);
    const sink = createTelegramAnswerSink(createDeps({
      sendMessages: async () => ({ ok: true, summary: 'Delivered 1 message.', undeliveredCount: 0, sentMessageIds: [101] }),
      ...pins.deps,
    }));

    assert.deepEqual(await sink.deliverAnswer(topicKey, delivery), { ok: true }, 'the answer itself landed');
    assert.deepEqual(pins.events, ['pin 101']);
    assert.equal(pins.getRemembered(), 77);
  });

  it('an answer whose text sends all failed pins nothing; a failed send never touches the pins', async () => {
    const pins = createPinRecorder(77);
    const nothingLanded = createTelegramAnswerSink(createDeps({
      sendMessages: async () => ({ ok: true, summary: 'Delivered 1 message.', undeliveredCount: 0, sentMessageIds: [] }),
      ...pins.deps,
    }));
    await nothingLanded.deliverAnswer(topicKey, delivery);
    const failed = createTelegramAnswerSink(createDeps({ sendMessages: async () => ({ ok: false, error: 'chat not found' }), ...pins.deps }));
    await failed.deliverAnswer(topicKey, delivery);

    assert.deepEqual(pins.events, []);
    assert.equal(pins.getRemembered(), 77);
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

  it('releasing an alert unpins exactly that message; an unserved platform rejects so it is kept', async () => {
    const unpinned: number[] = [];
    const sink = createTelegramAnswerSink(createDeps({ unpinMessage: async (_key, messageId) => { unpinned.push(messageId); } }));
    const sinks: AnswerSinks = new Map([['telegram', sink]]);

    await releaseRequestAlert(sinks, { conversationKey: keyToString(topicKey), alertRef: alertMessageId.toString() });
    assert.deepEqual(unpinned, [alertMessageId]);

    await assert.rejects(
      releaseRequestAlert(new Map(), { conversationKey: keyToString(topicKey), alertRef: alertMessageId.toString() }),
      /no answer sink serves/,
    );
  });
});
