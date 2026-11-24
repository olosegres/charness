/**
 * @description The "buffer-or-forward" unit (`utils/promptDelivery.ts`) every prompt that may meet a session another caller is
 * starting or stopping goes through — a person's prompts (their buffer step), a scheduled run, the Jira connector's posts, the lost-work
 * post, an API-error retry's "continue" nudge, a move's first prompt. Load-bearing: the prompt is routed at the moment of its write —
 * BUFFERED behind an open window (a direct forward would hit an adapter that is not there yet and be lost), replayed in order, and NEVER
 * left in a window that closed while its caller awaited (it is forwarded, or the sleeping conversation woken for it); the "queued"
 * notice is a topic message — it must not be sent for a Jira issue (R6).
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
import { deliverLatePrompt, deliverPromptOrBuffer, getLatePromptRoute, type LatePromptDeliveryPorts, type LatePromptOutcome, type PromptDeliveryDeps, type PromptDeliveryOptions } from '../utils/promptDelivery';

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
/** What the delivery did besides forwarding, in order: `wake`, `reportNoSession(<alreadyTold>)`. */
let steps: string[];
/** Where the bot's forward puts a prompt (`forwardPromptToAgent`); only a prompt that waited for an adopt replay can come out as anything but `forwarded`. */
let forwardOutcome: LatePromptOutcome;
/** Whether the conversation's session is live at the moment of the write. */
let isSessionActive: boolean;
/** Whether a wake brings a session up (`wakeSleepingSessionForPrompt`). */
let isWakeOk: boolean;
/** Whether the wake found the conversation ended by a release while it waited in the queue. */
let isWakeEnded: boolean;
/** Whether a command ends or replaces the conversation now (`ConversationEndings.checkIsRefusingMessages`). */
let isRefusingMessages: boolean;
let deps: PromptDeliveryDeps;

beforeEach(() => {
  startupBuffer = new StartupPromptBuffer();
  forwarded = [];
  announced = [];
  steps = [];
  forwardOutcome = 'forwarded';
  isSessionActive = true;
  isWakeOk = true;
  isWakeEnded = false;
  isRefusingMessages = false;
  deps = {
    startupBuffer,
    forwardPrompt: async (key, text) => {
      forwarded.push({ key, text });
      return forwardOutcome;
    },
    checkIsSessionActive: () => isSessionActive,
    wakeSession: async () => {
      steps.push('wake');
      // A wake that works brings the session up.
      if (isWakeOk) isSessionActive = true;
      return { isAwake: isWakeOk, isNoticePosted: false, ...(isWakeEnded ? { isEnded: true } : {}) };
    },
    checkIsRefusingMessages: () => isRefusingMessages,
    reportNoSession: async (_key, isAlreadyTold) => { steps.push(`reportNoSession(${isAlreadyTold})`); },
    reportRefused: async (_key, options) => { steps.push(`reportRefused(${options.isPersonInput === true ? 'person' : 'bot'})`); },
    announceQueued: async (key) => { announced.push(key); },
  };
});

describe('deliverPromptOrBuffer: what a buffered prompt keeps', () => {
  it('the options travel with a buffered prompt to its replay — the accounts note\'s carrier flag, and the lost-work note\'s optional wording (review 14 #3) — and a prompt without them replays without them', async () => {
    startupBuffer.markStarting(keyToString(topicKey));
    await deliverPromptOrBuffer(deps, topicKey, 'a person\'s message', undefined, { isPersonInput: true, isAccountsNoteCarrier: true });
    await deliverPromptOrBuffer(deps, topicKey, 'a tracker fire', undefined, { isAccountsNoteCarrier: true, lostWorkTelling: 'runHeader' });
    await deliverPromptOrBuffer(deps, topicKey, 'a retry nudge');
    const replayed: Array<[string, PromptDeliveryOptions]> = [];
    await startupBuffer.replayPrompts(keyToString(topicKey), { isSessionActive: true, forward: async (text, options) => { replayed.push([text, options]); } });
    assert.deepEqual(replayed, [
      ['a person\'s message', { isPersonInput: true, isAccountsNoteCarrier: true }],
      ['a tracker fire', { isAccountsNoteCarrier: true, lostWorkTelling: 'runHeader' }],
      ['a retry nudge', {}],
    ]);
  });

  it('forwarded at once, the options reach the forward as they are', async () => {
    const seen: Array<{ isAccountsNoteCarrier?: boolean }> = [];
    await deliverPromptOrBuffer({ ...deps, forwardPrompt: async (_key, _text, options) => { seen.push(options); return 'forwarded'; } }, topicKey, 'hi', undefined, { isAccountsNoteCarrier: true });
    assert.deepEqual(seen, [{ isAccountsNoteCarrier: true }]);
  });
});

describe('deliverPromptOrBuffer', () => {
  it('forwards at once to a live session with no window open — nothing buffered, nothing announced, nothing woken', async () => {
    const delivery = await deliverPromptOrBuffer(deps, topicKey, 'hello');

    assert.equal(delivery, 'forwarded');
    assert.deepEqual(forwarded, [{ key: topicKey, text: 'hello' }]);
    assert.deepEqual(announced, []);
    assert.deepEqual(steps, []);
    assert.deepEqual(await replayTexts(startupBuffer, topicKey), []);
  });

  it('a forward that finds no session (the prompt waited for a bot restart\'s replay) reads as noSession, so the caller opens no turn for it', async () => {
    forwardOutcome = 'noSession';

    assert.equal(await deliverPromptOrBuffer(deps, topicKey, 'hello'), 'noSession');
    assert.equal(await deliverPromptOrBuffer(deps, issueKey, 'the nudge'), 'noSession', 'whatever the platform');
  });

  it('a forward that routed the prompt behind a stop window itself still reads as forwarded: no settle callback was registered for that buffer', async () => {
    forwardOutcome = 'buffered';

    assert.equal(await deliverPromptOrBuffer(deps, topicKey, 'hello'), 'forwarded');
  });

  it('a prompt buffered for a starting session never reads as noSession — the forward is not reached', async () => {
    forwardOutcome = 'noSession';
    startupBuffer.markStarting(keyToString(topicKey));

    assert.equal(await deliverPromptOrBuffer(deps, topicKey, 'hello'), 'buffered');
    assert.deepEqual(forwarded, []);
  });

  it('buffers for a starting session instead of forwarding — it replays in arrival order once the session is up', async () => {
    startupBuffer.markStarting(keyToString(topicKey));

    const first = await deliverPromptOrBuffer(deps, topicKey, 'first');
    await deliverPromptOrBuffer(deps, topicKey, 'second');

    assert.equal(first, 'buffered');
    assert.deepEqual(forwarded, [], 'a direct forward would reach an adapter that is not there yet');
    assert.deepEqual(await replayTexts(startupBuffer, topicKey), ['first', 'second']);
  });

  it('a stop\'s window that closed after the caller read it open never keeps the prompt: the sleeping conversation is woken and the prompt forwarded — nothing is left in the buffer (review 18 #1)', async () => {
    const outcomes: BufferedPromptOutcome[] = [];
    const threadId = keyToString(topicKey);
    startupBuffer.markStarting(threadId);
    assert.equal(startupBuffer.checkIsStarting(threadId), true, 'the caller read the window open when the prompt arrived');
    // During the caller's awaits (its request opened, a file downloaded) the stop ends: the process is gone.
    startupBuffer.closeWindow(threadId);
    isSessionActive = false;

    const delivery = await deliverPromptOrBuffer(deps, topicKey, 'a file sent while the process stopped', (outcome) => outcomes.push(outcome));

    assert.equal(delivery, 'forwarded');
    assert.deepEqual(steps, ['wake']);
    assert.deepEqual(forwarded, [{ key: topicKey, text: 'a file sent while the process stopped' }]);
    assert.equal(startupBuffer.checkHasPrompts(threadId), false, 'not orphaned in a buffer nobody replays');
    assert.equal(startupBuffer.checkIsAnyPending(), false);
    assert.deepEqual(outcomes, [], 'forwarded: no buffered wait to settle');
    assert.deepEqual(announced, [], 'no «queued» notice for a window that is gone');
  });

  it('a start\'s window whose replay already ran when the prompt is written: forwarded to the session it brought up, not added behind the replay (review 18 #1)', async () => {
    const threadId = keyToString(topicKey);
    startupBuffer.markStarting(threadId);
    await replayTexts(startupBuffer, topicKey);

    assert.equal(await deliverPromptOrBuffer(deps, topicKey, 'typed during the boot, written after it'), 'forwarded');
    assert.deepEqual(forwarded, [{ key: topicKey, text: 'typed during the boot, written after it' }]);
    assert.deepEqual(steps, [], 'the session is up: nothing to wake');
    assert.equal(startupBuffer.checkHasPrompts(threadId), false);
  });

  it('no window and nothing to wake: noSession, and the miss is reported with the prompt\'s own options', async () => {
    isSessionActive = false;
    isWakeOk = false;
    const reported: Array<[boolean, PromptDeliveryOptions]> = [];

    const delivery = await deliverPromptOrBuffer({ ...deps, reportNoSession: async (_key, isAlreadyTold, options) => { reported.push([isAlreadyTold, options]); } }, topicKey, 'hello', undefined, { isPersonInput: true });

    assert.equal(delivery, 'noSession');
    assert.deepEqual(forwarded, [], 'a forward would show the topic working over a dropped text');
    assert.deepEqual(reported, [[false, { isPersonInput: true }]]);
  });

  it('a buffer that refuses a prompt in the tick its window read open is a bug: the delivery throws instead of losing the prompt without a word (review 20 nit 5)', async () => {
    const refusingBuffer: PromptDeliveryDeps['startupBuffer'] = { checkIsStarting: () => true, addPrompt: () => 'refused' };

    await assert.rejects(deliverPromptOrBuffer({ ...deps, startupBuffer: refusingBuffer }, topicKey, 'hello'), /refused a prompt in the tick its window read open/);
    assert.deepEqual(forwarded, []);
    assert.deepEqual(announced, []);
  });

  it('a first buffered prompt resolves `buffered` without waiting for its «queued» notice: its caller watches the turn before any replay can write the prompt (review 20 #2)', async () => {
    const threadId = keyToString(topicKey);
    const order: string[] = [];
    let finishNotice: () => void = () => {};
    const notice = new Promise<void>((resolve) => { finishNotice = resolve; });
    startupBuffer.markStarting(threadId);

    const delivery = deliverPromptOrBuffer({ ...deps, announceQueued: () => notice }, topicKey, 'the first message of the window').then((result) => {
      // The caller's next step: `settleTopicRequestAfterDelivery` watches the request's turn.
      order.push(`tracked (${result})`);
      return result;
    });
    await new Promise((resolve) => setImmediate(resolve));
    // The paced notice is still on its way when the start ends and its replay writes the prompt.
    await startupBuffer.replayPrompts(threadId, { isSessionActive: true, forward: async (text) => { order.push(`replayed: ${text}`); } });
    finishNotice();
    assert.equal(await delivery, 'buffered');
    assert.deepEqual(order, ['tracked (buffered)', 'replayed: the first message of the window'], 'watched before its replay, whatever the notice takes');
  });

  it('tells a buffered prompt\'s caller how the wait ended: replayed once the session is up, dropped when the start fails', async () => {
    const outcomes: BufferedPromptOutcome[] = [];
    startupBuffer.markStarting(keyToString(topicKey));
    await deliverPromptOrBuffer(deps, topicKey, 'replayed one', (outcome) => outcomes.push(outcome));
    assert.equal(outcomes.length, 0, 'not before the window ends');
    await replayTexts(startupBuffer, topicKey);
    assert.deepEqual(outcomes, ['replayed']);

    startupBuffer.markStarting(keyToString(topicKey));
    await deliverPromptOrBuffer(deps, topicKey, 'dropped one', (outcome) => outcomes.push(outcome));
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
        (outcome) => outcomes.push(outcome),
      );
      // Not awaited by the delivery: its failure is logged once it lands.
      await new Promise((resolve) => setImmediate(resolve));
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
    await deliverPromptOrBuffer(deps, topicKey, 'now', (outcome) => outcomes.push(outcome));
    assert.equal(outcomes.length, 0);
  });

  it('tells a Telegram topic once per startup window that the prompt is queued', async () => {
    startupBuffer.markStarting(keyToString(topicKey));

    await deliverPromptOrBuffer(deps, topicKey, 'first');
    await deliverPromptOrBuffer(deps, topicKey, 'second');
    assert.deepEqual(announced, [topicKey]);

    await replayTexts(startupBuffer, topicKey);
    startupBuffer.markStarting(keyToString(topicKey));
    await deliverPromptOrBuffer(deps, topicKey, 'next window');
    assert.deepEqual(announced, [topicKey, topicKey], 'a new startup window announces again');
  });

  it('buffers a Jira issue\'s prompt without the topic notice — an issue has no topic to say it in (R6)', async () => {
    startupBuffer.markStarting(keyToString(issueKey));

    await deliverPromptOrBuffer(deps, issueKey, 'the nudge');

    assert.deepEqual(announced, []);
    assert.deepEqual(forwarded, []);
    assert.deepEqual(await replayTexts(startupBuffer, issueKey), ['the nudge'], 'it is still buffered, not dropped');
  });

  it('forwards a Jira issue\'s prompt to a session that is up', async () => {
    await deliverPromptOrBuffer(deps, issueKey, 'the nudge');

    assert.deepEqual(forwarded, [{ key: issueKey, text: 'the nudge' }]);
  });
});

