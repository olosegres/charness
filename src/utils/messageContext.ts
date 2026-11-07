/**
 * @description Pure helpers for the MESSAGE CONTEXT of a prompt — the agent-facing
 * blocks the bot glues ahead of the operator's text because of how the Telegram
 * message arrived: the reply-quote block (`replyQuote.ts`, the message it
 * answers) and the forwarded mark (`forwardedMark.ts`, who first wrote it).
 *
 * The blocks ride the per-message body (like the `/timestamps` line), NOT the
 * once-per-change preamble marker. One fold rule ({@link getPromptWithMessageContext})
 * serves every route a prompt takes — the live forward (`forwardPromptToAgent`),
 * the startup buffer, a file or album announcement — so a spoken or captioned
 * message carries exactly what a typed one does.
 */

/** Separator between the context blocks, and between them and the prompt they lead. */
const messageContextSeparator = '\n\n';

/**
 * @description The blocks that apply to one message as one context block, in the
 * order given, or `undefined` when none does.
 */
export function joinMessageContextBlocks(blocks: ReadonlyArray<string | null | undefined>): string | undefined {
  const present = blocks.filter((block): block is string => !!block);
  return present.length > 0 ? present.join(messageContextSeparator) : undefined;
}

/**
 * @description Lead a prompt with its message-context block — the ONE folding
 * rule, shared by the live forward (`forwardPromptToAgent`) and a prompt buffered
 * behind a session start, whose replay forwards the buffered text as is: a reply
 * or a forward made while the agent boots must reach it exactly like one made after.
 *
 * The prompt is returned unchanged when there is no block, or when it is not an
 * agent prompt at all:
 *   - a slash command is a control token for the agent, which a block ahead of
 *     it would corrupt into plain text (`isSlashCommand` classifies the user's
 *     own text — the caller may have extended it, held prompts ride after it);
 *   - a terminal topic's input is a shell command line, and typed into a shell
 *     the block's `> ` lines run as redirections that overwrite a file named by
 *     the quote's first word. A message there never carries a block either.
 */
export function getPromptWithMessageContext(
  prompt: string,
  context: { block: string | undefined; isSlashCommand: boolean; isShellInput: boolean },
): string {
  if (!context.block || context.isSlashCommand || context.isShellInput) return prompt;
  return `${context.block}${messageContextSeparator}${prompt}`;
}
