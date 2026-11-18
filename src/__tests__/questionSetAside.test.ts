/**
 * @description The set-aside of an agent's unanswered question (`connectors/telegram/commands/questionSetAside.ts`), through its
 * ports and no Telegram: the timer that arms it, what it does to the pending question, the record and the message, and the
 * races the lifecycle of a question can run into.
 *
 *   • the timer fires at `askedAt + wait`, never for «Wait for my answer», and `clear` cancels it; a question saved before `askedAt`
 *     existed is stamped (and saved) when it is armed;
 *   • the question is set aside only while it is still THE ONE waiting: another request id, or one the agent asks while the
 *     counter of the record ids is being taken, is left untouched and the adapter is never told;
 *   • from the moment the adapter is told to the removal of the question from the pending state nothing is awaited — a question
 *     the agent asks next cannot arrive in between and be removed with it;
 *   • the bot holds the question and the adapter does not: one log line, the bot's copy closed as «not answered», no record;
 *   • the record, the `qs_<id>_<i>` keyboard, the 5-cap with its eviction, the message check for stale buttons.
 *
 * The real flows — the Bot API's edits, the pin, a restart — are `questionSetAsideE2e.test.ts` and `openCodeQuestionE2e.test.ts`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { InlineKeyboardMarkup, User } from 'telegraf/typings/core/types/typegram';
import { createQuestionSetAside, type QuestionSetAsidePorts, type SetAsideReplyCandidate } from '../connectors/telegram/commands/questionSetAside';
import type { MessageContext } from '../utils/messageContext';
import type { LatePromptOutcome } from '../utils/promptDelivery';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { keyToString, type SessionKey } from '../sessionKey';
import type { AgentAdapter, OpenCodeQuestion, PendingQuestionState, SetAsideQuestionRecord } from '../types';
import type { QuestionEnd } from '../openCodeQuestionFlow';
import { maxSetAsideQuestions, type QuestionWaitChoice } from '../utils/questionWaitPlan';
import { createSerialQueue } from '../utils/serialQueue';

const key: SessionKey = makeTelegramKey(-1001234567890, 11);
const keyString = keyToString(key);

const deployQuestion: OpenCodeQuestion = { question: 'Push the fix to main now, or wait for the review?', header: 'Deploy', options: [{ label: 'Push now' }, { label: 'Wait for the review' }] };
const docsQuestion: OpenCodeQuestion = { question: 'Which docs to update first?', header: 'Docs', options: [{ label: 'README' }, { label: 'Changelog' }, { label: 'Both' }] };

function createPending(requestId: string, overrides: Partial<PendingQuestionState> = {}): PendingQuestionState {
  return { data: { requestId, questions: [deployQuestion] }, messageId: 500, answers: [null], currentIndex: 0, askedAt: Date.now(), ...overrides };
}

function createRecord(id: string, messageId: number): SetAsideQuestionRecord {
  return { id, messageId, questions: [deployQuestion], answers: [null], lateFromIndex: 0, askedAt: 1, setAsideAt: 2 };
}

interface Harness {
  ports: QuestionSetAsidePorts;
  setAside: ReturnType<typeof createQuestionSetAside>;
  pendingQuestions: Map<string, PendingQuestionState>;
  /** What happened, in order: `adapter`, `release`, … — the order is what some tests read. */
  events: string[];
  adapterCalls: Array<{ requestId: string; text: string; givenAnswers: (string[] | null)[] }>;
  edits: Array<{ messageId: number; note: string; keyboard: InlineKeyboardMarkup | undefined }>;
  closes: Array<{ messageId: number; ending: QuestionEnd }>;
  unpins: number[];
  cleared: number[];
  savedRecords: Map<string, SetAsideQuestionRecord[]>;
  savedPending: PendingQuestionState[];
  markedNewMessage: number[];
  state: { sequence: number; takeSequence: () => Promise<number> };
  /** The late-answer messages delivered to the agent, with the context they carried. */
  delivered: Array<{ text: string; messageContext: MessageContext | undefined }>;
  /** The questions posted as new messages (the next question of a record), and the pins made without a notification. */
  sentQuestions: Array<{ question: OpenCodeQuestion; keyboard: InlineKeyboardMarkup | undefined; messageId: number }>;
  silentPins: number[];
  pushedMessageIds: number[];
}

