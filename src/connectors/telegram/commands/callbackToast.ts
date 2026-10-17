/**
 * The toast a button tap is answered with.
 */
import type { Context } from 'telegraf';
import type { SessionKey } from '../../../sessionKey';

/** The most characters Telegram shows in the toast a button tap is answered with (`answerCallbackQuery`'s `text`). */
export const callbackToastMaxLength = 200;

/** Splits text into the characters a reader sees (an emoji with a skin tone, a family, a flag is ONE). */
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * The longest start of `text` that holds at most `maxUnits` UTF-16 units and ends on a whole grapheme: a combined
 * emoji (a family, a flag, a skin tone) or an accented letter built from several code points is never split into a
 * broken-looking piece.
 */
function cutToGraphemes(text: string, maxUnits: number): string {
  let cut = '';
  for (const { segment } of graphemeSegmenter.segment(text)) {
    if (cut.length + segment.length > maxUnits) break;
    cut += segment;
  }
  return cut;
}

/**
 * @description Answer a button tap with `text` as the toast: whole when it fits {@link callbackToastMaxLength}, else
 * cut (with an ellipsis, on a grapheme boundary, within the limit counted in UTF-16 units). Resolves to whether it
 * was cut. For a text the thread already carries in full (an answer the question message was just edited to show):
 * the toast only confirms the tap, and a longer one must still be answered — Telegram refuses a toast over the
 * limit and the tap would get no feedback at all.
 */
export async function answerCallbackWithFittedText(ctx: Pick<Context, 'answerCbQuery'>, text: string): Promise<boolean> {
  if (text.length <= callbackToastMaxLength) {
    await ctx.answerCbQuery(text);
    return false;
  }
  await ctx.answerCbQuery(`${cutToGraphemes(text, callbackToastMaxLength - 1)}…`);
  return true;
}

/**
 * @description Answer a button tap with `text` whole. A toast holds {@link callbackToastMaxLength} characters: a
 * longer text is cut for the toast ({@link answerCallbackWithFittedText}) and handed to `postWhole` to be posted in
 * full as a message — a notice or an error that says what to do must never reach the user half-sentence, and must
 * never be dropped because it did not fit.
 */
export async function answerCallbackWithWholeText(
  ctx: Pick<Context, 'answerCbQuery'>,
  text: string,
  postWhole: (wholeText: string) => Promise<unknown>,
): Promise<void> {
  if (await answerCallbackWithFittedText(ctx, text)) await postWhole(text);
}

/**
 * @description {@link answerCallbackWithWholeText} for a command module: the topic of the tap is where a text too long
 * for the toast is posted in full. A module builds its answerer once from its own `replyToThread` port.
 */
export function createWholeTextAnswerer(
  replyToThread: (key: SessionKey, text: string) => Promise<unknown>,
): (ctx: Pick<Context, 'answerCbQuery'>, key: SessionKey, text: string) => Promise<void> {
  return (ctx, key, text) => answerCallbackWithWholeText(ctx, text, (wholeText) => replyToThread(key, wholeText));
}
