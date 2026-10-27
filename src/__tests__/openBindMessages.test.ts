import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenBindMessages, splitByDeleteWindow, telegramDeleteWindowMs } from '../connectors/telegram/openBindMessages';

const topic = '-1001111111111:191';
const otherTopic = '-1001111111111:192';
const nowMs = 1_000_000_000_000;

test('take gives every message remembered for the topic, oldest first, and forgets them', () => {
  const open = new OpenBindMessages();
  open.remember(topic, 10, nowMs);
  open.remember(topic, 12, nowMs);
  open.remember(topic, 11, nowMs);
  assert.deepEqual(open.take(topic).map((entry) => entry.messageId), [10, 12, 11]);
  assert.deepEqual(open.take(topic), [], 'taken once');
});

test('each message comes back with the time it was sent', () => {
  const open = new OpenBindMessages();
  open.remember(topic, 10, nowMs - 5);
  open.remember(topic, 11, nowMs);
  assert.deepEqual(open.take(topic), [{ messageId: 10, sentAtMs: nowMs - 5 }, { messageId: 11, sentAtMs: nowMs }]);
});

test('topics are kept apart', () => {
  const open = new OpenBindMessages();
  open.remember(topic, 10, nowMs);
  open.remember(otherTopic, 10, nowMs);
  assert.deepEqual(open.take(topic).map((entry) => entry.messageId), [10]);
  assert.deepEqual(open.take(otherTopic).map((entry) => entry.messageId), [10], 'the other topic still holds its own');
});

test('remembering a message again keeps one entry', () => {
  const open = new OpenBindMessages();
  open.remember(topic, 10, nowMs);
  open.remember(topic, 10, nowMs);
  assert.deepEqual(open.take(topic).map((entry) => entry.messageId), [10]);
});

test('forget drops one message and leaves the others; forgetting an unknown one is harmless', () => {
  const open = new OpenBindMessages();
  open.remember(topic, 10, nowMs);
  open.remember(topic, 11, nowMs);
  open.forget(topic, 10);
  open.forget(topic, 99);
  open.forget(otherTopic, 10);
  assert.deepEqual(open.take(topic).map((entry) => entry.messageId), [11]);
});

test('only the newest messages of a topic are kept: a topic nobody ever binds cannot grow the list without bound', () => {
  const open = new OpenBindMessages(3);
  for (const messageId of [1, 2, 3, 4, 5]) open.remember(topic, messageId, nowMs);
  assert.deepEqual(open.take(topic).map((entry) => entry.messageId), [3, 4, 5]);
});

test('splitByDeleteWindow: a message older than Telegram lets a bot delete is not offered for deletion — its buttons are all that can go', () => {
  const entries = [
    { messageId: 1, sentAtMs: nowMs - telegramDeleteWindowMs - 1 },
    { messageId: 2, sentAtMs: nowMs - telegramDeleteWindowMs },
    { messageId: 3, sentAtMs: nowMs - telegramDeleteWindowMs + 1 },
    { messageId: 4, sentAtMs: nowMs },
  ];
  assert.deepEqual(splitByDeleteWindow(entries, nowMs), { deletable: [3, 4], tooOld: [1, 2] });
});

test('splitByDeleteWindow of nothing is nothing', () => {
  assert.deepEqual(splitByDeleteWindow([], nowMs), { deletable: [], tooOld: [] });
});
