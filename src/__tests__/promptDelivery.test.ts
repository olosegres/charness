/**
 * @description The "buffer-or-forward" unit (`utils/promptDelivery.ts`) every
 * prompt that may reach a session still starting goes through — file intake,
 * `/schedule`, the Jira connector's posts and an API-error retry's "continue"
 * nudge. Load-bearing: a prompt for a starting session is BUFFERED (a direct
 * forward would hit an adapter that is not there yet and be lost), replays in
 * order, and the "queued" notice is a topic message — it must not be sent for a
 * Jira issue (R6).
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { keyToString, unregisterSessionKeyCodec, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { makeTestKey, registerTestSessionKeyCodec } from '../connectors/test/sessionKeyCodec';
import { StartupPromptBuffer } from '../startupPromptBuffer';
import { deliverPromptOrBuffer, type PromptDeliveryDeps } from '../utils/promptDelivery';

registerTestSessionKeyCodec();
process.on('exit', () => unregisterSessionKeyCodec('test'));

const topicKey: SessionKey = makeTelegramKey(-1001234567890, 42);
const issueKey: SessionKey = makeTestKey('PROJ', 'PROJ-7');

let startupBuffer: StartupPromptBuffer;
let forwarded: Array<{ key: SessionKey; text: string }>;
let announced: SessionKey[];
let deps: PromptDeliveryDeps;

beforeEach(() => {
  startupBuffer = new StartupPromptBuffer();
  forwarded = [];
  announced = [];
  deps = {
    startupBuffer,
    forwardPrompt: async (key, text) => { forwarded.push({ key, text }); },
    announceQueued: async (key) => { announced.push(key); },
  };
});

describe('deliverPromptOrBuffer', () => {
  it('forwards at once to a session that is not starting — nothing buffered, nothing announced', async () => {
    await deliverPromptOrBuffer(deps, topicKey, 'hello', false);

    assert.deepEqual(forwarded, [{ key: topicKey, text: 'hello' }]);
    assert.deepEqual(announced, []);
    assert.deepEqual(startupBuffer.drainPrompts(keyToString(topicKey)), []);
  });

  it('buffers for a starting session instead of forwarding — it replays in arrival order once the session is up', async () => {
    startupBuffer.markStarting(keyToString(topicKey));

    await deliverPromptOrBuffer(deps, topicKey, 'first', true);
    await deliverPromptOrBuffer(deps, topicKey, 'second', true);

    assert.deepEqual(forwarded, [], 'a direct forward would reach an adapter that is not there yet');
    assert.deepEqual(startupBuffer.drainPrompts(keyToString(topicKey)), ['first', 'second']);
  });

  it('tells a Telegram topic once per startup window that the prompt is queued', async () => {
    startupBuffer.markStarting(keyToString(topicKey));

    await deliverPromptOrBuffer(deps, topicKey, 'first', true);
    await deliverPromptOrBuffer(deps, topicKey, 'second', true);
    assert.deepEqual(announced, [topicKey]);

    startupBuffer.drainPrompts(keyToString(topicKey));
    startupBuffer.markStarting(keyToString(topicKey));
    await deliverPromptOrBuffer(deps, topicKey, 'next window', true);
    assert.deepEqual(announced, [topicKey, topicKey], 'a new startup window announces again');
  });

  it('buffers a Jira issue\'s prompt without the topic notice — an issue has no topic to say it in (R6)', async () => {
    startupBuffer.markStarting(keyToString(issueKey));

    await deliverPromptOrBuffer(deps, issueKey, 'the nudge', true);

    assert.deepEqual(announced, []);
    assert.deepEqual(forwarded, []);
    assert.deepEqual(startupBuffer.drainPrompts(keyToString(issueKey)), ['the nudge'], 'it is still buffered, not dropped');
  });

  it('forwards a Jira issue\'s prompt to a session that is up', async () => {
    await deliverPromptOrBuffer(deps, issueKey, 'the nudge', false);

    assert.deepEqual(forwarded, [{ key: issueKey, text: 'the nudge' }]);
  });
});

describe('the bot buffers a prompt for a starting session through it, in one place', () => {
  const botSource = fs.readFileSync(path.join(__dirname, '..', 'bot.ts'), 'utf8');

  it('there is no second copy of the buffer-and-announce logic', () => {
    assert.doesNotMatch(botSource, /startupPromptBuffer\.addPrompt\(/);
    assert.equal(botSource.match(/agent\.queued_starting/g)?.length, 1, 'the notice is built in one place');
  });

  it('the text and voice handlers hand a mid-startup prompt to it', () => {
    assert.match(botSource, /await deliverPromptOrBuffer\(key, text, true\);/);
    assert.match(botSource, /await deliverPromptOrBuffer\(key, transcript, true\);/);
  });
});