function createHarness(options: {
  adapterReturns?: boolean;
  hasSetAside?: boolean;
  choice?: QuestionWaitChoice;
  shortenedWaitMs?: number;
  takeSequence?: () => Promise<number>;
  existingRecords?: SetAsideQuestionRecord[];
  deliverLateAnswer?: () => Promise<LatePromptOutcome>;
} = {}): Harness {
  const pendingQuestions = new Map<string, PendingQuestionState>();
  const events: string[] = [];
  const adapterCalls: Harness['adapterCalls'] = [];
  const edits: Harness['edits'] = [];
  const closes: Harness['closes'] = [];
  const unpins: number[] = [];
  const cleared: number[] = [];
  const savedRecords = new Map<string, SetAsideQuestionRecord[]>();
  if (options.existingRecords) savedRecords.set(keyString, options.existingRecords);
  const savedPending: PendingQuestionState[] = [];
  const markedNewMessage: number[] = [];
  const delivered: Harness['delivered'] = [];
  const sentQuestions: Harness['sentQuestions'] = [];
  const silentPins: number[] = [];
  const pushedMessageIds: number[] = [];
  let nextPostedMessageId = 900;
  const queue = createSerialQueue();
  const harnessState = { sequence: 0, takeSequence: async () => { harnessState.sequence += 1; return harnessState.sequence; } };
  if (options.takeSequence) harnessState.takeSequence = options.takeSequence;

  const adapter: Pick<AgentAdapter, 'setQuestionAside'> = options.hasSetAside === false ? {} : {
    setQuestionAside: (_key, requestId, text, givenAnswers) => {
      events.push('adapter');
      adapterCalls.push({ requestId, text, givenAnswers });
      // A microtask queued here runs before any `await` that follows the call resumes: if the bot awaits anything between telling
      // the adapter and releasing the question, it shows as `microtask` ahead of `release`.
      queueMicrotask(() => events.push('microtask'));
      return options.adapterReturns ?? true;
    },
  };

  const ports: QuestionSetAsidePorts = {
    getState: () => ({
      takeNextSetAsideQuestionSequence: () => harnessState.takeSequence(),
      getSetAsideQuestions: () => Object.fromEntries(savedRecords),
      setSetAsideQuestions: async (_key, records) => { savedRecords.set(keyString, [...records]); },
      pushMessageId: async (_key, messageId) => { pushedMessageIds.push(messageId); },
    }),
    withThreadLocale: (_key, run) => run(),
    pendingQuestions,
    getThreadAdapter: () => adapter,
    runQuestionLifecycleOp: (_key, op) => queue.run(op),
    setPendingQuestion: (_key, value) => { savedPending.push(value); },
    clearPendingQuestion: () => { events.push('clear'); pendingQuestions.delete(keyString); cleared.push(1); },
    releasePendingQuestionToSetAside: async () => { events.push('release'); pendingQuestions.delete(keyString); },
    editQuestionMessageWithNote: async (_key, messageId, _question, note, keyboard) => { edits.push({ messageId, note, keyboard }); return true; },
    closeQuestionMessage: async (_key, messageId, _question, ending) => { closes.push({ messageId, ending }); return true; },
    unpinMessage: async (_key, messageId) => { unpins.push(messageId); },
    markNeedsNewMessage: () => { markedNewMessage.push(1); },
    getQuestionWaitChoice: () => options.choice ?? 'thirtyMinutes',
    shortenedWaitMs: options.shortenedWaitMs,
    authoriseSpeaker: async () => null,
    replyToThread: async () => null,
    pinMessageSilently: async (_key, messageId) => { silentPins.push(messageId); return true; },
    sendQuestionMessage: async (_key, question, keyboard) => {
      nextPostedMessageId += 1;
      sentQuestions.push({ question, keyboard, messageId: nextPostedMessageId });
      return nextPostedMessageId;
    },
    deliverLateAnswer: async (_key, text, messageContext) => {
      delivered.push({ text, messageContext });
      return options.deliverLateAnswer ? options.deliverLateAnswer() : 'forwarded';
    },
  };
  return { ports, setAside: createQuestionSetAside(ports), pendingQuestions, events, adapterCalls, edits, closes, unpins, cleared, savedRecords, savedPending, markedNewMessage, state: harnessState, delivered, sentQuestions, silentPins, pushedMessageIds };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Keep the console quiet and read what the code logged. */
function captureWarnings(run: () => Promise<void>): Promise<string[]> {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map((arg) => String(arg)).join(' ')); };
  return run().then(() => warnings).finally(() => { console.warn = originalWarn; });
}