describe('deliverPromptOrBuffer while a command ends or replaces the conversation (review 25 #1, #2)', () => {
  it('a person\'s prompt is refused ahead of everything — even an open window: nothing buffered, forwarded or woken, and the person told the ending command\'s line', async () => {
    isRefusingMessages = true;
    startupBuffer.markStarting(keyToString(topicKey));
    assert.equal(await deliverPromptOrBuffer(deps, topicKey, 'hello', undefined, { isPersonInput: true }), 'noSession');
    assert.deepEqual(steps, ['reportRefused(person)']);
    assert.deepEqual(forwarded, []);
    assert.equal(startupBuffer.checkHasPrompts(keyToString(topicKey)), false, 'never waits in the window of what the command starts');
  });

  it('a bot-made prompt is not refused: the move\'s own first prompt, a fire, a «continue» go their usual way and are settled by their callers', async () => {
    isRefusingMessages = true;
    assert.equal(await deliverPromptOrBuffer(deps, topicKey, 'the bridge'), 'forwarded');
    assert.deepEqual(forwarded.map((entry) => entry.text), ['the bridge']);
    startupBuffer.markStarting(keyToString(topicKey));
    assert.equal(await deliverPromptOrBuffer(deps, topicKey, 'a fire'), 'buffered');
    assert.deepEqual(steps, []);
  });

  it('a wake that found the conversation released while it waited in the queue: nothing is forwarded; a person told the ending command\'s line, a bot prompt\'s miss reported as no session', async () => {
    isSessionActive = false;
    isWakeOk = false;
    isWakeEnded = true;
    assert.equal(await deliverPromptOrBuffer(deps, topicKey, 'hello', undefined, { isPersonInput: true }), 'noSession');
    assert.deepEqual(steps, ['wake', 'reportRefused(person)']);
    steps = [];
    assert.equal(await deliverPromptOrBuffer(deps, topicKey, 'a fire'), 'noSession');
    assert.deepEqual(steps, ['wake', 'reportRefused(bot)']);
    assert.deepEqual(forwarded, []);
  });
});

