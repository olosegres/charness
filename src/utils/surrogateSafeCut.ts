/**
 * @description Where to cut a string to at most `maxChars` UTF-16 units without splitting a surrogate pair. A plain
 * `slice(0, maxChars)` can end between the two halves of an emoji and leave a lone high surrogate, which serialises to an
 * unpaired `\ud83d` (it broke `jq` readers of the output trace) and which Telegram refuses as invalid text. The cut
 * moves back by one when it would land right after a high surrogate. `maxChars` of 1 or less is cut as asked: a cut never
 * moves to 0, so a caller that loops over the rest of a text always makes progress.
 *
 * One source for the output trace's preview, the Jira comment splitter and a check's status line.
 */

/** The first half of a character outside the BMP (a high surrogate). */
const highSurrogateMin = 0xd800;
const highSurrogateMax = 0xdbff;

/** @description The index at which `text` is cut to at most `maxChars` units, never between the halves of a surrogate pair. */
export function getSurrogateSafeCutIndex(text: string, maxChars: number): number {
  if (text.length <= maxChars) return text.length;
  if (maxChars <= 1) return maxChars;
  const lastKeptCode = text.charCodeAt(maxChars - 1);
  return lastKeptCode >= highSurrogateMin && lastKeptCode <= highSurrogateMax ? maxChars - 1 : maxChars;
}

/** @description The first `maxChars` units of `text` at most, never ending on the first half of a surrogate pair. */
export function cutTextSurrogateSafe(text: string, maxChars: number): string {
  return text.slice(0, getSurrogateSafeCutIndex(text, maxChars));
}
