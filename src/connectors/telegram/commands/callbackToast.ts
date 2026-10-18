/**
 * The toast a button tap is answered with.
 */
import type { Context } from 'telegraf';
import type { SessionKey } from '../../../sessionKey';
import { checkIsStaleAnswerCallbackQueryError } from '../../../utils/telegramError';

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
 * @description Answer a button tap, surviving an EXPIRED query. A handler that works a long time before it answers (a
 * default-account change re-spawns every live topic, ~30 s) answers after Telegram stopped waiting, and the Bot API
 * refuses with «query is too old»: the toast is lost, but that must never change what the handler still has to do (the
 * re-render of the screen). Resolves to whether the toast reached the user; any other failure is thrown.
 */
export async function answerCallbackQuerySafely(ctx: Pick<Context, 'answerCbQuery'>, text?: string): Promise<boolean> {
  try {
    await ctx.answerCbQuery(text);
    return true;
  } catch (error) {
    if (!checkIsStaleAnswerCallbackQueryError(error)) throw error;
    console.debug('[callback] the tap was answered after its query expired; the toast is lost');
    return false;
  }
}

/** The toast for `text`: the text whole when it fits {@link callbackToastMaxLength}, else its start with an ellipsis. */
function fitToastText(text: string): { toast: string; isCut: boolean } {
  if (text.length <= callbackToastMaxLength) return { toast: text, isCut: false };
  return { toast: `${cutToGraphemes(text, callbackToastMaxLength - 1)}…`, isCut: true };
}

/**
 * @description Answer a button tap with `text` as the toast: whole when it fits {@link callbackToastMaxLength}, else
 * cut (with an ellipsis, on a grapheme boundary, within the limit counted in UTF-16 units). Resolves to whether it
 * was cut. For a text the thread already carries in full (an answer the question message was just edited to show):
 * the toast only confirms the tap, and a longer one must still be answered — Telegram refuses a toast over the
 * limit and the tap would get no feedback at all. An expired query ({@link answerCallbackQuerySafely}) is no failure
 * here: the thread carries the text.
 */
export async function answerCallbackWithFittedText(ctx: Pick<Context, 'answerCbQuery'>, text: string): Promise<boolean> {
  const { toast, isCut } = fitToastText(text);
  await answerCallbackQuerySafely(ctx, toast);
  return isCut;
}

/**
 * @description Answer a button tap with `text` whole. A toast holds {@link callbackToastMaxLength} characters: a
 * longer text is cut for the toast and handed to `postWhole` to be posted in full as a message — a notice or an error
 * that says what to do must never reach the user half-sentence, and must never be dropped because it did not fit.
 * The same holds for a toast that came too late (the query expired): the text is posted instead.
 */
export async function answerCallbackWithWholeText(
  ctx: Pick<Context, 'answerCbQuery'>,
  text: string,
  postWhole: (wholeText: string) => Promise<unknown>,
): Promise<void> {
  const { toast, isCut } = fitToastText(text);
  const isToastShown = await answerCallbackQuerySafely(ctx, toast);
  if (isCut || !isToastShown) await postWhole(text);
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
