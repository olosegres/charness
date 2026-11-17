/**
 * An agent's question the owner has not answered never keeps the agent standing still: when the question wait ends, the
 * bot tells the agent «no answer yet, go on» (`utils/questionWaitPlan.ts` words it, the adapter's `setQuestionAside` sends it),
 * and keeps the question OPEN in the topic — the same message with a note under its options, its buttons and its pin — so an
 * answer given later still reaches the agent. This module owns the timer of that wait, the move of the question from
 * «the agent is blocked on it» (`pendingQuestions`) to the conversation's set-aside list (`state.json`), and the message's
 * edit; the plan is the pure module's, the answer routes (a tap, a reply) and the closing at the end of a conversation are
 * the next steps. README: contracts.
 */
import type { SessionKey } from '../../../sessionKey';
import { keyToString } from '../../../sessionKey';
import { t } from '../../../i18n';
import { buildClosedQuestionPlainText, buildClosedQuestionText, type QuestionEnd } from '../../../openCodeQuestionFlow';
import type { AgentAdapter, OpenCodeQuestion, PendingQuestionState, SetAsideQuestionRecord } from '../../../types';
import {
  addSetAsideQuestion,
  buildQuestionSetAsideText,
  createSetAsideQuestionId,
  getQuestionSetAsideDelayMs,
  getSetAsideAnswerTarget,
  type QuestionWaitChoice,
} from '../../../utils/questionWaitPlan';
import { MAX_MESSAGE_LEN } from '../messageSplit';
import { buildKeyboardExtra, buildQuestionOptionsKeyboard } from '../questionKeyboards';
import type { BotCore } from './botCore';

/** The prefix of a set-aside question's button data: `qs_<record id>_<option index>`. */
const setAsideButtonPrefix = 'qs_';

/**
 * What the set-aside needs from the bot: the shared core, the pending-question state it moves the question out of, the
 * lifecycle queue it runs in (the same one the post, the re-post and the answer of a question run in, so they never overlap),
 * and the few bot-owned effects around the question message — its pin, its closing, its send gate.
 */
export interface QuestionSetAsidePorts extends Pick<BotCore, 'getState' | 'editThreadMessage' | 'withThreadLocale'> {
  pendingQuestions: Map<string, PendingQuestionState>;
  getThreadAdapter: (key: SessionKey) => AgentAdapter;
  runQuestionLifecycleOp: <TResult>(key: SessionKey, op: () => Promise<TResult>) => Promise<TResult>;
  /** Persist the pending question (the in-memory map and the saved state, which `bot.ts` keeps in lockstep). */
  setPendingQuestion: (key: SessionKey, value: PendingQuestionState) => void;
  /**
   * Take the pending question out of the pending state (memory and disk) because it was SET ASIDE: unlike a clear, the pin stays
   * on the question's message — it belongs to the set-aside record now — so the pin of a question the agent asks next does not
   * retire it, and does not count as a re-pin (silent).
   */
  releasePendingQuestionToSetAside: (key: SessionKey) => Promise<void>;
  /** End a question's message without deleting it (the buttons go, a note says how it ended). */
  closeQuestionMessage: (key: SessionKey, messageId: number, question: OpenCodeQuestion, ending: QuestionEnd) => Promise<boolean>;
  unpinMessage: (key: SessionKey, messageId: number) => Promise<void>;
  escapeMarkdown: (text: string) => string;
  /** The next agent output starts a message of its own, below the question (the answer path does the same). */
  markNeedsNewMessage: (key: SessionKey) => void;
  /** The question wait that applies to the topic (its own setting, else General's, else the default). */
  getQuestionWaitChoice: (key: SessionKey) => QuestionWaitChoice;
  /** A test instance's shorter wait (`CHARNESS_TEST_TIMINGS` `questionSetAsideWaitMs`), `undefined` in production. */
  shortenedWaitMs: number | undefined;
}

/**
 * @description Build the question set-aside over its ports. It returns the timer's arm and clear (the bot arms it when the
 * agent asks and when a restart restores a waiting question, and clears it with the pending question) and the set-aside
 * itself, which the idle fire and the asked-again check call too.
 */
