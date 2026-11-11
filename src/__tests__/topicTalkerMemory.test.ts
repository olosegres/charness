/**
 * @description The in-memory conveniences behind adding a talker: the people who wrote in a topic and were ignored (the last
 * few, most recent first, no duplicates) and the @usernames seen in the group (a bounded, least-recently-seen-first memory,
 * matched in any case).
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createRecentWriters, createSeenSenders, recentWritersPerTopicMax, seenSendersMax } from '../topicTalkerMemory';

const alice = { userId: '101', username: 'alice_w', name: 'Alice Smith' };
const bob = { userId: '102', name: 'Bob Stone' };

test('recent writers: the most recent first, one entry per person, and a writer who writes again moves to the front', () => {
  const writers = createRecentWriters();
  writers.noteIgnoredWriter('topic-a', alice);
  writers.noteIgnoredWriter('topic-a', bob);
  assert.deepEqual(writers.getRecentWriters('topic-a').map((writer) => writer.userId), ['102', '101']);
  writers.noteIgnoredWriter('topic-a', alice);
  assert.deepEqual(writers.getRecentWriters('topic-a').map((writer) => writer.userId), ['101', '102']);
});

test('recent writers: each topic has its own list, and it keeps only the last few', () => {
  const writers = createRecentWriters();
  writers.noteIgnoredWriter('topic-b', bob);
  for (let index = 0; index < recentWritersPerTopicMax + 3; index += 1) {
    writers.noteIgnoredWriter('topic-a', { userId: `${200 + index}`, name: `Person ${index}` });
  }
  const kept = writers.getRecentWriters('topic-a');
  assert.equal(kept.length, recentWritersPerTopicMax);
  assert.equal(kept[0].userId, `${200 + recentWritersPerTopicMax + 2}`, 'the newest is first');
  assert.ok(!kept.some((writer) => writer.userId === '200'), 'the oldest were let go');
  assert.deepEqual(writers.getRecentWriters('topic-b').map((writer) => writer.userId), ['102']);
  assert.deepEqual(writers.getRecentWriters('topic-never-written'), []);
});

test('recent writers: a person an admin added is forgotten for that topic only, and a read is a copy', () => {
  const writers = createRecentWriters();
  writers.noteIgnoredWriter('topic-a', alice);
  writers.noteIgnoredWriter('topic-b', alice);
  writers.forgetWriter('topic-a', '101');
  assert.deepEqual(writers.getRecentWriters('topic-a'), []);
  assert.equal(writers.getRecentWriters('topic-b').length, 1);
  writers.forgetWriter('topic-a', '101');
  const copy = writers.getRecentWriters('topic-b');
  copy[0].name = 'Changed';
  copy.length = 0;
  assert.equal(writers.getRecentWriters('topic-b')[0].name, 'Alice Smith');
});

test('seen senders: found by @username in any case, with or without the @; the latest sighting wins (a rename)', () => {
  const senders = createSeenSenders();
  senders.noteSender(alice);
  assert.deepEqual(senders.findSenderByUsername('@ALICE_W'), alice);
  assert.deepEqual(senders.findSenderByUsername('alice_w'), alice);
  senders.noteSender({ userId: '101', username: 'alice_w', name: 'Alice Jones' });
  assert.equal(senders.findSenderByUsername('alice_w')?.name, 'Alice Jones');
  assert.equal(senders.findSenderByUsername('nobody_here'), undefined);
});

test('seen senders: a person with no @username is not kept — there is nothing to look them up by', () => {
  const senders = createSeenSenders();
  senders.noteSender(bob);
  assert.equal(senders.findSenderByUsername('bob'), undefined);
});

test('seen senders: bounded — the least recently seen is forgotten first, and a sighting refreshes a name', () => {
  const senders = createSeenSenders(3);
  senders.noteSender({ userId: '1', username: 'first', name: 'First' });
  senders.noteSender({ userId: '2', username: 'second', name: 'Second' });
  senders.noteSender({ userId: '3', username: 'third', name: 'Third' });
  senders.noteSender({ userId: '1', username: 'first', name: 'First' }); // seen again: no longer the oldest
  senders.noteSender({ userId: '4', username: 'fourth', name: 'Fourth' });
  assert.equal(senders.findSenderByUsername('second'), undefined, 'the least recently seen went');
  assert.ok(senders.findSenderByUsername('first') && senders.findSenderByUsername('third') && senders.findSenderByUsername('fourth'));
  assert.equal(seenSendersMax, 500, 'the production bound is the documented one');
});

test('seen senders: a read is a copy', () => {
  const senders = createSeenSenders();
  senders.noteSender(alice);
  const found = senders.findSenderByUsername('alice_w');
  if (found) found.name = 'Changed';
  assert.equal(senders.findSenderByUsername('alice_w')?.name, 'Alice Smith');
});
