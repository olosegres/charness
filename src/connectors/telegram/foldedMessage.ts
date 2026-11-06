/**
 * @description A bot message with a DETAIL folded under it: a one-sentence headline a person reads, and the text behind it
 * (an agent's prompt, a check's output) in an EXPANDABLE block quotation — collapsed by default, opened on a tap. Telegram
 * HTML is the only way to ask for it (`<blockquote expandable>`, Bot API ≥ 7.4); the headline and the detail are plain text
 * here and escaped, so nothing in a prompt or a log can inject a tag. Pure — the caller sends the result with
 * `parse_mode: 'HTML'`.
 */

import { cutTextSurrogateSafe } from '../../utils/surrogateSafeCut';
import { MAX_MESSAGE_LEN } from './messageSplit';
import { escapeHtmlText, stripControlChars } from './renderAgentHtml';

/** Between the headline and the folded quotation. */
const foldedDetailSeparator = '\n\n';

/** Ends a detail that was cut to fit the message. */
const foldedDetailCutMark = '…';

/**
 * @description The headline plus the folded detail as Telegram HTML. The detail is cut (marked with «…») so the whole
 * message stays within {@link MAX_MESSAGE_LEN} characters — Telegram counts a message AFTER its tags are parsed, so the
 * budget is measured on the plain text, not on the escaped one. A blank detail, or a headline that leaves no room for
 * one, leaves just the headline.
 */
export function buildFoldedMessageHtml(headline: string, foldedDetail: string): string {
  const shownHeadline = stripControlChars(headline);
  const detail = stripControlChars(foldedDetail).trim();
  const detailBudget = MAX_MESSAGE_LEN - shownHeadline.length - foldedDetailSeparator.length;
  if (detail === '' || detailBudget <= foldedDetailCutMark.length) return escapeHtmlText(shownHeadline);
  const shownDetail = detail.length <= detailBudget
    ? detail
    : `${cutTextSurrogateSafe(detail, detailBudget - foldedDetailCutMark.length)}${foldedDetailCutMark}`;
  return `${escapeHtmlText(shownHeadline)}${foldedDetailSeparator}<blockquote expandable>${escapeHtmlText(shownDetail)}</blockquote>`;
}