describe('the bot buffers a prompt for a starting session through it, in one place', () => {
  const botSource = fs.readFileSync(path.join(__dirname, '..', 'bot.ts'), 'utf8');
  const getBody = (start: string, end: string): string => botSource.slice(botSource.indexOf(start), botSource.indexOf(end));

  it('there is no second copy of the buffer-and-announce logic', () => {
    assert.doesNotMatch(botSource, /startupPromptBuffer\.addPrompt\(/);
    assert.equal(botSource.match(/agent\.queued_starting/g)?.length, 1, 'the notice is built in one place');
  });

  it('every person prompt — text, voice, a file, an album, `/schedule` — is routed at its write, through one helper: nothing hands the delivery a window read before an await (review 18 #1)', () => {
    // A prompt that arrived in a window only takes the route that does not look at a pending question; its write is routed later.
    assert.match(botSource, /await deliverPromptDuringStartup\(key, text, \{ source: 'text'/);
    assert.match(botSource, /await deliverPromptDuringStartup\(key, transcript, \{ source: 'voice'/);
    assert.match(getBody('async function deliverPromptDuringStartup(', 'async function deliverActivePrompt('), /notePersonActivity\(key\);\n\s*await deliverPromptByState\(key, text, intake, undefined, messageContext\);\n\}/);
    for (const call of [
      "await deliverPromptByState(key, wrappedPrompt, { source: 'schedule', requesterId: getTopicRequesterId(ctx.from) });",
      "await deliverPromptByState(key, promptText, { source: 'album', requesterId: orderedItems[0].requesterId }, undefined, messageContext);",
      "await deliverPromptByState(key, promptText, { source: 'file', requesterId: getTopicRequesterId(ctx.from) }, undefined, messageContext);",
    ]) assert.ok(botSource.includes(call), call);
    // The helper opens the request first and routes the write after it, by what the session is then.
    assert.match(
      getBody('async function deliverPromptByState(', 'function deliverPersonPromptAtWrite('),
      /const opening = await openTopicRequest\(key, text, intake, messageContext\);\n(?:\s*\/\/[^\n]*\n)*\s*const outcome = await deliverPersonPromptAtWrite\(key, text, \{ opening, sentAtMs, messageContext, isAccountsNoteCarrier: intake !== null \}\);\n\s*await settleTopicRequestAfterDelivery\(key, opening, outcome\);\n\s*return outcome;/,
    );
    // No delivery is given a window state at all; the one stale read the file path had is gone (its gate reads the window itself).
    assert.doesNotMatch(botSource, /deliverPromptOrBuffer\([^;]*checkIsStarting/);
    assert.doesNotMatch(botSource, /deliverPromptOrBuffer\([^;]*`,\s*(?:true|false|isStarting),/);
    assert.doesNotMatch(botSource, /const isStarting = /);
    assert.ok(getBody('function deliverPromptOrBuffer(', 'interface AlbumCollectorItem').includes('return deliverPromptWithDeps(promptDeliveryDeps, key, promptText, onBufferedSettled, options);'));
  });

  it('a person\'s prompt is written by what the session is at the write: buffered behind a window, forwarded to a live session, a sleeping one woken', () => {
    // The race the re-ask flow hit: a tap read a live process, the idle stop ran during the tap's awaits, and the label
    // was forwarded to a session that was gone — dropped. The behaviour is `deliverLatePrompt`'s (below) and the e2e's.
    const atWrite = getBody('function deliverPersonPromptAtWrite(', 'function createPersonBufferedSettle(');
    assert.ok(atWrite.includes('return deliverLatePrompt({'));
    assert.ok(atWrite.includes('checkIsWindowOpen: () => startupPromptBuffer.checkIsStarting(keyToString(key)),'));
    assert.ok(atWrite.includes('checkIsSessionActive: () => checkIsAcceptingInput(key),'), 'the adapter the topic runs NOW (`checkIsAcceptingInput` reads it at the call)');
    assert.ok(atWrite.includes('const bufferedText = `${requestHeader}${getPromptWithThreadMessageContext(key, text, messageContext)}`;'), 'buffered with its header and context folded in');
    assert.ok(atWrite.includes('await deliverPromptOrBuffer(key, bufferedText, createPersonBufferedSettle(key, requestId), { isPersonInput: true, isAccountsNoteCarrier });'), 'a dropped one is told about and closes its request');
    assert.ok(atWrite.includes('forward: () => forwardPromptToAgent(key, getThreadAdapter(key), text, sentAtMs, { messageContext, requestHeader, requestId, isPersonInput: true, isAccountsNoteCarrier }),'), 'the forward\'s own outcome is the answer');
    assert.match(atWrite, /reportNoSession: async \(isAlreadyTold\) => \{\n\s*if \(!isAlreadyTold\) await replyToThread\(key, t\('agent\.no_session'\)\);\n\s*\},/, 'the topic is told once; the request is settled by the caller, for the wake and the forward alike');
    assert.ok(atWrite.includes('wake: () => wakeSleepingSessionForPrompt(key),'), 'the wake says whether its start already posted why it failed');
    assert.doesNotMatch(atWrite, /closeRequest|trackTopicRequestTurn|settleTopicRequestAfterDelivery/, 'the request is closed or tracked in one place');
    // The free text that cancels a pending question is written the same way: the SIGINT ended the turn, and a per-turn stop may follow.
    const cancel = getBody('async function cancelPendingQuestionAndForward(', 'async function applyQuestionAnswer(');
    assert.ok(cancel.includes('return deliverPersonPromptAtWrite(key, text, { opening, sentAtMs, messageContext, isAccountsNoteCarrier });'));
    assert.doesNotMatch(cancel, /forwardPromptToAgent\(/);
  });

  it('the delivery ports read the session at the write and return where the prompt went, with no wrapper that throws the answer away', () => {
    assert.ok(botSource.includes('forwardPrompt: (key, text, options) => forwardPromptToAgent(key, getThreadAdapter(key), text, undefined, { isPersonInput: options.isPersonInput, isAccountsNoteCarrier: options.isAccountsNoteCarrier, lostWorkTelling: options.lostWorkTelling }),'));
    assert.ok(botSource.includes('checkIsSessionActive: (key) => checkIsAcceptingInput(key),'));
    assert.match(botSource, /wakeSession: \(key\) => \(checkIsTelegramKey\(key\)\n\s*\? wakeSleepingSessionForPrompt\(key\)\n\s*: wakeSleepingSessionForPrompt\(key, async \(notice\) => \{ console\.log\(/, 'a tracker conversation\'s resume notice is logged, never sent to Telegram');
    // A session post whose prompt found no session and nothing to wake is a failed post (its caller retries it), never one that reads as written.
    for (const name of ['createSessionPostDeps', 'createLostWorkPostDeps']) {
      assert.match(getBody(`function ${name}(`, name === 'createSessionPostDeps' ? 'async function forwardScheduledRun(' : 'function createBufferedOutcome('), /if \(delivery === 'noSession'\) throw new Error\(noSessionForPostError\);/, name);
    }
    assert.match(botSource, /if \(options\.isPersonInput === true && !isAlreadyTold\) await replyToThread\(key, t\('agent\.no_session'\)\);/, 'only a person\'s own prompt is told about in the topic');
    assert.ok(botSource.includes('const outcome = await forwardPromptToAgent(key, adapter, prompt, undefined, options);'), 'a buffered prompt is replayed with the options it was buffered with');
    assert.doesNotMatch(botSource, /forwardPrompt: async \(key, text\) => \{ await forwardPromptToAgent/);
    assert.match(getBody('async function cancelPendingQuestionAndForward(', 'async function applyQuestionAnswer('), /\): Promise<LatePromptOutcome> \{/);
  });

  it('a scheduled run\'s two forwards fail when their prompt found no session, like every session post: the run records the error, and a check\'s lost failure wake clears its flag (review 21 #2)', () => {
    const ridingFire = getBody('async function forwardScheduledRun(', 'async function forwardTopicSchedulerRequestRun(');
    assert.match(ridingFire, /if \(delivery === 'noSession'\) throw new Error\(noSessionForPostError\);/, 'a fire riding a request');
    assert.ok(ridingFire.indexOf('throw new Error(noSessionForPostError)') < ridingFire.indexOf('trackForwardedTurn'), 'it fails before any watch is made');
    const openingFire = getBody('async function forwardTopicSchedulerRequestRun(', 'function wireScheduler(');
    assert.match(openingFire, /if \(delivery === 'noSession'\) throw new Error\(noSessionForPostError\);/, 'a fire that opens the scheduler\'s request');
    assert.ok(
      openingFire.indexOf('await settleTopicRequestAfterDelivery(key, { ...opening, isScheduledRun: true }, delivery);') < openingFire.indexOf('throw new Error(noSessionForPostError)'),
      'the scheduler\'s request nobody was told about is closed first, then the fire fails',
    );
  });

  it('the engine\'s wake, the answer-tail reminder and the replay\'s write fail when their prompt found no session: no watch for a turn that never started, no «replayed» for a prompt no agent got (review 21, own pass)', () => {
    const wake = getBody('async function forwardRequestWakeUp(', 'async function remindAnswerTail(');
    assert.match(wake, /const outcome = await forwardPromptToAgent\(key, getThreadAdapter\(key\), message\.text, undefined, \{/);
    assert.match(wake, /if \(outcome === 'noSession'\) throw new Error\(noSessionForPostError\);/, 'a wake that reached no session is a failed wake (R28 retry, the backstop, or `wakeFailed`), never tracked');
    const tail = getBody('async function remindAnswerTail(', 'const probeThreadTurn =');
    assert.match(tail, /return \(await forwardPromptToAgent\(key, getThreadAdapter\(key\), text, undefined, \{ isRequestReminder: true \}\)\) !== 'noSession';/, 'the answer tail reads as not reached');
    const replay = getBody('async function replayBufferedPrompts(', 'async function forwardPromptToLiveAgent(');
    assert.match(replay, /forward: async \(prompt, options\) => \{\n\s*const outcome = await forwardPromptToAgent\(key, adapter, prompt, undefined, options\);\n(?:\s*\/\/[^\n]*\n)*\s*if \(outcome === 'noSession'\) throw new Error\(noSessionForPostError\);\n\s*\},/, 'the buffer settles it `dropped`');
  });

  it('a request is settled by where its prompt went: tracked, or closed when no session was left to take it', () => {
    // The behaviour is `requests/topicRequestSettle.ts`'s (`topicRequestSettle.test.ts`): a prompt that found no session (it waited for
    // a bot restart's replay; the person was told) must not leave a request open, or the wake-up engine prods the agent later for a
    // turn that never started. Here: the bot wires the engine and the ledger into it, and every site settles through it.
    assert.match(botSource, /const \{ settleAfterDelivery: settleTopicRequestAfterDelivery \} = createTopicRequestSettler\(\{/);
    assert.ok(botSource.includes("await requestWakeUpEngine?.trackForwardedTurn(key, requestId, { isRequestPrompt: true, isScheduledRun });"), 'the engine watches the turn as a request prompt — a scheduled run\'s when the opening says so');
    assert.ok(botSource.includes("await topicRequestLedger?.closeRequest(requestId, 'cancelled');"), 'the ledger closes the request as cancelled');
    // Every site that opens a request and hands its prompt on settles it through the helper — the turn is never tracked directly.
    assert.doesNotMatch(botSource, /trackTopicRequestTurn/);
    assert.ok(botSource.includes('const delivery = await cancelPendingQuestionAndForward(key, adapter, text, sentAtMs, messageContext, opening, intake !== null);\n    await settleTopicRequestAfterDelivery(key, opening, delivery);'), 'free text that cancels a pending question');
    assert.equal(botSource.match(/await settleTopicRequestAfterDelivery\(key, opening, /g)?.length, 3, 'the person\'s one helper, the question-cancelling text, and the scheduler\'s request whose prompt a window dropped');
    // The scheduler's request a fire opened settles the same way, as that fire's scheduled run (`src/requests/README.md` § Scheduled
    // runs); a session post waits for the buffered prompt's replay as well (it must not count a prompt that never arrived): `buffered.settle`.
    assert.match(
      botSource.slice(botSource.indexOf('async function forwardTopicSchedulerRequestRun('), botSource.indexOf('async function forwardTopicSchedulerRequestRun(') + 1500),
      /const delivery = await deliverPromptOrBuffer\(key, `\$\{opening\.header\}\$\{text\}`, buffered\.settle, \{ isAccountsNoteCarrier: true \}\);\n(?:\s*\/\/[^\n]*\n)*\s*if \(delivery === 'buffered' && \(await buffered\.getOutcome\(\)\) === 'dropped'\) \{\n\s*await settleTopicRequestAfterDelivery\(key, opening, 'noSession'\);\n\s*throw new Error\(bufferedPromptDroppedError\);\n\s*\}\n\s*await settleTopicRequestAfterDelivery\(key, \{ \.\.\.opening, isScheduledRun: true \}, delivery\);/,
      'watched only once its prompt reached the session; a dropped one closes the scheduler\'s request (review 20 #1)',
    );
    assert.equal(botSource.match(/await settleTopicRequestAfterDelivery\(key, \{ \.\.\.opening, isScheduledRun: true \}, /g)?.length, 1, 'only the scheduler\'s request');
  });
});

describe('a startup window\'s prompts on every way out of it (review 19 #1)', () => {
  const botSource = fs.readFileSync(path.join(__dirname, '..', 'bot.ts'), 'utf8');
  const getBody = (start: string, end: string): string => botSource.slice(botSource.indexOf(start), botSource.indexOf(end));

  it('a failed resume keeps its window and what it holds: a fresh start that follows takes it over, a way that starts nothing discards it', () => {
    const resume = getBody('async function resumeSleepingSession(', 'function wakeSleepingSession(');
    assert.doesNotMatch(resume, /discardPrompts/, 'the resume drops nothing itself');
    assert.ok(resume.indexOf("if (!adapter.checkIsActive(key)) return 'refused';") > 0 && resume.indexOf("if (!adapter.checkIsActive(key)) return 'refused';") < resume.indexOf('void replayBufferedPrompts(key);'), 'a resume that did not come up replays nothing (a replay into a dead session drops every prompt)');
    const ensure = getBody('async function ensureAgentSessionNow(', 'function getResumableSessionId(');
    const resumeCase = ensure.slice(ensure.indexOf("case 'resume': {"), ensure.indexOf("case 'start': {"));
    assert.match(resumeCase, /if \(failureAction === 'reportUnavailable'\) \{\n\s*startupPromptBuffer\.discardPrompts\(keyToString\(key\)\);/);
    assert.match(resumeCase, /if \(failureAction === 'fail'\) \{\n\s*startupPromptBuffer\.discardPrompts\(keyToString\(key\)\);/);
    assert.equal(resumeCase.match(/discardPrompts\(/g)?.length, 2, 'the fresh start is not preceded by a discard: its replay writes the people\'s prompts the resume held');
    assert.match(resumeCase, /startupPromptBuffer\.discardBotPrompts\(keyToString\(key\)\);\n\s*const startMessage = await startAgentSession\(key, options\.args\);/, 'what the bot made for the lost conversation is dropped first, for its caller to post again');
    const start = getBody('async function startAgentSession(', 'function getAgentStartFailureText(');
    assert.match(start, /if \(!workDirDecision\.ok\) \{\n(?:\s*\/\/[^\n]*\n)*\s*startupPromptBuffer\.discardPrompts\(kStr\);\n\s*return workDirDecision\.message;/, 'a start that cannot run discards the window it was to take over');
    assert.equal(start.match(/startupPromptBuffer\.discardPrompts\(kStr\);/g)?.length, 2, 'that, and the start that threw');
  });

  it('an idle stop\'s held prompts go to the resume whatever the stop\'s end — also when it threw — and a conversation released during the stop starts nothing for them (review 19 nit 3)', () => {
    const suspend = getBody('async function suspendThreadSession(', 'const autoStopUnsupportedLoggedKeys');
    assert.match(suspend, /\} finally \{\n\s*startupPromptBuffer\.closeWindow\(kStr\);\n(?:\s*\/\/[^\n]*\n)*\s*await resumeForHeldPrompts\(key\);\n\s*\}\n\s*\}\);/, 'inside the stop\'s own transition, in the finally of the stop (review 20 nit 3)');
    assert.match(suspend, /\} finally \{\n(?:\s*\/\/[^\n]*\n)*\s*rearmThreadIdleTimer\(key\);\n\s*\}\n\}/);
    const resume = getBody('async function resumeForHeldPrompts(', 'const autoStopUnsupportedLoggedKeys');
    assert.match(resume, /if \(!startupPromptBuffer\.checkHasPrompts\(kStr\)\) return;\n\s*if \(conversationEndings\.checkIsEnding\(kStr\) \|\| getResumableSessionId\(key\) === null\) \{\n[^]*?startupPromptBuffer\.discardPrompts\(kStr\);\n\s*return;\n\s*\}\n\s*const ensured = await ensureAgentSessionNow\(key, \{\}\);/, 'the transition\'s own ensure: the queued one would wait for itself');
  });

  it('every start or resume a command makes runs as the conversation\'s one transition, so none shares a startup window with an ensure or a stop (review 20 nit 3)', () => {
    assert.match(getBody('function runCommandSessionTransition<TResult>(', 'async function waitForPendingRespawn('), /return sessionTransitions\.run\(keyToString\(key\), async \(\) => \{\n\s*await waitForPendingRespawn\(key\);\n\s*return transition\(\);\n\s*\}\);/);
    const fresh = getBody("command('new', async", '//  /whoami /version /help /status');
    assert.match(fresh, /conversationEndings\.hold\(key\)\.run\(async \(\) => \{\n\s*await releaseThreadSession\(key\);\n\s*return startAgentSession\(key\);\n\s*\}\)/, '/new (queued by its hold, below)');
    assert.match(getBody('async function handleAgentStart(', 'function handleStartCommand('), /: await runCommandSessionTransition\(key, async \(\) => \(getThreadAdapter\(key\)\.checkIsActive\(key\)\n\s*\? t\('agent\.already_active', \{ label: getThreadAdapter\(key\)\.label \}\)\n\s*: startAgentSession\(key, args\)\)\);/, 'a first /claude or /opencode, finding a session another trigger started meanwhile');
    const wedge = getBody('async function handleNoResponseWithLocale(', '/**\n * @description Surface a logged-out');
    assert.equal(wedge.match(/await runCommandSessionTransition\(key, async \(\) => \{/g)?.length, 2, 'the wedge recovery\'s fork and restart');
    assert.equal(wedge.match(/startAgentSession\(/g)?.length, 2);
    assert.match(getBody('async function applyClaudeBackendSwitch(', 'async function switchClaudeBackendNow('), /return runCommandSessionTransition\(key, \(\) => switchClaudeBackendNow\(key, target, label\)\);/, '/claude_mode');
    const switchNow = getBody('async function switchClaudeBackendNow(', "command('claude_mode'");
    assert.ok(switchNow.includes('if ((await resumeSleepingSession(key, sessionId, { isWithRecentContext: true })) === null) {'), 'its resume opens a window, as a wake\'s does');
    assert.match(switchNow, /startupPromptBuffer\.discardBotPrompts\(keyToString\(key\)\);\n\s*\}\n\s*const msg = await startAgentSession\(key\);/, 'the fresh start takes the failed resume\'s window over');
    assert.doesNotMatch(switchNow, /\.resumeSession\(/, 'no resume without a window');
    assert.match(getBody('async function resumeSessionByIndex(', 'async function resumePickedSession('), /\(ending \?\? conversationEndings\.hold\(key\)\)\.run\(\(\) => resumePickedSession\(key, sessionId\)\)/, '/resume\'s pick');
    assert.match(botSource, /const conversationEndings = new ConversationEndings<SessionKey>\(\{ toConversationKey: keyToString, runTransition: runCommandSessionTransition \}\);/, 'which queues them as the one transition');
    // Every start outside the ensure is one of those.
    assert.equal(botSource.match(/startAgentSession\(key(?:, (?:options\.)?args)?\)/g)?.length, 7, 'the ensure\'s two, /new, the first /claude, the wedge recovery\'s two, /claude_mode\'s fallback');
  });

  it('every ensure and every command transition waits for a json-stream re-spawn first: none resumes a second process beside the one a model, effort or account change has down (review 21 nit 6)', () => {
    assert.match(getBody('async function waitForPendingRespawn(', 'async function ensureAgentSessionNow('), /await getThreadAdapter\(key\)\.waitForRespawn\?\.\(key\);/);
    const ensure = getBody('async function ensureAgentSessionNow(', 'function getResumableSessionId(');
    assert.ok(ensure.indexOf('await waitForPendingRespawn(key);') >= 0 && ensure.indexOf('await waitForPendingRespawn(key);') < ensure.indexOf('getEnsureSessionPlan({'), 'before the plan reads whether the session is live');
    assert.match(getBody('function runCommandSessionTransition<TResult>(', 'async function waitForPendingRespawn('), /await waitForPendingRespawn\(key\);\n\s*return transition\(\);/, 'the command\'s start or resume too');
  });

  it('the wake a /model, /effort or /compact makes goes through the queue and decides INSIDE it whether there is a conversation to wake: a stop under way is waited for and the conversation resumed after it, so a model pick is never refused as «no agent» in the seconds after a per-turn answer, and a release queued ahead leaves nothing to wake — no fresh agent for the pick (review 23 nit 3, review 24 nit 2)', () => {
    const wake = getBody('function wakeSleepingSession(', 'async function suspendThreadSession(');
    assert.match(wake, /return sessionTransitions\.run\(keyToString\(key\), async \(\) => \{\n\s*if \(getResumableSessionId\(key\) === null\) return null;\n\s*return \(await ensureAgentSessionNow\(key, \{\}\)\)\.message;\n\s*\}\);/, 'the id is read once the transitions ahead are over; the ensure inside is the queue\'s own (the queued one would wait for itself)');
    assert.doesNotMatch(wake.slice(0, wake.indexOf('return sessionTransitions.run(')), /getResumableSessionId|await /, 'nothing is decided ahead of the queue');
    assert.doesNotMatch(wake.slice(wake.indexOf('function wakeSleepingSession(')), /\.checkIsActive\(key\)|isResumeOnly/, 'a process that still looks live while it is stopped is no reason to skip the queue, and a failed resume still starts fresh');
  });

  it('the stop\'s transition waits for a json-stream re-spawn first, and no way out of a stop leaves its held prompts in a closed buffer: a conversation already live gets them replayed (review 22 #1 b, c)', () => {
    const stop = getBody('async function suspendThreadSession(', 'async function resumeForHeldPrompts(');
    const transition = stop.slice(stop.indexOf('await sessionTransitions.run(kStr, async () => {'));
    assert.ok(transition.indexOf('await waitForPendingRespawn(key);') > 0, 'the stop waits for a re-spawn');
    assert.ok(transition.indexOf('await waitForPendingRespawn(key);') < transition.indexOf('adapter.checkIsActive(key)'), 'before it reads whether a process is there to stop');
    const held = getBody('async function resumeForHeldPrompts(', 'const autoStopUnsupportedLoggedKeys');
    assert.match(held, /const ensured = await ensureAgentSessionNow\(key, \{\}\);\n(?:\s*\/\/[^\n]*\n)*\s*if \(!startupPromptBuffer\.checkHasPrompts\(kStr\) \|\| startupPromptBuffer\.checkIsStarting\(kStr\)\) return;\n(?:\s*\/\/[^\n]*\n)*\s*if \(ensured\.ok\) void replayBufferedPrompts\(key\);\n(?:\s*\/\/[^\n]*\n)*\s*else startupPromptBuffer\.discardPrompts\(kStr\);/, 'a live conversation the ensure only found ready still gets them — not awaited inside the transition, as a resume\'s replay — and an ensure that failed without a start drops them (review 23 nit 6)');
  });

  it('a release — /quit, leaving the folder, /quitall — a move across backends and a start onto another agent run as the conversation\'s one transition, after a re-spawn, MARKED as ending it: a stop queued ahead drops what it held and starts nothing (review 22 own pass, review 23 #1, nits 2 and 4)', () => {
    const quit = getBody("command(['quit', 'q']", "command('c', async");
    assert.ok(quit.indexOf('await conversationEndings.hold(key).run(async () => {') > 0 && quit.indexOf('await conversationEndings.hold(key).run(async () => {') < quit.indexOf('const primaryActive = adapter.checkIsActive(key);'), '/quit reads what runs inside its marked transition');
    assert.ok(quit.indexOf('await state.clearAgentSessionIds(key);') > quit.indexOf('await conversationEndings.hold(key).run('), 'and releases inside it');
    assert.doesNotMatch(quit, /sessionTransitions\.run\(|runCommandSessionTransition\(/, 'no nested queue: it would wait for itself');
    const unbind = getBody('async function unbindThread(', "command('ls', async");
    assert.ok(unbind.indexOf('await ending.run(async () => {') > 0 && unbind.indexOf('await ending.run(async () => {') < unbind.indexOf('if (adapter.checkIsActive(key)) {'), 'leaving the folder, under the tap\'s hold');
    assert.ok(unbind.indexOf('await releaseConversationIds(key);') > unbind.indexOf('await ending.run('));
    assert.match(unbind, /if \(adapter\.stopSessionAndWait\) await adapter\.stopSessionAndWait\(key\);\n\s*else adapter\.stopSession\(key\);/, 'it waits for the exit (review 23 nit 4)');
    const quitAll = getBody("command('quitall'", "command(['quit', 'q']");
    assert.match(quitAll, /await Promise\.all\(conversations\.map\(async \(\{ key: bKey \}\) => \{\n\s*cancelConversationRequest\(bKey\);\n\s*const result = await conversationEndings\.hold\(bKey\)\.run\(async \(\) => \{/, '/quitall: each topic marked and queued, side by side (review 23 nit 4)');
    assert.match(quitAll, /const swept = await stopAndWaitAllAdaptersFor\(bKey\);/, 'each waits for its exits');
    assert.match(getBody('async function moveTopicToOtherBackend(', 'async function resumeTopicOnNewSession('), /await ending\.run\(\(\) => switchThreadAdapter\(/, 'a move across backends, under the hold its caller took ahead of the bridge');
    const start = getBody('async function handleAgentStart(', 'function handleStartCommand(');
    assert.match(getBody('function checkIsStartLeavingConversation(', 'function handleStartCommand('), /return previousName !== undefined && !checkIsSameConversationSwitch\(previousName, startAdapterName\);/, 'a start onto another agent or a shell ends the conversation (review 23 nit 2)');
    assert.match(start, /const isLeavingConversation = checkIsStartLeavingConversation\(key, adapterName\);/);
    assert.match(start, /if \(isLeavingConversation\) \{\n\s*await \(ending \?\? conversationEndings\.hold\(key\)\)\.run\(switchAdapter\);\n\s*\} else \{\n\s*ending\?\.release\(\);\n\s*await runCommandSessionTransition\(key, switchAdapter\);\n\s*\}/, 'its switch queued, held as ending when it leaves the conversation — under the caller\'s hold when it took one');
    const held = getBody('async function resumeForHeldPrompts(', 'const autoStopUnsupportedLoggedKeys');
    assert.match(held, /if \(conversationEndings\.checkIsEnding\(kStr\) \|\| getResumableSessionId\(key\) === null\) \{[^]*?startupPromptBuffer\.discardPrompts\(kStr\);\n\s*return;/, 'a stop\'s held prompts: a conversation being ended drops them; no id left is the same drop, as a guard');
    assert.doesNotMatch(held, /released during the stop/, 'no release can happen during a stop any more: it waits behind it');
  });

  it('every command that ends or replaces the conversation — /new and a /resume pick among them — marks it from the command until its OWN transition begins: a stop queued ahead drops what it held, and a start or resume queued ahead drops its window instead of replaying it into the conversation they leave — a person told (review 21 nit 4, review 22 nit 3)', () => {
    const fresh = getBody("command('new', async", '//  /whoami /version /help /status');
    assert.match(fresh, /return conversationEndings\.hold\(key\)\.run\(async \(\) => \{\n\s*await releaseThreadSession\(key\);\n\s*return startAgentSession\(key\);\n\s*\}\);/, '/new');
    assert.match(getBody('async function resumeSessionByIndex(', 'async function resumePickedSession('), /return \(ending \?\? conversationEndings\.hold\(key\)\)\.run\(\(\) => resumePickedSession\(key, sessionId\)\);/, 'the /resume pick');
    // The hold itself — a count, taken before the queue, ended as the command's own transition begins and whatever the end — is
    // `conversationEnding.test.ts`'s.
    const held = getBody('async function resumeForHeldPrompts(', 'const autoStopUnsupportedLoggedKeys');
    assert.match(held, /if \(conversationEndings\.checkIsEnding\(kStr\) \|\| getResumableSessionId\(key\) === null\) \{[^]*?startupPromptBuffer\.discardPrompts\(kStr\);/, 'a stop\'s held prompts: a conversation being ended drops them');
    const replay = getBody('async function replayBufferedPrompts(', 'async function forwardPromptToLiveAgent(');
    assert.ok(replay.indexOf('if (conversationEndings.checkIsEnding(keyToString(key))) {') >= 0 && replay.indexOf('if (conversationEndings.checkIsEnding(keyToString(key))) {') < replay.indexOf('await startupPromptBuffer.replayPrompts('), 'a start\'s or a resume\'s window: dropped before any write');
    assert.match(replay, /if \(conversationEndings\.checkIsEnding\(keyToString\(key\)\)\) \{[^]*?startupPromptBuffer\.discardPrompts\(keyToString\(key\)\);\n\s*return;/);
    const stopDoc = getBody(' * @description The idle stop (lifecycle plan L3)', 'async function suspendThreadSession(');
    assert.match(stopDoc.replace(/\n \* /g, ' '), /a command queued behind it ends or replaces \(every release, `\/new`, the `\/resume` pick, a move or a start onto another backend: held from the moment the bot knows the command ends it until its own transition begins\)/, 'the JSDoc says which commands end the conversation the stop resumes nothing for');
  });

  it('every command that ends or replaces the conversation holds it the moment the bot knows, ahead of anything it awaits after that — a toast, a paced send, a move\'s bridge — so a stop that ends meanwhile finds the mark (review 24 #1, own pass)', () => {
    const indexIn = (body: string, text: string): number => {
      const index = body.indexOf(text);
      assert.ok(index >= 0, `missing: ${text}`);
      return index;
    };
    const leave = getBody('bot.action(bindLeaveCurrentCallback, async (ctx) => {', '// `/topic`\'s buttons');
    const leaveWork = leave.slice(indexIn(leave, 'bindPickerClaims.runClaimed(key, pickerMessageId, async () => {'));
    assert.ok(indexIn(leaveWork, 'const ending = conversationEndings.hold(key);') < indexIn(leaveWork, 'await answerCallbackQuerySafely(ctx);'), '«Leave current dir»: held ahead of its toast');
    assert.doesNotMatch(leaveWork.slice(0, indexIn(leaveWork, 'const ending = conversationEndings.hold(key);')), /await /, 'nothing awaited in the claimed work before it');
    assert.ok(indexIn(leaveWork, 'await unbindThread(key, ending);') > 0, 'and handed to the leave, whose unpin and question retirement follow it');
    const unbind = getBody('async function unbindThread(', "command('ls', async");
    assert.ok(indexIn(unbind, 'await clearPinnedStatus(key);') < indexIn(unbind, 'await ending.run(async () => {'), 'the paced unpin runs under the tap\'s hold');
    const resumeButton = getBody('bot.action(/^resume_(\\d+)$/, async (ctx) => {', '// The agent\'s own question buttons');
    assert.ok(indexIn(resumeButton, 'const ending = getListedSessionId(key, idx) === null ? undefined : conversationEndings.hold(key);') < indexIn(resumeButton, 'await ctx.answerCbQuery();'), 'a /resume button: held ahead of its toast');
    assert.match(resumeButton, /const result = await resumeSessionByIndex\(key, idx, async \(\) => \{\n[^]*?\}, ending\);/);
    const byIndex = getBody('async function resumeSessionByIndex(', 'function getListedSessionId(');
    assert.match(byIndex, /if \(sessionId === null\) \{\n\s*ending\?\.release\(\);\n\s*await onExpired\(\);\n\s*return null;\n\s*\}/, 'a row the list no longer has lets go before it says so');
    const agentButton = getBody('bot.action(/^agent_(.+)$/, async (ctx) => {', 'bot.action(/^resume_(\\d+)$/');
    assert.ok(indexIn(agentButton, 'conversationEndings.hold(key)') < indexIn(agentButton, "await ctx.answerCbQuery(t('cb.agent_switched'"), 'an agent button onto a shell: held ahead of its toast');
    assert.match(agentButton, /const ending = getBackendFamily\(startAdapterName\) === null && checkIsStartLeavingConversation\(key, startAdapterName\) \? conversationEndings\.hold\(key\) : undefined;/, 'only where the tap alone decides: onto the other agent the hand-over read decides first');
    const execute = getBody('async function executeBackendSwitch(', 'async function checkIsPickBeyondLimit(');
    assert.ok(indexIn(execute, 'const ending = options.ending ?? conversationEndings.hold(key);') < indexIn(execute, 'await buildFallbackBridge('), 'the operator\'s move: held ahead of its bridge');
    assert.doesNotMatch(execute.slice(0, indexIn(execute, 'const ending = options.ending ?? conversationEndings.hold(key);')), /await /);
    assert.match(execute, /isStoppingBackground = await moveTopicToOtherBackend\(key, ending, /);
    const fallback = getBody('async function switchTopicToFallbackEntry(', 'async function moveTopicToOtherBackend(');
    const crossBackend = fallback.slice(indexIn(fallback, "} else {\n    // Onto the other backend"));
    assert.ok(indexIn(crossBackend, 'const ending = options.ending ?? conversationEndings.hold(key);') < indexIn(crossBackend, 'bridge = await buildFallbackBridge('), 'the limit move onto the other backend: held ahead of its bridge, unless its caller held it already');
    assert.match(fallback, /\} else if \(to\.backend === 'opencode' && !checkIsFallbackMoveAcrossBackends\(key, from, to\)\) \{/, 'the ways are told apart by the one predicate the callers read too');
    const balance = getBody('async function handleBalanceExhausted(', 'function retargetLimitWait(');
    const balanceMove = balance.slice(indexIn(balance, "if (plan.action === 'auto') {"));
    assert.ok(indexIn(balanceMove, 'const ending = checkIsFallbackMoveAcrossBackends(key, plan.from, to) ? conversationEndings.hold(key) : undefined;') < indexIn(balanceMove, 'if (checkIsTelegramKey(key)) await replyToThread(key, notice);'), 'a used-up balance\'s move onto the other backend: held ahead of its paced notice (own pass)');
    assert.match(balanceMove, /switchTopicToFallbackEntry\(key, plan\.from, to, \{ isAnnounced: true, isAutomatic: true, ending \}\)/);
    assert.doesNotMatch(fallback.slice(indexIn(fallback, '): Promise<{ isSwitched: boolean; notice: string; isFailed?: boolean }> {'), indexIn(fallback, "if (from?.backend === 'claude' && to.backend === 'claude') {")), /^ {2}\S[^\n]*\bawait /m, 'and nothing is awaited in the move before its branches (its `say` and `fail` only define what runs later)');
    assert.match(crossBackend, /isStoppingBackground = await moveTopicToOtherBackend\(key, ending, /);
    const operatorSwitch = getBody('async function switchTopicByOperator(', 'const { askBackendSwitch, registerBackendSwitchCallbacks }');
    assert.match(operatorSwitch, /hasConversation: !isUsageLimitWaitArmed && currentFamily !== null && currentFamily !== to\.backend && await checkHasConversationToHandOver\(key\),/, 'a pick on the other backend during a limit wait reads nothing ahead of the move');
    const wiring = getBody('const { askBackendSwitch, registerBackendSwitchCallbacks } = createBackendSwitch({', 'async function takeFallbackSwitchOffer(');
    assert.match(wiring, /holdConversationEnding: \(key\) => conversationEndings\.hold\(key\),/, 'the hand-over question\'s tap holds it (`backendSwitch.test.ts` pins the order)');
    assert.match(wiring, /executeBackendSwitch\(key, target, \{ isBridged: true, userMessage: options\.userMessage, ending: options\.ending \}\)/);
    // The commands that marked in their own tick still do.
    const quit = getBody("command(['quit', 'q']", "command('c', async");
    assert.doesNotMatch(quit.slice(0, indexIn(quit, 'await conversationEndings.hold(key).run(')), /await /, '/quit');
    const fresh = getBody("command('new', async", '//  /whoami /version /help /status');
    assert.doesNotMatch(fresh.slice(indexIn(fresh, 'cancelConversationRequest(key);'), indexIn(fresh, 'const msg = await startFreshSessionForNew(key);')), /await /, '/new');
    assert.match(getBody("command('quitall'", "command(['quit', 'q']"), /cancelConversationRequest\(bKey\);\n\s*const result = await conversationEndings\.hold\(bKey\)\.run\(/, '/quitall');
    assert.doesNotMatch(byIndex.slice(0, indexIn(byIndex, 'if (sessionId === null) {')), /await /, 'the digit pick');
  });

  it('a process a release or a move is stopping is no live session for a prompt: a person\'s prompt and every buffer-or-forward prompt route on whether the process takes input, so they wake the conversation and wait behind that stop instead of being written into a process that abandons them (review 24 nit 3)', () => {
    assert.match(getBody('function checkIsAcceptingInput(', 'function deliverPromptOrBuffer('), /return adapter\.checkIsAcceptingInput\?\.\(key\) \?\? adapter\.checkIsActive\(key\);/, 'a backend with no such check: as live as it is active');
    assert.match(getBody('function deliverPersonPromptAtWrite(', 'function createPersonBufferedSettle('), /checkIsSessionActive: \(\) => checkIsAcceptingInput\(key\),/, 'a person\'s prompt, routed at its write');
    assert.match(getBody('const promptDeliveryDeps: PromptDeliveryDeps = {', 'function checkIsAcceptingInput('), /checkIsSessionActive: \(key\) => checkIsAcceptingInput\(key\),/, 'a scheduled run, a tracker post, a nudge, a move\'s first prompt');
  });

  it('a person whose message an ending command dropped is told the conversation was being ended or switched, not that the agent was starting — read at the drop, while the command holds the conversation (review 24 nit 5)', () => {
    const settle = getBody('function createPersonBufferedSettle(', 'async function reportDroppedPersonPrompt(');
    assert.match(settle, /if \(outcome !== 'dropped'\) return;\n\s*const isDroppedForEndingCommand = conversationEndings\.checkIsEnding\(keyToString\(key\)\);\n\s*void withThreadLocale\(key, \(\) => reportDroppedPersonPrompt\(key, requestId, isDroppedForEndingCommand\)\)/, 'read in the drop\'s own tick: the report awaits before it posts, and the hold may be gone by then');
    const report = getBody('async function reportDroppedPersonPrompt(', '/**\n * @description Deliver a LATE ANSWER');
    assert.match(report, /isDroppedForEndingCommand\n\s*\? t\('agent\.queued_prompt_dropped_by_command'\)\n\s*: t\('agent\.queued_prompt_dropped', \{ label: getThreadAdapter\(key\)\.label \}\)/);
  });

  it('a move\'s first prompt that reached no session tracks no continuation: nothing is reset, lifted or watched for a turn that never starts (review 19 nit 4)', () => {
    const resume = getBody('async function resumeTopicOnNewSession(', 'function getTopicBackendFamily(');
    assert.match(resume, /const delivery = await deliverPromptOrBuffer\(key, prompt\.text, \(outcome\) => \{\n\s*if \(outcome === 'replayed'\) \{\n\s*trackContinuation\(\)\.catch\(/, 'a buffered first prompt is tracked at its replay, and only then (review 20 #1)');
    assert.match(resume, /if \(delivery === 'noSession'\) \{\n[^]*?return;\n\s*\}\n\s*if \(delivery === 'forwarded'\) await trackContinuation\(\);\n\}/, 'one forwarded at once is tracked at once; one that reached no session, never');
    assert.ok(resume.includes('requestWakeUpEngine?.trackContinuationTurn(key, { isCountersReset: true, carriedRequestIds: prompt.carriedRequestIds })'), 'the requests it carries, named as it was built (review 21 nit 3)');
  });

  it('a person\'s prompt that waited in a buffer and was dropped closes its request and the person is told — at the person\'s own buffer and at the adopt-replay re-route', () => {
    const settle = getBody('function createPersonBufferedSettle(', 'async function deliverLateAnswerPrompt(');
    assert.match(settle, /if \(outcome !== 'dropped'\) return;/);
    assert.ok(settle.includes("await settleTopicRequestAfterDelivery(key, { requestId }, 'noSession');"), 'closed `cancelled`, like a prompt that found no session');
    assert.match(settle, /await replyToThread\(key, isDroppedForEndingCommand\n\s*\? t\('agent\.queued_prompt_dropped_by_command'\)\n\s*: t\('agent\.queued_prompt_dropped', \{ label: getThreadAdapter\(key\)\.label \}\)\);/, 'the line says why (the ending command\'s own, review 24 nit 5)');
    const adopt = getBody('async function forwardPromptToAgent(', 'interface PromptForwardOptions');
    assert.ok(adopt.includes('await deliverPromptOrBuffer(key, bufferedText, createPersonBufferedSettle(key, options.requestId ?? null), bufferedOptions);'));
    assert.equal(botSource.match(/createPersonBufferedSettle\(key, /g)?.length, 2, 'every buffer a person\'s prompt can wait in');
  });

  it('a person\'s message is refused while a command ends or replaces the conversation — at its arrival (text, a voice note\'s transcript, a file: ahead of the no-agent hint) and at every write of a person\'s prompt, ahead of any window; a bot-made prompt is not (review 25 #1)', () => {
    const deps = getBody('const promptDeliveryDeps: PromptDeliveryDeps = {', 'function checkIsAcceptingInput(');
    assert.match(deps, /checkIsRefusingMessages: \(key\) => conversationEndings\.checkIsRefusingMessages\(keyToString\(key\)\),/);
    assert.match(deps, /reportRefused: async \(key, options\) => \{\n[^]*?if \(options\.isPersonInput === true\) await replyToThread\(key, t\('agent\.queued_prompt_dropped_by_command'\)\);/, 'only a person is told; `deliverPromptOrBuffer` asks only for a person\'s prompt (`utils/promptDelivery.ts`)');
    const write = getBody('function deliverPersonPromptAtWrite(', 'function createPersonBufferedSettle(');
    assert.match(write, /checkIsRefused: \(\) => conversationEndings\.checkIsRefusingMessages\(keyToString\(key\)\),/, 'a person\'s prompt at its write');
    assert.match(write, /reportRefused: \(\) => reportDroppedPersonPrompt\(key, requestId, true\),/, 'its request closed, the ending command\'s line');
    const adopt = getBody('async function forwardPromptToAgent(', 'interface PromptForwardOptions');
    assert.match(adopt, /\.\.\.\(isPersonInput \? \{\n\s*checkIsRefused: \(\) => conversationEndings\.checkIsRefusingMessages\(keyToString\(key\)\),\n\s*reportRefused: \(\) => reportDroppedPersonPrompt\(key, options\.requestId \?\? null, true\),\n\s*\} : \{\}\),/, 'and at the adopt-replay re-route');
    assert.match(getBody('function checkIsArrivalRoutedAtWrite(', 'async function deliverPromptDuringStartup('), /return startupPromptBuffer\.checkIsStarting\(conversationKey\) \|\| conversationEndings\.checkIsRefusingMessages\(conversationKey\);/);
    assert.equal(botSource.match(/if \(checkIsArrivalRoutedAtWrite\(key\)\) \{\n\s*await deliverPromptDuringStartup\(/g)?.length, 3, 'an admin\'s text, a talker\'s text, a voice note\'s transcript');
    assert.doesNotMatch(botSource, /if \(startupPromptBuffer\.checkIsStarting\([^)]*\)\) \{\n\s*await deliverPromptDuringStartup\(/, 'no arrival branch reads the window alone');
    const fileGate = getBody('async function checkFileIntakeGatePassed(', 'async function downloadIncomingFile(');
    assert.ok(fileGate.indexOf('if (conversationEndings.checkIsRefusingMessages(keyToString(key))) {') >= 0 && fileGate.indexOf('if (conversationEndings.checkIsRefusingMessages(keyToString(key))) {') < fileGate.indexOf('startupPromptBuffer.checkIsStarting('), 'a file: told before anything is downloaded');
    assert.match(fileGate, /await sendHint\(t\('agent\.queued_prompt_dropped_by_command'\)\);\n\s*return false;/);
  });

  it('a move onto the other backend, and a start onto another agent or a shell, refuse a person\'s message from their top until the new agent took its first prompt — the bridge, or the start (review 25 #1)', () => {
    const fallback = getBody('async function switchTopicToFallbackEntry(', 'async function switchTopicToFallbackEntryNow(');
    assert.match(fallback, /\): Promise<\{ isSwitched: boolean; notice: string; isFailed\?: boolean \}> \{\n\s*const stopRefusingMessages = checkIsFallbackMoveAcrossBackends\(key, from, to\) \? conversationEndings\.refuseMessages\(key\) : null;\n\s*try \{\n\s*return await switchTopicToFallbackEntryNow\(key, from, to, options\);\n\s*\} finally \{\n\s*stopRefusingMessages\?\.\(\);\n\s*\}\n\}/, 'the limit move: from its first statement to its very end, the second half\'s first prompt included');
    const execute = getBody('async function executeBackendSwitch(', 'async function checkIsPickBeyondLimit(');
    assert.match(execute, /\): Promise<void> \{\n(?:\s*\/\/[^\n]*\n)*\s*const stopRefusingMessages = conversationEndings\.refuseMessages\(key\);\n\s*try \{/, 'the operator\'s move: first');
    assert.ok(execute.indexOf('await resumeTopicOnNewSession(') < execute.indexOf('stopRefusingMessages();'), 'until its second half is over');
    const start = getBody('async function handleAgentStart(', 'function checkIsStartLeavingConversation(');
    assert.ok(start.indexOf('const stopRefusingMessages = isLeavingConversation ? conversationEndings.refuseMessages(key) : null;') < start.indexOf('await (ending ?? conversationEndings.hold(key)).run(switchAdapter);'), 'a start that leaves the conversation: ahead of its switch');
    assert.ok(start.indexOf('startAgentSession(key, args)') < start.indexOf('stopRefusingMessages?.();'), 'until the new agent\'s start is over');
  });

  it('a person\'s wake decides inside the queue whether there is a conversation to wake: a release ahead leaves none, nothing is started, and the person is told the release ended it (review 25 #2)', () => {
    const wake = getBody('async function wakeSleepingSessionForPrompt(', 'async function replayBufferedPrompts(');
    assert.match(wake, /const ensured = await sessionTransitions\.run\(keyToString\(key\), async \(\) => \{\n\s*if \(!state\.getBinding\(key\) \|\| getResumableSessionId\(key\) === null\) return null;\n\s*return ensureAgentSessionNow\(key, \{\}\);\n\s*\}\);\n\s*if \(ensured === null\) return \{ isAwake: false, isNoticePosted: false, isEnded: true \};/, 'read again once the transitions ahead are over; the ensure inside is the queue\'s own; a failed resume still starts fresh');
    assert.doesNotMatch(wake, /ensureAgentSession\(key\)|isResumeOnly/, 'no ensure queued with its decision read before the wait');
  });

  it('a switch to another agent closes the requests and tells a person whose words the agent never read — once, not on top of a drop already being told (review 25 #3)', () => {
    const switchAdapter = getBody('async function switchThreadAdapter(', '/**\n * @description The post-start "ready" notice');
    assert.match(switchAdapter, /if \(prevName && !checkIsSameConversationSwitch\(prevName, newName\)\) \{\n\s*cancelConversationRequestOnSwitch\(key\);/);
    const onSwitch = getBody('function cancelConversationRequestOnSwitch(', '/**\n * @name SchedulerWiringDeps');
    assert.match(onSwitch, /const unreadRequestIds = \(await engine\.cancelConversation\(key\)\)\.filter\(\(requestId\) => !personDropsBeingTold\.has\(requestId\)\);\n(?:\s*\/\/[^\n]*\n)*\s*if \(unreadRequestIds\.length === 0 \|\| !checkIsTelegramKey\(key\)\) return;/, 'the engine names them (`wakeUpEngine.test.ts`)');
    assert.match(onSwitch, /replyToThread\(key, t\('agent\.queued_prompt_dropped_by_command'\)\)/);
    const report = getBody('async function reportDroppedPersonPrompt(', '/**\n * @description Deliver a LATE ANSWER');
    assert.match(report, /\): Promise<void> \{\n\s*if \(requestId !== null\) personDropsBeingTold\.add\(requestId\);\n\s*try \{/, 'marked in the drop\'s own tick, before its first await');
    assert.match(report, /\} finally \{\n\s*if \(requestId !== null\) personDropsBeingTold\.delete\(requestId\);\n\s*\}/, 'until the request is closed and the line out');
  });

  it('every routing point reads whether the process takes input, and so does the ensure\'s plan: the adapter\'s own suspend after a torn frame is resumed for the prompt, not read `ready` while the prompt meets a dying process (review 25 nits 4 and 7)', () => {
    assert.match(getBody('async function ensureAgentSessionNow(', 'function getResumableSessionId('), /const plan = getEnsureSessionPlan\(\{\n(?:\s*\/\/[^\n]*\n)*\s*isActive: checkIsAcceptingInput\(key\),/);
    assert.match(getBody('async function forwardPromptToAgent(', 'interface PromptForwardOptions'), /checkIsSessionActive: \(\) => checkIsAcceptingInput\(key\) && !\(isTechnicalPrompt && \(adapter\.checkIsBusy\?\.\(key\) \?\? false\)\),/, 'the adopt-replay re-route, the technical prompt\'s idle test kept');
  });
});

describe('deliverLatePrompt: a prompt decided on at arrival, delivered by what the session is NOW', () => {
  /** `afterWake`: what the session is when a wake that brought it up resolves (absent: live, no window). */
  function createPorts(state: { isWindowOpen: boolean; isSessionActive: boolean; isWakeOk?: boolean; isWakeNoticePosted?: boolean; isWakeEnded?: boolean; isRefused?: boolean; isTechnical?: boolean; forwardOutcome?: LatePromptOutcome; afterWake?: Array<{ isWindowOpen: boolean; isSessionActive: boolean }> }): { ports: LatePromptDeliveryPorts; steps: string[] } {
    const steps: string[] = [];
    const afterWake = [...(state.afterWake ?? [])];
    return {
      steps,
      ports: {
        isTechnical: state.isTechnical,
        checkIsWindowOpen: () => state.isWindowOpen,
        checkIsSessionActive: () => state.isSessionActive,
        buffer: async () => { steps.push('buffer'); },
        wake: async () => {
          steps.push('wake');
          const isAwake = state.isWakeOk ?? true;
          if (isAwake) Object.assign(state, afterWake.shift() ?? { isWindowOpen: false, isSessionActive: true });
          return { isAwake, isNoticePosted: state.isWakeNoticePosted ?? false, ...(state.isWakeEnded === true ? { isEnded: true } : {}) };
        },
        ...(state.isRefused === undefined ? {} : { checkIsRefused: () => state.isRefused === true }),
        reportRefused: async () => { steps.push('reportRefused'); },
        forward: async () => {
          steps.push('forward');
          return state.forwardOutcome ?? 'forwarded';
        },
        reportNoSession: async (isAlreadyTold) => { steps.push(isAlreadyTold ? 'reportNoSession(alreadyTold)' : 'reportNoSession'); },
      },
    };
  }

  it('the idle stop under way (its window open, the process still reads active): buffered, never written to the process', async () => {
    const { ports, steps } = createPorts({ isWindowOpen: true, isSessionActive: true });
    assert.equal(await deliverLatePrompt(ports), 'buffered');
    assert.deepEqual(steps, ['buffer']);
  });

  it('the process gone meanwhile: the conversation is woken, then the prompt forwarded to it', async () => {
    const { ports, steps } = createPorts({ isWindowOpen: false, isSessionActive: false });
    assert.equal(await deliverLatePrompt(ports), 'forwarded');
    assert.deepEqual(steps, ['wake', 'forward']);
  });

  it('a wake that finds nothing to resume: the person is told, and nothing is forwarded (no "working" topic over a dropped text)', async () => {
    const { ports, steps } = createPorts({ isWindowOpen: false, isSessionActive: false, isWakeOk: false });
    assert.equal(await deliverLatePrompt(ports), 'noSession');
    assert.deepEqual(steps, ['wake', 'reportNoSession']);
  });

  it('a wake whose start failed and said why: reported without a second, generic line', async () => {
    const { ports, steps } = createPorts({ isWindowOpen: false, isSessionActive: false, isWakeOk: false, isWakeNoticePosted: true });
    assert.equal(await deliverLatePrompt(ports), 'noSession');
    assert.deepEqual(steps, ['wake', 'reportNoSession(alreadyTold)']);
  });

  it('a forward that itself ends in no session (a prompt that waited for an adopt replay) is the answer — the wake report is not run for it', async () => {
    for (const state of [{ isWindowOpen: false, isSessionActive: true }, { isWindowOpen: false, isSessionActive: false }]) {
      const { ports, steps } = createPorts({ ...state, forwardOutcome: 'noSession' });
      assert.equal(await deliverLatePrompt(ports), 'noSession', JSON.stringify(state));
      assert.ok(!steps.includes('reportNoSession') && !steps.includes('reportNoSession(alreadyTold)'), `the forward told the person already: ${JSON.stringify(state)}`);
    }
  });

  it('a wake routes the prompt once more by what the session is when it resolves: a stop that began during the wake\'s awaits (its notice) takes it into its window, never the stopping process (review 19 nit 2)', async () => {
    const { ports, steps } = createPorts({ isWindowOpen: false, isSessionActive: false, afterWake: [{ isWindowOpen: true, isSessionActive: true }] });
    assert.equal(await deliverLatePrompt(ports), 'buffered');
    assert.deepEqual(steps, ['wake', 'buffer']);
  });

  it('a session gone again by the time its wake resolves is woken once more; gone after that too, the prompt reaches no session and that is said', async () => {
    const once = createPorts({ isWindowOpen: false, isSessionActive: false, afterWake: [{ isWindowOpen: false, isSessionActive: false }, { isWindowOpen: false, isSessionActive: true }] });
    assert.equal(await deliverLatePrompt(once.ports), 'forwarded');
    assert.deepEqual(once.steps, ['wake', 'wake', 'forward']);
    const never = createPorts({ isWindowOpen: false, isSessionActive: false, afterWake: [{ isWindowOpen: false, isSessionActive: false }, { isWindowOpen: false, isSessionActive: false }] });
    assert.equal(await deliverLatePrompt(never.ports), 'noSession');
    assert.deepEqual(never.steps, ['wake', 'wake', 'reportNoSession'], 'bounded: never a third wake, never a blind forward');
  });

  it('a live process: forwarded at once', async () => {
    const { ports, steps } = createPorts({ isWindowOpen: false, isSessionActive: true });
    assert.equal(await deliverLatePrompt(ports), 'forwarded');
    assert.deepEqual(steps, ['forward']);
  });

  it('a bot-made technical prompt (the todo reminder) that finds the stop window open or the session gone is dropped: no buffer, no wake, no report', async () => {
    for (const state of [{ isWindowOpen: true, isSessionActive: true }, { isWindowOpen: false, isSessionActive: false }, { isWindowOpen: true, isSessionActive: false }]) {
      const { ports, steps } = createPorts({ ...state, isTechnical: true });
      assert.equal(await deliverLatePrompt(ports), 'dropped', JSON.stringify(state));
      assert.deepEqual(steps, [], `nothing is done for it: ${JSON.stringify(state)}`);
    }
  });

  it('a technical prompt that finds a live session with no window is forwarded as any prompt is', async () => {
    const { ports, steps } = createPorts({ isWindowOpen: false, isSessionActive: true, isTechnical: true });
    assert.equal(await deliverLatePrompt(ports), 'forwarded');
    assert.deepEqual(steps, ['forward']);
  });

  it('a person\'s prompt while a command ends or replaces the conversation is refused, whatever the session reads as — a window, a live process, none: the ending command\'s line, nothing done for it (review 25 #1)', async () => {
    for (const state of [{ isWindowOpen: true, isSessionActive: true }, { isWindowOpen: false, isSessionActive: true }, { isWindowOpen: false, isSessionActive: false }]) {
      const { ports, steps } = createPorts({ ...state, isRefused: true });
      assert.equal(await deliverLatePrompt(ports), 'noSession', JSON.stringify(state));
      assert.deepEqual(steps, ['reportRefused'], JSON.stringify(state));
    }
  });

  it('a wake that brought the session up is routed again, and a command that began meanwhile refuses the prompt there', async () => {
    const state = { isWindowOpen: false, isSessionActive: false, isRefused: false };
    const { ports, steps } = createPorts(state);
    const wake = ports.wake;
    ports.wake = async () => {
      const result = await wake();
      state.isRefused = true;
      return result;
    };
    assert.equal(await deliverLatePrompt(ports), 'noSession');
    assert.deepEqual(steps, ['wake', 'reportRefused'], 'never written into the conversation a command now ends');
  });

  it('a wake that found the conversation ended by a release while it waited: the ending command\'s line, not «no agent running» (review 25 #2)', async () => {
    const { ports, steps } = createPorts({ isWindowOpen: false, isSessionActive: false, isWakeOk: false, isWakeEnded: true });
    assert.equal(await deliverLatePrompt(ports), 'noSession');
    assert.deepEqual(steps, ['wake', 'reportRefused']);
  });
});

describe('getLatePromptRoute: how a prompt decided on at arrival is delivered at forward time', () => {
  it('a start or a stop under way (its window open) → buffer, whatever the process reads as', () => {
    assert.equal(getLatePromptRoute({ isWindowOpen: true, isSessionActive: true }), 'buffer', 'a process being stopped still reads as active');
    assert.equal(getLatePromptRoute({ isWindowOpen: true, isSessionActive: false }), 'buffer');
  });

  it('no window, the process gone → wake the conversation; a live process → forward', () => {
    assert.equal(getLatePromptRoute({ isWindowOpen: false, isSessionActive: false }), 'wake');
    assert.equal(getLatePromptRoute({ isWindowOpen: false, isSessionActive: true }), 'forward');
  });

  it('a person\'s prompt while a command ends or replaces the conversation → refuse, ahead of any window (review 25 #1)', () => {
    for (const isWindowOpen of [true, false]) for (const isSessionActive of [true, false]) {
      assert.equal(getLatePromptRoute({ isWindowOpen, isSessionActive, isRefused: true }), 'refuse', JSON.stringify({ isWindowOpen, isSessionActive }));
    }
  });

  it('a technical prompt is never buffered or woken for: forward into a live session with no window, else drop', () => {
    assert.equal(getLatePromptRoute({ isWindowOpen: false, isSessionActive: true, isTechnical: true }), 'forward');
    assert.equal(getLatePromptRoute({ isWindowOpen: true, isSessionActive: true, isTechnical: true }), 'drop');
    assert.equal(getLatePromptRoute({ isWindowOpen: false, isSessionActive: false, isTechnical: true }), 'drop');
    assert.equal(getLatePromptRoute({ isWindowOpen: true, isSessionActive: false, isTechnical: true }), 'drop');
  });
});
