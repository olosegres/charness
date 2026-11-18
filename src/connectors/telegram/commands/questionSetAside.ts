/**
 * An agent's question the owner has not answered never keeps the agent standing still: when the question wait ends, the bot tells
 * the agent «no answer yet, go on» (`utils/questionWaitPlan.ts` words it, the adapter's `setQuestionAside` sends it), and keeps the
 * question OPEN in the topic — the same message with a note under its options, its buttons and its pin — so an answer given later
 * still reaches the agent, as a new message. This module owns the timer of that wait, the move of the question from «the agent is
 * blocked on it» (`pendingQuestions`) to the conversation's set-aside list (`state.json`), the message's edit, and what ends such a
 * question: a late answer (a tap on its buttons, a reply to its message), the end of its conversation, a sixth open question.
 * README: contracts.
 */
import type { Context, Telegraf } from 'telegraf';
import type { InlineKeyboardMarkup, User } from 'telegraf/typings/core/types/typegram';
import type { SessionKey } from '../../../sessionKey';
import { keyToString } from '../../../sessionKey';
import { t } from '../../../i18n';
import type { QuestionEnd } from '../../../openCodeQuestionFlow';
import type { StateStore } from '../../../state';
import type { AgentAdapter, OpenCodePendingQuestion, OpenCodeQuestion, PendingQuestionState, SetAsideQuestionRecord } from '../../../types';
import type { LatePromptOutcome } from '../../../utils/promptDelivery';
import {
  addSetAsideQuestion,
  buildLateAnswerPrompt,
  buildQuestionSetAsideText,
  checkIsSetAsideRecordMessage,
  createSetAsideQuestionId,
  getQuestionReplyRouteWithSetAside,
  getQuestionSetAsideDelayMs,
  getSetAsideAnswerTarget,
  getSetAsideRecordAskedAgain,
  type LateAnswerEntry,
} from '../../../utils/questionWaitPlan';
import { setAsideRetryDelayMs, type QuestionWaitChoice } from '../../../utils/questionWaitChoices';
import { getAnswerWithAttribution } from '../../../utils/authorMark';
import { getTelegramTalkerContext } from '../inbound';
import { getCallbackMessageId } from './callbackMessage';
import { answerCallbackWithFittedText } from './callbackToast';
import { buildQuestionOptionsKeyboard } from '../questionKeyboards';
import type { BotCore } from './botCore';

/** The prefix of a set-aside question's button data: `qs_<record id>_<option index>`. */
const setAsideButtonPrefix = 'qs_';

/** After the agent's server could not confirm a waiting question, or did not take what sets it aside, it is tried again at most this many times (a pause of {@link setAsideRetryDelayMs} between). */
export const setAsideRetryLimit = 3;

/**
 * What the note under a set-aside question says: the agent went on, or its server did not CONFIRM the message that tells it to. The second is
 * worded as a fact about that message («did not confirm … if it seems stuck, send it any message»), never as the agent's state now: the
 * agent may move on afterwards on its own, by the owner's message (the wedge abort), or by asking the next question — and a note that
 * claimed it waits would stay up, false, with no single signal to take it down (a restart forgets it too). The way back to the plain note
 * ({@link notTakenNotes}) is best effort: when it is missed the note is still true.
 */
type SetAsideNoteState = 'wentOn' | 'unconfirmed';

/**
 * What the set-aside needs from the bot: the shared core, the pending-question state it moves the question out of, the
 * lifecycle queue it runs in (the same one the post, the re-post and the answer of a question run in, so they never overlap),
 * and the few bot-owned effects around the question message — its pin, its closing, its send gate.
 */
