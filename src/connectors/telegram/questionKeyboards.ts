/**
 * The inline keyboard of a pending question's options and the `extra` object a send carries it in.
 */
import type { InlineKeyboardMarkup } from 'telegraf/typings/core/types/typegram';
import type { OpenCodeQuestion } from '../../types';
import { buildOptionsKeyboard } from './outbound';

/**
 * @description Build the tappable keyboard for an OpenCode question's options.
 *
 * The bot offers a question's options twice with different callback wiring —
 * the live answer buttons (`qa_<qIdx>_<optIdx>`) and the idle-compaction re-ask
 * buttons (`reask_<optIdx>`) — so `buildCallbackId` is the only thing that
 * varies. Labels are passed through untouched: the button width cap and its
 * elision are Telegram's, and belong to the connector's
 * {@link buildOptionsKeyboard}, not here.
 *
 * `buildCallbackId` must produce an id the matching `bot.action` regex accepts.
 * The index it receives is the 0-based position in `question.options`; the body
 * shows that option as `index + 1`.
 */
export function buildQuestionOptionsKeyboard(
  question: OpenCodeQuestion,
  buildCallbackId: (optionIndex: number) => string,
): InlineKeyboardMarkup | undefined {
  return buildOptionsKeyboard(
    question.options.map((option, optionIndex) => ({
      id: buildCallbackId(optionIndex),
      label: option.label,
    })),
  );
}

/**
 * @description Attach an optional inline keyboard to a {@link replyToThread}
 * `extra`.
 *
 * One place owns the `reply_markup` spelling, because getting it wrong fails
 * SILENTLY: the message still sends, just with no buttons, and Telegram reports
 * nothing. `base` carries whatever else the send needs (a `parse_mode`).
 */
export function buildKeyboardExtra(
  keyboard: InlineKeyboardMarkup | undefined,
  base: Record<string, unknown> = {},
): Record<string, unknown> {
  return keyboard ? { ...base, reply_markup: keyboard } : { ...base };
}
