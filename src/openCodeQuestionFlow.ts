/**
 * @description Pure logic for the OpenCode interactive-question UX (plan
 * `2026-06-09-question-ux.md`, scopes S1 + S2). Kept side-effect-free so the
 * tricky parts — rendering option descriptions and the sequential
 * multi-question answer collection — are exhaustively unit-testable without a
 * live Telegram round-trip (the answer path real topics depend on; a bug here
 * silently breaks question answering and can't be force-triggered on demand).
 *
 * The bot (`bot.ts`) owns all I/O: it calls {@link buildQuestionBodyLines} to
 * render a question's text body, and drives the answer state machine via
 * {@link recordAnswerAndAdvance}, then performs the resulting Telegram send /
 * agent reply.
 */

import type { OpenCodeQuestion, PendingQuestionState } from './types';

/**
 * @description Build the message-BODY text lines for ONE question: the header,
 * the question text (only when it differs from the header), then the numbered
 * option labels each followed by its description (S1 — descriptions were
 * previously discarded even though OpenCode delivers them).
 *
 * The numbering is 1-based and lines up with the inline option buttons
 * (`qa_<qIdx>_<optIdx>`), so a user can answer by tapping a button OR by typing
 * the digit. Descriptions go ONLY in the body (indented under the label), never
 * on the button — buttons stay label-only under Telegram's 40-char cap.
 *
 * `escape` is injected (Markdown or HTML escaper) so this stays pure and
 * backend-agnostic; the bot passes its own `escapeMarkdown`.
 */
export function buildQuestionBodyLines(
  question: OpenCodeQuestion,
  escape: (text: string) => string,
): string[] {
  const header = question.header || question.question || 'Question';
  const lines: string[] = [`❓ *${escape(header)}*`];
  if (question.question && question.question !== header) {
    lines.push(escape(question.question));
  }
  question.options.forEach((option, optIdx) => {
    lines.push(`${optIdx + 1}. ${escape(option.label)}`);
    if (option.description) {
      // Indented under the label so it reads as that option's sub-line.
      lines.push(`   ${escape(option.description)}`);
    }
  });
  return lines;
}

/**
 * @description Build the same body as {@link buildQuestionBodyLines} but with NO
 * escaping and no bold markers — the plain-text fallback used when Telegram
 * rejects the Markdown render of a question.
 */
export function buildQuestionBodyLinesPlain(question: OpenCodeQuestion): string[] {
  const header = question.header || question.question || 'Question';
  const lines: string[] = [`❓ ${header}`];
  if (question.question && question.question !== header) {
    lines.push(question.question);
  }
  question.options.forEach((option, optIdx) => {
    lines.push(`${optIdx + 1}. ${option.label}`);
    if (option.description) lines.push(`   ${option.description}`);
  });
  return lines;
}

/**
 * @description How a question's message ends in the topic. A question message is never deleted: the buttons go, the
 * text stays, and the note below it says what became of the question.
 *  - `unanswered` — it was closed with no answer (a message sent instead, `/esc`, the session gone);
 *  - `askedAgain` — the same question was put again further down (re-posted to the bottom, re-asked after the idle
 *    compaction), so this copy is only the record.
 * An answer is a note of its own (`agent.question_answered_note`), built where the chosen label is known.
 */
export type QuestionClosing = 'unanswered' | 'askedAgain';

/** How a question's message ends: a {@link QuestionClosing}, or with the answer that was given. */
export type QuestionEnd = QuestionClosing | { answer: string };

/**
 * @description The text a question's message is edited to when it ends: the same body it was posted with (header,
 * question, numbered options with their descriptions), a blank line, then `note`. `escape` is the one
 * {@link buildQuestionBodyLines} takes; the note goes through it too, since it may carry the chosen label.
 */
export function buildClosedQuestionText(
  question: OpenCodeQuestion,
  note: string,
  escape: (text: string) => string,
): string {
  return [...buildQuestionBodyLines(question, escape), '', escape(note)].join('\n');
}

/** What stands where a cut body ends. */
const cutBodyEllipsis = '…';

/**
 * @description {@link buildClosedQuestionText} as plain text: no escaping, no bold marker — what the close is edited to
 * when Telegram cannot parse the Markdown render of it, the way {@link buildQuestionBodyLinesPlain} is for a post.
 *
 * `maxLength` is the most characters the text may have (a Telegram message holds a few thousand): a question that
 * filled a message when it was asked cannot take an answer note under it, and the note is the result the person looks
 * for, so the BODY gives way — first the option descriptions (what a long question is mostly made of; the labels stay,
 * they are what the answer names), then, if that is still too long, the end of the body, cut with an ellipsis. The note
 * is never cut. No limit by default.
 */
export function buildClosedQuestionPlainText(question: OpenCodeQuestion, note: string, maxLength: number = Number.POSITIVE_INFINITY): string {
  const render = (shown: OpenCodeQuestion): string => [...buildQuestionBodyLinesPlain(shown), '', note].join('\n');
  const full = render(question);
  if (full.length <= maxLength) return full;

  const withoutDescriptions: OpenCodeQuestion = { ...question, options: question.options.map((option) => ({ label: option.label })) };
  const shortened = render(withoutDescriptions);
  if (shortened.length <= maxLength) return shortened;

  const noteBlock = `\n\n${note}`;
  const bodyBudget = Math.max(maxLength - noteBlock.length - cutBodyEllipsis.length, 0);
  const body = buildQuestionBodyLinesPlain(withoutDescriptions).join('\n');
  // Whole characters up to the budget, which counts UTF-16 units as a message limit does: a code point is never split in two.
  let cutBody = '';
  for (const character of body) {
    if (cutBody.length + character.length > bodyBudget) break;
    cutBody += character;
  }
  return `${cutBody}${cutBodyEllipsis}${noteBlock}`;
}