describe('setPendingQuestionAside', () => {
  it('tells the adapter, moves the question out of the pending state into a record, edits the message and keeps nothing waiting', async () => {
    const harness = createHarness();
    harness.pendingQuestions.set(keyString, createPending('req_a', { answers: [null], askedAt: Date.now() - 1000 }));

    assert.equal(await harness.setAside.setPendingQuestionAside(key, 'req_a'), true);

    assert.equal(harness.adapterCalls.length, 1);
    assert.equal(harness.adapterCalls[0].requestId, 'req_a');
    assert.match(harness.adapterCalls[0].text, /^\[Charness\] The user has not answered yet/);
    assert.deepEqual(harness.adapterCalls[0].givenAnswers, [null]);
    assert.equal(harness.pendingQuestions.has(keyString), false, 'the question is no longer the one the agent is blocked on');
    const [record, ...others] = harness.savedRecords.get(keyString) ?? [];
    assert.deepEqual(others, []);
    assert.equal(record.id, '1', 'its id comes from the counter');
    assert.equal(record.messageId, 500);
    assert.equal(record.originalMessageId, undefined, 'a question never re-posted has no original');
    assert.deepEqual(record.answers, [null]);
    assert.equal(harness.edits.length, 1);
    assert.equal(harness.edits[0].messageId, 500);
    assert.deepEqual(harness.edits[0].keyboard?.inline_keyboard.map((row) => row.map((button) => 'callback_data' in button ? button.callback_data : null)), [['qs_1_0'], ['qs_1_1']], 'the buttons name the record');
    assert.equal(harness.markedNewMessage.length, 1, 'the agent\'s next output starts a message of its own');
    assert.deepEqual(harness.closes, []);
  });

  it('keeps both messages of a re-posted question: the live copy and the original it left up', async () => {
    const harness = createHarness();
    harness.pendingQuestions.set(keyString, createPending('req_a', { messageId: 250, originalMessageId: 150 }));

    await harness.setAside.setPendingQuestionAside(key, 'req_a');

    const [record] = harness.savedRecords.get(keyString) ?? [];
    assert.equal(record.messageId, 250);
    assert.equal(record.originalMessageId, 150);
  });

  it('a question whose post never landed is saved with no message and nothing is edited', async () => {
    const harness = createHarness();
    harness.pendingQuestions.set(keyString, createPending('req_a', { messageId: null }));

    assert.equal(await harness.setAside.setPendingQuestionAside(key, 'req_a'), true);

    assert.equal(harness.savedRecords.get(keyString)?.[0].messageId, null);
    assert.deepEqual(harness.edits, []);
  });

  it('shows the first question still open of a half-answered call, and the given answer goes to the adapter', async () => {
    const harness = createHarness();
    harness.pendingQuestions.set(keyString, createPending('req_a', { data: { requestId: 'req_a', questions: [deployQuestion, docsQuestion] }, answers: [['Push now'], null], currentIndex: 1 }));

    await harness.setAside.setPendingQuestionAside(key, 'req_a');

    assert.deepEqual(harness.adapterCalls[0].givenAnswers, [['Push now'], null]);
    assert.match(harness.adapterCalls[0].text, /\(Answers already given in this call: "Push the fix to main now, or wait for the review\?" = "Push now"\.\)$/);
    assert.deepEqual(harness.edits[0].keyboard?.inline_keyboard.map((row) => row.length), [1, 1, 1], 'the buttons are the second question\'s three options');
  });

  it('does nothing for a question that is not the one waiting: another request id, or nothing pending', async () => {
    const harness = createHarness();
    harness.pendingQuestions.set(keyString, createPending('req_b'));

    assert.equal(await harness.setAside.setPendingQuestionAside(key, 'req_a'), false);
    assert.equal(harness.adapterCalls.length, 0, 'the adapter is never told');
    assert.equal(harness.pendingQuestions.get(keyString)?.data.requestId, 'req_b', 'the waiting question is untouched');

    harness.pendingQuestions.clear();
    assert.equal(await harness.setAside.setPendingQuestionAside(key, 'req_a'), false);
    assert.equal(harness.adapterCalls.length, 0);
  });

  it('does nothing for a backend that cannot set a question aside, and leaves the question waiting', async () => {
    const harness = createHarness({ hasSetAside: false });
    harness.pendingQuestions.set(keyString, createPending('req_a'));

    assert.equal(await harness.setAside.setPendingQuestionAside(key, 'req_a'), false);

    assert.equal(harness.pendingQuestions.has(keyString), true);
    assert.deepEqual(harness.cleared, []);
  });

  it('a question the agent asks while the counter of the ids is being taken is not removed with the old one — and the adapter is never told', async () => {
    let resolveSequence: (value: number) => void = () => {};
    const harness = createHarness({ takeSequence: () => new Promise<number>((resolve) => { resolveSequence = resolve; }) });
    harness.pendingQuestions.set(keyString, createPending('req_a'));

    const setAside = harness.setAside.setPendingQuestionAside(key, 'req_a');
    await sleep(0);
    // The agent asks the next question: its handler runs on the event, outside the lifecycle queue.
    harness.pendingQuestions.set(keyString, createPending('req_b', { data: { requestId: 'req_b', questions: [docsQuestion] } }));
    resolveSequence(7);

    assert.equal(await setAside, false);
    assert.equal(harness.adapterCalls.length, 0, 'the old question\'s text is never sent for the new one');
    assert.equal(harness.pendingQuestions.get(keyString)?.data.requestId, 'req_b', 'the new question is still waiting');
    assert.deepEqual(harness.events.filter((event) => event === 'release' || event === 'clear'), [], 'nothing was removed');
    assert.equal(harness.savedRecords.size, 0);
  });

  it('removes the question from the pending state in the same tick the adapter is told: nothing is awaited in between', async () => {
    const harness = createHarness();
    harness.pendingQuestions.set(keyString, createPending('req_a'));

    await harness.setAside.setPendingQuestionAside(key, 'req_a');

    // `microtask` was queued by the adapter call: had the bot awaited anything before releasing, it would stand before `release`.
    assert.deepEqual(harness.events.slice(0, 3), ['adapter', 'release', 'microtask']);
  });

  it('the bot holds the question and the adapter does not: one log line, the bot\'s copy closed as not answered, no record', async () => {
    const harness = createHarness({ adapterReturns: false });
    harness.pendingQuestions.set(keyString, createPending('req_a'));

    const warnings = await captureWarnings(async () => {
      assert.equal(await harness.setAside.setPendingQuestionAside(key, 'req_a'), false);
    });

    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes(keyString) && warnings[0].includes('req_a'), `the line names the conversation and the request: ${warnings[0]}`);
    assert.equal(harness.pendingQuestions.has(keyString), false, 'the stale copy no longer blocks the topic');
    assert.deepEqual(harness.closes, [{ messageId: 500, ending: 'unanswered' }]);
    assert.equal(harness.savedRecords.size, 0, 'nothing was set aside');
    assert.deepEqual(harness.edits, []);
    assert.equal(harness.markedNewMessage.length, 0);
  });

  it('a sixth open question closes the oldest as not answered and releases its pin', async () => {
    const existing = Array.from({ length: maxSetAsideQuestions }, (_, index) => createRecord(`r${index + 1}`, 100 + index));
    const harness = createHarness({ existingRecords: existing });
    harness.pendingQuestions.set(keyString, createPending('req_a', { messageId: 900 }));

    await harness.setAside.setPendingQuestionAside(key, 'req_a');

    const records = harness.savedRecords.get(keyString) ?? [];
    assert.deepEqual(records.map((record) => record.id), ['r2', 'r3', 'r4', 'r5', '1'], 'five stay open, the newest last');
    assert.deepEqual(harness.closes, [{ messageId: 100, ending: 'unanswered' }]);
    assert.deepEqual(harness.unpins, [100]);
  });

  it('ids keep going up across set-asides', async () => {
    const harness = createHarness();
    for (const [requestId, messageId] of [['req_a', 61], ['req_b', 62], ['req_c', 63]] as const) {
      harness.pendingQuestions.set(keyString, createPending(requestId, { messageId }));
      await harness.setAside.setPendingQuestionAside(key, requestId);
    }
    assert.deepEqual((harness.savedRecords.get(keyString) ?? []).map((record) => record.id), ['1', '2', '3']);
  });
});

