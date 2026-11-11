/**
 * @description Pure helpers for the MESSAGE CONTEXT of a prompt — the agent-facing
 * blocks the bot glues ahead of the operator's text because of how the Telegram
 * message arrived: the author mark (`authorMark.ts`, who wrote it when that is not the
 * operator), the reply-quote block (`replyQuote.ts`, the message it
 * answers) and the forwarded mark (`forwardedMark.ts`, who first wrote it).
 *
 * The blocks ride the per-message body (like the `/timestamps` line), NOT the
 * once-per-change preamble marker. One fold rule ({@link getPromptWithMessageContext})
 * serves every route a prompt takes — the live forward (`forwardPromptToAgent`),
 * the startup buffer, a file or album announcement — so a spoken or captioned
 * message carries exactly what a typed one does.
 */

import { checkShouldSkipPreambleForText } from '../threadContextPreamble';

/** Separator between the context blocks, and between them and the prompt they lead. */
const messageContextSeparator = '\n\n';

/**
 * @name MessageContext
 * @description What a Telegram message carries besides its words: the `block` that leads the prompt (the author mark, the reply
 * quote, the forwarded mark), whether the message was FORWARDED, and who sent it when that is not the operator.
 * A forwarded message is content and never control input: its text starting with `/` is not a slash command, a bare digit in
 * it is not an answer, a phrase in it does not start an agent — see {@link checkIsSlashCommandPrompt}. A message of another
 * person is content too: whatever it says, it is not the operator's command.
 */
export interface MessageContext {
  block: string;
  isForwarded: boolean;
  /**
   * Who sent the message, as the agent reads it (`topic member "Alice Smith" (@alice)`), when the sender is not the operator;
   * absent for the operator's own messages. The request header names it too.
   */
  nonOperatorSender?: string;
}

/**
 * @description The blocks that apply to one message as one context block, in the
 * order given, or `undefined` when none does.
 */
export function joinMessageContextBlocks(blocks: ReadonlyArray<string | null | undefined>): string | undefined {
  const present = blocks.filter((block): block is string => !!block);
  return present.length > 0 ? present.join(messageContextSeparator) : undefined;
}

/**
 * @description Whether `text` is a slash command for the agent (`/compact`, `/clear`…): a control token that no block,
 * preamble or timestamp may be put ahead of. Never for a forwarded message, whose words are somebody else's: the mark
 * ahead of them is exactly what makes them plain text. Never for a message of a person who is not the operator either — a
 * backstop: such a slash text is refused before it gets here, and one that did slip through must reach the agent
 * marked, as plain words, never as the control token it would be unmarked.
 */
export function checkIsSlashCommandPrompt(text: string, context: MessageContext | undefined): boolean {
  return context?.isForwarded !== true && context?.nonOperatorSender === undefined && checkShouldSkipPreambleForText(text);
}

/**
 * @description Lead a prompt with its message-context block — the ONE folding
 * rule, shared by the live forward (`forwardPromptToAgent`) and a prompt buffered
 * behind a session start, whose replay forwards the buffered text as is: a reply
 * or a forward made while the agent boots must reach it exactly like one made after.
 *
 * The prompt is returned unchanged when there is no context, or when it is not an
 * agent prompt at all:
 *   - a slash command typed by the operator is a control token for the agent, which
 *     a block ahead of it would corrupt into plain text (a FORWARDED message is
 *     never one — {@link checkIsSlashCommandPrompt});
 *   - a terminal topic's input is a shell command line, and typed into a shell
 *     the block's `> ` lines run as redirections that overwrite a file named by
 *     the quote's first word. A message there never carries a block either.
 */
export function getPromptWithMessageContext(
  prompt: string,
  options: { context: MessageContext | undefined; isShellInput: boolean },
): string {
  const { context } = options;
  if (!context || options.isShellInput || checkIsSlashCommandPrompt(prompt, context)) return prompt;
  return `${context.block}${messageContextSeparator}${prompt}`;
}
