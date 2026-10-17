/**
 * The toast a button tap is answered with.
 */
import type { Context } from 'telegraf';

/** The most characters Telegram shows in the toast a button tap is answered with (`answerCallbackQuery`'s `text`). */
export const callbackToastMaxLength = 200;

/**
 * @description Answer a button tap with `text` whole. A toast holds {@link callbackToastMaxLength} characters: a
 * longer text is cut for the toast (with an ellipsis, on a character boundary) and handed to `postWhole` to be posted
 * in full as a message — a notice or an error that says what to do must never reach the user half-sentence, and
 * must never be dropped because it did not fit.
 */
export async function answerCallbackWithWholeText(
  ctx: Pick<Context, 'answerCbQuery'>,
  text: string,
  postWhole: (wholeText: string) => Promise<unknown>,
): Promise<void> {
  if (text.length <= callbackToastMaxLength) {
    await ctx.answerCbQuery(text);
    return;
  }
  await ctx.answerCbQuery(`${cutToCharacters(text, callbackToastMaxLength - 1)}…`);
  await postWhole(text);
}

/** The longest start of `text` that holds at most `maxUnits` UTF-16 units and ends on a whole character (an emoji is two units). */
function cutToCharacters(text: string, maxUnits: number): string {
  let cut = '';
  for (const character of text) {
    if (cut.length + character.length > maxUnits) break;
    cut += character;
  }
  return cut;
}
