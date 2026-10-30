/**
 * @description The question the idle compaction asks again (D1), through the REAL compaction module
 * (`connectors/telegram/commands/compaction.ts`) wired to ports (`commandModuleHarness.ts`: a real telegraf instance against
 * the fake Bot API, the real state store, recording topic sends) and a stub adapter. The record of the question goes through
 * its phases the way it does in the bot — the idle fire rejects the open question, compacts, posts the re-ask — and a held
 * send and a controllable `deliverLabel` port put a typed number or a tap at every point of it:
 *
 *   • a number typed while the re-ask is being sent, delivered BEFORE the copy lands and AFTER it, and not delivered at all
 *     (the label reaches no session): what is written on the old message and on the copy, and when;
 *   • the idle fire's own record in the saved state, the person writing or the conversation ending meanwhile;
 *   • a restored (boot) record answered by a tap; a tap on a message that is not the record's; a tap that reaches no session;
 *     a tap whose record a newer re-ask took the place of.
 *
 * What the end-to-end flows cover instead: the same questions asked by a real agent process and a real bot (`questionKeptE2e.test.ts`).
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { EventEmitter } from 'node:events';
import { after, before, beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCompaction } from '../connectors/telegram/commands/compaction';
import type { AgentAdapter, AgentSession, CompactionResult, OpenCodeQuestion, PendingQuestionState, ReAskedQuestionRecord } from '../types';
import type { QuestionEnd } from '../openCodeQuestionFlow';
import type { LatePromptOutcome } from '../utils/promptDelivery';
import type { SessionKey } from '../sessionKey';
import { keyToString } from '../sessionKey';
import { enDict } from '../i18n/en';
import { createCommandHarness, type CommandHarness } from './commandModuleHarness';

const waitStepMs = 10;
const waitTimeoutMs = 10_000;
/** The idle window of the module under test: the fire comes this long after the last activity. */
const idleWindowMs = 20;

const question: OpenCodeQuestion = { question: 'Which way?', header: 'Way', options: [{ label: 'Short' }, { label: 'Long' }] };
/** The message the question waited in when the idle compaction took it over. */
const waitingMessageId = 77;
const staleMessageId = 9999;

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function createDeferred(): Deferred {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((resolveFn) => { resolve = resolveFn; });
  return { promise, resolve };
}

async function waitUntil(description: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + waitTimeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, waitStepMs));
  }
}

/** The conversation as the idle fire sees it: live, not working, able to compact and to be stopped. */
class StubAdapter extends EventEmitter implements AgentAdapter {
  readonly name = 'stub-idle-adapter';
  readonly label = 'Stub';
  isActive = true;
  readonly signals: string[] = [];
  /** When set, the compaction does not finish until the test lets it: the record stays in its COMPACTING phase. */
  compactionGate: Deferred | null = null;
  compactionStarted = createDeferred();

  async startSession(): Promise<void> {}
  async resumeSession(): Promise<void> {}
  stopSession(): void {}
  async suspendSession(): Promise<void> {}
  checkIsActive(): boolean { return this.isActive; }
  sendInput(): void {}
  sendSignal(_key: SessionKey, signal: string): void { this.signals.push(signal); }
  async getSessions(): Promise<AgentSession[]> { return []; }
  rejectQuestion(): void {}
  async compactContext(): Promise<CompactionResult> {
    this.compactionStarted.resolve();
    await this.compactionGate?.promise;
    return { ok: true, preTokens: null, postTokens: null };
  }
}

interface PendingDelivery {
  label: string;
  settle: (outcome: LatePromptOutcome | null) => void;
}

let harness: CommandHarness;
let compaction: ReturnType<typeof createCompaction>;
const adapter = new StubAdapter();
const pendingQuestions = new Map<string, PendingQuestionState>();
/** What the module asked the bot to close, through its `closeQuestionMessage` port. */
let closedQuestionMessages: Array<{ messageId: number; closing: QuestionEnd }> = [];
/** What the module asked the bot to close because its buttons were tapped on a message it holds no record of. */
let closedOrphanMessages: Array<{ messageId: number; text: string | null }> = [];
/** Messages whose orphan close does not land (both the text edit and the removal of the buttons fail), and ones whose close throws. */
let refusedOrphanCloses = new Set<number>();
let throwingOrphanCloses = new Set<number>();
/** The labels handed to the conversation, each waiting for the test to say where it went. */
let deliveries: PendingDelivery[] = [];
/** Whether the conversation can be woken for a tap (a stopped one can, unless the test says it cannot). */
let canWakeConversation = true;
/** When set, the send of the re-ask is refused (the topic cannot be written to): the send resolves with no message id. */
let isReAskSendRefused = false;
/** Messages whose close the test holds (the call is recorded, its answer waits) — the edit that has not landed yet. */
let heldCloses = new Map<number, Deferred>();
/** Messages whose close Telegram refuses: the call is recorded, the edit does not land. */
let refusedCloses = new Set<number>();
let reAskSendStarted = createDeferred();
let reAskSendGate = createDeferred();
let idleFireFinished = createDeferred();