describe('the timer', () => {
  const timers: Array<() => void> = [];
  afterEach(() => {
    for (const clear of timers.splice(0)) clear();
  });

  it('fires at askedAt + wait and sets the question aside', async () => {
    const harness = createHarness({ shortenedWaitMs: 40 });
    harness.pendingQuestions.set(keyString, createPending('req_a', { askedAt: Date.now() }));
    timers.push(() => harness.setAside.clearQuestionSetAsideTimer(key));

    harness.setAside.armQuestionSetAsideTimer(key);
    await sleep(10);
    assert.equal(harness.adapterCalls.length, 0, 'not before the wait is over');
    await sleep(120);
    assert.equal(harness.adapterCalls.length, 1);
    assert.equal(harness.savedRecords.get(keyString)?.length, 1);
  });

  it('counts from the ORIGINAL ask, so a restart keeps the rest of the wait: a wait already over fires at once', async () => {
    const harness = createHarness({ shortenedWaitMs: 5000 });
    harness.pendingQuestions.set(keyString, createPending('req_a', { askedAt: Date.now() - 6000 }));
    timers.push(() => harness.setAside.clearQuestionSetAsideTimer(key));

    harness.setAside.armQuestionSetAsideTimer(key);
    await sleep(60);

    assert.equal(harness.adapterCalls.length, 1);
  });

  it('never fires for «Wait for my answer»', async () => {
    const harness = createHarness({ choice: 'untilAnswered', shortenedWaitMs: 10 });
    harness.pendingQuestions.set(keyString, createPending('req_a', { askedAt: Date.now() - 60_000 }));

    harness.setAside.armQuestionSetAsideTimer(key);
    await sleep(80);

    assert.equal(harness.adapterCalls.length, 0);
    assert.equal(harness.pendingQuestions.has(keyString), true);
  });

  it('«Don\'t wait» fires at once', async () => {
    const harness = createHarness({ choice: 'dontWait' });
    harness.pendingQuestions.set(keyString, createPending('req_a'));

    harness.setAside.armQuestionSetAsideTimer(key);
    await sleep(60);

    assert.equal(harness.adapterCalls.length, 1);
  });

  it('clearing the timer cancels it', async () => {
    const harness = createHarness({ shortenedWaitMs: 40 });
    harness.pendingQuestions.set(keyString, createPending('req_a', { askedAt: Date.now() }));

    harness.setAside.armQuestionSetAsideTimer(key);
    harness.setAside.clearQuestionSetAsideTimer(key);
    await sleep(120);

    assert.equal(harness.adapterCalls.length, 0);
  });

  it('arming again replaces the timer: one question, one set-aside', async () => {
    const harness = createHarness({ shortenedWaitMs: 40 });
    harness.pendingQuestions.set(keyString, createPending('req_a', { askedAt: Date.now() }));
    timers.push(() => harness.setAside.clearQuestionSetAsideTimer(key));

    harness.setAside.armQuestionSetAsideTimer(key);
    harness.setAside.armQuestionSetAsideTimer(key);
    await sleep(150);

    assert.equal(harness.adapterCalls.length, 1);
  });

  it('a question saved before askedAt existed counts from now, and the moment is saved', async () => {
    const harness = createHarness({ shortenedWaitMs: 5000 });
    const pending = createPending('req_a');
    delete pending.askedAt;
    harness.pendingQuestions.set(keyString, pending);
    timers.push(() => harness.setAside.clearQuestionSetAsideTimer(key));

    const before = Date.now();
    harness.setAside.armQuestionSetAsideTimer(key);

    assert.ok(pending.askedAt !== undefined && pending.askedAt >= before, 'stamped');
    assert.deepEqual(harness.savedPending, [pending], 'and saved, so a later restart keeps it');
  });

  it('nothing is armed for a conversation with no pending question', () => {
    const harness = createHarness({ choice: 'dontWait' });
    assert.doesNotThrow(() => harness.setAside.armQuestionSetAsideTimer(key));
  });
});

