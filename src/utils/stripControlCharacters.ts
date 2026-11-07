/**
 * @description Text from outside the process (a runner's output, a name a stranger chose) made safe to print or to put in a
 * prompt: every character a terminal could act on, or that could disguise what is shown, is taken out. Node built-ins only
 * (none at all): the runner's root step, which runs from a copy of the package without `node_modules`, imports it too.
 */

/** Everything that is a control character (C0, DEL, C1 — escape sequences start with one), the bidirectional overrides and isolates, and the line and paragraph separators. */
const unsafeCharacterPattern = /[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/gu;
const keptControlCharacters = new Set(['\n', '\t']);

/** @description `text` with every character that a terminal could act on, or that could disguise what is printed, taken out; newlines and tabs stay. */
export function stripControlCharacters(text: string): string {
  return text.replace(unsafeCharacterPattern, (character) => (keptControlCharacters.has(character) ? character : ''));
}
