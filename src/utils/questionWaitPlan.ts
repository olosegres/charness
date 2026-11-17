/**
 * @description Pure plan for «a question the agent asked never stops its work»: how long a question waits for the owner
 * (the «question wait» setting and its resolution), what the agent is told when the wait ends and the question is set aside,
 * what it is told when the answer comes later, how a typed message is routed while questions wait or are set aside, and how
 * many set-aside questions stay open at once.
 *
 * The bot owns every side effect (the timer, the deny / reply to the CLI, the Telegram edit and pin, the delivery of the late
 * answer); this module only decides and words — so the rules are unit-testable without a live agent. The texts here are
 * agent-facing English, never i18n, and the only place the model learns what «set aside» means: they are literal and
 * never phrased as the user's words.
 */

import { getQuestionReplyRoute } from '../openCodeQuestionFlow';
import type { OpenCodeQuestion, SetAsideQuestionRecord } from '../types';
import { neutraliseHeaderLookalikes } from './authorMark';
import { formatLocalClockWithDateIfNotToday } from './localClock';

const msPerMinute = 60_000;

/** The question wait, in the order a picker lists it: `dontWait` sets a question aside at once, `untilAnswered` never does. */
export const questionWaitChoices = ['dontWait', 'tenMinutes', 'thirtyMinutes', 'oneHour', 'untilAnswered'] as const;

/** @name QuestionWaitChoice @description One value of the «question wait» setting. */
export type QuestionWaitChoice = (typeof questionWaitChoices)[number];

/** What an instance does until the operator chooses: the owner's figure. */
export const defaultQuestionWaitChoice: QuestionWaitChoice = 'thirtyMinutes';

/** How long each choice lets a question wait; `null` = for as long as it takes (the pre-set-aside behaviour). */
const questionWaitMs: Record<QuestionWaitChoice, number | null> = {
  dontWait: 0,
  tenMinutes: 10 * msPerMinute,
  thirtyMinutes: 30 * msPerMinute,
  oneHour: 60 * msPerMinute,
  untilAnswered: null,
};

/** The most questions set aside and still open in one conversation; a further one closes the oldest. */
export const maxSetAsideQuestions = 5;

/**
 * @description The wait that applies to a topic: its own choice, else General's (the instance default), else
 * {@link defaultQuestionWaitChoice}.
 */
export function resolveQuestionWait(
  topicChoice: QuestionWaitChoice | undefined,
  generalChoice: QuestionWaitChoice | undefined,
): QuestionWaitChoice {
  return topicChoice ?? generalChoice ?? defaultQuestionWaitChoice;
}

/**
 * @description How long from `nowMs` until a question asked at `askedAtMs` is to be set aside: `0` when its wait is over
 * (also a `dontWait`), `null` when its choice never sets it aside. The point is `askedAtMs + wait` whatever the agent's
 * process looks like — the timer is armed from this at ask time and again at boot, so a restart keeps the original moment.
 */
export function getQuestionSetAsideDelayMs(askedAtMs: number, choice: QuestionWaitChoice, nowMs: number): number | null {
  const waitMs = questionWaitMs[choice];
  if (waitMs === null) return null;
  return Math.max(askedAtMs + waitMs - nowMs, 0);
}

/** @description Whether the wait of a question asked at `askedAtMs` is over — it is to be set aside now. */
export function checkIsQuestionSetAsideDue(askedAtMs: number, choice: QuestionWaitChoice, nowMs: number): boolean {
  return getQuestionSetAsideDelayMs(askedAtMs, choice, nowMs) === 0;
}

/** What a question is called to the agent: its full text, else its header. */
function getQuestionText(question: OpenCodeQuestion): string {
  return question.question || question.header || 'Question';
}

/** A multi-select answer reads as its labels in a row. */
function formatAnswer(answer: string[]): string {
  return answer.join(', ');
}

/** What the agent's tool result says about a call's questions that were answered before the wait ended. */
function formatGivenAnswers(questions: OpenCodeQuestion[], answers: (string[] | null)[]): string | null {
  const given: string[] = [];
  questions.forEach((question, index) => {
    const answer = answers[index];
    // Quoted as JSON strings: the agent cannot mistake a typed answer for a line of the text around it.
    if (answer) given.push(`${JSON.stringify(getQuestionText(question))} = ${JSON.stringify(formatAnswer(answer))}`);
  });
  return given.length > 0 ? `(Answers already given in this call: ${given.join('; ')}.)` : null;
}

