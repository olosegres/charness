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
import { deliverLatePrompt, deliverPromptOrBuffer, getLatePromptRoute, type LatePromptDeliveryPorts, type LatePromptOutcome, type PromptDeliveryDeps } from '../utils/promptDelivery';

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
/** Where the bot's forward puts a prompt (`forwardPromptToAgent`); only a prompt that waited for an adopt replay can come out as anything but `forwarded`. */
let forwardOutcome: LatePromptOutcome;
let deps: PromptDeliveryDeps;

beforeEach(() => {
  startupBuffer = new StartupPromptBuffer();
  forwarded = [];
  announced = [];
  forwardOutcome = 'forwarded';
  deps = {
    startupBuffer,
    forwardPrompt: async (key, text) => {
      forwarded.push({ key, text });
      return forwardOutcome;
    },
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

  it('a forward that finds no session (the prompt waited for a bot restart\'s replay) reads as noSession, so the caller opens no turn for it', async () => {
    forwardOutcome = 'noSession';

    assert.equal(await deliverPromptOrBuffer(deps, topicKey, 'hello', false), 'noSession');
    assert.equal(await deliverPromptOrBuffer(deps, issueKey, 'the nudge', false), 'noSession', 'whatever the platform');
  });

  it('a forward that routed the prompt behind a stop window itself still reads as forwarded: no settle callback was registered for that buffer', async () => {
    forwardOutcome = 'buffered';

    assert.equal(await deliverPromptOrBuffer(deps, topicKey, 'hello', false), 'forwarded');
  });

  it('a prompt buffered for a starting session never reads as noSession — the forward is not reached', async () => {
    forwardOutcome = 'noSession';

    assert.equal(await deliverPromptOrBuffer(deps, topicKey, 'hello', true), 'buffered');
    assert.deepEqual(forwarded, []);
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
    // (`replyQuoteWiring.test.ts`): the replay forwards the buffered text as is.
    assert.match(botSource, /await bufferPromptDuringStartup\(key, text, \{ source: 'text'/);
    assert.match(botSource, /await bufferPromptDuringStartup\(key, transcript, \{ source: 'voice'/);
    assert.match(botSource, /await deliverPromptOrBuffer\(key, `\$\{opening\.header\}\$\{quotedText\}`, true\);/);
  });

  it('a prompt for an active session is delivered through the late route, read after the last await before the forward', () => {
    // The race the re-ask flow hit: a tap read a live process, the idle stop ran during the tap's awaits, and the label
    // was forwarded to a session that was gone — dropped. The behaviour is `deliverLatePrompt`'s (below) and the e2e's.
    const deliver = botSource.slice(botSource.indexOf('async function deliverActivePrompt('), botSource.indexOf('async function cancelPendingQuestionAndForward('));
    assert.match(deliver, /const opening = await openTopicRequest\(key, text, intake\);\n(?:\s*\/\/[^\n]*\n)+\s*const outcome = await deliverLatePrompt\(\{/);
    assert.ok(deliver.includes('forward: () => forwardPromptToAgent(key, getThreadAdapter(key), text, sentAtMs, { replyContext, requestHeader: opening.header }),'), 'the forward\'s own outcome is the answer');
    assert.match(deliver, /reportNoSession: async \(isAlreadyTold\) => \{\n\s*if \(!isAlreadyTold\) await replyToThread\(key, t\('agent\.no_session'\)\);\n\s*\},/, 'the topic is told once; the request is settled below, for the wake and the forward alike');
    assert.ok(deliver.includes('wake: () => wakeSleepingSessionForPrompt(key),'), 'the wake says whether its start already posted why it failed');
    assert.doesNotMatch(deliver, /closeRequest|trackTopicRequestTurn/, 'the request is closed or tracked in one place');
    assert.match(deliver, /\}\);\n\s*await settleTopicRequestAfterDelivery\(key, opening, outcome\);\n\s*return outcome;/);
  });

  it('the forward ports return where the prompt went, with no wrapper that throws the answer away', () => {
    assert.ok(botSource.includes('forwardPrompt: (key, text) => forwardPromptToAgent(key, getThreadAdapter(key), text),'));
    assert.doesNotMatch(botSource, /forwardPrompt: async \(key, text\) => \{ await forwardPromptToAgent/);
    const cancel = botSource.slice(botSource.indexOf('async function cancelPendingQuestionAndForward('), botSource.indexOf('async function applyQuestionAnswer('));
    assert.match(cancel, /\): Promise<LatePromptOutcome> \{/);
    assert.ok(cancel.includes('return forwardPromptToAgent(key, adapter, text, sentAtMs, { replyContext, requestHeader });'));
  });

  it('a request is settled by where its prompt went: tracked, or closed when no session was left to take it', () => {
    // The behaviour is `requests/topicRequestSettle.ts`'s (`topicRequestSettle.test.ts`): a prompt that found no session (it waited for
    // a bot restart's replay; the person was told) must not leave a request open, or the wake-up engine prods the agent later for a
    // turn that never started. Here: the bot wires the engine and the ledger into it, and every site settles through it.
    assert.match(botSource, /const \{ trackTurn: trackTopicRequestTurn, settleAfterDelivery: settleTopicRequestAfterDelivery \} = createTopicRequestSettler\(\{/);
    assert.ok(botSource.includes("await requestWakeUpEngine?.trackForwardedTurn(key, requestId, { isRequestPrompt: true });"), 'the engine watches the turn as a request prompt');
    assert.ok(botSource.includes("await topicRequestLedger?.closeRequest(requestId, 'cancelled');"), 'the ledger closes the request as cancelled');
    // Every site that opens a request and hands its prompt on settles it through the helper — the turn is never tracked directly,
    // except for the prompt buffered at capture time, which cannot find a session gone.
    assert.equal(botSource.match(/trackTopicRequestTurn\(key, opening\)/g)?.length, 1, 'only the capture-time buffer; the settle module tracks for the rest');
    assert.match(botSource.slice(botSource.indexOf('async function bufferPromptDuringStartup(')), /^[^]*?await deliverPromptOrBuffer\(key, `\$\{opening\.header\}\$\{quotedText\}`, true\);\n\s*trackTopicRequestTurn\(key, opening\);/);
    const sites: Array<{ name: string; call: string; count: number }> = [
      { name: '/schedule', call: 'deliverPromptOrBuffer(key, `${opening.header}${wrappedPrompt}`, isStarting)', count: 1 },
      { name: 'an album and a file', call: 'deliverPromptOrBuffer(key, `${opening.header}${quotedPrompt}`, isStarting)', count: 2 },
      { name: 'a scheduled run', call: 'deliverPromptOrBuffer(key, `${opening.header}${text}`, startupPromptBuffer.checkIsStarting(conversationKey))', count: 1 },
      { name: 'free text that cancels a pending question', call: 'cancelPendingQuestionAndForward(key, adapter, text, sentAtMs, replyContext, opening.header)', count: 1 },
    ];
    for (const { name, call, count } of sites) {
      const settled = new RegExp(`const delivery = await ${call.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')};\\n\\s*await settleTopicRequestAfterDelivery\\(key, opening, delivery\\);`, 'g');
      assert.equal(botSource.match(settled)?.length, count, `${name} settles its request by where the prompt went`);
    }
    assert.equal(botSource.match(/await settleTopicRequestAfterDelivery\(key, opening, /g)?.length, 6, 'the five above and the text handler, no other');
  });
});

describe('deliverLatePrompt: a prompt decided on at arrival, delivered by what the session is NOW', () => {
  function createPorts(state: { isWindowOpen: boolean; isSessionActive: boolean; isWakeOk?: boolean; isWakeNoticePosted?: boolean; isTechnical?: boolean; forwardOutcome?: LatePromptOutcome }): { ports: LatePromptDeliveryPorts; steps: string[] } {
    const steps: string[] = [];
    return {
      steps,
      ports: {
        isTechnical: state.isTechnical,
        checkIsWindowOpen: () => state.isWindowOpen,
        checkIsSessionActive: () => state.isSessionActive,
        buffer: async () => { steps.push('buffer'); },
        wake: async () => { steps.push('wake'); return { isAwake: state.isWakeOk ?? true, isNoticePosted: state.isWakeNoticePosted ?? false }; },
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
