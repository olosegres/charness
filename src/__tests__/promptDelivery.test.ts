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
let deps: PromptDeliveryDeps;

beforeEach(() => {
  startupBuffer = new StartupPromptBuffer();
  forwarded = [];
  announced = [];
  steps = [];
  forwardOutcome = 'forwarded';
  isSessionActive = true;
  isWakeOk = true;
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
      return { isAwake: isWakeOk, isNoticePosted: false };
    },
    reportNoSession: async (_key, isAlreadyTold) => { steps.push(`reportNoSession(${isAlreadyTold})`); },
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

  it('a buffer that refuses the prompt (its window closed between the read and the add) routes it again at once: it is forwarded, never lost', async () => {
    let windowReads = 0;
    const refusingBuffer: PromptDeliveryDeps['startupBuffer'] = {
      // Open at the first read only: the window closes right after it.
      checkIsStarting: () => {
        windowReads += 1;
        return windowReads === 1;
      },
      addPrompt: () => 'refused',
    };

    const delivery = await deliverPromptOrBuffer({ ...deps, startupBuffer: refusingBuffer }, topicKey, 'hello');

    assert.equal(delivery, 'forwarded');
    assert.deepEqual(forwarded, [{ key: topicKey, text: 'hello' }]);
    assert.deepEqual(announced, [], 'nothing was queued, so nothing is announced');
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
    assert.ok(atWrite.includes('checkIsSessionActive: () => getThreadAdapter(key).checkIsActive(key),'), 'the adapter the topic runs NOW');
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
    assert.ok(botSource.includes('checkIsSessionActive: (key) => getThreadAdapter(key).checkIsActive(key),'));
    assert.match(botSource, /wakeSession: \(key\) => \(checkIsTelegramKey\(key\)\n\s*\? wakeSleepingSessionForPrompt\(key\)\n\s*: wakeSleepingSessionForPrompt\(key, async \(notice\) => \{ console\.log\(/, 'a tracker conversation\'s resume notice is logged, never sent to Telegram');
    // A session post whose prompt found no session and nothing to wake is a failed post (its caller retries it), never one that reads as written.
    for (const name of ['createSessionPostDeps', 'createLostWorkPostDeps']) {
      assert.match(getBody(`function ${name}(`, name === 'createSessionPostDeps' ? 'async function forwardScheduledRun(' : 'function createBufferedOutcome('), /if \(delivery === 'noSession'\) throw new Error\(noSessionForPostError\);/, name);
    }
    assert.match(botSource, /if \(options\.isPersonInput === true && !isAlreadyTold\) await replyToThread\(key, t\('agent\.no_session'\)\);/, 'only a person\'s own prompt is told about in the topic');
    assert.ok(botSource.includes('forward: async (prompt, options) => { await forwardPromptToAgent(key, adapter, prompt, undefined, options); },'), 'a buffered prompt is replayed with the options it was buffered with');
    assert.doesNotMatch(botSource, /forwardPrompt: async \(key, text\) => \{ await forwardPromptToAgent/);
    assert.match(getBody('async function cancelPendingQuestionAndForward(', 'async function applyQuestionAnswer('), /\): Promise<LatePromptOutcome> \{/);
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
    const resume = getBody('async function resumeSleepingSession(', 'async function wakeSleepingSession(');
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
    assert.match(suspend, /\n  \} finally \{\n(?:\s*\/\/[^\n]*\n)*\s*rearmThreadIdleTimer\(key\);\n\s*await resumeForHeldPrompts\(key\);\n\s*\}\n\}/, 'after the transition, in a finally');
    const resume = getBody('async function resumeForHeldPrompts(', 'const autoStopUnsupportedLoggedKeys');
    assert.match(resume, /if \(!startupPromptBuffer\.checkHasPrompts\(kStr\)\) return;\n\s*if \(getResumableSessionId\(key\) === null\) \{\n[^]*?startupPromptBuffer\.discardPrompts\(kStr\);\n\s*return;\n\s*\}\n\s*await ensureAgentSession\(key\);/);
  });

  it('a move\'s first prompt that reached no session tracks no continuation: nothing is reset, lifted or watched for a turn that never starts (review 19 nit 4)', () => {
    const resume = getBody('async function resumeTopicOnNewSession(', 'function getTopicBackendFamily(');
    assert.match(resume, /const delivery = await deliverPromptOrBuffer\(key, prompt\.text, \(outcome\) => \{\n\s*if \(outcome === 'replayed'\) \{\n\s*trackContinuation\(\)\.catch\(/, 'a buffered first prompt is tracked at its replay, and only then (review 20 #1)');
    assert.match(resume, /if \(delivery === 'noSession'\) \{\n[^]*?return;\n\s*\}\n\s*if \(delivery === 'forwarded'\) await trackContinuation\(\);\n\}/, 'one forwarded at once is tracked at once; one that reached no session, never');
    assert.ok(resume.includes('requestWakeUpEngine?.trackContinuationTurn(key, { isCountersReset: true, isRequestPrompt: prompt.isRequestPrompt })'));
  });

  it('a person\'s prompt that waited in a buffer and was dropped closes its request and the person is told — at the person\'s own buffer and at the adopt-replay re-route', () => {
    const settle = getBody('function createPersonBufferedSettle(', 'async function deliverLateAnswerPrompt(');
    assert.match(settle, /if \(outcome !== 'dropped'\) return;/);
    assert.ok(settle.includes("await settleTopicRequestAfterDelivery(key, { requestId }, 'noSession');"), 'closed `cancelled`, like a prompt that found no session');
    assert.ok(settle.includes("await replyToThread(key, t('agent.queued_prompt_dropped', { label: getThreadAdapter(key).label }));"));
    const adopt = getBody('async function forwardPromptToAgent(', 'interface PromptForwardOptions');
    assert.ok(adopt.includes('await deliverPromptOrBuffer(key, bufferedText, createPersonBufferedSettle(key, options.requestId ?? null), bufferedOptions);'));
    assert.equal(botSource.match(/createPersonBufferedSettle\(key, /g)?.length, 2, 'every buffer a person\'s prompt can wait in');
  });
});

describe('deliverLatePrompt: a prompt decided on at arrival, delivered by what the session is NOW', () => {
  /** `afterWake`: what the session is when a wake that brought it up resolves (absent: live, no window). */
  function createPorts(state: { isWindowOpen: boolean; isSessionActive: boolean; isWakeOk?: boolean; isWakeNoticePosted?: boolean; isTechnical?: boolean; forwardOutcome?: LatePromptOutcome; afterWake?: Array<{ isWindowOpen: boolean; isSessionActive: boolean }> }): { ports: LatePromptDeliveryPorts; steps: string[] } {
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
          return { isAwake, isNoticePosted: state.isWakeNoticePosted ?? false };
        },
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

  it('a technical prompt is never buffered or woken for: forward into a live session with no window, else drop', () => {
    assert.equal(getLatePromptRoute({ isWindowOpen: false, isSessionActive: true, isTechnical: true }), 'forward');
    assert.equal(getLatePromptRoute({ isWindowOpen: true, isSessionActive: true, isTechnical: true }), 'drop');
    assert.equal(getLatePromptRoute({ isWindowOpen: false, isSessionActive: false, isTechnical: true }), 'drop');
    assert.equal(getLatePromptRoute({ isWindowOpen: true, isSessionActive: false, isTechnical: true }), 'drop');
  });
});
