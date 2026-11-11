/**
 * @description Pure helpers for how the agent is told WHO wrote a message that is not the operator's: the mark glued
 * ahead of such a message, and the description the reply-quote header and the request header reuse.
 *
 * In a topic where an admin let other people talk to the agent (`topicTalkers.ts`), everything the agent reads looks the
 * same unless the bot says whose words they are — and a talker's words must never pass for the operator's (an
 * instruction to read a secret, to change its own rules). Plain English (agent-facing, NOT i18n) and structural, like
 * `forwardedMark.ts`, whose cleaning of third-party text it reuses: a name is chosen by its owner and must not take part
 * in the mark's own syntax.
 */

import { cleanThirdPartyText, quoteCleanText } from './forwardedMark';
import { stripControlCharacters } from './stripControlCharacters';

/** The two kinds of author who are not the operator: what each is called to the agent. */
const authorKindLabels = {
  /** On the list of the topic (or General's group-wide one): allowed to talk to the agent here. */
  talker: 'topic member',
  /** A member of the group nobody allowed to talk to the agent: its words are only ever quoted, as untrusted text. */
  other: 'group member',
} as const;

/** @name NonOperatorAuthorKind @description Who wrote a message that is not the operator's. */
export type NonOperatorAuthorKind = keyof typeof authorKindLabels;

/** What the bot knows of an author: the name Telegram shows and the @username, when there is one. */
export interface MessageAuthorSource {
  /** The display name; empty when Telegram gave none (a channel's post carries the channel's title instead). */
  name: string;
  /** Without a leading `@`. */
  username?: string;
}

/** Fallback for an author with no name at all. */
const unknownAuthorName = 'unknown';

/** Tail of the mark: what the agent must take from it. */
const authorMarkTail = 'not the operator';

/**
 * @description Who wrote a message, as the agent reads it: `topic member "Alice Smith" (@alice)`. The name is quoted, so
 * the author cannot be told apart from what they say.
 */
export function describeMessageAuthor(kind: NonOperatorAuthorKind, source: MessageAuthorSource): string {
  const cleanName = cleanThirdPartyText(source.name);
  const name = cleanName ? quoteCleanText(cleanName) : unknownAuthorName;
  const cleanUsername = source.username ? cleanThirdPartyText(source.username) : '';
  return `${authorKindLabels[kind]} ${name}${cleanUsername ? ` (@${cleanUsername})` : ''}`;
}

/**
 * @description The mark that leads a message of a non-operator author:
 * `[Message from topic member "Alice Smith" (@alice) · not the operator]`.
 */
export function buildMessageAuthorMark(kind: NonOperatorAuthorKind, source: MessageAuthorSource): string {
  return `[Message from ${describeMessageAuthor(kind, source)} · ${authorMarkTail}]`;
}

/**
 * A line that opens with `[`, after any horizontal whitespace or invisible characters (zero-width spaces, a byte-order mark):
 * the shape of every header the bot itself puts into a prompt (`[Request …]`, `[Replying to …]`, `[Telegram thread context]`,
 * `[Held over …]`). The leading part is kept in group 1.
 */
const headerLookalikePattern = /^((?:[^\S\n]|[\u200b-\u200d\u2060\ufeff])*)\[/gm;

/** The line breaks other than `\n` — a carriage return, NEL, the Unicode line and paragraph separators — which a reader takes for one. */
const otherLineBreakPattern = /\r\n|[\r\u0085\u2028\u2029]/g;

/**
 * @description The words of somebody who is not the operator, made unable to pass for the bot's own lines. The bot's headers
 * always open a line with `[`, and a message's words end only where the next such header begins — so a person's words must
 * never hold a line that opens with `[`: a forged `[Request …]` or `[Replying to an earlier message · from: user]` would
 * read as a separate message of the operator's in the same prompt. Every kind of line break becomes `\n` first (so a header
 * after a carriage return is a line of its own to the pattern, as it is to a reader), the other control characters go, then
 * each line-leading `[` is escaped as `\[` — still readable as what they wrote, never a header. Idempotent.
 */
export function neutraliseHeaderLookalikes(text: string): string {
  return stripControlCharacters(text.replace(otherLineBreakPattern, '\n')).replace(headerLookalikePattern, '$1\\[');
}

/**
 * @description What an answer to the agent's own question carries when somebody other than the operator gave it:
 * `(answered by topic member "Alice Smith" (@alice), not the operator)`. The agent's question is its way to ask the operator
 * before it acts, so an answer must say who chose it — a plain label would read as the operator's «yes».
 */
export function buildAnswerAttribution(senderDescription: string): string {
  return `(answered by ${senderDescription}, ${authorMarkTail})`;
}

/**
 * @description The chosen option label(s) of one question with the attribution after the last one — one per answer, so in a
 * question of several parts each part says who chose it. The agent (Claude's answers map, OpenCode's reply matrix) takes a
 * label that is no option as the answer's own text.
 */
export function getAnswerWithAttribution(labels: readonly string[], senderDescription: string): string[] {
  const attribution = buildAnswerAttribution(senderDescription);
  if (labels.length === 0) return [attribution];
  return labels.map((label, index) => (index === labels.length - 1 ? `${label} ${attribution}` : label));
}
