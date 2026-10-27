import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenBindMessages } from '../connectors/telegram/openBindMessages';

const topic = '-1001111111111:191';
const otherTopic = '-1001111111111:192';

test('take gives every message remembered for the topic, oldest first, and forgets them', () => {
  const open = new OpenBindMessages();
  open.remember(topic, 10);
  open.remember(topic, 12);
  open.remember(topic, 11);
  assert.deepEqual(open.take(topic), [10, 12, 11]);
  assert.deepEqual(open.take(topic), [], 'taken once');
});

test('topics are kept apart', () => {
  const open = new OpenBindMessages();
  open.remember(topic, 10);
  open.remember(otherTopic, 10);
  assert.deepEqual(open.take(topic), [10]);
  assert.deepEqual(open.take(otherTopic), [10], 'the other topic still holds its own');
});

test('remembering a message again keeps one entry', () => {
  const open = new OpenBindMessages();
  open.remember(topic, 10);
  open.remember(topic, 10);
  assert.deepEqual(open.take(topic), [10]);
});

test('forget drops one message and leaves the others; forgetting an unknown one is harmless', () => {
  const open = new OpenBindMessages();
  open.remember(topic, 10);
  open.remember(topic, 11);
  open.forget(topic, 10);
  open.forget(topic, 99);
  open.forget(otherTopic, 10);
  assert.deepEqual(open.take(topic), [11]);
});

test('only the newest messages of a topic are kept: a topic nobody ever binds cannot grow the list without bound', () => {
  const open = new OpenBindMessages(3);
  for (const messageId of [1, 2, 3, 4, 5]) open.remember(topic, messageId);
  assert.deepEqual(open.take(topic), [3, 4, 5]);
});