const key: SessionKey = { platform: 'telegram', space: '-1001111111111', thread: '111' };
const keyString = keyToString(key);

function resetGates(): void {
  reAskSendStarted = createDeferred();
  reAskSendGate = createDeferred();
  idleFireFinished = createDeferred();
}

/** The id the fake topic gave the re-asked question's message (the only send that carries `reask_` buttons). */
function getReAskedMessageId(): number {
  const sent = harness.replies.find((reply) => harness.getKeyboardData(reply).flat().some((data) => data.startsWith('reask_')));
  assert.ok(sent && sent.messageId !== null, 'the re-asked question was sent');
  return sent.messageId;
}

function sortByMessageId(closed: typeof closedQuestionMessages): typeof closedQuestionMessages {
  return [...closed].sort((a, b) => a.messageId - b.messageId);
}

/**
 * Let the idle fire take the open question over: the question is pending in the message it waited in, a turn produced
 * output, the topic goes quiet for the (short) idle window. Resolves once the fire has begun to send the re-ask, which the
 * gate then holds — the record is in its SENDING phase.
 */
async function startIdleFireUntilReAskIsBeingSent(options: { waitingMessageId: number | null } = { waitingMessageId }): Promise<void> {
  startIdleFire(options.waitingMessageId);
  await reAskSendStarted.promise;
}

/** The question is pending in `messageId` (`null`: its own post is still in flight), a turn produced output, the topic goes quiet. */
function startIdleFire(messageId: number | null): void {
  pendingQuestions.set(keyString, {
    data: { requestId: 'que_1', questions: [question] },
    messageId,
    answers: [null],
    currentIndex: 0,
  });
  compaction.markThreadTurnProducedOutput(key);
  compaction.noteThreadActivity(key);
}

/** A restored (boot) record whose copy is the message `messageId`, saved the way the post leaves it. */
async function seedRestoredReAskedQuestion(messageId: number): Promise<ReAskedQuestionRecord> {
  const saved: ReAskedQuestionRecord = { messageId, question };
  await harness.state.setReAskedQuestion(key, saved);
  compaction.restoreReAskedQuestion(key, saved);
  return saved;
}

/** Run a tap on `reask_<optionIndex>` of message `messageId`; resolves once the handler is done. */
function tapReAskedButton(messageId: number, optionIndex: number): Promise<void> {
  return harness.tapButton(messageId, `reask_${optionIndex}`);
}

async function waitForDelivery(deliveryCount: number): Promise<void> {
  await waitUntil(`${deliveryCount} label(s) to be handed to the conversation`, () => deliveries.length >= deliveryCount);
}

function getLastToast(): string | undefined {
  return harness.fakeTelegram.callbackAnswers.at(-1);
}

