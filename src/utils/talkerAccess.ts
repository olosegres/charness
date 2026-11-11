/**
 * @description The buttons a talker (a person an admin let talk to the agent in one topic) may tap. Everything else on a
 * button is the admins': a picker, a wizard, a setting. The set is closed — default-deny, like the commands — and holds only
 * the taps that ANSWER the agent: an option of a question it put to the topic, the same question asked again after a
 * compaction, and the option of a Claude TUI selector.
 */

/** The callback data of the agent's own question buttons: `qa_<question>_<option>` (a question), `reask_<option>` (asked again), `opt_<n>` (a TUI selector). */
const talkerCallbackPatterns: readonly RegExp[] = [/^qa_\d+_\d+$/, /^reask_\d+$/, /^opt_\d+$/];

/** @description Whether a button with this `callback_data` is one a talker may tap. */
export function checkIsTalkerCallback(callbackData: string | undefined): boolean {
  return callbackData !== undefined && talkerCallbackPatterns.some((pattern) => pattern.test(callbackData));
}
