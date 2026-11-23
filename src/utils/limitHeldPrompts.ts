/**
 * @description Prompts that arrived during an armed usage-limit wait (Jira plan
 * R23): posting them would only run into the limit again, so they are HELD and
 * delivered once nothing holds them any more. They are never dropped: they ride
 * the first prompt forwarded after the wait — its resume, the operator's next
 * message, a later post — or, when a new session starts with nothing to
 * forward, go to it on their own. The scheduler's fire and a tracker's request
 * share the hold through `postToSession`.
 */

import type { PromptsNotTakenIn } from '../requests/requestHeader';

/** Held per conversation at most; a scheduler firing all through a long wait must not flood the resume. */
export const limitHeldPromptsMax = 10;
/** Between two prompts delivered as one: each carries its own header. */
const heldPromptSeparator = '\n\n';
/**
 * The line that opens the held prompts after a message's own text. The message may be a forwarded one, whose mark has no end: without a
 * line of their own the scheduled runs below would read as the rest of the forwarded words.
 */
export const heldPromptsHeader = '[Held over the usage-limit wait — not part of the message above]';

/**
 * @name LimitHeldPrompt
 * @description A prompt held over a usage-limit wait. `text` is the prompt as it
 * is posted at once — two holds of the same `text` are the same run; `heldText`,
 * when it differs, is what the prompt says once it arrives late (R27: a scheduled
 * run names when it was due).
 */
export interface LimitHeldPrompt {
  text: string;
  heldText?: string;
}

/** What a held prompt says when it is finally delivered. */
function getDeliveredText(prompt: LimitHeldPrompt): string {
  return prompt.heldText ?? prompt.text;
}

/**
 * @description `held` with `prompt` added, the oldest dropped past {@link limitHeldPromptsMax}.
 * A prompt whose `text` is already held is not added again — a recurring job
 * firing all through a long wait runs once after it, like the scheduler's one
 * catch-up for missed runs, and says when it was FIRST due, as the catch-up does.
 */
export function getHeldPromptsWith(
  held: readonly LimitHeldPrompt[],
  prompt: LimitHeldPrompt,
): { held: LimitHeldPrompt[]; droppedCount: number } {
  if (held.some((heldPrompt) => heldPrompt.text === prompt.text)) return { held: [...held], droppedCount: 0 };
  const next = [...held, prompt];
  const droppedCount = Math.max(0, next.length - limitHeldPromptsMax);
  return { held: next.slice(droppedCount), droppedCount };
}

/**
 * @description The forwarded `text` with the held prompts after it, in arrival
 * order — one message, so nothing can slip between them — under a line of their
 * own ({@link heldPromptsHeader}), so they never read as part of `text`. A held
 * copy of `text` itself is not repeated: it is being delivered right now.
 */
export function getTextWithHeldPrompts(text: string, held: readonly LimitHeldPrompt[]): string {
  const heldTexts = held.filter((prompt) => prompt.text !== text).map(getDeliveredText);
  return heldTexts.length === 0 ? text : [text, heldPromptsHeader, ...heldTexts].join(heldPromptSeparator);
}

/**
 * @description The held prompts as one message, for a session that starts with
 * nothing else to forward; `null` when nothing is held.
 */
export function getHeldPromptsText(held: readonly LimitHeldPrompt[]): string | null {
  return held.length > 0 ? held.map(getDeliveredText).join(heldPromptSeparator) : null;
}

/**
 * @name LimitResumeMessage
 * @description What a resume forwards, and the requests whose own prompts it carries (`carriedRequestIds`, named as it is built:
 * empty for the plain «continue» nudge and for a context bridge).
 */
export interface LimitResumeMessage {
  text: string;
  carriedRequestIds: readonly string[];
}

/**
 * @description What the resume of a usage-limit wait forwards: the open
 * requests' prompts when the agent never took them in (R21 — they arrived during
 * the wait, or their post failed), else the "continue" nudge, which resumes the
 * turn the limit interrupted. Held prompts are not part of it: they ride whichever
 * is forwarded.
 */
export function getLimitResumeMessage(input: {
  continueNudge: string;
  untakenRequestPrompts: PromptsNotTakenIn | undefined;
}): LimitResumeMessage {
  return input.untakenRequestPrompts === undefined
    ? { text: input.continueNudge, carriedRequestIds: [] }
    : { text: input.untakenRequestPrompts.text, carriedRequestIds: input.untakenRequestPrompts.requestIds };
}
