/**
 * @description The "buffer-or-forward" unit (`utils/promptDelivery.ts`) every
 * prompt that may reach a session still starting goes through — file intake,
 * `/schedule`, the Jira connector's posts and an API-error retry's "continue"
 * nudge. Load-bearing: a prompt for a starting session is BUFFERED (a direct
 * forward would hit an adapter that is not there yet and be lost), replays in
 * order, and the "queued" notice is a topic message — it must not be sent for a
 * Jira issue (R6).
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { keyToString, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { makeJiraKey } from '../connectors/jira/sessionKeyCodec';
import { StartupPromptBuffer, type BufferedPromptOutcome } from '../startupPromptBuffer';
import { deliverPromptOrBuffer, type PromptDeliveryDeps } from '../utils/promptDelivery';

const topicKey: SessionKey = makeTelegramKey(-1001234567890, 42);
const issueKey: SessionKey = makeJiraKey('PROJ-7');

/** Close the startup window the way a successful start does; what reached the session, in order. */
async function replayTexts(buffer: StartupPromptBuffer, key: SessionKey): Promise<string[]> {
  const texts: string[] = [];
  await buffer.replayPrompts(keyToString(key), { isSessionActive: true, forward: async (text) => { texts.push(text); } });
  return texts;
}

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
    const delivery = await deliverPromptOrBuffer(deps, topicKey, 'hello', false);

    assert.equal(delivery, 'forwarded');
    assert.deepEqual(forwarded, [{ key: topicKey, text: 'hello' }]);
    assert.deepEqual(announced, []);
    assert.deepEqual(await replayTexts(startupBuffer, topicKey), []);
  });

  it('buffers for a starting session instead of forwarding — it replays in arrival order once the session is up', async () => {
    startupBuffer.markStarting(keyToString(topicKey));

    const first = await deliverPromptOrBuffer(deps, topicKey, 'first', true);
    await deliverPromptOrBuffer(deps, topicKey, 'second', true);

    assert.equal(first, 'buffered');
    assert.deepEqual(forwarded, [], 'a direct forward would reach an adapter that is not there yet');
    assert.deepEqual(await replayTexts(startupBuffer, topicKey), ['first', 'second']);
  });

  it('tells a buffered prompt\'s caller how the wait ended: replayed once the session is up, dropped when the start fails', async () => {
    const outcomes: BufferedPromptOutcome[] = [];
    startupBuffer.markStarting(keyToString(topicKey));
    await deliverPromptOrBuffer(deps, topicKey, 'replayed one', true, (outcome) => outcomes.push(outcome));
    assert.equal(outcomes.length, 0, 'not before the window ends');
    await replayTexts(startupBuffer, topicKey);
    assert.deepEqual(outcomes, ['replayed']);

    startupBuffer.markStarting(keyToString(topicKey));
    await deliverPromptOrBuffer(deps, topicKey, 'dropped one', true, (outcome) => outcomes.push(outcome));
    startupBuffer.discardPrompts(keyToString(topicKey));
    assert.deepEqual(outcomes, ['replayed', 'dropped']);
  });

  it('a "queued" notice that fails is logged; the prompt is still buffered and its caller still hears how the wait ends', async () => {
    const outcomes: BufferedPromptOutcome[] = [];
    startupBuffer.markStarting(keyToString(topicKey));
    const logged = mock.method(console, 'error', () => {});
    let delivery: Awaited<ReturnType<typeof deliverPromptOrBuffer>>;
    try {
      delivery = await deliverPromptOrBuffer(
        { ...deps, announceQueued: async () => { throw new Error('notice failed'); } },
        topicKey,
        'the nudge',
        true,
        (outcome) => outcomes.push(outcome),
      );
      assert.equal(logged.mock.calls.length, 1);
    } finally {
      logged.mock.restore();
    }
    assert.equal(delivery, 'buffered', 'the notice is not the delivery');
    assert.deepEqual(await replayTexts(startupBuffer, topicKey), ['the nudge']);
    assert.deepEqual(outcomes, ['replayed']);
  });

  it('a prompt forwarded at once has no wait to tell about: the callback is not called', async () => {
    const outcomes: BufferedPromptOutcome[] = [];
    await deliverPromptOrBuffer(deps, topicKey, 'now', false, (outcome) => outcomes.push(outcome));
    assert.equal(outcomes.length, 0);
  });

  it('tells a Telegram topic once per startup window that the prompt is queued', async () => {
    startupBuffer.markStarting(keyToString(topicKey));

    await deliverPromptOrBuffer(deps, topicKey, 'first', true);
    await deliverPromptOrBuffer(deps, topicKey, 'second', true);
    assert.deepEqual(announced, [topicKey]);

    await replayTexts(startupBuffer, topicKey);
    startupBuffer.markStarting(keyToString(topicKey));
    await deliverPromptOrBuffer(deps, topicKey, 'next window', true);
    assert.deepEqual(announced, [topicKey, topicKey], 'a new startup window announces again');
  });

  it('buffers a Jira issue\'s prompt without the topic notice — an issue has no topic to say it in (R6)', async () => {
    startupBuffer.markStarting(keyToString(issueKey));

    await deliverPromptOrBuffer(deps, issueKey, 'the nudge', true);

    assert.deepEqual(announced, []);
    assert.deepEqual(forwarded, []);
    assert.deepEqual(await replayTexts(startupBuffer, issueKey), ['the nudge'], 'it is still buffered, not dropped');
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

  it('the text and voice handlers hand a mid-startup prompt to it, with the request header opened at capture time (S7)', () => {
    // Through one shared unit, which also folds the reply quote in at capture time
    // (`voiceReplyQuoteWiring.test.ts`): the replay forwards the buffered text as is.
    assert.match(botSource, /await bufferPromptDuringStartup\(key, text, \{ source: 'text'/);
    assert.match(botSource, /await bufferPromptDuringStartup\(key, transcript, \{ source: 'voice'/);
    assert.match(botSource, /await deliverPromptOrBuffer\(key, `\$\{opening\.header\}\$\{quotedText\}`, true\);/);
  });
});