export interface QuestionSetAsidePorts extends Pick<BotCore, 'withThreadLocale' | 'authoriseSpeaker' | 'replyToThread'> {
  /** The state store (assigned at boot): the saved set-aside records and the counter their ids come from. */
  getState: () => Pick<StateStore, 'takeNextSetAsideQuestionSequence' | 'getSetAsideQuestions' | 'setSetAsideQuestions' | 'pushMessageId'>;
  pendingQuestions: Map<string, PendingQuestionState>;
  getThreadAdapter: (key: SessionKey) => Pick<AgentAdapter, 'setQuestionAside' | 'resyncOpenQuestion' | 'surfaceOpenQuestion'>;
  runQuestionLifecycleOp: <TResult>(key: SessionKey, op: () => Promise<TResult>) => Promise<TResult>;
  /** Persist the pending question (the in-memory map and the saved state, which `bot.ts` keeps in lockstep). */
  setPendingQuestion: (key: SessionKey, value: PendingQuestionState) => void;
  /** Drop the pending question (memory and disk) and release its pin; not awaited. */
  clearPendingQuestion: (key: SessionKey) => void;
  /**
   * Take the pending question out of the pending state (memory and disk) because it was SET ASIDE: unlike a clear, the pin stays
   * on the question's message — it belongs to the set-aside record now — so the pin of a question the agent asks next does not
   * retire it, and does not count as a re-pin (silent). EVERYTHING it does is started before it returns its promise, so the
   * caller's next statement may be sure the question is gone from the pending state.
   */
  releasePendingQuestionToSetAside: (key: SessionKey) => Promise<void>;
  /**
   * Put a note under a question's message, and `keyboard` as its buttons (none: the buttons go). A text edit that fails leaves no
   * stale buttons behind: they are replaced by `keyboard`, or taken off. Resolves whether the text edit landed.
   */
  editQuestionMessageWithNote: (key: SessionKey, messageId: number, question: OpenCodeQuestion, note: string, keyboard?: InlineKeyboardMarkup) => Promise<boolean>;
  /** End a question's message without deleting it (the buttons go, a note says how it ended). */
  closeQuestionMessage: (key: SessionKey, messageId: number, question: OpenCodeQuestion, ending: QuestionEnd) => Promise<boolean>;
  unpinMessage: (key: SessionKey, messageId: number) => Promise<void>;
  /** Pin a message of the topic with no notification (the owner is looking at it); resolves whether it is pinned. */
  pinMessageSilently: (key: SessionKey, messageId: number) => Promise<boolean>;
  /** Post a question as a new message of the topic with `keyboard` as its buttons; the id of the message, `null` when no send landed. */
  sendQuestionMessage: (key: SessionKey, question: OpenCodeQuestion, keyboard: InlineKeyboardMarkup | undefined) => Promise<number | null>;
  /**
   * Deliver a late answer to the agent as a message of the owner's, by the state of its session: written to a live one (behind
   * whatever it is doing — it is NOT an answer to a question the agent waits on now, and never cancels one), buffered behind a start,
   * or waking a sleeping conversation. `noSession`: nothing could take it (the topic was told).
   */
  deliverLateAnswer: (key: SessionKey, text: string) => Promise<LatePromptOutcome>;
  /** The next agent output starts a message of its own, below the question (the answer path does the same). */
  markNeedsNewMessage: (key: SessionKey) => void;
  /** The question wait that applies to the topic (its own setting, else General's, else the default). */
  getQuestionWaitChoice: (key: SessionKey) => QuestionWaitChoice;
  /** A test instance's shorter wait (`CHARNESS_TEST_TIMINGS` `questionSetAsideWaitMs`), `undefined` in production. */
  shortenedWaitMs: number | undefined;
  /** The wait between two tries when the server could not confirm a question ({@link setAsideRetryDelayMs} unless a test shortens it). */
  retryDelayMs?: number;
  /** Put a question the agent asks to the topic as a NEW waiting question (what a question that repeats no open one gets); not awaited. */
  postQuestionAnew: (key: SessionKey, questionData: OpenCodePendingQuestion) => void;
}

/** Which question a late answer was meant for: its index in the record and the message it was given on (tapped, or replied to). */
export interface LateAnswerTarget {
  recordId: string;
  questionIndex: number;
  messageId: number;
}

/** A text message of the topic as far as the late-answer route reads it: what it says, what it replies to, whether it is a forward. */
export interface SetAsideReplyCandidate {
  message_id: number;
  text: string;
  /** The message it is genuinely a reply to (`getTelegramReplyTargetId`: «post in this topic» is no reply), `null` for none. */
  replyToMessageId: number | null;
  isForwarded: boolean;
}

/**
 * @description Build the question set-aside over its ports. It returns the timer's arm and clear (the bot arms it when the
 * agent asks and when a restart restores a waiting question, and clears it with the pending question) and the set-aside
 * itself, which the idle fire and the asked-again check call too.
 */
