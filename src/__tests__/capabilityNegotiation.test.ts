/**
 * @description Platform-seam S5 — capability negotiation, both sides.
 *
 * Telegram declares every capability `true`, so the degraded half of every
 * branch is unreachable from the real connector: shipping it untested would
 * mean the first non-Telegram connector discovers a crash, not a fallback. The
 * in-repo test double exists for exactly this, and every capability with a
 * behavioural consequence is asserted here in BOTH directions.
 *
 * The contract being defended: dropping a capability costs the user an
 * affordance, never information. Options stay readable as enumerated text; a
 * question that cannot be pinned is still sent; a file that cannot be attached
 * is reported as a failure rather than silently swallowed.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { keyToString, keysEqual, tryKeyFromString, unregisterSessionKeyCodec } from '../sessionKey';
import type { ConnectorCapabilities, OutboundContent } from '../platform/outbound';
import { checkNeedsOwnMessage, getDegradedContent } from '../platform/capabilityFallback';
import {
  createTestConnector,
  minimalCapabilities,
  richCapabilities,
} from '../connectors/test/connector';
import {
  makeTestKey,
  registerTestSessionKeyCodec,
} from '../connectors/test/sessionKeyCodec';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { telegramCapabilities } from '../connectors/telegram/outbound';

registerTestSessionKeyCodec();
process.on('exit', () => unregisterSessionKeyCodec('test'));

const key = makeTestKey('project', 'PROJ-123');

/** A question as the core writes it: options enumerated in the text AND offered. */
const question: OutboundContent = {
  text: 'Proceed with the migration?\n1. Yes, run it\n2. No, abort',
  options: [
    { id: 'qa_0_0', label: 'Yes, run it' },
    { id: 'qa_0_1', label: 'No, abort' },
  ],
  keepVisible: true,
};

// ─── the degradation rule ───────────────────────────────────────────────

test('a fully capable surface gets the content untouched (same object)', () => {
  // Identity, not deep equality: the rich path must not pay for the poor one.
  assert.equal(getDegradedContent(question, richCapabilities), question);
  assert.equal(getDegradedContent(question, telegramCapabilities), question);
});

test('no tappable controls → options dropped, the enumerated text kept intact', () => {
  const degraded = getDegradedContent(question, minimalCapabilities);
  assert.equal(degraded.options, undefined);
  // The information survives; only the tap is gone.
  assert.equal(degraded.text, question.text);
  assert.match(degraded.text, /1\. Yes, run it/);
  assert.match(degraded.text, /2\. No, abort/);
});

test('no pinning → keepVisible cleared, the message still sent', () => {
  const degraded = getDegradedContent(question, minimalCapabilities);
  assert.equal(degraded.keepVisible, false);
});

test('degrading never mutates the caller content', () => {
  getDegradedContent(question, minimalCapabilities);
  assert.equal(question.keepVisible, true);
  assert.equal(question.options?.length, 2);
});

test('each capability degrades independently', () => {
  const pinOnly: ConnectorCapabilities = { ...minimalCapabilities, pinMessages: true };
  const tapOnly: ConnectorCapabilities = { ...minimalCapabilities, tappableOptions: true };

  assert.equal(getDegradedContent(question, pinOnly).keepVisible, true);
  assert.equal(getDegradedContent(question, pinOnly).options, undefined);

  assert.equal(getDegradedContent(question, tapOnly).keepVisible, false);
  assert.equal(getDegradedContent(question, tapOnly).options?.length, 2);
});

test('content stripped of both affordances stops needing a message of its own', () => {
  // Nothing distinguishes it any more, so forcing a separate message would only
  // fragment the conversation.
  assert.equal(checkNeedsOwnMessage(question), true);
  assert.equal(checkNeedsOwnMessage(getDegradedContent(question, minimalCapabilities)), false);
});

// ─── the test double, end to end ────────────────────────────────────────

test('a poor surface delivers the question as ordinary enumerated text', async () => {
  const connector = createTestConnector(minimalCapabilities);
  await connector.deliver(key, question);

  const [delivery] = connector.deliveries;
  assert.deepEqual(delivery.offeredOptionIds, []);
  assert.equal(delivery.wasKeptVisible, false);
  assert.equal(delivery.wasOwnMessage, false);
  // Split at the surface's OWN cap, not Telegram's.
  assert.ok(delivery.chunks.length > 1);
  assert.ok(delivery.chunks.every((chunk) => chunk.length <= minimalCapabilities.maxMessageChars));
  assert.equal(delivery.chunks.join(''), question.text);
});

