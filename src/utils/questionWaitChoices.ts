/**
 * @description The choices of the «question wait» setting and how long each lets a question wait — kept apart from
 * `questionWaitPlan.ts` (the texts and the routing of a set-aside question) because the instance settings, the state store and the
 * test timings need only these, and they load before any env file is read: this module imports nothing.
 */

const msPerMinute = 60_000;

/** The question wait, in the order a picker lists it: `dontWait` sets a question aside at once, `untilAnswered` never does. */
export const questionWaitChoices = ['dontWait', 'tenMinutes', 'thirtyMinutes', 'oneHour', 'untilAnswered'] as const;

/** @name QuestionWaitChoice @description One value of the «question wait» setting. */
export type QuestionWaitChoice = (typeof questionWaitChoices)[number];

/** @description Whether `value` is one of the wait choices (a hand-edited state or settings file may hold anything). */
export function checkIsQuestionWaitChoice(value: string | undefined): value is QuestionWaitChoice {
  return questionWaitChoices.some((choice) => choice === value);
}

/** What an instance does until the operator chooses: the owner's figure. */
export const defaultQuestionWaitChoice: QuestionWaitChoice = 'thirtyMinutes';

/** How long each choice lets a question wait; `null` = for as long as it takes (the pre-set-aside behaviour). */
export const questionWaitMs: Record<QuestionWaitChoice, number | null> = {
  dontWait: 0,
  tenMinutes: 10 * msPerMinute,
  thirtyMinutes: 30 * msPerMinute,
  oneHour: 60 * msPerMinute,
  untilAnswered: null,
};

/** The longest finite wait the setting offers: the ceiling a test's shorter window (`CHARNESS_TEST_TIMINGS`) may name. */
export const longestQuestionWaitMs = 60 * msPerMinute;
