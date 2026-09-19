/**
 * @description Platform-seam S3 — the Telegram connector's outbound side.
 *
 * The load-bearing property is the ROUTING decision: ordinary turn content must
 * keep flowing through the chat-mode `OutputTransport` (edit-in-place / draft
 * cursor), while content the core marked prominent or interactive must get its
 * own message — finalize first, send, then pin. Getting that backwards would
 * either chop a streaming answer or bury a question inside the output cursor,
 * and neither shows up in a typecheck.
 *
 * The capability gating is exercised here too: Telegram declares everything
 * `true`, so these tests pin the RICH path, and the S5 test double covers the
 * degraded one.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { InlineKeyboardMarkup } from 'telegraf/typings/core/types/typegram';
import type { SessionKey } from '../sessionKey';
import { keyToString } from '../sessionKey';
import type { OutputTransport } from '../types';
import type { OutboundHints } from '../platform/outbound';
import type { SendFilesToThreadOptions, SendFilesToThreadResult } from '../utils/fileSendService';
import { MAX_MESSAGE_LEN } from '../connectors/telegram/messageSplit';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import {
  buildOptionsKeyboard,
  createTelegramConnectorOutbound,
  telegramCapabilities,
  type TelegramOutboundDeps,
} from '../connectors/telegram/outbound';

const key = makeTelegramKey(-1001234567890, 42);

interface Recorder {
  delivered: { key: SessionKey; text: string; hints?: OutboundHints }[];
  finalized: SessionKey[];
  disposed: SessionKey[];
  standalone: { text: string; replyMarkup?: InlineKeyboardMarkup }[];
  pinned: number[];
  typing: boolean[];
  files: { threadKeyString: string; request: SendFilesToThreadOptions }[];
}

function makeOutbound(
  overrides: Partial<TelegramOutboundDeps> = {},
  transportOverrides: Partial<OutputTransport> = {},
) {
  const recorder: Recorder = {
    delivered: [],
    finalized: [],
    disposed: [],
    standalone: [],
    pinned: [],
    typing: [],
    files: [],
  };
  let nextMessageId = 500;

  const transport: OutputTransport = {
    deliverOutput: (deliveredKey, text, hints) => {
      recorder.delivered.push({ key: deliveredKey, text, hints });
    },
    finalizeInFlight: async (finalizedKey) => {
      recorder.finalized.push(finalizedKey);
    },
    disposeThread: (disposedKey) => {
      recorder.disposed.push(disposedKey);
    },
    checkIsStreaming: () => false,
    getInFlightThreadKeys: () => [],
    ...transportOverrides,
  };

  const outbound = createTelegramConnectorOutbound({
    getOutputTransport: () => transport,
    sendStandaloneMessage: async (_key, text, replyMarkup) => {
      recorder.standalone.push({ text, replyMarkup });
      return (nextMessageId += 1);
    },
    pinMessage: async (_key, messageId) => {
      recorder.pinned.push(messageId);
    },
    setTypingLoader: (_key, isActive) => {
      recorder.typing.push(isActive);
    },
    sendFiles: async (threadKeyString, request) => {
      recorder.files.push({ threadKeyString, request });
      return { ok: true, summary: 'sent 1 file' } satisfies SendFilesToThreadResult;
    },
    encodeKey: keyToString,
    ...overrides,
  });

  return { outbound, recorder };
}

// ─── capabilities ───────────────────────────────────────────────────────

test('Telegram declares every capability, with the splitter cap as its limit', () => {
  assert.deepEqual(telegramCapabilities, {
    editMessages: true,
    pinMessages: true,
    tappableOptions: true,
    attachments: true,
    threadedReplies: true,
    activityIndicator: true,
    maxMessageChars: MAX_MESSAGE_LEN,
    markupDialect: 'telegramHtml',
  });
});

// ─── deliver — the routing decision ─────────────────────────────────────

test('ordinary content streams through the chat-mode transport, hints intact', async () => {
  const { outbound, recorder } = makeOutbound();
  const hints: OutboundHints = { isContinuation: true, startsNewParagraph: true };

  await outbound.deliver(key, { text: 'a streaming tail' }, hints);

  assert.deepEqual(recorder.delivered, [{ key, text: 'a streaming tail', hints }]);
  // No finalize: interrupting the cursor is exactly what a continuation must not do.
  assert.deepEqual(recorder.finalized, []);
  assert.deepEqual(recorder.standalone, []);
});

test('prominent content finalizes in-flight output FIRST, then sends, then pins', async () => {
  const { outbound, recorder } = makeOutbound();

  await outbound.deliver(key, { text: 'pick one', keepVisible: true });

  // Ordering is the point: the pinned question must land BELOW whatever the
  // agent had already written, not on top of a half-flushed answer.
  assert.deepEqual(recorder.finalized, [key]);
  assert.equal(recorder.standalone.length, 1);
  assert.equal(recorder.standalone[0].text, 'pick one');
  assert.deepEqual(recorder.delivered, []);
  assert.deepEqual(recorder.pinned, [501]);
});

test('content with options is standalone too, and carries the keyboard', async () => {
  const { outbound, recorder } = makeOutbound();

  await outbound.deliver(key, {
    text: 'Proceed?\n1. Yes\n2. No',
    options: [
      { id: 'qa_0_0', label: 'Yes' },
      { id: 'qa_0_1', label: 'No' },
    ],
  });

  assert.deepEqual(recorder.delivered, []);
  assert.deepEqual(recorder.standalone[0].replyMarkup, {
    inline_keyboard: [
      [{ text: 'Yes', callback_data: 'qa_0_0' }],
      [{ text: 'No', callback_data: 'qa_0_1' }],
    ],
  });
  // Not asked to stay visible → not pinned.
  assert.deepEqual(recorder.pinned, []);
});

test('an empty options array is still ordinary streaming content', async () => {
  const { outbound, recorder } = makeOutbound();
  await outbound.deliver(key, { text: 'no choices here', options: [] });
  assert.equal(recorder.delivered.length, 1);
  assert.deepEqual(recorder.standalone, []);
});

test('a send that failed outright is not pinned', async () => {
  // Pinning a message id we never got would throw inside a detached promise.
  const { outbound, recorder } = makeOutbound({
    sendStandaloneMessage: async () => null,
  });

  await outbound.deliver(key, { text: 'unsendable', keepVisible: true });
  assert.deepEqual(recorder.pinned, []);
});

// ─── the options keyboard ───────────────────────────────────────────────

test('buildOptionsKeyboard: one button per row, id as the callback payload', () => {
  assert.deepEqual(buildOptionsKeyboard([{ id: 'a', label: 'Alpha' }]), {
    inline_keyboard: [[{ text: 'Alpha', callback_data: 'a' }]],
  });
});

test('buildOptionsKeyboard: an over-wide label is elided, never dropped', () => {
  const label = 'x'.repeat(60);
  const keyboard = buildOptionsKeyboard([{ id: 'a', label }]);
  const text = keyboard?.inline_keyboard[0][0].text ?? '';
  assert.equal(text.length, 40);
  assert.equal(text.endsWith('...'), true);
});

test('buildOptionsKeyboard: no options means no keyboard at all', () => {
  assert.equal(buildOptionsKeyboard([]), undefined);
});

// ─── activity, lifecycle and files ──────────────────────────────────────

test('setActivity maps the two states onto the typing loop', () => {
  const { outbound, recorder } = makeOutbound();
  outbound.setActivity(key, 'working');
  outbound.setActivity(key, 'idle');
  assert.deepEqual(recorder.typing, [true, false]);
});

test('finalize and dispose delegate to the chat-mode transport', async () => {
  const { outbound, recorder } = makeOutbound();
  await outbound.finalize(key);
  outbound.dispose(key);
  assert.deepEqual(recorder.finalized, [key]);
  assert.deepEqual(recorder.disposed, [key]);
});

test('checkIsDelivering and listUnfinalizedKeys report the transport state', () => {
  const { outbound } = makeOutbound(
    {},
    { checkIsStreaming: () => true, getInFlightThreadKeys: () => [key] },
  );
  assert.equal(outbound.checkIsDelivering(key), true);
  assert.deepEqual(outbound.listUnfinalizedKeys(), [key]);
});

test('deliverFile serializes the key for the string-keyed file service', async () => {
  const { outbound, recorder } = makeOutbound();
  const request: SendFilesToThreadOptions = { paths: ['chart.png'], caption: 'here' };

  const result = await outbound.deliverFile(key, request);

  assert.deepEqual(result, { ok: true, summary: 'sent 1 file' });
  assert.deepEqual(recorder.files, [
    { threadKeyString: '-1001234567890:42', request },
  ]);
});
