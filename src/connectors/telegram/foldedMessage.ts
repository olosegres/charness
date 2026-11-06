/**
 * @description A bot message with a DETAIL folded under it: a one-sentence headline a person reads, and the text behind it
 * (an agent's prompt, a check's output) in an EXPANDABLE block quotation — collapsed by default, opened on a tap. Telegram
 * HTML is the only way to ask for it (`<blockquote expandable>`, Bot API ≥ 7.4); the headline and the detail are plain text
 * here and escaped, so nothing in a prompt or a log can inject a tag. Pure — the caller sends `html` with
 * `parse_mode: 'HTML'` and keeps `plain` for the case Telegram rejects the markup anyway.
 */

import { cutTextSurrogateSafe } from '../../utils/surrogateSafeCut';
import { MAX_MESSAGE_LEN } from './messageSplit';
import { escapeHtmlText, stripControlChars } from './renderAgentHtml';

/** Between the headline and the folded quotation. */
const foldedDetailSeparator = '\n\n';

/** Ends a detail that was cut to fit the message. */
const foldedDetailCutMark = '…';

/**
 * @name FoldedMessage
 * @description The same message twice: `html` for `parse_mode: 'HTML'`, and `plain` — headline, blank line, detail, no markup
 * and nothing escaped — for a send without a parse mode.
 */
export interface FoldedMessage {
  html: string;
  plain: string;
}

/**
 * @description The headline plus the folded detail. The detail is cut (marked with «…») so the whole message stays within
 * {@link MAX_MESSAGE_LEN} characters — Telegram counts a message AFTER its tags are parsed, so the budget is measured on the
 * plain text, not on the escaped one, and `plain` fits for the same reason. A blank detail, or a headline that leaves no room
 * for one, leaves just the headline in both.
 */
export function buildFoldedMessage(headline: string, foldedDetail: string): FoldedMessage {
  const shownHeadline = stripControlChars(headline);
  const detail = stripControlChars(foldedDetail).trim();
  const detailBudget = MAX_MESSAGE_LEN - shownHeadline.length - foldedDetailSeparator.length;
  if (detail === '' || detailBudget <= foldedDetailCutMark.length) {
    return { html: escapeHtmlText(shownHeadline), plain: shownHeadline };
  }
  const shownDetail = detail.length <= detailBudget
    ? detail
    : `${cutTextSurrogateSafe(detail, detailBudget - foldedDetailCutMark.length)}${foldedDetailCutMark}`;
  return {
    html: `${escapeHtmlText(shownHeadline)}${foldedDetailSeparator}<blockquote expandable>${escapeHtmlText(shownDetail)}</blockquote>`,
    plain: `${shownHeadline}${foldedDetailSeparator}${shownDetail}`,
  };
}
