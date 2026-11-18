/**
 * @description The buttons a talker (a person an admin let talk to the agent in one topic) may tap. Everything else on a
 * button is the admins': a picker, a wizard, a setting. The set is closed — default-deny, like the commands — and holds only
 * the taps that ANSWER the agent: an option of a question it put to the topic, the same question asked again after a
 * compaction, and a question the bot set aside because nobody answered it in time.
 */

/**
 * The callback data of the agent's own question buttons: `qa_<question>_<option>` (a question), `reask_<option>` (asked again) and
 * `qs_<record id>_<option>` (set aside; the id is base 36).
 * `opt_<n>` (a Claude TUI selector) is NOT one: no code builds such a button any more, and its handler types a digit into whatever the
 * TUI shows — an admin's dialog, a login picker.
 */
const talkerCallbackPatterns: readonly RegExp[] = [/^qa_\d+_\d+$/, /^reask_\d+$/, /^qs_[0-9a-z]+_\d+$/];

/** @description Whether a button with this `callback_data` is one a talker may tap. */
export function checkIsTalkerCallback(callbackData: string | undefined): boolean {
  return callbackData !== undefined && talkerCallbackPatterns.some((pattern) => pattern.test(callbackData));
}
