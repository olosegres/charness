import test from 'node:test';
import assert from 'node:assert/strict';
import { getFreshPendingTopicName, getTrustedPendingTopicName, type PendingTopicName } from '../connectors/telegram/pendingTopicName';

const ttlMs = 1000;
const nowMs = 10_000;
const adminName: PendingTopicName = { name: 'Release notes', ts: nowMs - 10, isFromAdmin: true };
const strangerName: PendingTopicName = { name: 'whatever a member typed', ts: nowMs - 10, isFromAdmin: false };

test('a fresh entry is returned as it is, an expired or missing one is not', () => {
  assert.equal(getFreshPendingTopicName(adminName, nowMs, ttlMs), adminName);
  assert.equal(getFreshPendingTopicName({ ...adminName, ts: nowMs - ttlMs }, nowMs, ttlMs), undefined, 'exactly the TTL old is expired');
  assert.equal(getFreshPendingTopicName(undefined, nowMs, ttlMs), undefined);
});

test('a binding may carry the name of an authorised user', () => {
  assert.equal(getTrustedPendingTopicName(adminName, nowMs, ttlMs), 'Release notes');
});

test('a binding never carries a name only someone else gave: the agent\'s preamble would repeat it', () => {
  assert.equal(getTrustedPendingTopicName(strangerName, nowMs, ttlMs), undefined);
});

test('an expired or missing name is no name', () => {
  assert.equal(getTrustedPendingTopicName({ ...adminName, ts: nowMs - ttlMs - 1 }, nowMs, ttlMs), undefined);
  assert.equal(getTrustedPendingTopicName(undefined, nowMs, ttlMs), undefined);
});
