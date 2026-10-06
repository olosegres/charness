/**
 * @description Pure helpers for the reply-quote context block — the agent-facing
 * `[Replying to an earlier message …]` snippet the bot glues ahead of a prompt
 * when the operator uses Telegram's REPLY feature on a message in a bound,
 * agent-active topic.
 *
 * The block is plain English (agent-facing, NOT i18n) and mirrors the
 * thread-context preamble in shape: the bot just prepends it to the prompt body
 * ({@link getPromptWithReplyQuote}) in `forwardPromptToAgent`, the single choke
 * point for direct texts and voice transcripts, and in the startup buffering of
 * both. It rides the per-message body (like the `/timestamps` line), NOT the
 * once-per-change preamble marker.
 *
 * These helpers take STRUCTURAL input (no telegraf imports) so they are fully
 * unit-testable; the bridge that reads a real telegraf message lives in the
 * Telegram connector (`getTelegramReplyQuoteBlock`).
 */

/**
 * Max length of the quoted content folded into the prompt. A very long replied-to
 * message (e.g. a big agent answer) would otherwise dominate the prompt; we cap
 * it and mark the truncation so the agent knows the quote is partial.
 */
export const replyQuoteMaxChars = 4000;

/** Header prefix of the injected block — recognisable, agent-facing English. */
const replyQuoteHeaderPrefix = '[Replying to an earlier message · from: ';

/** Marker appended when the quoted content is truncated to the cap. */
const replyQuoteTruncationMarker = '… [truncated]';

/** Prefix applied to every line of the quoted content (markdown blockquote). */
const replyQuoteLinePrefix = '> ';

/** Separator between the block and the prompt it leads. */
const replyQuotePromptSeparator = '\n\n';

/**
 * @description Structural inputs for {@link extractReplyQuote}, distilled from a
 * telegraf message by the Telegram connector so this module never imports telegraf.
 */
export interface ReplyQuoteSource {
  /** `ctx.message.quote?.text` — the part the operator highlighted (partial quote). */
  manualQuoteText?: string;
  /** `reply_to_message.text` — the replied-to text message body. */
  replyText?: string;
  /** `reply_to_message.caption` — the replied-to media message caption. */
  replyCaption?: string;
  /** `reply_to_message.message_id`. */
  replyMessageId?: number;
  /** `ctx.message.message_thread_id` — undefined/0 outside a forum topic (e.g. a DM). */
  topicRootId?: number;
  /** Whether the replied-to message is a forum/service message (no real content). */
  isServiceMessage: boolean;
  /** Whether the replied-to message is the bot's own (`reply_to_message.from?.id === bot.botInfo.id`). */
  fromBot: boolean;
}

/** The resolved quote: the content to render plus who authored it. */
export interface ExtractedReplyQuote {
  quotedText: string;
  fromBot: boolean;
}

/**
 * @description Decide whether a genuine reply carries quotable content and, if
 * so, extract it.
 *
 * Returns `null` (the reply is silently ignored, prompt forwarded as-is) when:
 *   - there is no source;
 *   - the replied-to message is a forum/service message (conveys nothing);
 *   - the reply targets the forum topic-root message
 *     (`topicRootId && replyMessageId === topicRootId`) — replying to the topic
 *     root is Telegram's "post in this topic", not a genuine quote;
 *   - none of the three content candidates has non-empty text after trimming.
 *
 * Otherwise `quotedText` is the first non-empty of the manual (highlighted)
 * quote, the replied-to text, then the caption — the highlighted part wins
 * because it is the specific thing the operator pointed at.
 */
export function extractReplyQuote(source: ReplyQuoteSource | undefined): ExtractedReplyQuote | null {
  if (!source) return null;
  if (source.isServiceMessage) return null;

  const { topicRootId, replyMessageId } = source;
  if (topicRootId !== undefined && topicRootId !== 0 && replyMessageId === topicRootId) {
    return null;
  }

  const candidates = [source.manualQuoteText, source.replyText, source.replyCaption];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return { quotedText: trimmed, fromBot: source.fromBot };
  }
  return null;
}

/**
 * @description Render the extracted quote as the injectable block, or `null`
 * when there is no quote. The content is capped at {@link replyQuoteMaxChars}
 * (with a truncation marker) BEFORE each line is prefixed with `> `, so the cap
 * counts real content, not the prefixes.
 */
export function buildReplyQuoteBlock(quote: ExtractedReplyQuote | null): string | null {
  if (!quote) return null;

  let content = quote.quotedText;
  if (content.length > replyQuoteMaxChars) {
    content = `${content.slice(0, replyQuoteMaxChars)}${replyQuoteTruncationMarker}`;
  }

  const header = `${replyQuoteHeaderPrefix}${quote.fromBot ? 'assistant' : 'user'}]`;
  const quotedLines = content.split('\n').map((line) => `${replyQuoteLinePrefix}${line}`);
  return [header, ...quotedLines].join('\n');
}

/**
 * @description Lead a prompt with its reply-quote block — the ONE folding rule,
 * shared by the live forward (`forwardPromptToAgent`) and a prompt buffered
 * behind a session start, whose replay forwards the buffered text as is: a reply
 * made while the agent boots must reach it exactly like one made after.
 *
 * The prompt is returned unchanged when there is no block, or when it is not an
 * agent prompt at all:
 *   - a slash command is a control token for the agent, which a block ahead of
 *     it would corrupt into plain text (`isSlashCommand` classifies the user's
 *     own text — the caller may have extended it, held prompts ride after it);
 *   - a terminal topic's input is a shell command line, and typed into a shell
 *     the block's `> ` lines run as redirections that overwrite a file named by
 *     the quote's first word. A typed reply there never carries a block either.
 */
export function getPromptWithReplyQuote(
  prompt: string,
  quote: { block: string | undefined; isSlashCommand: boolean; isShellInput: boolean },
): string {
  if (!quote.block || quote.isSlashCommand || quote.isShellInput) return prompt;
  return `${quote.block}${replyQuotePromptSeparator}${prompt}`;
}