describe('checkIsSetAsideQuestionMessage', () => {
  it('is true for the live message and the original of a record, false for any other message, and for a conversation with none', () => {
    const harness = createHarness({ existingRecords: [{ ...createRecord('a', 250), originalMessageId: 150 }, createRecord('b', 300)] });
    assert.equal(harness.setAside.checkIsSetAsideQuestionMessage(key, 250), true);
    assert.equal(harness.setAside.checkIsSetAsideQuestionMessage(key, 150), true);
    assert.equal(harness.setAside.checkIsSetAsideQuestionMessage(key, 300), true);
    assert.equal(harness.setAside.checkIsSetAsideQuestionMessage(key, 301), false);

    const none = createHarness();
    assert.equal(none.setAside.checkIsSetAsideQuestionMessage(key, 250), false);
  });
});

const operatorReply = (messageId: number, text: string, replyTo: number | null, overrides: Partial<SetAsideReplyCandidate> = {}): SetAsideReplyCandidate => ({
  message_id: messageId,
  text,
  reply_to_message: replyTo === null ? undefined : { message_id: replyTo },
  isForwarded: false,
  ...overrides,
});

const topicMember: User = { id: 515151, is_bot: false, first_name: 'Tess', last_name: 'Talker', username: 'tess' };

describe('a late answer by reply', () => {
  it('a reply to the question\'s message sends ONE late-answer message to the agent, closes the message with the answer and releases its pin', async () => {
    const harness = createHarness({ existingRecords: [createRecord('1', 500)] });

    assert.equal(await harness.setAside.answerSetAsideQuestionByReply(undefined, key, operatorReply(700, 'Wait, the review comes first', 500), 'admin'), true);

    assert.equal(harness.delivered.length, 1);
    assert.match(harness.delivered[0].text, /^\[Late answer to your question asked [\d: -]+, set aside [\d: -]+\]\nQuestion: Push the fix to main now, or wait for the review\?\nAnswer: Wait, the review comes first\n/);
    assert.equal(harness.delivered[0].messageContext, undefined, 'the operator\'s answer carries no mark');
    assert.deepEqual(harness.closes, [{ messageId: 500, ending: { answer: 'Wait, the review comes first' } }]);
    assert.deepEqual(harness.unpins, [500]);
    assert.deepEqual(harness.savedRecords.get(keyString), [], 'the record is over');
    assert.deepEqual(harness.pushedMessageIds, [700], 'the reply is tracked like any inbound message');
  });

  it('a bare option number in a reply picks that option', async () => {
    const harness = createHarness({ existingRecords: [createRecord('1', 500)] });

    await harness.setAside.answerSetAsideQuestionByReply(undefined, key, operatorReply(700, '2', 500), 'admin');

    assert.match(harness.delivered[0].text, /Answer: Wait for the review\n/);
    assert.deepEqual(harness.closes, [{ messageId: 500, ending: { answer: 'Wait for the review' } }]);
  });

  it('a topic member\'s reply reaches the agent under their mark, never as the operator\'s words', async () => {
    const harness = createHarness({ existingRecords: [createRecord('1', 500)] });

    await harness.setAside.answerSetAsideQuestionByReply(topicMember, key, operatorReply(700, 'Push now', 500), 'talker');

    assert.match(harness.delivered[0].messageContext?.block ?? '', /^\[Message from topic member "Tess Talker" \(@tess\) · not the operator\]$/, 'the mark, and nothing else');
    assert.equal(harness.delivered[0].messageContext?.nonOperatorSender, undefined, 'not marked as foreign words: that would neutralise the bot\'s own header');
    assert.equal(harness.delivered[0].messageContext?.isForwarded, false);
  });

  it('a reply to the ORIGINAL message of a re-posted question answers it too', async () => {
    const harness = createHarness({ existingRecords: [{ ...createRecord('1', 250), originalMessageId: 150 }] });

    assert.equal(await harness.setAside.answerSetAsideQuestionByReply(undefined, key, operatorReply(700, 'Push now', 150), 'admin'), true);

    assert.equal(harness.delivered.length, 1);
    assert.deepEqual(harness.closes, [{ messageId: 250, ending: { answer: 'Push now' } }], 'the live copy carries the answer');
  });

  it('is no answer — and delivers nothing — when it replies to another message, to nothing, is forwarded, a slash command or empty, or nothing is set aside', async () => {
    const harness = createHarness({ existingRecords: [createRecord('1', 500)] });
    const notAnswers: SetAsideReplyCandidate[] = [
      operatorReply(701, 'Push now', 999),
      operatorReply(702, 'Push now', null),
      operatorReply(703, 'Push now', 500, { isForwarded: true }),
      operatorReply(704, '/new', 500),
      operatorReply(705, '   ', 500),
    ];
    for (const message of notAnswers) {
      assert.equal(await harness.setAside.answerSetAsideQuestionByReply(undefined, key, message, 'admin'), false, JSON.stringify(message));
    }
    assert.deepEqual(harness.delivered, []);
    assert.equal(harness.savedRecords.get(keyString)?.length, 1, 'the question stays open');

    const none = createHarness();
    assert.equal(await none.setAside.answerSetAsideQuestionByReply(undefined, key, operatorReply(706, 'Push now', 500), 'admin'), false);
  });

  it('a conversation with no session to take it leaves the question open: nothing is closed, and the next reply still answers', async () => {
    let outcome: LatePromptOutcome = 'noSession';
    const harness = createHarness({ existingRecords: [createRecord('1', 500)], deliverLateAnswer: async () => outcome });

    assert.equal(await harness.setAside.answerSetAsideQuestionByReply(undefined, key, operatorReply(700, 'Push now', 500), 'admin'), true, 'it was taken as an answer — the topic was told why it did not arrive');
    assert.deepEqual(harness.closes, []);
    assert.equal(harness.savedRecords.get(keyString)?.length, 1);

    outcome = 'forwarded';
    await harness.setAside.answerSetAsideQuestionByReply(undefined, key, operatorReply(701, 'Push now', 500), 'admin');
    assert.deepEqual(harness.closes, [{ messageId: 500, ending: { answer: 'Push now' } }]);
    assert.deepEqual(harness.savedRecords.get(keyString), []);
  });

  it('a second answer while the first is on its way answers nothing: the agent gets one late answer', async () => {
    let release: () => void = () => {};
    const harness = createHarness({ existingRecords: [createRecord('1', 500)], deliverLateAnswer: () => new Promise<LatePromptOutcome>((resolve) => { release = () => resolve('forwarded'); }) });

    const first = harness.setAside.answerSetAsideQuestionByReply(undefined, key, operatorReply(700, 'Push now', 500), 'admin');
    await sleep(10);
    const second = await harness.setAside.answerSetAsideQuestionByReply(undefined, key, operatorReply(701, 'Wait', 500), 'admin');
    release();

    assert.equal(second, false, 'the second one is an ordinary message');
    assert.equal(await first, true);
    assert.equal(harness.delivered.length, 1);
  });
});