/** @description What {@link buildQuestionSetAsideText} words. */
export interface QuestionSetAsideTextInput {
  /** The questions of the call the agent is blocked on. */
  questions: OpenCodeQuestion[];
  /** One slot per question: the answer given before the wait ended, `null` while open. */
  answers: (string[] | null)[];
  askedAtMs: number;
  /** The moment the text is written: the end of the wait (or of an earlier set-aside, for the question asked again). */
  nowMs: number;
  /** The agent asked a question whose set-aside copy is still open: told it is the same one, not a new one. */
  isAlreadyOpen?: boolean;
}

/**
 * @description The text the agent gets as the result of its question when the wait ends: Claude's `can_use_tool` deny
 * message, OpenCode's custom answer of every question left open. It says the truth — nobody answered, the question stays
 * open, the answer arrives later as a message — and tells the agent to go on, so its turn does not stop on the tool call.
 * Answers given before the wait ended are named, so the agent does not lose them.
 */
export function buildQuestionSetAsideText(input: QuestionSetAsideTextInput): string {
  const asked = formatLocalClockWithDateIfNotToday(input.askedAtMs, input.nowMs);
  const waitedMinutes = Math.round((input.nowMs - input.askedAtMs) / msPerMinute);
  const waited = waitedMinutes >= 1 ? `waited ${waitedMinutes} min` : 'set aside at once';
  const firstLine = input.isAlreadyOpen
    ? `[Charness] This question is still open: the user has not answered it yet (asked ${asked}). This is NOT an answer.`
    : `[Charness] The user has not answered yet (asked ${asked}, ${waited}). This is NOT an answer.`;
  const givenAnswers = formatGivenAnswers(input.questions, input.answers);
  return [
    firstLine,
    'The question stays open for them in the topic; do not ask it again and do not wait for it.',
    'Go on with work that does not depend on it; if nothing is left, end your turn.',
    'Their answer, when it comes, arrives as a new message headed "[Late answer to your question …]".',
    ...(givenAnswers ? [givenAnswers] : []),
  ].join('\n');
}

/** One answer of a late-answer prompt: the question and what the person answered (a label, labels or typed text). */
export interface LateAnswerEntry {
  question: OpenCodeQuestion;
  answer: string[];
}

/** @description What {@link buildLateAnswerPrompt} words. */
export interface LateAnswerPromptInput {
  /** The questions answered now — one for an ordinary question, several when a call's remaining questions are answered together. */
  entries: [LateAnswerEntry, ...LateAnswerEntry[]];
  askedAtMs: number;
  setAsideAtMs: number;
  /** The moment of the answer: clocks of an earlier day read with their date. */
  nowMs: number;
}

/**
 * @description The message that carries a late answer to the agent, which went on without it: names the question, the
 * answer, and asks the agent to check what it did meanwhile. The words of the question and the answer cannot open a line
 * the way one of the bot's own headers does (`neutraliseHeaderLookalikes`) — an answer may be typed by a topic member.
 */
export function buildLateAnswerPrompt(input: LateAnswerPromptInput): string {
  const asked = formatLocalClockWithDateIfNotToday(input.askedAtMs, input.nowMs);
  const setAside = formatLocalClockWithDateIfNotToday(input.setAsideAtMs, input.nowMs);
  const isSeveral = input.entries.length > 1;
  const pairs = input.entries.map((entry) =>
    [
      `Question: ${neutraliseHeaderLookalikes(getQuestionText(entry.question))}`,
      `Answer: ${neutraliseHeaderLookalikes(formatAnswer(entry.answer))}`,
    ].join('\n'),
  );
  return [
    `[Late answer to your question asked ${asked}, set aside ${setAside}]`,
    pairs.join('\n\n'),
    isSeveral
      ? 'You went on without them — check whether anything you did meanwhile conflicts with these answers, and adjust.'
      : 'You went on without it — check whether anything you did meanwhile conflicts with this answer, and adjust.',
  ].join('\n');
}

