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

test('a claim is visible to whoever else is about to act on the picker, until it is given back', () => {
  const claims = new BindPickerClaims();
  assert.equal(claims.has(topicKey, 500), false);
  claims.claim(topicKey, 500);
  assert.equal(claims.has(topicKey, 500), true);
  assert.equal(claims.has(topicKey, 501), false);
  assert.equal(claims.has(otherChatKey, 500), false);
  claims.release(topicKey, 500);
  assert.equal(claims.has(topicKey, 500), false);
});

test('runClaimed runs the work holding the picker, and a finished one keeps it: the picker is spent', async () => {
  const claims = new BindPickerClaims();
  let wasHeldDuringWork = false;
  const outcome = await claims.runClaimed(topicKey, 500, async () => {
    wasHeldDuringWork = claims.has(topicKey, 500);
    return true;
  });
  assert.equal(outcome, 'done');
  assert.equal(wasHeldDuringWork, true);
  assert.equal(claims.has(topicKey, 500), true);
});

test('runClaimed on a held picker runs nothing and says it is busy', async () => {
  const claims = new BindPickerClaims();
  claims.claim(topicKey, 500);
  let ran = false;
  const outcome = await claims.runClaimed(topicKey, 500, async () => {
    ran = true;
    return true;
  });
  assert.equal(outcome, 'busy');
  assert.equal(ran, false);
});

test('runClaimed gives the picker back when the work did nothing (a refused bind)', async () => {
  const claims = new BindPickerClaims();
  assert.equal(await claims.runClaimed(topicKey, 500, async () => false), 'undone');
  assert.equal(claims.has(topicKey, 500), false);
  assert.equal(await claims.runClaimed(topicKey, 500, async () => true), 'done', 'and it works again');
});

test('runClaimed gives the picker back when the work throws — nothing between the claim and a finished bind can leave it held — and rethrows', async () => {
  const claims = new BindPickerClaims();
  await assert.rejects(claims.runClaimed(topicKey, 500, async () => {
    throw new Error('the answer was refused');
  }), /the answer was refused/);
  assert.equal(claims.has(topicKey, 500), false);
});

test('of two runs started together exactly one works: the claim is taken before the first await', async () => {
  const claims = new BindPickerClaims();
  let runs = 0;
  const work = async () => {
    runs += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return true;
  };
  const outcomes = await Promise.all([claims.runClaimed(topicKey, 500, work), claims.runClaimed(topicKey, 500, work)]);
  assert.deepEqual([...outcomes].sort(), ['busy', 'done']);
  assert.equal(runs, 1);
});

test('a message Telegram attached no id to is worked on unclaimed', async () => {
  const claims = new BindPickerClaims();
  assert.equal(await claims.runClaimed(topicKey, null, async () => true), 'done');
  assert.equal(await claims.runClaimed(topicKey, null, async () => false), 'undone');
});