describe('a late answer to a call with several questions', () => {
  const twoQuestionRecord = (overrides: Partial<SetAsideQuestionRecord> = {}): SetAsideQuestionRecord => ({
    id: '1', messageId: 500, questions: [deployQuestion, docsQuestion], answers: [null, null], lateFromIndex: 0, askedAt: 1, setAsideAt: 2, ...overrides,
  });

  it('the first answer is kept, its message closes with it, and the next question is posted in the set-aside look — nothing goes to the agent yet', async () => {
    const harness = createHarness({ existingRecords: [{ ...twoQuestionRecord(), originalMessageId: 400 }] });

    await harness.setAside.answerSetAsideQuestionByReply(undefined, key, operatorReply(700, 'Push now', 500), 'admin');

    assert.deepEqual(harness.delivered, []);
    assert.deepEqual(harness.closes, [{ messageId: 500, ending: { answer: 'Push now' } }]);
    assert.deepEqual(harness.unpins, [500]);
    assert.equal(harness.sentQuestions.length, 1);
    assert.equal(harness.sentQuestions[0].question, docsQuestion);
    assert.deepEqual(harness.sentQuestions[0].keyboard?.inline_keyboard.map((row) => row.map((button) => 'callback_data' in button ? button.callback_data : null)), [['qs_1_0'], ['qs_1_1'], ['qs_1_2']]);
    assert.deepEqual(harness.silentPins, [901], 'the next question is pinned, silently');
    assert.equal(harness.edits.length, 1, 'and shown in the set-aside look');
    assert.equal(harness.edits[0].messageId, 901);
    const [record] = harness.savedRecords.get(keyString) ?? [];
    assert.deepEqual(record.answers, [['Push now'], null]);
    assert.equal(record.messageId, 901, 'the record now follows the second question\'s message');
    assert.equal(record.originalMessageId, undefined, 'the answered question\'s first message is not the new one\'s');
  });

  it('the last answer sends ONE message listing every late answer, and ends the record', async () => {
    const harness = createHarness({ existingRecords: [twoQuestionRecord()] });

    await harness.setAside.answerSetAsideQuestionByReply(undefined, key, operatorReply(700, 'Push now', 500), 'admin');
    await harness.setAside.answerSetAsideQuestionByReply(undefined, key, operatorReply(701, '3', 901), 'admin');

    assert.equal(harness.delivered.length, 1, 'one message for the whole call');
    assert.match(harness.delivered[0].text, /Question: Push the fix to main now, or wait for the review\?\nAnswer: Push now\n\nQuestion: Which docs to update first\?\nAnswer: Both\nYou went on without them/);
    assert.deepEqual(harness.closes.map((close) => close.messageId), [500, 901]);
    assert.deepEqual(harness.savedRecords.get(keyString), []);
  });

  it('only the questions that were open when the agent was told to go on are late: the answer given before the wait is not repeated', async () => {
    const harness = createHarness({ existingRecords: [twoQuestionRecord({ answers: [['Push now'], null], lateFromIndex: 1, messageId: 501 })] });

    await harness.setAside.answerSetAsideQuestionByReply(undefined, key, operatorReply(700, 'README', 501), 'admin');

    assert.equal(harness.delivered.length, 1);
    assert.ok(!harness.delivered[0].text.includes('Push the fix to main'), 'the first question was answered at the wait');
    assert.match(harness.delivered[0].text, /Question: Which docs to update first\?\nAnswer: README\n/);
  });

  it('a question that cannot be posted leaves the record open with no message, and says so in the log', async () => {
    const harness = createHarness({ existingRecords: [twoQuestionRecord()] });
    harness.ports.sendQuestionMessage = async () => null;
    const setAside = createQuestionSetAside(harness.ports);

    const warnings = await captureWarnings(async () => {
      await setAside.answerSetAsideQuestionByReply(undefined, key, operatorReply(700, 'Push now', 500), 'admin');
    });

    assert.equal(warnings.length, 1);
    assert.equal(harness.savedRecords.get(keyString)?.[0].messageId, null);
    assert.deepEqual(harness.silentPins, []);
  });
});

