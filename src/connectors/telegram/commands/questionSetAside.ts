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
import type { AgentAdapter, OpenCodeQuestion, PendingQuestionState, SetAsideQuestionRecord } from '../../../types';
import type { MessageContext } from '../../../utils/messageContext';
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
  type LateAnswerEntry,
  type QuestionWaitChoice,
} from '../../../utils/questionWaitPlan';
import { getTelegramTalkerContext } from '../inbound';
import { getCallbackMessageId } from './callbackMessage';
import { answerCallbackWithFittedText } from './callbackToast';
import { buildQuestionOptionsKeyboard } from '../questionKeyboards';
import type { BotCore } from './botCore';

/** The prefix of a set-aside question's button data: `qs_<record id>_<option index>`. */
const setAsideButtonPrefix = 'qs_';

/**
 * What the set-aside needs from the bot: the shared core, the pending-question state it moves the question out of, the
 * lifecycle queue it runs in (the same one the post, the re-post and the answer of a question run in, so they never overlap),
 * and the few bot-owned effects around the question message — its pin, its closing, its send gate.
 */
export interface QuestionSetAsidePorts extends Pick<BotCore, 'withThreadLocale' | 'authoriseSpeaker' | 'replyToThread'> {
  /** The state store (assigned at boot): the saved set-aside records and the counter their ids come from. */
  getState: () => Pick<StateStore, 'takeNextSetAsideQuestionSequence' | 'getSetAsideQuestions' | 'setSetAsideQuestions' | 'pushMessageId'>;
  pendingQuestions: Map<string, PendingQuestionState>;
  getThreadAdapter: (key: SessionKey) => Pick<AgentAdapter, 'setQuestionAside'>;
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
  deliverLateAnswer: (key: SessionKey, text: string, messageContext?: MessageContext) => Promise<LatePromptOutcome>;
  /** The next agent output starts a message of its own, below the question (the answer path does the same). */
  markNeedsNewMessage: (key: SessionKey) => void;
  /** The question wait that applies to the topic (its own setting, else General's, else the default). */
  getQuestionWaitChoice: (key: SessionKey) => QuestionWaitChoice;
  /** A test instance's shorter wait (`CHARNESS_TEST_TIMINGS` `questionSetAsideWaitMs`), `undefined` in production. */
  shortenedWaitMs: number | undefined;
}

/** A text message of the topic as far as the late-answer route reads it: what it says, what it replies to, whether it is a forward. */
export interface SetAsideReplyCandidate {
  message_id: number;
  text: string;
  reply_to_message?: { message_id: number } | undefined;
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
    markNeedsNewMessage, getQuestionWaitChoice, shortenedWaitMs,
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
   * `false` — and nothing set aside — when it is no longer the one waiting (answered or closed while the timer waited its turn
   * in the lifecycle queue, or the agent asked the next one meanwhile) or the backend cannot set a question aside.
   *
   * When the bot holds the question but the adapter does not (a restart found the agent's session without it, or the agent was
   * told and the bot died before it saved), the adapter is the authority on what blocks the agent: the bot's copy is stale — one
   * log line, and it is closed as «not answered» like any question nobody can answer, never left as a waiting question nothing
   * can end.
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
      // The adapter checks the request id once more, against the question it holds: the one authority on what is pending there.
      if (!adapter.setQuestionAside(key, requestId, text, pending.answers)) return dropQuestionTheAdapterDoesNotHold(key, pending);

