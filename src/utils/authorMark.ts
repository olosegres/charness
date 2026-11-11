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