describe('closeSetAsideQuestions — the end of a conversation', () => {
  it('empties the saved list FIRST, then closes every message as not answered and releases every pin', async () => {
    const harness = createHarness({ existingRecords: [createRecord('1', 500), { ...createRecord('2', 600), originalMessageId: 550 }] });
    let listWhenFirstClosed: number | undefined;
    harness.ports.closeQuestionMessage = async (_key, messageId, _question, ending) => {
      listWhenFirstClosed ??= harness.savedRecords.get(keyString)?.length;
      harness.closes.push({ messageId, ending });
      return true;
    };
    const fresh = createQuestionSetAside(harness.ports);

    await fresh.closeSetAsideQuestions(key);

    assert.equal(listWhenFirstClosed, 0, 'a tap that comes meanwhile finds nothing');
    assert.deepEqual(harness.closes, [{ messageId: 500, ending: 'unanswered' }, { messageId: 600, ending: 'unanswered' }]);
    assert.deepEqual(harness.unpins, [500, 600]);
    assert.deepEqual(harness.savedRecords.get(keyString), []);
  });

  it('does nothing for a conversation with no set-aside question', async () => {
    const harness = createHarness();
    await harness.setAside.closeSetAsideQuestions(key);
    assert.deepEqual(harness.closes, []);
    assert.equal(harness.savedRecords.size, 0);
  });

  it('orders after a set-aside in flight: the question that set-aside is about to save is closed too, not left open for a conversation that is gone', async () => {
    let resolveSequence: (value: number) => void = () => {};
    const harness = createHarness({ takeSequence: () => new Promise<number>((resolve) => { resolveSequence = resolve; }) });
    harness.pendingQuestions.set(keyString, createPending('req_a', { messageId: 500 }));

    const setAside = harness.setAside.setPendingQuestionAside(key, 'req_a');
    await sleep(0);
    const closing = harness.setAside.closeSetAsideQuestions(key);
    resolveSequence(1);
    await Promise.all([setAside, closing]);

    assert.deepEqual(harness.savedRecords.get(keyString), [], 'nothing stays open');
    assert.ok(harness.closes.some((close) => close.messageId === 500 && close.ending === 'unanswered'), 'the question\'s message ends as not answered');
    assert.ok(harness.unpins.includes(500));
  });

  it('a late answer that comes after the conversation ended answers nothing', async () => {
    const harness = createHarness({ existingRecords: [createRecord('1', 500)] });
    await harness.setAside.closeSetAsideQuestions(key);

    assert.equal(await harness.setAside.answerSetAsideQuestionByReply(undefined, key, operatorReply(700, 'Push now', 500), 'admin'), false);
    assert.deepEqual(harness.delivered, []);
  });
});