      const record: SetAsideQuestionRecord = {
        id: createSetAsideQuestionId(sequence),
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
      const { records, evicted } = addSetAsideQuestion(getState().getSetAsideQuestions()[kStr] ?? [], record);
      await getState().setSetAsideQuestions(key, records);

      await showQuestionSetAside(key, record);
      for (const closedRecord of evicted) await closeSetAsideRecord(key, closedRecord, 'unanswered');
      return true;
    });
  }

  /** The bot's copy of a waiting question that the adapter holds no such question for: stale, so it ends as «not answered». */
  async function dropQuestionTheAdapterDoesNotHold(key: SessionKey, pending: PendingQuestionState): Promise<false> {
    console.warn(`[questionSetAside] ${keyToString(key)}: the agent holds no question ${pending.data.requestId}, so there is nothing to set aside; the bot's copy is closed as not answered`);
    clearPendingQuestion(key);
    const question = pending.data.questions[pending.currentIndex];
    if (pending.messageId !== null && question) await closeQuestionMessage(key, pending.messageId, question, 'unanswered');
    return false;
  }

  /**
   * @description Edit the question's message to the set-aside look: the question as asked, a note under it («the agent went on
   * without your answer — you can still answer»), and the option buttons, whose data now names the record. The message is not
   * re-posted, not deleted, not unpinned. When the edit fails the old buttons never stay (they would answer the agent's NEXT
   * question): they are replaced by the record's, or taken off. The record is saved and open either way.
   */
  async function showQuestionSetAside(key: SessionKey, record: SetAsideQuestionRecord): Promise<void> {
    const target = getSetAsideAnswerTarget(record);
    if (record.messageId === null || !target) return;
    const note = withThreadLocale(key, () => t('agent.question_set_aside_note'));
    const keyboard = buildQuestionOptionsKeyboard(target.question, (optionIndex) => `${setAsideButtonPrefix}${record.id}_${optionIndex}`);
    const isEdited = await editQuestionMessageWithNote(key, record.messageId, target.question, note, keyboard);
    if (!isEdited) console.warn(`[questionSetAside] the note could not be written under the question (record ${record.id})`);
  }

  /**
   * @description Whether `messageId` is a message of one of the conversation's set-aside questions. A stale `qa_<i>_<j>` button on
   * such a message (its edit to the set-aside look never landed) must never answer the question the agent asks next.
   */
  function checkIsSetAsideQuestionMessage(key: SessionKey, messageId: number): boolean {
    return (getState().getSetAsideQuestions()[keyToString(key)] ?? []).some((record) => checkIsSetAsideRecordMessage(record, messageId));
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

  // ── a late answer ──

  /**
   * The message context of a late answer a topic member gave: the author mark ahead of the text, so it never reads as the operator's.
   * Only the mark: the text is the BOT's (`buildLateAnswerPrompt`), and the member's own words in it — the answer — are already made
   * unable to pass for one of the bot's headers there, so the delivery does not neutralise the whole message as it does a member's
   * free text (it would turn the bot's own «[Late answer …]» header into «\\[Late answer …]»).
   */
  function getAnsweringMemberContext(from: User): MessageContext {
    return { block: getTelegramTalkerContext(from).block, isForwarded: false };
  }

  /** The records whose last answer is on its way to the agent: a second tap on one of them answers nothing. */
  const answeringRecords = new Set<string>();

  function getSetAsideRecords(key: SessionKey): SetAsideQuestionRecord[] {
    return getState().getSetAsideQuestions()[keyToString(key)] ?? [];
  }

  /** The late answers of a record — the questions from `lateFromIndex` on — with the one given now. */
  function buildLateEntries(record: SetAsideQuestionRecord, questionIndex: number, answer: string[]): [LateAnswerEntry, ...LateAnswerEntry[]] {
    const [first, ...rest] = record.questions.slice(record.lateFromIndex).map((question, offset): LateAnswerEntry => {
      const index = record.lateFromIndex + offset;
      return { question, answer: index === questionIndex ? answer : record.answers[index] ?? [] };
    });
    if (!first) throw new Error(`set-aside question ${record.id} has no late question`);
    return [first, ...rest];
  }

  /** What became of a late answer: it reached the agent (`answered`), it is kept for the questions still open (`collected`), the conversation has no session to take it (`noSession`), or the question is not open any more (`gone`). */
  type LateAnswerOutcome = 'answered' | 'collected' | 'noSession' | 'gone';

  /**
   * @description Give the answer `answer` to the first question still open of the set-aside record `recordId`. The record's questions
   * are answered in order, as on screen:
   *  - while another question of the record is still open the answer is KEPT, its message closes with «✅ Answer: …» and the next
   *    question is posted as a message of its own with the set-aside look (the agent hears nothing yet);
   *  - the last one sends ONE late-answer message with every late answer to the agent (`deliverLateAnswer`); only once it reached
   *    a session is the record over — its message closes with the answer, its pin is released. A conversation with no session to
   *    take it leaves the record open.
   * Resolves the outcome and whether the topic now shows the whole answer (the question's message was edited to carry it). The
   * record is read and changed inside the question lifecycle queue, so this orders after a set-aside or a conversation's end in flight.
   */
  async function giveSetAsideAnswer(key: SessionKey, request: { recordId: string; answer: string[]; messageContext?: MessageContext }): Promise<{ outcome: LateAnswerOutcome; isAnswerShown: boolean }> {
    const answeringKey = `${keyToString(key)}:${request.recordId}`;
    const step = await runQuestionLifecycleOp(key, async () => {
      const record = getSetAsideRecords(key).find((candidate) => candidate.id === request.recordId);
      const target = record ? getSetAsideAnswerTarget(record) : null;
      if (!record || !target || answeringRecords.has(answeringKey)) return { kind: 'gone' as const };
      const isLastOpenQuestion = record.answers.every((answer, index) => answer !== null || index === target.index);
      if (!isLastOpenQuestion) return { kind: 'collected' as const, isAnswerShown: await collectLateAnswer(key, record, target, request.answer) };
      answeringRecords.add(answeringKey);
      return { kind: 'last' as const, record, target };
    });
    if (step.kind === 'gone') return { outcome: 'gone', isAnswerShown: false };
    if (step.kind === 'collected') return { outcome: 'collected', isAnswerShown: step.isAnswerShown };

    try {
      const prompt = buildLateAnswerPrompt({
        entries: buildLateEntries(step.record, step.target.index, request.answer),
        askedAtMs: step.record.askedAt,
        setAsideAtMs: step.record.setAsideAt,
        nowMs: Date.now(),
      });
      const delivery = await deliverLateAnswer(key, prompt, request.messageContext);
      if (delivery === 'noSession') return { outcome: 'noSession', isAnswerShown: false };
      const isAnswerShown = await runQuestionLifecycleOp(key, () => finishSetAsideRecord(key, step.record, step.target.question, request.answer));
      return { outcome: 'answered', isAnswerShown };
    } finally {
      answeringRecords.delete(answeringKey);
    }
  }

  /** The record's last open question was answered and delivered: the record is over. Its message carries the answer, its pin goes. */
  async function finishSetAsideRecord(key: SessionKey, record: SetAsideQuestionRecord, question: OpenCodeQuestion, answer: string[]): Promise<boolean> {
    await getState().setSetAsideQuestions(key, getSetAsideRecords(key).filter((candidate) => candidate.id !== record.id));
    if (record.messageId === null) return false;
    const isAnswerShown = await closeQuestionMessage(key, record.messageId, question, { answer: answer.join(', ') });
    await unpinMessage(key, record.messageId);
    return isAnswerShown;
  }

  /**
   * One answer of a record with more questions still open: kept in the record, its question's message closes with the answer and
   * gives up its pin, and the next open question is posted as a message of its own in the set-aside look — buttons, note, pin.
   * Resolves whether the answered question's message shows the answer.
   */
  async function collectLateAnswer(key: SessionKey, record: SetAsideQuestionRecord, target: { index: number; question: OpenCodeQuestion }, answer: string[]): Promise<boolean> {
    const answers = record.answers.slice();
    answers[target.index] = answer;
    let isAnswerShown = false;
    if (record.messageId !== null) {
      isAnswerShown = await closeQuestionMessage(key, record.messageId, target.question, { answer: answer.join(', ') });
      await unpinMessage(key, record.messageId);
    }
    const nextIndex = answers.findIndex((candidate) => candidate === null);
    const nextQuestion = record.questions[nextIndex];
    const nextMessageId = nextQuestion
      ? await sendQuestionMessage(key, nextQuestion, buildQuestionOptionsKeyboard(nextQuestion, (optionIndex) => `${setAsideButtonPrefix}${record.id}_${optionIndex}`))
      : null;
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
    if (nextMessageId !== null) {
      await pinMessageSilently(key, nextMessageId);
      await showQuestionSetAside(key, updated);
    } else {
      console.warn(`[questionSetAside] the next question of record ${record.id} could not be posted`);
    }
    return isAnswerShown;
  }

  /**
   * @description A tap on a button of a set-aside question (`qs_<record id>_<option index>`). A topic member may answer the agent's
   * question, as for a waiting one (the speaker gate, not the admin one). The tap must be on the message of the question that is
   * open NOW — a button left on a message that carries a result, or on one of another record, answers nothing — and the toast is
   * the label (the closed question carries it whole).
   */
  async function handleSetAsideTap(ctx: Context, recordId: string, optionIndex: number): Promise<void> {
    const speaker = await authoriseSpeaker(ctx);
    if (!speaker) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
    const { key } = speaker;
    const record = getSetAsideRecords(key).find((candidate) => candidate.id === recordId);
    const target = record ? getSetAsideAnswerTarget(record) : null;
    const tappedMessageId = getCallbackMessageId(ctx);
    if (!record || !target || tappedMessageId === null || record.messageId !== tappedMessageId) { await ctx.answerCbQuery(t('cb.no_pending_question')); return; }
    const label = target.question.options[optionIndex]?.label;
    if (!label) { await ctx.answerCbQuery(t('cb.invalid_option')); return; }
    const isLabelCut = await answerCallbackWithFittedText(ctx, label);
    const messageContext = speaker.role === 'talker' && ctx.from ? getAnsweringMemberContext(ctx.from) : undefined;
    const { outcome, isAnswerShown } = await giveSetAsideAnswer(key, { recordId, answer: [label], messageContext });
    // The closed question carries the whole label; one that could not be edited does not, and a toast cut it.
    if (outcome === 'answered' && !isAnswerShown && isLabelCut) await replyToThread(key, label);
  }

  /**
   * @description A text typed as a REPLY to a set-aside question's message (either of its messages, when it was re-posted) is its
   * late answer: a bare option number in range picks that option, any other text is the answer itself. Resolves whether it was taken
   * as one — otherwise it is an ordinary message. `role`: a topic member's answer reaches the agent under their mark (`from` says who).
   */
  async function answerSetAsideQuestionByReply(from: User | undefined, key: SessionKey, message: SetAsideReplyCandidate, role: 'admin' | 'talker'): Promise<boolean> {
    const replyToMessageId = message.reply_to_message?.message_id ?? null;
    const setAside = getSetAsideRecords(key);
    const text = message.text.trim();
    // A slash command is no answer; a message that replies to nothing, or when nothing is set aside, is none either.
    if (replyToMessageId === null || setAside.length === 0 || text === '' || (!message.isForwarded && text.startsWith('/'))) return false;
    const route = getQuestionReplyRouteWithSetAside({ text, replyToMessageId, liveQuestion: undefined, setAside, isForwarded: message.isForwarded });
    if (route.kind !== 'answerSetAside') return false;
    await getState().pushMessageId(key, message.message_id);
    const messageContext = role === 'talker' && from ? getAnsweringMemberContext(from) : undefined;
    const { outcome } = await giveSetAsideAnswer(key, { recordId: route.recordId, answer: route.answer, messageContext });
    return outcome !== 'gone';
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
    checkIsSetAsideQuestionMessage,
    registerQuestionSetAsideCallbacks,
    answerSetAsideQuestionByReply,
    closeSetAsideQuestions,
  };
}