/**
 * @description How to route a user's free-form reply that arrives WHILE an
 * OpenCode interactive question is pending. Mirrors `getClaudeReplyRoute`:
 *  - `answer` — the reply is a bare digit in range of the current question's
 *    options, so it PICKS that option (`labels` are the chosen option labels,
 *    the same a button tap would send);
 *  - `cancel` — any other free-form input (prose, an out-of-range digit, a voice
 *    transcript): the user means "move on", so the bot cancels the question and
 *    delivers the text as a fresh prompt instead of treating it as the answer.
 */
export type QuestionReplyRoute =
  | { kind: 'answer'; labels: string[] }
  | { kind: 'cancel' };

/**
 * @description Decide how to route a user's reply for a thread that has an
 * OpenCode question on screen. Pure so the digit-in-range precedence is
 * unit-testable without a live session.
 *
 * Only a bare 1-based digit in range of `currentQuestion.options` answers; any
 * other text (out-of-range digit, prose, empty) cancels. A digit answer carries
 * the chosen option label(s) so the caller never re-parses the digit (single
 * source of truth for the digit→label mapping).
 */
export function getQuestionReplyRoute(
  text: string,
  currentQuestion: OpenCodeQuestion | undefined,
): QuestionReplyRoute {
  const trimmed = text.trim();
  if (currentQuestion && /^\d+$/.test(trimmed)) {
    const optionIndex = parseInt(trimmed, 10) - 1;
    const picked = currentQuestion.options[optionIndex];
    if (picked) return { kind: 'answer', labels: [picked.label] };
  }
  return { kind: 'cancel' };
}

/**
 * @description Outcome of recording one answer into the pending-question state.
 * Either the bot must SHOW the next unanswered question (`showQuestion`, with
 * the new `currentIndex`), or every question is now answered and the bot must
 * SUBMIT the full answer matrix to the agent (`submit`).
 */
export type AnswerAdvanceAction =
  | { kind: 'showQuestion'; index: number }
  | { kind: 'submit'; matrix: string[][] };

/**
 * @description Record the user's answer for the CURRENTLY shown question and
 * decide what happens next (S2 — sequential multi-question + local answer
 * collection). Pure: returns the mutated-copy state plus the action; the bot
 * performs the side effect (post the next question OR reply to the agent).
 *
 * The bug this fixes: the old handler closed the whole request on the first
 * answer, sending EMPTY answers for every other question. Here we only submit
 * once NO slot is left `null`.
 *
 * `answerForCurrent` is the chosen option label(s) or the typed text, wrapped
 * as a one-element array per OpenCode's `string[][]` matrix shape.
 */
export function recordAnswerAndAdvance(
  state: PendingQuestionState,
  answerForCurrent: string[],
): { nextState: PendingQuestionState; action: AnswerAdvanceAction } {
  const answers = state.answers.slice();
  answers[state.currentIndex] = answerForCurrent;

  const nextUnansweredIndex = answers.findIndex(slot => slot === null);
  if (nextUnansweredIndex === -1) {
    // All answered → build the matrix. A null slot can only appear here
    // defensively (e.g. a migrated/corrupt state); coerce it to [''] so the
    // reply shape stays valid string[][] and never carries `null`.
    const matrix = answers.map(slot => slot ?? ['']);
    return {
      nextState: { ...state, answers },
      action: { kind: 'submit', matrix },
    };
  }

  return {
    nextState: { ...state, answers, currentIndex: nextUnansweredIndex },
    action: { kind: 'showQuestion', index: nextUnansweredIndex },
  };
}

/**
 * @description Restore-compat guard for {@link PendingQuestionState} (S2). The
 * persisted shape grew `answers` + `currentIndex`; an OLD `state.json` entry
 * written before this change has only `{ data, messageId }`. Returning it raw
 * would leave `answers`/`currentIndex` undefined and crash the answer handlers
 * at boot. This normalises any restored entry to the new shape:
 *  - missing/mismatched-length `answers` → rebuilt as `[null…]` sized to the
 *    question count (the user must re-answer — the in-progress local answers
 *    were never sent to the agent anyway);
 *  - missing/out-of-range `currentIndex` → `0`.
 */
export function migratePendingQuestionState(raw: PendingQuestionState): PendingQuestionState {
  const questionCount = raw.data.questions.length;
  const hasValidAnswers =
    Array.isArray(raw.answers) && raw.answers.length === questionCount;
  const answers: (string[] | null)[] = hasValidAnswers
    ? raw.answers
    : new Array(questionCount).fill(null);

  const hasValidIndex =
    typeof raw.currentIndex === 'number' &&
    raw.currentIndex >= 0 &&
    raw.currentIndex < questionCount;
  const currentIndex = hasValidIndex ? raw.currentIndex : 0;

  return { ...raw, answers, currentIndex };
}