describe('the question the idle compaction asked again, through the compaction module', () => {
  before(async () => {
    harness = await createCommandHarness();
    compaction = createCompaction({
      ...harness.core,
      replyToThread: async (replyKey, text, extra) => {
        if (JSON.stringify(extra ?? {}).includes('reask_')) {
          reAskSendStarted.resolve();
          await reAskSendGate.promise;
          if (isReAskSendRefused) return null;
        }
        return harness.core.replyToThread(replyKey, text, extra);
      },
      startTypingLoader: () => {},
      forwardPromptToAgent: async () => {},
      pendingQuestions,
      clearPendingQuestion: (clearedKey) => { pendingQuestions.delete(keyToString(clearedKey)); },
      closeQuestionMessage: async (_key, messageId, _question, ending) => {
        closedQuestionMessages.push({ messageId, closing: ending });
        await heldCloses.get(messageId)?.promise;
        return !refusedCloses.has(messageId);
      },
      idleWindowMs,
      checkIsLimitWaitArmed: () => false,
      // The last step of the idle fire (after the compaction and the re-ask): the stop of the conversation.
      suspendThreadSession: async () => { idleFireFinished.resolve(); },
      resumeSleepingSessionForCompaction: async () => false,
      getThreadAdapter: () => adapter,
      deliverLabel: (_key, label) => new Promise((resolve) => { deliveries.push({ label, settle: resolve }); }),
      resumeSleepingSessionForPrompt: async () => canWakeConversation,
      checkIsStarting: () => false,
      closeOrphanQuestionMessage: async (_key, messageId, text) => {
        closedOrphanMessages.push({ messageId, text });
        if (throwingOrphanCloses.has(messageId)) throw new Error('the close could not be sent');
        return !refusedOrphanCloses.has(messageId);
      },
      notePersonActivity: (activeKey) => { compaction.noteThreadUserActivity(activeKey); },
    });
    compaction.registerCompactionCallbacks();
  });

  after(async () => {
    await harness.stop();
  });

  beforeEach(async () => {
    resetGates();
    closedQuestionMessages = [];
    closedOrphanMessages = [];
    refusedOrphanCloses = new Set();
    throwingOrphanCloses = new Set();
    deliveries = [];
    canWakeConversation = true;
    isReAskSendRefused = false;
    heldCloses = new Map();
    refusedCloses = new Set();
    adapter.compactionGate = null;
    adapter.compactionStarted = createDeferred();
    adapter.isActive = true;
    pendingQuestions.clear();
    harness.replies.length = 0;
    await harness.state.clearCompactIdleTracking(key);
    await harness.state.setCompactIdleLatched(key, false);
    await harness.state.setAgent(key, { name: adapter.name, claudeSessionId: 'session-reask' });
  });

  afterEach(async () => {
    reAskSendGate.resolve();
    adapter.compactionGate?.resolve();
    for (const held of heldCloses.values()) held.resolve();
    for (const delivery of deliveries) delivery.settle('forwarded');
    compaction.clearThreadCompaction(key);
    await harness.state.clearReAskedQuestion(key);
  });

  describe('a number typed while the re-ask is being sent', () => {
    it('delivered after the copy landed: nothing is written until then, and then the copy and the old message both show the answer', async () => {
      await startIdleFireUntilReAskIsBeingSent();
      const handled = compaction.answerReAskedQuestionByNumber(key, '2');
      await waitForDelivery(1);
      assert.equal(deliveries[0].label, 'Long', 'the label of option 2 goes to the conversation');

      reAskSendGate.resolve();
      await idleFireFinished.promise;
      assert.deepEqual(closedQuestionMessages, [], 'the copy landed and the idle fire is done: no result is written before the label is delivered');

      deliveries[0].settle('forwarded');
      assert.equal(await handled, true);
      assert.deepEqual(sortByMessageId(closedQuestionMessages), sortByMessageId([
        { messageId: waitingMessageId, closing: { answer: 'Long' } },
        { messageId: getReAskedMessageId(), closing: { answer: 'Long' } },
      ]));
    });

    it('delivered before the copy lands: the old message shows the answer at once, and the copy that lands shows it too', async () => {
      await startIdleFireUntilReAskIsBeingSent();
      const handled = compaction.answerReAskedQuestionByNumber(key, '2');
      await waitForDelivery(1);
      deliveries[0].settle('forwarded');
      assert.equal(await handled, true);
      assert.deepEqual(closedQuestionMessages, [{ messageId: waitingMessageId, closing: { answer: 'Long' } }], 'the old message ends with the answer, the copy has no id yet');

      reAskSendGate.resolve();
      await idleFireFinished.promise;
      assert.deepEqual(sortByMessageId(closedQuestionMessages), sortByMessageId([
        { messageId: waitingMessageId, closing: { answer: 'Long' } },
        { messageId: getReAskedMessageId(), closing: { answer: 'Long' } },
      ]), 'the copy that landed ends the same way, and nothing says «asked again»');
    });

    it('that reaches no session: the copy is left open with its buttons, the old message points at it, and a tap on the copy still answers', async () => {
      await startIdleFireUntilReAskIsBeingSent();
      const handled = compaction.answerReAskedQuestionByNumber(key, '2');
      await waitForDelivery(1);
      reAskSendGate.resolve();
      await idleFireFinished.promise;
      assert.deepEqual(closedQuestionMessages, [], 'the idle fire leaves the old message alone while an answer is on its way');

      deliveries[0].settle('noSession');
      assert.equal(await handled, true);
      // The line that makes this test load-bearing: without it the old message would never say where the question went.
      assert.deepEqual(closedQuestionMessages, [{ messageId: waitingMessageId, closing: 'askedAgain' }], 'the old message points at the copy; the copy is untouched');

      const copyMessageId = getReAskedMessageId();
      const tap = tapReAskedButton(copyMessageId, 0);
      await waitForDelivery(2);
      assert.equal(deliveries[1].label, 'Short', 'the question is open again: its button delivers its label');
      deliveries[1].settle('forwarded');
      await tap;
      assert.deepEqual(closedQuestionMessages.at(-1), { messageId: copyMessageId, closing: { answer: 'Short' } });
    });

    it('that is not an option number: it is not an answer, and the question stays as it was', async () => {
      await startIdleFireUntilReAskIsBeingSent();
      assert.equal(await compaction.answerReAskedQuestionByNumber(key, '7'), false, 'a number beyond the options');
      assert.equal(await compaction.answerReAskedQuestionByNumber(key, 'the long one'), false, 'words');
      assert.equal(deliveries.length, 0);

      reAskSendGate.resolve();
      await idleFireFinished.promise;
      assert.deepEqual(closedQuestionMessages, [{ messageId: waitingMessageId, closing: 'askedAgain' }]);
    });
  });

  describe('the idle fire', () => {
    it('saves the record at once, on the message the question waited in, and on the copy once it landed', async () => {
      await startIdleFireUntilReAskIsBeingSent();
      await waitUntil('the record to be saved unposted', () => harness.state.getReAskedQuestions()[keyString]?.isPosted === false);
      assert.deepEqual(harness.state.getReAskedQuestions()[keyString], { messageId: waitingMessageId, question, isPosted: false });
      assert.deepEqual(closedQuestionMessages, [], 'the old message is not touched while nothing is asked again yet');

      reAskSendGate.resolve();
      await idleFireFinished.promise;
      assert.deepEqual(
        harness.state.getReAskedQuestions()[keyString],
        { messageId: getReAskedMessageId(), question, predecessorMessageId: waitingMessageId, isPredecessorClosed: true },
        'and, once the old message has its note, says so',
      );
      assert.deepEqual(closedQuestionMessages, [{ messageId: waitingMessageId, closing: 'askedAgain' }]);
    });

    it('a person writing while the re-ask is being sent ends the old message and the copy that lands as «not answered»', async () => {
      await startIdleFireUntilReAskIsBeingSent();
      compaction.closeReAskedQuestion(key);
      await waitUntil('the old message to be closed', () => closedQuestionMessages.length === 1);
      assert.deepEqual(closedQuestionMessages, [{ messageId: waitingMessageId, closing: 'unanswered' }]);

      reAskSendGate.resolve();
      await idleFireFinished.promise;
      assert.deepEqual(sortByMessageId(closedQuestionMessages), sortByMessageId([
        { messageId: waitingMessageId, closing: 'unanswered' },
        { messageId: getReAskedMessageId(), closing: 'unanswered' },
      ]), 'the copy that landed after it ends the same way, and nothing says «asked again»');
      assert.equal(harness.state.getReAskedQuestions()[keyString], undefined, 'and nothing is left in the saved state');
    });
  });

  describe('a second tap, or a tap while a typed number is being delivered', () => {
    it('a second tap on a message the first is still answering answers nothing and rewrites nothing, then or after', async () => {
      adapter.isActive = false;
      await seedRestoredReAskedQuestion(4321);
      const firstTap = tapReAskedButton(4321, 0);
      await waitForDelivery(1);
      await tapReAskedButton(4321, 0);
      assert.equal(getLastToast(), enDict['cb.no_pending_question'], 'the second tap says the question is spent');
      assert.deepEqual(closedOrphanMessages, [], 'and does not rewrite the message the first is answering');

      deliveries[0].settle('forwarded');
      await firstTap;
      await tapReAskedButton(4321, 0);
      assert.deepEqual(closedOrphanMessages, [], 'nor does one that comes after the answer is written');
      assert.deepEqual(closedQuestionMessages, [{ messageId: 4321, closing: { answer: 'Short' } }], 'the answer is the only result the message got');
    });

    it('a tap while a typed number\'s label is being delivered rewrites nothing, and the question is open again if that finds no session', async () => {
      await seedRestoredReAskedQuestion(4322);
      const handled = compaction.answerReAskedQuestionByNumber(key, '2');
      await waitForDelivery(1);
      await tapReAskedButton(4322, 0);
      assert.equal(getLastToast(), enDict['cb.no_pending_question']);
      assert.deepEqual(closedOrphanMessages, [], 'the message is not rewritten over an answer that may still come');

      deliveries[0].settle('noSession');
      assert.equal(await handled, true);
      assert.deepEqual(closedQuestionMessages, [], 'nothing was written: the question is open again');
      const tap = tapReAskedButton(4322, 1);
      await waitForDelivery(2);
      deliveries[1].settle('forwarded');
      await tap;
      assert.deepEqual(closedQuestionMessages, [{ messageId: 4322, closing: { answer: 'Long' } }], 'and its buttons still answer');
    });

    it('a copy whose answer found no session is an open question again: once a newer re-ask replaces it, a stale tap on it closes it', async () => {
      await seedRestoredReAskedQuestion(4600);
      const tap = tapReAskedButton(4600, 0);
      await waitForDelivery(1);
      deliveries[0].settle('noSession');
      await tap;
      assert.deepEqual(closedQuestionMessages, [], 'nothing was written: the question is open again');

      compaction.restoreReAskedQuestion(key, { messageId: 4700, question });
      await tapReAskedButton(4600, 0);
      await waitUntil('the replaced copy to be closed', () => closedOrphanMessages.length === 1);
      assert.deepEqual(closedOrphanMessages, [{ messageId: 4600, text: 'screen 4600' }], 'it is not a message that carries a result, so it does not keep live buttons');
    });

    it('a message the bot closed is not rewritten by a stale tap, but one whose close Telegram refused is closed with its own text, once', async () => {
      await seedRestoredReAskedQuestion(4400);
      compaction.closeReAskedQuestion(key);
      await waitUntil('the close of the first message', () => closedQuestionMessages.length === 1);
      await tapReAskedButton(4400, 0);
      assert.deepEqual(closedOrphanMessages, [], 'its note is the result, whatever the stale view still shows');

      refusedCloses.add(4500);
      await seedRestoredReAskedQuestion(4500);
      compaction.closeReAskedQuestion(key);
      await waitUntil('the refused close', () => closedQuestionMessages.length === 2);
      await tapReAskedButton(4500, 0);
      await waitUntil('the stale message to be closed', () => closedOrphanMessages.length === 1);
      assert.deepEqual(closedOrphanMessages, [{ messageId: 4500, text: 'screen 4500' }]);
      await tapReAskedButton(4500, 0);
      assert.equal(closedOrphanMessages.length, 1, 'a second tap on it does not append a second note');
    });

    it('a close that did not land (both edits failed, or it threw) is tried again by the next tap, and not any more once it landed', async () => {
      /** Let what the tap left running in the background (the close, and what it does with the outcome) finish. */
      const flushBackground = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });
      refusedOrphanCloses.add(4800);
      throwingOrphanCloses.add(4900);
      await seedRestoredReAskedQuestion(4700);

      // The text edit and the removal of the buttons both fail: the message keeps live buttons that do nothing, so it is not "ended".
      await tapReAskedButton(4800, 0);
      await waitUntil('the first attempt', () => closedOrphanMessages.length === 1);
      await flushBackground();
      await tapReAskedButton(4800, 0);
      await waitUntil('the second attempt', () => closedOrphanMessages.length === 2);
      assert.deepEqual(closedOrphanMessages.map((closed) => closed.messageId), [4800, 4800], 'the next tap tries the close again');
      await flushBackground();

      refusedOrphanCloses.delete(4800);
      await tapReAskedButton(4800, 0);
      await waitUntil('the attempt that lands', () => closedOrphanMessages.length === 3);
      await flushBackground();
      await tapReAskedButton(4800, 0);
      await flushBackground();
      assert.equal(closedOrphanMessages.length, 3, 'once it landed, a further tap leaves the message alone');

      // A close that threw is no different.
      await tapReAskedButton(4900, 0);
      await waitUntil('the attempt that threw', () => closedOrphanMessages.length === 4);
      await flushBackground();
      throwingOrphanCloses.delete(4900);
      await tapReAskedButton(4900, 0);
      await waitUntil('the retry after the throw', () => closedOrphanMessages.length === 5);
      assert.deepEqual(closedOrphanMessages.slice(3).map((closed) => closed.messageId), [4900, 4900]);
    });
  });

  describe('while neither the copy nor the old message has an id', () => {
    it('no tap is taken: it answers nothing and rewrites nothing, and once the copy has its id it answers', async () => {
      await startIdleFireUntilReAskIsBeingSent({ waitingMessageId: null });
      await tapReAskedButton(800, 0);
      assert.equal(getLastToast(), enDict['cb.no_pending_question']);
      assert.deepEqual(closedOrphanMessages, [], 'the copy that is being sent may be the very message tapped');
      assert.equal(deliveries.length, 0, 'and no label reaches the conversation');

      reAskSendGate.resolve();
      await idleFireFinished.promise;
      const copyMessageId = getReAskedMessageId();
      const tap = tapReAskedButton(copyMessageId, 0);
      await waitForDelivery(1);
      deliveries[0].settle('forwarded');
      await tap;
      assert.deepEqual(closedQuestionMessages, [{ messageId: copyMessageId, closing: { answer: 'Short' } }]);
    });
  });

  describe('a typed number that finds no session', () => {
    /** The compaction runs; a number typed now takes the record in its COMPACTING phase and its label is being delivered. */
    async function typeNumberDuringCompaction(): Promise<{ handled: Promise<boolean> }> {
      adapter.compactionGate = createDeferred();
      startIdleFire(waitingMessageId);
      await adapter.compactionStarted.promise;
      const handled = compaction.answerReAskedQuestionByNumber(key, '2');
      await waitForDelivery(1);
      // In an object: an async function would otherwise wait for the very delivery the test settles later.
      return { handled };
    }

    it('after the idle fire ran without posting the re-ask: it is posted now, and the old message points at it', async () => {
      const { handled } = await typeNumberDuringCompaction();
      reAskSendGate.resolve();
      adapter.compactionGate?.resolve();
      await idleFireFinished.promise;
      assert.ok(!harness.replies.some((reply) => harness.getKeyboardData(reply).flat().some((data) => data.startsWith('reask_'))), 'the fire left the taken record alone: nothing asked again');
      assert.deepEqual(closedQuestionMessages, [], 'and the old message has no result yet');

      deliveries[0].settle('noSession');
      assert.equal(await handled, true);
      const copyMessageId = getReAskedMessageId();
      assert.deepEqual(closedQuestionMessages, [{ messageId: waitingMessageId, closing: 'askedAgain' }], 'the question is asked again, and the old message says so');
      assert.deepEqual(harness.state.getReAskedQuestions()[keyString]?.messageId, copyMessageId, 'the copy is the record');

      const tap = tapReAskedButton(copyMessageId, 0);
      await waitForDelivery(2);
      deliveries[1].settle('forwarded');
      await tap;
      assert.deepEqual(closedQuestionMessages.at(-1), { messageId: copyMessageId, closing: { answer: 'Short' } }, 'and the copy answers');
    });

    it('before the idle fire ran: the record goes back and the fire asks the question itself', async () => {
      const { handled } = await typeNumberDuringCompaction();
      deliveries[0].settle('noSession');
      assert.equal(await handled, true);
      assert.equal(harness.replies.filter((reply) => harness.getKeyboardData(reply).flat().some((data) => data.startsWith('reask_'))).length, 0, 'nothing is posted before the compaction ends');

      reAskSendGate.resolve();
      adapter.compactionGate?.resolve();
      await idleFireFinished.promise;
      getReAskedMessageId();
      assert.deepEqual(closedQuestionMessages, [{ messageId: waitingMessageId, closing: 'askedAgain' }]);
    });

    it('after the idle fire ran, when the re-ask cannot be sent: the old message ends as «not answered» and nothing is left to answer', async () => {
      isReAskSendRefused = true;
      const { handled } = await typeNumberDuringCompaction();
      reAskSendGate.resolve();
      adapter.compactionGate?.resolve();
      await idleFireFinished.promise;

      deliveries[0].settle('noSession');
      assert.equal(await handled, true);
      assert.deepEqual(closedQuestionMessages, [{ messageId: waitingMessageId, closing: 'unanswered' }]);
      assert.equal(harness.state.getReAskedQuestions()[keyString], undefined, 'nothing is saved');
      assert.equal(await compaction.answerReAskedQuestionByNumber(key, '1'), false, 'and no record is left for a number to answer');
    });
  });

  describe('the old message of a re-ask, across a restart', () => {
    it('the post is saved with the old message, and that is settled only once its edit has landed', async () => {
      const oldMessageEdit = createDeferred();
      heldCloses.set(waitingMessageId, oldMessageEdit);
      await startIdleFireUntilReAskIsBeingSent();
      reAskSendGate.resolve();
      await waitUntil('the edit of the old message to be asked', () => closedQuestionMessages.length === 1);
      const copyMessageId = getReAskedMessageId();
      await waitUntil('the post to be saved', () => harness.state.getReAskedQuestions()[keyString]?.messageId === copyMessageId);
      assert.deepEqual(
        harness.state.getReAskedQuestions()[keyString],
        { messageId: copyMessageId, question, predecessorMessageId: waitingMessageId, isPredecessorClosed: false },
        'a restart now finds the old message without its note',
      );

      oldMessageEdit.resolve();
      await waitUntil('the edit to be saved as landed', () => harness.state.getReAskedQuestions()[keyString]?.isPredecessorClosed === true);
      await idleFireFinished.promise;
    });

    it('an edit that did not land leaves the old message unsettled in the saved state', async () => {
      refusedCloses.add(waitingMessageId);
      await startIdleFireUntilReAskIsBeingSent();
      reAskSendGate.resolve();
      await idleFireFinished.promise;
      assert.equal(harness.state.getReAskedQuestions()[keyString]?.isPredecessorClosed, false);
    });

    it('a boot that restores the copy finishes an old message left without its note, and leaves a settled one alone', async () => {
      const unsettled: ReAskedQuestionRecord = { messageId: 4321, question, predecessorMessageId: waitingMessageId, isPredecessorClosed: false };
      await harness.state.setReAskedQuestion(key, unsettled);
      compaction.restoreReAskedQuestion(key, unsettled);
      await waitUntil('the old message to be settled', () => closedQuestionMessages.length === 1);
      assert.deepEqual(closedQuestionMessages, [{ messageId: waitingMessageId, closing: 'askedAgain' }], 'it points at the copy that was restored');
      await waitUntil('the saved record to say so', () => harness.state.getReAskedQuestions()[keyString]?.isPredecessorClosed === true);

      compaction.closeReAskedQuestion(key);
      closedQuestionMessages = [];
      const settled: ReAskedQuestionRecord = { messageId: 4322, question, predecessorMessageId: waitingMessageId, isPredecessorClosed: true };
      compaction.restoreReAskedQuestion(key, settled);
      assert.deepEqual(closedQuestionMessages, [], 'a note that landed is not written twice');
    });

    it('a boot that cannot bring the copy back closes it and an unsettled old message as «not answered», and drops the record', async () => {
      const unsettled: ReAskedQuestionRecord = { messageId: 4321, question, predecessorMessageId: waitingMessageId, isPredecessorClosed: false };
      await harness.state.setReAskedQuestion(key, unsettled);
      compaction.closeSavedReAskedQuestion(key, unsettled);
      await waitUntil('both closes', () => closedQuestionMessages.length === 2);
      assert.deepEqual(sortByMessageId(closedQuestionMessages), sortByMessageId([
        { messageId: waitingMessageId, closing: 'unanswered' },
        { messageId: 4321, closing: 'unanswered' },
      ]));
      await waitUntil('the saved record to be dropped', () => harness.state.getReAskedQuestions()[keyString] === undefined);

      closedQuestionMessages = [];
      compaction.closeSavedReAskedQuestion(key, { messageId: 4322, question, predecessorMessageId: waitingMessageId, isPredecessorClosed: true });
      compaction.closeSavedReAskedQuestion(key, { messageId: waitingMessageId, question, isPosted: false });
      await waitUntil('the two closes', () => closedQuestionMessages.length === 2);
      assert.deepEqual(sortByMessageId(closedQuestionMessages), sortByMessageId([
        { messageId: 4322, closing: 'unanswered' },
        { messageId: waitingMessageId, closing: 'unanswered' },
      ]), 'a settled old message is left alone; an unposted record names the old message itself');
    });
  });

  describe('the idle compaction a restart interrupted (the saved record names the message the question waited in)', () => {
    const interrupted: ReAskedQuestionRecord = { messageId: waitingMessageId, question, isPosted: false };

    it('the question is asked again by the same post the idle fire makes, the old message points at it, and the copy answers', async () => {
      reAskSendGate.resolve();
      await compaction.reAskInterruptedQuestion(key, interrupted);
      const copyMessageId = getReAskedMessageId();
      const sent = harness.replies.find((reply) => reply.messageId === copyMessageId);
      assert.ok(sent?.text.startsWith(enDict['compactOnIdle.pendingQuestionReask']), `the sentence that says it is asked again: ${sent?.text}`);
      assert.ok(sent?.text.includes(question.question), 'and the question');
      assert.deepEqual(harness.getKeyboardData(sent), [['reask_0'], ['reask_1']], 'one button per option');
      assert.deepEqual(closedQuestionMessages, [{ messageId: waitingMessageId, closing: 'askedAgain' }], 'the old message says where the question went');
      assert.deepEqual(harness.state.getReAskedQuestions()[keyString], { messageId: copyMessageId, question, predecessorMessageId: waitingMessageId, isPredecessorClosed: true }, 'and the saved record names the copy and the settled old message');

      const tap = tapReAskedButton(copyMessageId, 1);
      await waitForDelivery(1);
      assert.equal(deliveries[0].label, 'Long');
      deliveries[0].settle('forwarded');
      await tap;
      assert.deepEqual(closedQuestionMessages.at(-1), { messageId: copyMessageId, closing: { answer: 'Long' } });
    });

    it('a re-ask that cannot be sent ends the old message as «not answered» and leaves nothing in the saved state', async () => {
      isReAskSendRefused = true;
      reAskSendGate.resolve();
      await compaction.reAskInterruptedQuestion(key, interrupted);
      assert.deepEqual(closedQuestionMessages, [{ messageId: waitingMessageId, closing: 'unanswered' }]);
      assert.equal(harness.state.getReAskedQuestions()[keyString], undefined);
    });
  });

  describe('a restored record (the bot restarted while the conversation sleeps)', () => {
    it('a tap on its message wakes the conversation, delivers the label and writes the answer there; the saved record is dropped', async () => {
      adapter.isActive = false;
      await seedRestoredReAskedQuestion(4321);
      const tap = tapReAskedButton(4321, 1);
      await waitForDelivery(1);
      assert.equal(deliveries[0].label, 'Long');
      assert.deepEqual(closedQuestionMessages, [], 'the answer is written once the label is delivered');
      deliveries[0].settle('forwarded');
      await tap;
      assert.deepEqual(closedQuestionMessages, [{ messageId: 4321, closing: { answer: 'Long' } }]);
      await waitUntil('the saved record to be dropped', () => harness.state.getReAskedQuestions()[keyString] === undefined);
    });

    it('a tap when the conversation cannot be woken: the topic is told, the question stays open with its buttons, and the next tap works', async () => {
      adapter.isActive = false;
      canWakeConversation = false;
      await seedRestoredReAskedQuestion(4321);
      await tapReAskedButton(4321, 0);
      assert.equal(getLastToast(), enDict['agent.no_session']);
      assert.equal(deliveries.length, 0, 'nothing was delivered');
      assert.deepEqual(closedQuestionMessages, [], 'and nothing was closed');
      await waitUntil('the record to be saved again', () => harness.state.getReAskedQuestions()[keyString]?.messageId === 4321);

      canWakeConversation = true;
      const tap = tapReAskedButton(4321, 0);
      await waitForDelivery(1);
      deliveries[0].settle('forwarded');
      await tap;
      assert.deepEqual(closedQuestionMessages, [{ messageId: 4321, closing: { answer: 'Short' } }]);
    });

    it('a tap on a message that is not the record\'s answers nothing, closes that message with its own text, and leaves the record alone', async () => {
      await seedRestoredReAskedQuestion(4321);
      await tapReAskedButton(staleMessageId, 0);
      assert.equal(getLastToast(), enDict['cb.no_pending_question']);
      await waitUntil('the stale message to be closed', () => closedOrphanMessages.length === 1);
      assert.deepEqual(closedOrphanMessages, [{ messageId: staleMessageId, text: `screen ${staleMessageId}` }]);
      assert.equal(deliveries.length, 0, 'no label reached the conversation');

      const tap = tapReAskedButton(4321, 0);
      await waitForDelivery(1);
      deliveries[0].settle('forwarded');
      await tap;
      assert.deepEqual(closedQuestionMessages, [{ messageId: 4321, closing: { answer: 'Short' } }], 'the record\'s own message still answers');
    });

    it('a button for an option the question does not have answers nothing and leaves the record alone', async () => {
      await seedRestoredReAskedQuestion(4321);
      await tapReAskedButton(4321, 5);
      assert.equal(getLastToast(), enDict['cb.invalid_option']);
      assert.equal(deliveries.length, 0);
      const handled = compaction.answerReAskedQuestionByNumber(key, '1');
      await waitForDelivery(1);
      deliveries[0].settle('forwarded');
      assert.equal(await handled, true, 'the record is still there');
    });

    it('a tap whose label reaches no session, while a newer re-ask took the record\'s place: the tapped message is closed as «not answered»', async () => {
      await seedRestoredReAskedQuestion(4321);
      const tap = tapReAskedButton(4321, 0);
      await waitForDelivery(1);
      // The tap holds the record; a newer re-ask is restored meanwhile.
      compaction.restoreReAskedQuestion(key, { messageId: 5555, question });
      deliveries[0].settle('noSession');
      await tap;
      assert.deepEqual(closedQuestionMessages, [{ messageId: 4321, closing: 'unanswered' }], 'the tapped copy would answer the wrong question, so it ends');

      const newerTap = tapReAskedButton(5555, 1);
      await waitForDelivery(2);
      assert.equal(deliveries[1].label, 'Long', 'the newer re-ask is the question that waits');
      deliveries[1].settle('forwarded');
      await newerTap;
    });

    it('the end of the conversation closes its message once as «not answered» and forgets the record', async () => {
      await seedRestoredReAskedQuestion(4321);
      compaction.closeReAskedQuestion(key);
      await waitUntil('the close', () => closedQuestionMessages.length === 1);
      assert.deepEqual(closedQuestionMessages, [{ messageId: 4321, closing: 'unanswered' }]);
      await waitUntil('the saved record to be dropped', () => harness.state.getReAskedQuestions()[keyString] === undefined);

      compaction.closeReAskedQuestion(key);
      compaction.clearThreadCompaction(key);
      assert.equal(closedQuestionMessages.length, 1, 'closing again closes nothing more');
    });
  });
});
