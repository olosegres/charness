/**
 * @description The request merge key (`requests/requestGroup.ts`): a request
 * supersedes an earlier open one only within the same group — the conversation
 * (surface + topic / thread / issue, the `SessionKey`) plus the requester — and
 * the persisted form of that key round-trips, including entries written before
 * requesters existed (a bare conversation key).
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getRequestGroupKey,
  getRequestRequester,
  requestGroupKeyToString,
  requestRequesterAttribute,
  tryRequestGroupKeyFromString,
} from '../requests/requestGroup';
import { keyToString } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { makeTestKey, registerTestSessionKeyCodec } from '../connectors/test/sessionKeyCodec';

const topicKey = makeTelegramKey(-1001234567890, 42);

describe('getRequestGroupKey', () => {
  it('is the conversation plus the requester named in the origin', () => {
    const group = getRequestGroupKey(topicKey, { kind: 'message', attributes: { [requestRequesterAttribute]: '424242', source: 'text' } });
    assert.deepEqual(group, { conversation: topicKey, requester: '424242' });
  });

  it('an origin without a requester has the empty requester', () => {
    assert.equal(getRequestRequester({ kind: 'scheduledRun', attributes: {} }), '');
    assert.deepEqual(getRequestGroupKey(topicKey, { kind: 'scheduledRun', attributes: {} }), { conversation: topicKey, requester: '' });
  });
});

describe('requestGroupKeyToString / tryRequestGroupKeyFromString', () => {
  it('round-trips a group with a requester, and one with the empty requester reads as the bare conversation key', () => {
    const withRequester = requestGroupKeyToString({ conversation: topicKey, requester: '424242' });
    assert.ok(withRequester.startsWith(keyToString(topicKey)));
    assert.notEqual(withRequester, requestGroupKeyToString({ conversation: topicKey, requester: '535353' }), 'another person in the same topic is another group');
    assert.notEqual(withRequester, requestGroupKeyToString({ conversation: makeTelegramKey(-1001234567890, 99), requester: '424242' }), 'the same person in another topic is another group');
    assert.deepEqual(tryRequestGroupKeyFromString(withRequester), { conversation: topicKey, requester: '424242' });
    assert.equal(requestGroupKeyToString({ conversation: topicKey, requester: '' }), keyToString(topicKey), 'a pre-requester state.json field reads back unchanged');
    assert.deepEqual(tryRequestGroupKeyFromString(keyToString(topicKey)), { conversation: topicKey, requester: '' });
  });

  it('a requester containing the separator or key characters survives the round trip', () => {
    const requester = 'acc:ount|with\u001fodd chars';
    const serialized = requestGroupKeyToString({ conversation: topicKey, requester });
    assert.deepEqual(tryRequestGroupKeyFromString(serialized), { conversation: topicKey, requester });
  });

  it('a conversation key of another platform, even one using "|" itself, round-trips', () => {
    registerTestSessionKeyCodec();
    const trackerKey = makeTestKey('PROJ', 'PROJ-123');
    const serialized = requestGroupKeyToString({ conversation: trackerKey, requester: '712020:abc' });
    assert.deepEqual(tryRequestGroupKeyFromString(serialized), { conversation: trackerKey, requester: '712020:abc' });
  });

  it('a field of no registered platform is null, never a throw', () => {
    assert.equal(tryRequestGroupKeyFromString('nonsense'), null);
  });
});