test('a rich surface delivers the same question with controls and a pin', async () => {
  const connector = createTestConnector(richCapabilities);
  await connector.deliver(key, question);

  const [delivery] = connector.deliveries;
  assert.deepEqual(delivery.offeredOptionIds, ['qa_0_0', 'qa_0_1']);
  assert.equal(delivery.wasKeptVisible, true);
  assert.equal(delivery.wasOwnMessage, true);
  assert.deepEqual(delivery.chunks, [question.text]);
});

test('no activity indicator → setActivity is silently dropped', () => {
  const poor = createTestConnector(minimalCapabilities);
  poor.setActivity(key, 'working');
  poor.setActivity(key, 'idle');
  poor.setActivity(key, 'starting');
  assert.deepEqual(poor.activity, []);

  const rich = createTestConnector(richCapabilities);
  rich.setActivity(key, 'working');
  rich.setActivity(key, 'starting');
  assert.deepEqual(rich.activity, [{ key, state: 'working' }, { key, state: 'starting' }]);
});

test('no attachments → deliverFile reports a failure instead of pretending', async () => {
  const poor = createTestConnector(minimalCapabilities);
  const result = await poor.deliverFile(key, { paths: ['chart.png'] });
  // Silently answering "ok" would leave the agent believing a file it can see
  // was delivered, so it would never describe the contents in text instead.
  assert.equal(result.ok, false);
  assert.deepEqual(poor.files, []);

  const rich = createTestConnector(richCapabilities);
  const richResult = await rich.deliverFile(key, { paths: ['chart.png'] });
  assert.equal(richResult.ok, true);
  assert.equal(rich.files.length, 1);
});

test('the lifecycle methods track in-flight content on any surface', async () => {
  const connector = createTestConnector(richCapabilities);
  await connector.deliver(key, { text: 'a streaming tail' });

  assert.equal(connector.checkIsDelivering(key), true);
  assert.deepEqual(connector.listUnfinalizedKeys(), [key]);

  await connector.finalize(key);
  assert.equal(connector.checkIsDelivering(key), false);
  assert.deepEqual(connector.listUnfinalizedKeys(), []);
  assert.deepEqual(connector.finalized, [keyToString(key)]);

  connector.dispose(key);
  assert.deepEqual(connector.disposed, [keyToString(key)]);
});

test('a final frame leaves nothing to finalize', async () => {
  const connector = createTestConnector(richCapabilities);
  await connector.deliver(key, { text: 'the last word' }, { isFinal: true });
  assert.equal(connector.checkIsDelivering(key), false);
});

test('the inbound half only routes once armed', async () => {
  const connector = createTestConnector();
  const seen: string[] = [];
  const event = {
    key,
    author: { id: 'u1', displayName: 'Ada' },
    text: 'ping',
    attachments: [],
    raw: null,
  };

  await connector.emit(event);
  // `deepEqual(seen, [])` would narrow `seen` to `never[]` for the pushes below.
  assert.equal(seen.length, 0);

  await connector.start((received) => {
    seen.push(received.text);
  });
  await connector.emit(event);
  assert.deepEqual(seen, ['ping']);

  await connector.stop();
  await connector.emit(event);
  assert.deepEqual(seen, ['ping']);
});

// ─── the second platform is what makes the key primitives provable ──────

test('a second platform round-trips without colliding with Telegram', () => {
  const serialized = keyToString(key);
  assert.equal(serialized, 'test|project|PROJ-123');
  assert.deepEqual(tryKeyFromString(serialized), key);
  // The all-numeric Telegram shape can never claim it, and vice versa.
  assert.equal(tryKeyFromString('-1001234567890:42')?.platform, 'telegram');
});

test('keysEqual separates two platforms with identical space/thread pairs', () => {
  // The silent-collision hazard: without the platform comparison these two
  // unrelated conversations share every Map built on the predicate.
  const telegramKey = makeTelegramKey(123, 5);
  const testKey = makeTestKey('123', '5');
  assert.equal(telegramKey.space, testKey.space);
  assert.equal(telegramKey.thread, testKey.thread);
  assert.equal(keysEqual(telegramKey, testKey), false);
});