export function createQuestionSetAside(ports: QuestionSetAsidePorts) {
  const {
    getState, withThreadLocale, authoriseSpeaker, replyToThread, pendingQuestions, getThreadAdapter, runQuestionLifecycleOp, setPendingQuestion, clearPendingQuestion,
    releasePendingQuestionToSetAside, editQuestionMessageWithNote, closeQuestionMessage, unpinMessage, pinMessageSilently, sendQuestionMessage, deliverLateAnswer,
    markNeedsNewMessage, getQuestionWaitChoice, shortenedWaitMs, postQuestionAnew,
  } = ports;
  const retryDelayMs = ports.retryDelayMs ?? setAsideRetryDelayMs;

  /** One timer per waiting question, by conversation: it fires at `askedAt + wait`, whatever the agent's process does. */
  const timers = new Map<string, NodeJS.Timeout>();
  /** How many times the wait of a question has ended again for want of the server's word, by conversation and request. */
  const retryAttempts = new Map<string, number>();
  /** How many times the reply that set a question aside failed to reach the agent's server, by conversation and request. */
  const replyFailures = new Map<string, number>();
  /** One pending re-try of such a reply per conversation. */
  const replyRetryTimers = new Map<string, NodeJS.Timeout>();
  /** The set-aside records whose message says the server did not confirm the «go on» reply, by conversation and record id (in memory only: see {@link SetAsideNoteState}). */
  const notTakenNotes = new Set<string>();

  /** What is counted for a question: the conversation and the request (or, for the notes of a record, the record id). */
  const getAttemptKey = (key: SessionKey, id: string): string => `${keyToString(key)}:${id}`;

  /** Forget every count of the conversation's questions (its question was answered, closed or timed again). */
  function forgetAttempts(key: SessionKey): void {
    const prefix = `${keyToString(key)}:`;
    for (const counts of [retryAttempts, replyFailures]) {
      for (const attemptKey of [...counts.keys()]) if (attemptKey.startsWith(prefix)) counts.delete(attemptKey);
    }
    for (const recordKey of [...notTakenNotes]) if (recordKey.startsWith(prefix)) notTakenNotes.delete(recordKey);
  }

  /** The conversation's open set-aside questions, oldest first. */
  function getSetAsideRecords(key: SessionKey): SetAsideQuestionRecord[] {
    return getState().getSetAsideQuestions()[keyToString(key)] ?? [];
  }

  /** The option buttons of a set-aside question: their data names the record, `qs_<record id>_<option index>`. */
  function buildSetAsideKeyboard(record: SetAsideQuestionRecord, question: OpenCodeQuestion): InlineKeyboardMarkup | undefined {
    return buildQuestionOptionsKeyboard(question, (optionIndex) => `${setAsideButtonPrefix}${record.id}_${optionIndex}`);
  }

  function stopSetAsideTimer(key: SessionKey): void {
    const kStr = keyToString(key);
    const timer = timers.get(kStr);
    if (timer) clearTimeout(timer);
    timers.delete(kStr);
  }

  /** The conversation's question left the pending state, or its wait is timed afresh: no timer, and no count of tries made for it. */
  function clearQuestionSetAsideTimer(key: SessionKey): void {
    stopSetAsideTimer(key);
    forgetAttempts(key);
  }

  /** Set a question aside after `delayMs`: the one timer of the conversation — the wait's own, and the wait ending again after the server's silence. */
  function armSetAsideTimer(key: SessionKey, requestId: string, delayMs: number): void {
    stopSetAsideTimer(key);
    const kStr = keyToString(key);
    const timer = setTimeout(() => {
      timers.delete(kStr);
      void withThreadLocale(key, () => setPendingQuestionAside(key, requestId))
        .catch((error) => console.error('[questionSetAside] setting the question aside failed:', error));
    }, delayMs);
    timer.unref();
    timers.set(kStr, timer);
  }

  /**
   * @description Arm the timer of the conversation's waiting question: at `askedAt + wait` — the original ask moment, so a restart
   * that restores the question arms the REST of its wait, not a new one — the question is set aside. No timer for a wait that
   * never ends («Wait for my answer»). A question saved before `askedAt` existed counts from now (and keeps that from then on).
   */
  function armQuestionSetAsideTimer(key: SessionKey): void {
    clearQuestionSetAsideTimer(key);
    const kStr = keyToString(key);
    const pending = pendingQuestions.get(kStr);
    if (!pending) return;
    const nowMs = Date.now();
    if (pending.askedAt === undefined) {
      pending.askedAt = nowMs;
      setPendingQuestion(key, pending);
    }
    const delayMs = getQuestionSetAsideDelayMs(pending.askedAt, getQuestionWaitChoice(key), nowMs, shortenedWaitMs);
    if (delayMs === null) return;
    armSetAsideTimer(key, pending.data.requestId, delayMs);
  }

  /**
   * @description Set the conversation's waiting question `requestId` aside: the agent is told to go on without it, the question
   * leaves `pendingQuestions` (so everything that asks «is the agent blocked on a question?» now says no), becomes a record of
   * the conversation's set-aside list, and its message is edited to say so — keeping its buttons (their data now names the
   * record) and its pin. A sixth open question closes the oldest as «not answered». Resolves whether the question was set aside:
   * `false` — and nothing set aside — when it is no longer the one waiting (answered or closed while the timer waited its turn
   * in the lifecycle queue, or the agent asked the next one meanwhile) or the backend cannot set a question aside.
   *
   * When the bot holds the question but the adapter says it holds none, what that means depends on the backend:
   *  - json-stream: the CLI's own question is the authority (the bot reads its sidecar before it restores its copy), so none is held
   *    — the bot's copy is stale (the agent was told and the bot died before it saved): one log line, and it is closed as «not
   *    answered», never left as a waiting question nothing can end;
   *  - OpenCode: the adapter only CACHES the server's registry (a reattach that could not read it leaves it empty), so «none» means
   *    «not known»: the server is asked (`resyncOpenQuestion`). It holds the question → the adapter takes it and the question is set
   *    aside after all; it confirms there is none → the bot's copy is closed as above; it cannot tell → nothing is closed, one log
   *    line, and the wait ends again after {@link setAsideRetryDelayMs}, at most {@link setAsideRetryLimit} times.
   */
  async function setPendingQuestionAside(key: SessionKey, requestId: string): Promise<boolean> {
    return runQuestionLifecycleOp(key, async () => {
      const kStr = keyToString(key);
      if (pendingQuestions.get(kStr)?.data.requestId !== requestId) return false;
      const adapter = getThreadAdapter(key);
      if (!adapter.setQuestionAside) return false;
      // Taken BEFORE the adapter is told: from the moment it is told to the removal of the question from the pending state nothing
      // is awaited, so a question the agent asks next (its handler runs on the event, outside this queue) cannot arrive in between
      // and be removed with this one. The number only has to be unique, so one that is not used is no loss.
      const sequence = await getState().takeNextSetAsideQuestionSequence(key);
      const pending = pendingQuestions.get(kStr);
      // The agent asked the next question while the counter was taken: this one is gone from the pending state already.
      if (!pending || pending.data.requestId !== requestId) return false;
      const nowMs = Date.now();
      const askedAtMs = pending.askedAt ?? nowMs;
      const text = buildQuestionSetAsideText({ questions: pending.data.questions, answers: pending.answers, askedAtMs, nowMs });
      const recordId = createSetAsideQuestionId(sequence);
      // The adapter checks the request id once more, against the question it holds.
      if (!adapter.setQuestionAside(key, requestId, text, pending.answers, handleReplySettled(key, requestId, recordId))) {
        const resynced = await settleQuestionTheAdapterDoesNotHold(key, adapter, pending, text, recordId);
        if (resynced === 'ended') return false;
      }
      forgetAttempt(key, requestId);

      const record: SetAsideQuestionRecord = {
        id: recordId,
        messageId: pending.messageId,
        // A re-posted question has two messages: the live copy (`messageId`) and the original it left up.
        ...(pending.originalMessageId != null && pending.originalMessageId !== pending.messageId ? { originalMessageId: pending.originalMessageId } : {}),
        questions: pending.data.questions,
        answers: pending.answers,
        lateFromIndex: pending.answers.findIndex((answer) => answer === null),
        askedAt: askedAtMs,
        setAsideAt: nowMs,
      };
      const released = releasePendingQuestionToSetAside(key);
      markNeedsNewMessage(key);
      await released;
      const { records, evicted } = addSetAsideQuestion(getSetAsideRecords(key), record);
      await getState().setSetAsideQuestions(key, records);

      await showQuestionSetAside(key, record);
      for (const closedRecord of evicted) await closeSetAsideRecord(key, closedRecord, 'unanswered');
      // A question the agent's server holds BESIDE this one (its parallel tool calls) was never shown: it is handed to the bot now, as
      // the question that waits. Not awaited — the server may still list this question for a moment, so it is left out.
      void adapter.surfaceOpenQuestion?.(key, requestId);
      return true;
    });
  }

  /** Forget the counts of one question: it was told to go on, or it is gone. */
  function forgetAttempt(key: SessionKey, requestId: string): void {
    retryAttempts.delete(getAttemptKey(key, requestId));
    replyFailures.delete(getAttemptKey(key, requestId));
  }

  /**
   * @description What the agent's server made of the reply that set question `requestId` aside (the one that became the record
   * `recordId`), as `setQuestionAside`'s `onSettled` hands it over. A reply the server took ends the count of failures — and, when the
   * question's message had been told «the server did not take it», takes that note back. One it did not take is
   * {@link countReplyFailure}.
   */
  function handleReplySettled(key: SessionKey, requestId: string, recordId: string): (isSent: boolean) => void {
    return (isSent) => {
      if (isSent) {
        replyFailures.delete(getAttemptKey(key, requestId));
        if (notTakenNotes.delete(getAttemptKey(key, recordId))) void rewriteSetAsideNote(key, recordId, 'wentOn');
        return;
      }
      countReplyFailure(key, requestId, recordId, `did not take the reply that sets the question ${requestId} aside`);
    };
  }

  /**
   * One more failure to get the question `requestId` aside on the agent's server — its reply was not taken, or the server could not be
   * read to find the question again. The question stays OPEN there: the topic says «the agent went on» and nothing waits on the bot's
   * side, yet the agent stands still on it. After a pause the question is handed to the bot again (`surfaceOpenQuestion`), which finds
   * its record and tells the agent once more as a question asked again ({@link surfaceQuestionAgain}). At most
   * {@link setAsideRetryLimit} times; then the topic is told — a message, and the pinned message's own note, which no longer says the
   * agent went on but that the server did not confirm it — so a stuck agent is not left to a console line.
   */
  function countReplyFailure(key: SessionKey, requestId: string, recordId: string, cause: string): void {
    const attemptKey = getAttemptKey(key, requestId);
    const failures = (replyFailures.get(attemptKey) ?? 0) + 1;
    replyFailures.set(attemptKey, failures);
    const kStr = keyToString(key);
    if (failures > setAsideRetryLimit) {
      console.warn(`[questionSetAside] ${kStr}: the agent's server ${cause} ${failures} times; it may still wait for it`);
      replyFailures.delete(attemptKey);
      clearTimeout(replyRetryTimers.get(kStr));
      replyRetryTimers.delete(kStr);
      notTakenNotes.add(getAttemptKey(key, recordId));
      void rewriteSetAsideNote(key, recordId, 'unconfirmed');
      void replyToThread(key, withThreadLocale(key, () => t('agent.set_aside_reply_failed_notice')));
      return;
    }
    console.warn(`[questionSetAside] ${kStr}: the agent's server ${cause}; trying again in ${retryDelayMs / 1000} s (try ${failures} of ${setAsideRetryLimit})`);
    clearTimeout(replyRetryTimers.get(kStr));
    const timer = setTimeout(() => {
      replyRetryTimers.delete(kStr);
      void surfaceQuestionAgain(key, requestId, recordId);
    }, retryDelayMs);
    timer.unref();
    replyRetryTimers.set(kStr, timer);
  }

  /**
   * The pause after a reply the server did not take is over: the server's own question is handed to the bot again. When it is
   * shown (`emitted`) the telling runs once more and its outcome comes back through {@link handleReplySettled}; when the server holds
   * none any more nothing waits and the count ends; when it could not be read the question may still be open there, which is another
   * failure — the chain never stops silently on a read that failed.
   */
  async function surfaceQuestionAgain(key: SessionKey, requestId: string, recordId: string): Promise<void> {
    const outcome = await getThreadAdapter(key).surfaceOpenQuestion?.(key);
    if (outcome === 'readFailed') countReplyFailure(key, requestId, recordId, `could not be read to find the question ${requestId} again`);
    else if (outcome === 'none') replyFailures.delete(getAttemptKey(key, requestId));
  }

  /**
   * The adapter would not set the bot's waiting question aside (see {@link setPendingQuestionAside} for what that means per backend).
   * Resolves `told` when the adapter took it on a second try after it re-read the server's registry — the caller goes on to save the
   * record — and `ended` when it did not: the bot's copy was closed (nothing is held), or left waiting with one more try armed.
   * Nothing is awaited between the second try and the return, like the first.
   */
  async function settleQuestionTheAdapterDoesNotHold(key: SessionKey, adapter: Pick<AgentAdapter, 'setQuestionAside' | 'resyncOpenQuestion' | 'surfaceOpenQuestion'>, pending: PendingQuestionState, text: string, recordId: string): Promise<'told' | 'ended'> {
    const kStr = keyToString(key);
    const { requestId } = pending.data;
    // A backend with no registry of its own to ask holds exactly what it says it holds.
    const server = adapter.resyncOpenQuestion ? await adapter.resyncOpenQuestion(key, requestId) : 'none';
    // The agent asked the next question, or this one was answered, while the server was asked: it is not this one's business any more.
    if (pendingQuestions.get(kStr) !== pending) return 'ended';
    if (server === 'held' && adapter.setQuestionAside?.(key, requestId, text, pending.answers, handleReplySettled(key, requestId, recordId))) return 'told';
    if (server === 'none') {
      await dropQuestionTheAdapterDoesNotHold(key, adapter, pending);
      return 'ended';
    }
    const attemptKey = getAttemptKey(key, requestId);
    const attempt = (retryAttempts.get(attemptKey) ?? 0) + 1;
    retryAttempts.set(attemptKey, attempt);
    const isRetried = attempt <= setAsideRetryLimit;
    console.warn(`[questionSetAside] ${kStr}: the agent's server did not confirm the question ${requestId} (${server}); it stays waiting${isRetried ? `, the wait ends again in ${retryDelayMs / 1000} s (try ${attempt} of ${setAsideRetryLimit})` : ', no more tries'}`);
    if (isRetried) armRetry(key, requestId);
    return 'ended';
  }

  /** The wait of a question ends again after the server did not confirm it. */
  function armRetry(key: SessionKey, requestId: string): void {
    armSetAsideTimer(key, requestId, retryDelayMs);
  }

  /**
   * @description The idle fire (`compaction.ts`) meets a question that still waits: it is set aside NOW — earlier than its wait —
   * instead of the idle compaction rejecting it, compacting, stopping the process and asking it again. Not for «Wait for my
   * answer» (today's flow stays for that choice), and not when nothing waits. Resolves whether the question was set aside; `false`
   * leaves everything as it was, so the caller goes on with the flow it had.
   */
  async function setPendingQuestionAsideAtIdle(key: SessionKey): Promise<boolean> {
    const pending = pendingQuestions.get(keyToString(key));
    if (!pending || getQuestionWaitChoice(key) === 'untilAnswered') return false;
    return setPendingQuestionAside(key, pending.data.requestId);
  }

  /**
   * @description The agent asks a question whose set-aside copy is still open in the topic (`getSetAsideRecordAskedAgain`) — it did
   * not take «do not ask it again». It is told AT ONCE, in the set-aside text worded «still open», that it is the same question and
   * nobody answered it yet; nothing else happens: no second message, no pin, no record, no timer, nothing waiting. Returns whether it
   * took the question over (the caller posts nothing then); the telling runs in the lifecycle queue, after whatever is in flight. When
   * by then the record is gone (answered or closed meanwhile) or the agent's side cannot be told, the question is posted like a new
   * one ({@link QuestionSetAsidePorts.postQuestionAnew}): an agent left blocked on a question nobody sees is the worse failure.
   */
  function answerQuestionAskedAgain(key: SessionKey, questionData: OpenCodePendingQuestion): boolean {
    if (!getSetAsideRecordAskedAgain(getSetAsideRecords(key), questionData.questions)) return false;
    void runQuestionLifecycleOp(key, () => tellAgentQuestionIsStillOpen(key, questionData))
      .catch((error) => {
        console.error('[questionSetAside] telling the agent its question is still open failed:', error);
        return false;
      })
      .then((isTold) => {
        if (isTold) return;
        console.warn(`[questionSetAside] ${keyToString(key)}: the question ${questionData.requestId} the agent asked again could not be answered as «still open»; it is posted as a new one`);
        postQuestionAnew(key, questionData);
      });
    return true;
  }

  /** The record the question repeats is read AGAIN, now that the queue got to it; resolves whether the agent was told. */
  async function tellAgentQuestionIsStillOpen(key: SessionKey, questionData: OpenCodePendingQuestion): Promise<boolean> {
    const found = getSetAsideRecordAskedAgain(getSetAsideRecords(key), questionData.questions);
    if (!found) return false;
    const { record, answers } = found;
    const text = buildQuestionSetAsideText({ questions: record.questions, answers: record.answers, askedAtMs: record.askedAt, nowMs: Date.now(), isAlreadyOpen: true });
    return getThreadAdapter(key).setQuestionAside?.(key, questionData.requestId, text, answers, handleReplySettled(key, questionData.requestId, record.id)) === true;
  }

  /**
   * The bot's copy of a waiting question that the agent's side confirms it holds no such question for: stale, so it ends as «not
   * answered». The question the agent's side holds INSTEAD (a backend whose server can hold another one than the bot knew of) was
   * never shown: it is handed to the bot now, after the stale copy is gone, so it shows as the question that waits.
   */
  async function dropQuestionTheAdapterDoesNotHold(key: SessionKey, adapter: Pick<AgentAdapter, 'surfaceOpenQuestion'>, pending: PendingQuestionState): Promise<void> {
    console.warn(`[questionSetAside] ${keyToString(key)}: the agent holds no question ${pending.data.requestId}, so there is nothing to set aside; the bot's copy is closed as not answered`);
    forgetAttempt(key, pending.data.requestId);
    clearPendingQuestion(key);
    const question = pending.data.questions[pending.currentIndex];
    if (pending.messageId !== null && question) await closeQuestionMessage(key, pending.messageId, question, 'unanswered');
    await adapter.surfaceOpenQuestion?.(key);
  }

  /**
   * @description Edit the question's message to the set-aside look: the question as asked, a note under it («the agent went on
   * without your answer — you can still answer», or, when the agent's server did not confirm the message that tells it to go on, «the server
   * did not confirm it — if the agent seems stuck, send it any message»), and the option buttons, whose data now names the record. The message is not
   * re-posted, not deleted, not unpinned. When the edit fails the old buttons never stay (they would answer the agent's NEXT
   * question): they are replaced by the record's, or taken off. The record is saved and open either way.
   */
  async function showQuestionSetAside(key: SessionKey, record: SetAsideQuestionRecord, state: SetAsideNoteState = 'wentOn'): Promise<void> {
    const target = getSetAsideAnswerTarget(record);
    if (record.messageId === null || !target) return;
    const note = withThreadLocale(key, () => t(state === 'wentOn' ? 'agent.question_set_aside_note' : 'agent.question_set_aside_not_taken_note'));
    const isEdited = await editQuestionMessageWithNote(key, record.messageId, target.question, note, buildSetAsideKeyboard(record, target.question));
    if (!isEdited) console.warn(`[questionSetAside] the note could not be written under the question (record ${record.id})`);
  }

  /**
   * The note of record `recordId`'s message changes with what became of the reply that told the agent to go on. Decided inside the
   * lifecycle queue against the record as it is THEN: one that was answered or closed meanwhile has a message that is no longer the
   * note's to rewrite — its «✅ Answer» must stay.
   */
  async function rewriteSetAsideNote(key: SessionKey, recordId: string, state: SetAsideNoteState): Promise<void> {
    try {
      await runQuestionLifecycleOp(key, async () => {
        const record = getSetAsideRecords(key).find((candidate) => candidate.id === recordId);
        if (record) await showQuestionSetAside(key, record, state);
      });
    } catch (error) {
      console.error(`[questionSetAside] ${keyToString(key)}: rewriting the note of the set-aside question ${recordId} failed:`, error);
    }
  }

  /**
   * @description Whether `messageId` is a message of one of the conversation's set-aside questions. A stale `qa_<i>_<j>` button on
   * such a message (its edit to the set-aside look never landed) must never answer the question the agent asks next.
   */
  function checkIsSetAsideQuestionMessage(key: SessionKey, messageId: number): boolean {
    return getSetAsideRecords(key).some((record) => checkIsSetAsideRecordMessage(record, messageId));
  }

  /**
   * @description End a set-aside record that is no longer open (evicted by a sixth question, ended with its conversation): its
   * message is closed without deleting it, and its pin is released.
   */
  async function closeSetAsideRecord(key: SessionKey, record: SetAsideQuestionRecord, ending: QuestionEnd): Promise<void> {
    notTakenNotes.delete(getAttemptKey(key, record.id));
    const question = getSetAsideAnswerTarget(record)?.question ?? record.questions[0];
    if (record.messageId === null || !question) return;
    await closeQuestionMessage(key, record.messageId, question, ending);
    await unpinMessage(key, record.messageId);
  }

  // ── a late answer ──

  /**
   * Who answered, as the agent must read it: the description of a topic member (`topic member "Tess Talker" (@tess)`), `undefined`
   * for the operator. The late-answer message is the BOT's block — a member's author mark ahead of it would end at its own header
   * («everything after it up to the next line that starts with `[` is theirs»), so the attribution travels INSIDE each answer, as
   * it does for the answer to a waiting question.
   */
  function getAnsweringMember(from: User | undefined, role: 'admin' | 'talker'): string | undefined {
    return role === 'talker' && from ? getTelegramTalkerContext(from).nonOperatorSender : undefined;
  }

  /** The records whose last answer is on its way to the agent: a second tap on one of them answers nothing. */
  const answeringRecords = new Set<string>();

  /** The late answers of a record — the questions from `lateFromIndex` on — with the one given now (already attributed, like the kept ones). */
  function buildLateEntries(record: SetAsideQuestionRecord, questionIndex: number, answer: string[]): [LateAnswerEntry, ...LateAnswerEntry[]] {
    const [first, ...rest] = record.questions.slice(record.lateFromIndex).map((question, offset): LateAnswerEntry => {
      const index = record.lateFromIndex + offset;
      return { question, answer: index === questionIndex ? answer : record.answers[index] ?? [] };
    });
    if (!first) throw new Error(`set-aside question ${record.id} has no late question`);
    return [first, ...rest];
  }

  /**
   * What became of a late answer: it reached the agent (`answered`), it is kept for the questions still open (`collected`), the
   * conversation has no session to take it (`noSession`), the next question of the call could not be posted so the answer was not
   * taken (`notPosted`), or the question is not the open one any more (`gone`).
   */
  type LateAnswerOutcome = 'answered' | 'collected' | 'noSession' | 'notPosted' | 'gone';

  /**
   * @description Give the answer `answer` to the question `target` names of a set-aside record. The record's questions are answered in
   * order, as on screen:
   *  - while another question of the record is still open the answer is KEPT: the next question is posted as a message of its own
   *    with the set-aside look, and only then does the answered question's message close with «✅ Answer: …» (the agent hears
   *    nothing yet; an answer whose next question could not be posted is not taken);
   *  - the last one sends ONE late-answer message with every late answer to the agent (`deliverLateAnswer`); only once it reached
   *    a session is the record over — its message closes with the answer, its pin is released. A conversation with no session to
   *    take it leaves the record open.
   * Everything is decided inside the question lifecycle queue, against the record as it is THEN: an answer meant for a question that
   * is no longer the open one (two taps made at once, the first of which moved the record on) is `gone`, never given to the next
   * question. `answeredBy` (see {@link getAnsweringMember}) rides inside the answer. Resolves the outcome and whether the topic now
   * shows the whole answer (the question's message was edited to carry it).
   */
  async function giveSetAsideAnswer(key: SessionKey, request: { target: LateAnswerTarget; answer: string[]; answeredBy?: string }): Promise<{ outcome: LateAnswerOutcome; isAnswerShown: boolean }> {
    const { target: meant } = request;
    const answeringKey = `${keyToString(key)}:${meant.recordId}`;
    const attributed = request.answeredBy === undefined ? request.answer : getAnswerWithAttribution(request.answer, request.answeredBy);
    const step = await runQuestionLifecycleOp(key, async () => {
      const record = getSetAsideRecords(key).find((candidate) => candidate.id === meant.recordId);
      const open = record ? getSetAsideAnswerTarget(record) : null;
      if (!record || !open || open.index !== meant.questionIndex || !checkIsSetAsideRecordMessage(record, meant.messageId) || answeringRecords.has(answeringKey)) return { kind: 'gone' as const };
      const isLastOpenQuestion = record.answers.every((answer, index) => answer !== null || index === open.index);
      if (!isLastOpenQuestion) {
        const collected = await collectLateAnswer(key, record, open, request.answer, attributed);
        return collected === null ? { kind: 'notPosted' as const } : { kind: 'collected' as const, isAnswerShown: collected };
      }
      answeringRecords.add(answeringKey);
      return { kind: 'last' as const, record, open };
    });
    if (step.kind === 'gone' || step.kind === 'notPosted') return { outcome: step.kind, isAnswerShown: false };
    if (step.kind === 'collected') return { outcome: 'collected', isAnswerShown: step.isAnswerShown };

    try {
      const prompt = buildLateAnswerPrompt({
        entries: buildLateEntries(step.record, step.open.index, attributed),
        askedAtMs: step.record.askedAt,
        setAsideAtMs: step.record.setAsideAt,
        nowMs: Date.now(),
      });
      const delivery = await deliverLateAnswer(key, prompt);
      if (delivery === 'noSession') return { outcome: 'noSession', isAnswerShown: false };
      const isAnswerShown = await runQuestionLifecycleOp(key, () => finishSetAsideRecord(key, step.record, step.open.question, request.answer));
      return { outcome: 'answered', isAnswerShown };
    } finally {
      answeringRecords.delete(answeringKey);
    }
  }

  /** The record's last open question was answered and delivered: the record is over. Its message carries the answer, its pin goes. */
  async function finishSetAsideRecord(key: SessionKey, record: SetAsideQuestionRecord, question: OpenCodeQuestion, answer: string[]): Promise<boolean> {
    notTakenNotes.delete(getAttemptKey(key, record.id));
    await getState().setSetAsideQuestions(key, getSetAsideRecords(key).filter((candidate) => candidate.id !== record.id));
    if (record.messageId === null) return false;
    const isAnswerShown = await closeQuestionMessage(key, record.messageId, question, { answer: answer.join(', ') });
    await unpinMessage(key, record.messageId);
    return isAnswerShown;
  }

  /**
   * One answer of a record with more questions still open. The next open question is posted FIRST, as a message of its own in the
   * set-aside look; only once it is there is the answer kept in the saved record and the answered question's message closed with it
   * («✅ Answer: …», its pin released, the new message pinned). A post that fails changes nothing — the answer is not taken, the
   * record stays on this question — and resolves `null`. Otherwise resolves whether the answered question's message shows the answer.
   * `answer` is the plain one (the note under the question), `attributed` the one the record keeps for the agent.
   */
  async function collectLateAnswer(key: SessionKey, record: SetAsideQuestionRecord, open: { index: number; question: OpenCodeQuestion }, answer: string[], attributed: string[]): Promise<boolean | null> {
    const answers = record.answers.slice();
    answers[open.index] = attributed;
    const nextQuestion = record.questions[answers.findIndex((candidate) => candidate === null)];
    const nextMessageId = nextQuestion ? await sendQuestionMessage(key, nextQuestion, buildSetAsideKeyboard(record, nextQuestion)) : null;
    if (nextMessageId === null) {
      console.warn(`[questionSetAside] the next question of record ${record.id} could not be posted; the answer was not taken`);
      return null;
    }
    // The record keeps what it needs for the questions left: the first message of the answered question is not theirs.
    const updated: SetAsideQuestionRecord = {
      id: record.id,
      messageId: nextMessageId,
      questions: record.questions,
      answers,
      lateFromIndex: record.lateFromIndex,
      askedAt: record.askedAt,
      setAsideAt: record.setAsideAt,
    };
    await getState().setSetAsideQuestions(key, getSetAsideRecords(key).map((candidate) => (candidate.id === record.id ? updated : candidate)));
    let isAnswerShown = false;
    if (record.messageId !== null) {
      isAnswerShown = await closeQuestionMessage(key, record.messageId, open.question, { answer: answer.join(', ') });
      await unpinMessage(key, record.messageId);
    }
    await pinMessageSilently(key, nextMessageId);
    await showQuestionSetAside(key, updated);
    return isAnswerShown;
  }

  /** What the topic is told when an answer was not taken: the question is no longer open, or the next question could not be posted. */
  async function tellAnswerNotTaken(key: SessionKey, outcome: 'gone' | 'notPosted'): Promise<void> {
    await replyToThread(key, withThreadLocale(key, () => t(outcome === 'gone' ? 'agent.set_aside_question_gone_notice' : 'agent.set_aside_next_question_failed_notice')));
  }

  /**
   * @description A tap on a button of a set-aside question (`qs_<record id>_<option index>`). A topic member may answer the agent's
   * question, as for a waiting one (the speaker gate, not the admin one). The tap must be on the message of the question that is
   * open NOW — a button left on a message that carries a result, or on one of another record, answers nothing — and the toast is
   * the label (the closed question carries it whole). The answer is meant for the question it was tapped on: one that is no longer
   * the open one by the time it is taken (a double tap) is not given to the next.
   */
  async function handleSetAsideTap(ctx: Context, recordId: string, optionIndex: number): Promise<void> {
    const speaker = await authoriseSpeaker(ctx);
    if (!speaker) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
    const { key } = speaker;
    const record = getSetAsideRecords(key).find((candidate) => candidate.id === recordId);
    const open = record ? getSetAsideAnswerTarget(record) : null;
    const tappedMessageId = getCallbackMessageId(ctx);
    // A second tap made while the first answer of the record's last question is still on its way answers nothing — in the toast alone:
    // the topic shows the first answer, and a notice beside it would read as «your answer was not sent».
    const isLastAnswerOnItsWay = answeringRecords.has(`${keyToString(key)}:${recordId}`);
    if (!record || !open || tappedMessageId === null || record.messageId !== tappedMessageId || isLastAnswerOnItsWay) { await ctx.answerCbQuery(t('cb.no_pending_question')); return; }
    const label = open.question.options[optionIndex]?.label;
    if (!label) { await ctx.answerCbQuery(t('cb.invalid_option')); return; }
    const isLabelCut = await answerCallbackWithFittedText(ctx, label);
    const { outcome, isAnswerShown } = await giveSetAsideAnswer(key, {
      target: { recordId, questionIndex: open.index, messageId: tappedMessageId },
      answer: [label],
      answeredBy: getAnsweringMember(ctx.from, speaker.role),
    });
    if (outcome === 'gone' || outcome === 'notPosted') await tellAnswerNotTaken(key, outcome);
    // The closed question carries the whole label; one that could not be edited does not, and a toast cut it.
    else if (outcome === 'answered' && !isAnswerShown && isLabelCut) await replyToThread(key, label);
  }

  /**
   * @description A text typed as a REPLY to a set-aside question's message (either of its messages, when it was re-posted) is its
   * late answer: a bare option number in range picks that option, so does an option's own label, and — for the operator only — any
   * other text is the answer itself (a topic member answers only with an option number or label: their other words are an ordinary
   * prompt, as on the waiting-question route). A voice note is a reply too: the bot hands its transcript here. Resolves whether it
   * was taken as one — otherwise it is an ordinary message. `role`: a topic member's answer reaches the agent as theirs (`from` says who). A
   * reply that matched a question which is no longer the open one (a second reply made at once, a record closed meanwhile) is
   * still no ordinary message — it was meant as an answer, so it is answered with a note, never passed on as a prompt or a pick.
   */
  async function answerSetAsideQuestionByReply(from: User | undefined, key: SessionKey, message: SetAsideReplyCandidate, role: 'admin' | 'talker'): Promise<boolean> {
    const { replyToMessageId } = message;
    const setAside = getSetAsideRecords(key);
    const text = message.text.trim();
    // A slash command is no answer; a message that replies to nothing, or when nothing is set aside, is none either.
    if (replyToMessageId === null || setAside.length === 0 || text === '' || (!message.isForwarded && text.startsWith('/'))) return false;
    const route = getQuestionReplyRouteWithSetAside({ text, replyToMessageId, liveQuestion: undefined, setAside, isForwarded: message.isForwarded, canAnswerWithFreeText: role === 'admin' });
    if (route.kind !== 'answerSetAside') return false;
    await getState().pushMessageId(key, message.message_id);
    const { outcome } = await giveSetAsideAnswer(key, {
      target: { recordId: route.recordId, questionIndex: route.questionIndex, messageId: replyToMessageId },
      answer: route.answer,
      answeredBy: getAnsweringMember(from, role),
    });
    if (outcome === 'gone' || outcome === 'notPosted') await tellAnswerNotTaken(key, outcome);
    return true;
  }

  /** Register the buttons of a set-aside question (`qs_<record id>_<option index>`), disjoint from the live (`qa_`) and re-asked (`reask_`) ones. */
  function registerQuestionSetAsideCallbacks(bot: Telegraf): void {
    bot.action(new RegExp(`^${setAsideButtonPrefix}([0-9a-z]+)_(\\d+)$`), (ctx) => handleSetAsideTap(ctx, ctx.match[1], parseInt(ctx.match[2], 10)));
  }

  // ── the end of a conversation ──

  /**
   * @description The conversation ended or was replaced (`/new`, `/quit`, `/quitall`, leaving the folder, another conversation or
   * backend): every open set-aside question ends as «not answered», its pin released, and the saved list is emptied FIRST — a late
   * tap finds nothing. Run in the question lifecycle queue, so it orders after a set-aside in flight (the question it is about to
   * save is closed too, not left open for a conversation that is gone) and after an answer on its way.
   */
  function closeSetAsideQuestions(key: SessionKey): Promise<void> {
    return runQuestionLifecycleOp(key, async () => {
      const records = getSetAsideRecords(key);
      if (records.length === 0) return;
      await getState().setSetAsideQuestions(key, []);
      for (const record of records) await closeSetAsideRecord(key, record, 'unanswered');
    });
  }

  return {
    armQuestionSetAsideTimer,
    clearQuestionSetAsideTimer,
    setPendingQuestionAside,
    setPendingQuestionAsideAtIdle,
    answerQuestionAskedAgain,
    checkIsSetAsideQuestionMessage,
    registerQuestionSetAsideCallbacks,
    answerSetAsideQuestionByReply,
    giveSetAsideAnswer,
    closeSetAsideQuestions,
  };
}