/**
 * @description The question of a set-aside record a late answer goes to: its first one still open (the questions of one call
 * are answered in order, like on screen), `null` when none is. `index` is its place in `record.questions` / `record.answers`.
 */
export function getSetAsideAnswerTarget(record: SetAsideQuestionRecord): { index: number; question: OpenCodeQuestion } | null {
  const index = record.answers.findIndex((answer) => answer === null);
  if (index === -1) return null;
  const question = record.questions[index];
  return question ? { index, question } : null;
}

/**
 * @description How a message typed in the topic is routed while a question may wait or may be set aside.
 *  - `answer` / `cancel` — a question is still waiting (the agent is blocked on it): today's route, see {@link getQuestionReplyRoute};
 *  - `answerSetAside` — the message answers the open question `questionIndex` of the set-aside record `recordId`, with `answer`
 *    (the label a bare option number names, else the typed text);
 *  - `prompt` — an ordinary message: it closes nothing and interrupts nothing, a set-aside question stays open.
 */
export type QuestionReplyRouteWithSetAside =
  | { kind: 'answer'; labels: string[] }
  | { kind: 'cancel' }
  | { kind: 'answerSetAside'; recordId: string; questionIndex: number; answer: string[] }
  | { kind: 'prompt' };

/** @description What {@link getQuestionReplyRouteWithSetAside} decides on. */
export interface QuestionReplyRouteInput {
  text: string;
  /** The Telegram message the text replies to, `null` when it is not a reply. */
  replyToMessageId: number | null;
  /** The question on screen that the agent is blocked on right now, if any. */
  liveQuestion: OpenCodeQuestion | undefined;
  /** The conversation's open set-aside questions, oldest first. */
  setAside: readonly SetAsideQuestionRecord[];
}

/**
 * @description Route a typed message, in this order:
 *  1. a REPLY to a set-aside question's message answers that question — whatever else is open, the person named it: a bare
 *     option number in range picks that label, any other text is the answer itself (a reply with no text routes on);
 *  2. a question still waiting keeps its route (a number answers it, other text cancels it and goes as a prompt);
 *  3. no question waiting: a bare option number in range of the NEWEST set-aside question answers it;
 *  4. anything else is an ordinary prompt — it never closes a set-aside question.
 */
export function getQuestionReplyRouteWithSetAside(input: QuestionReplyRouteInput): QuestionReplyRouteWithSetAside {
  const text = input.text.trim();

  const repliedRecord = input.replyToMessageId === null ? undefined : input.setAside.find((record) => record.messageId === input.replyToMessageId);
  const repliedTarget = repliedRecord ? getSetAsideAnswerTarget(repliedRecord) : null;
  if (repliedRecord && repliedTarget && text !== '') {
    const numberRoute = getQuestionReplyRoute(text, repliedTarget.question);
    return {
      kind: 'answerSetAside',
      recordId: repliedRecord.id,
      questionIndex: repliedTarget.index,
      answer: numberRoute.kind === 'answer' ? numberRoute.labels : [text],
    };
  }

  if (input.liveQuestion) return getQuestionReplyRoute(text, input.liveQuestion);

  const newestRecord = input.setAside[input.setAside.length - 1];
  const newestTarget = newestRecord ? getSetAsideAnswerTarget(newestRecord) : null;
  if (newestRecord && newestTarget) {
    const numberRoute = getQuestionReplyRoute(text, newestTarget.question);
    if (numberRoute.kind === 'answer') {
      return { kind: 'answerSetAside', recordId: newestRecord.id, questionIndex: newestTarget.index, answer: numberRoute.labels };
    }
  }
  return { kind: 'prompt' };
}

/**
 * @description Add a newly set-aside question to the conversation's list (oldest first), keeping at most
 * {@link maxSetAsideQuestions}: the oldest ones that no longer fit are handed back as `evicted`, for the bot to close as
 * «not answered» and unpin.
 */
export function addSetAsideQuestion(
  records: readonly SetAsideQuestionRecord[],
  added: SetAsideQuestionRecord,
): { records: SetAsideQuestionRecord[]; evicted: SetAsideQuestionRecord[] } {
  const all = [...records, added];
  const overflow = Math.max(all.length - maxSetAsideQuestions, 0);
  return { records: all.slice(overflow), evicted: all.slice(0, overflow) };
}