export function createQuestionSetAside(ports: QuestionSetAsidePorts) {
  const {
    getState, editThreadMessage, withThreadLocale, pendingQuestions, getThreadAdapter, runQuestionLifecycleOp, setPendingQuestion,
    releasePendingQuestionToSetAside, closeQuestionMessage, unpinMessage, escapeMarkdown, markNeedsNewMessage, getQuestionWaitChoice, shortenedWaitMs,
  } = ports;

  /** One timer per waiting question, by conversation: it fires at `askedAt + wait`, whatever the agent's process does. */
  const timers = new Map<string, NodeJS.Timeout>();

  function clearQuestionSetAsideTimer(key: SessionKey): void {
    const kStr = keyToString(key);
    const timer = timers.get(kStr);
    if (timer) clearTimeout(timer);
    timers.delete(kStr);
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
    const { requestId } = pending.data;
    const timer = setTimeout(() => {
      timers.delete(kStr);
      void withThreadLocale(key, () => setPendingQuestionAside(key, requestId))
        .catch((error) => console.error('[questionSetAside] setting the question aside failed:', error));
    }, delayMs);
    timer.unref();
    timers.set(kStr, timer);
  }

  /**
   * @description Set the conversation's waiting question `requestId` aside: the agent is told to go on without it, the question
   * leaves `pendingQuestions` (so everything that asks «is the agent blocked on a question?» now says no), becomes a record of
   * the conversation's set-aside list, and its message is edited to say so — keeping its buttons (their data now names the
   * record) and its pin. A sixth open question closes the oldest as «not answered». Resolves whether the question was set aside:
   * `false` — and nothing changed — when it is no longer the one waiting (answered or closed while the timer waited its turn in
   * the lifecycle queue, or the agent asked the next one meanwhile), the backend cannot set a question aside, or the adapter had
   * nothing to set aside (no live session).
   */
  async function setPendingQuestionAside(key: SessionKey, requestId: string): Promise<boolean> {
    return runQuestionLifecycleOp(key, async () => {
      const kStr = keyToString(key);
      const pending = pendingQuestions.get(kStr);
      if (!pending || pending.data.requestId !== requestId) return false;
      const adapter = getThreadAdapter(key);
      if (!adapter.setQuestionAside) return false;
      const nowMs = Date.now();
      const askedAtMs = pending.askedAt ?? nowMs;
      const text = buildQuestionSetAsideText({ questions: pending.data.questions, answers: pending.answers, askedAtMs, nowMs });
      // The adapter checks the request id once more, against the question it holds: the one authority on what is pending there.
      if (!adapter.setQuestionAside(key, requestId, text, pending.answers)) return false;

      const sequence = await getState().takeNextSetAsideQuestionSequence(key);
      const record: SetAsideQuestionRecord = {
        id: createSetAsideQuestionId(sequence),
        messageId: pending.messageId,
        // A re-posted question has two messages: the live copy (`messageId`) and the original it left up.
        ...(pending.originalMessageId != null && pending.originalMessageId !== pending.messageId ? { originalMessageId: pending.originalMessageId } : {}),
        questions: pending.data.questions,
        answers: pending.answers,
        askedAt: askedAtMs,
        setAsideAt: nowMs,
      };
      await releasePendingQuestionToSetAside(key);
      markNeedsNewMessage(key);
      const { records, evicted } = addSetAsideQuestion(getState().getSetAsideQuestions()[kStr] ?? [], record);
      await getState().setSetAsideQuestions(key, records);

      await showQuestionSetAside(key, record);
      for (const closedRecord of evicted) await closeSetAsideRecord(key, closedRecord, 'unanswered');
      return true;
    });
  }

  /**
   * @description Edit the question's message to the set-aside look: the question as asked, a note under it («the agent went on
   * without your answer — you can still answer»), and the option buttons, whose data now names the record. The message is not
   * re-posted, not deleted, not unpinned. A failure is logged — the record is saved and stays open either way.
   */
  async function showQuestionSetAside(key: SessionKey, record: SetAsideQuestionRecord): Promise<void> {
    const target = getSetAsideAnswerTarget(record);
    if (record.messageId === null || !target) return;
    const note = withThreadLocale(key, () => t('agent.question_set_aside_note'));
    const keyboard = buildQuestionOptionsKeyboard(target.question, (optionIndex) => `${setAsideButtonPrefix}${record.id}_${optionIndex}`);
    const markdownText = buildClosedQuestionText(target.question, note, escapeMarkdown);
    const plainText = buildClosedQuestionPlainText(target.question, note, MAX_MESSAGE_LEN);
    // The same body-plus-note text a closed question gets, with the keyboard kept; a question that filled a message when it was
    // asked has no room for the note in Markdown, so the body gives way and it goes out as plain text.
    const isEdited = markdownText.length <= MAX_MESSAGE_LEN
      ? await editThreadMessage(key, record.messageId, markdownText, buildKeyboardExtra(keyboard, { parse_mode: 'Markdown' }), plainText)
      : await editThreadMessage(key, record.messageId, plainText, buildKeyboardExtra(keyboard));
    if (!isEdited) console.warn(`[questionSetAside] the note could not be written under the question (record ${record.id})`);
  }

  /**
   * @description End a set-aside record that is no longer open (evicted by a sixth question, ended with its conversation): its
   * message is closed without deleting it, and its pin is released.
   */
  async function closeSetAsideRecord(key: SessionKey, record: SetAsideQuestionRecord, ending: QuestionEnd): Promise<void> {
    const question = getSetAsideAnswerTarget(record)?.question ?? record.questions[0];
    if (record.messageId === null || !question) return;
    await closeQuestionMessage(key, record.messageId, question, ending);
    await unpinMessage(key, record.messageId);
  }

  return { armQuestionSetAsideTimer, clearQuestionSetAsideTimer, setPendingQuestionAside, closeSetAsideRecord };
}
