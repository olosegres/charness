/**
 * @description Pure helper for the forwarded-message mark — the agent-facing
 * `[Forwarded message · from: … · originally sent: …]` line the bot glues ahead
 * of a prompt when the operator FORWARDS a message into a bound, agent-active
 * topic. Without it the agent reads the forwarded words as the operator's own
 * (it once took two forwarded bot alerts, sent as examples, for a report).
 *
 * Plain English (agent-facing, NOT i18n) and folded ahead of the prompt by the
 * same rule as the reply quote (`getPromptWithMessageContext`): a forwarded text,
 * a caption, a voice note's transcript and a file announcement all carry it.
 *
 * The input is STRUCTURAL (no telegraf imports) so the helper is unit-testable;
 * the bridge that reads a real telegraf message lives in the Telegram connector
 * (`getTelegramForwardedMark`).
 */

import { formatIsoLocalOffset } from './isoTimestamp';
import { stripControlCharacters } from './stripControlCharacters';

/** Header prefix of the mark — recognisable, agent-facing English. */
const forwardedMarkHeaderPrefix = '[Forwarded message · from: ';

/** Milliseconds in a second: Telegram dates are unix SECONDS, `formatIsoLocalOffset` takes ms. */
const millisecondsPerSecond = 1000;

/** What the origin's name stands for, as it reads in the mark. */
const originKindLabels = {
  user: 'user',
  hiddenUser: 'hidden user',
  chat: 'chat',
  channel: 'channel',
} as const;

/** The four kinds of origin Telegram reports for a forwarded message. */
export type ForwardedOriginKind = keyof typeof originKindLabels;

/**
 * @description The origin of a forwarded message, distilled from a telegraf
 * `forward_origin` by the Telegram connector.
 */
export interface ForwardedMarkSource {
  kind: ForwardedOriginKind;
  /** The sender's display name, or the chat / channel title; empty when Telegram gave none. */
  name: string;
  /** A user's `@username`, when they have one. */
  username?: string;
  /** The post author's signature (a channel post, an anonymous group admin). */
  signature?: string;
  /** When the message was ORIGINALLY sent, unix seconds. */
  originalSentAtSeconds?: number;
}

/** Fallback for an origin with no name at all. */
const unknownOriginName = 'unknown';

/**
 * A third party's text (a sender's name, a chat's title, a post signature — all chosen by someone else) as ONE line
 * that cannot take part in the mark's own syntax: control and bidirectional characters out, whitespace flattened, and the square brackets that
 * close the header turned into parentheses.
 */
function cleanThirdPartyText(value: string): string {
  return stripControlCharacters(value).replace(/\s+/g, ' ').trim().replace(/\[/g, '(').replace(/\]/g, ')');
}

/** A cleaned text as a quoted token: what a stranger wrote reads as DATA, whatever it says (`"` and `\` are escaped). */
function quoteCleanText(cleanText: string): string {
  return JSON.stringify(cleanText);
}

/**
 * @description Who first wrote a forwarded message, as it reads in the mark and in the header of a reply to it:
 * `channel "Ops Alerts"`, `user "Alice Smith" (@alice)`, `chat "Team room" (signed "Chief")`. A name is quoted, so
 * the origin cannot be told apart from what it says.
 */
export function describeForwardedOrigin(source: ForwardedMarkSource): string {
  const cleanName = cleanThirdPartyText(source.name);
  const name = cleanName ? quoteCleanText(cleanName) : unknownOriginName;
  const cleanUsername = source.username ? cleanThirdPartyText(source.username) : '';
  const cleanSignature = source.signature ? cleanThirdPartyText(source.signature) : '';
  const details = [
    ...(cleanUsername ? [`@${cleanUsername}`] : []),
    ...(cleanSignature ? [`signed ${quoteCleanText(cleanSignature)}`] : []),
  ];
  return `${originKindLabels[source.kind]} ${name}${details.length > 0 ? ` (${details.join(', ')})` : ''}`;
}

/**
 * @description Render the mark, or `null` when the message was not forwarded.
 * The original date is the instance-local ISO instant the `/timestamps` line
 * uses, so the agent reads both on one clock; it is left out when Telegram gave
 * no usable date.
 */
export function buildForwardedMark(source: ForwardedMarkSource | undefined): string | null {
  if (!source) return null;
  const parts = [
    `${forwardedMarkHeaderPrefix}${describeForwardedOrigin(source)}`,
    ...(source.originalSentAtSeconds && source.originalSentAtSeconds > 0
      ? [`originally sent: ${formatIsoLocalOffset(source.originalSentAtSeconds * millisecondsPerSecond)}`]
      : []),
  ];
  return `${parts.join(' · ')}]`;
}
