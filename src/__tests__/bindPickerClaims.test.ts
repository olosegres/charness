import test from 'node:test';
import assert from 'node:assert/strict';
import { BindPickerClaims } from '../connectors/telegram/bindPickerClaims';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';

const topicKey = makeTelegramKey(-1001111111111, 191);
const otherChatKey = makeTelegramKey(-1002222222222, 191);

test('of two claims on the same picker message the first wins', () => {
  const claims = new BindPickerClaims();
  assert.equal(claims.claim(topicKey, 500), true);
  assert.equal(claims.claim(topicKey, 500), false);
});

test('another message, or the same message id in another chat, is another picker', () => {
  const claims = new BindPickerClaims();
  assert.equal(claims.claim(topicKey, 500), true);
  assert.equal(claims.claim(topicKey, 501), true);
  assert.equal(claims.claim(otherChatKey, 500), true);
});

test('a refused bind gives its claim back: the picker can be used again', () => {
  const claims = new BindPickerClaims();
  assert.equal(claims.claim(topicKey, 500), true);
  claims.release(topicKey, 500);
  assert.equal(claims.claim(topicKey, 500), true);
});

test('releasing a claim nobody holds is harmless', () => {
  const claims = new BindPickerClaims();
  claims.release(topicKey, 500);
  assert.equal(claims.claim(topicKey, 500), true);
});

test('only the newest claims are kept: the oldest is dropped past the limit', () => {
  const claims = new BindPickerClaims(2);
  assert.equal(claims.claim(topicKey, 1), true);
  assert.equal(claims.claim(topicKey, 2), true);
  assert.equal(claims.claim(topicKey, 3), true);
  assert.equal(claims.claim(topicKey, 3), false, 'the newest is held');
  assert.equal(claims.claim(topicKey, 1), true, 'the oldest was dropped');
});
