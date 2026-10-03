/**
 * @description Prompts that arrived during an armed usage-limit wait (Jira plan
 * R23): posting them would only run into the limit again, so they are HELD on the
 * armed wait and delivered when it resumes — in place of the "continue" nudge,
 * which would resume older work first. The scheduler's fire and a tracker's
 * request share the rule through `postToSession`.
 */

/** Held per conversation at most; a scheduler firing all through a long wait must not flood the resume. */
export const limitHeldPromptsMax = 10;
/** Between two held prompts delivered as one: each carries its own header. */
const heldPromptSeparator = '\n\n';

/** @description `held` with `text` added, the oldest dropped past {@link limitHeldPromptsMax}. */
export function getHeldPromptsWith(held: readonly string[], text: string): { held: string[]; droppedCount: number } {
  const next = [...held, text];
  const droppedCount = Math.max(0, next.length - limitHeldPromptsMax);
  return { held: next.slice(droppedCount), droppedCount };
}

/**
 * @description What the resume of a usage-limit wait forwards: the held prompts
 * as one message, else the "continue" nudge. `isRequestPrompt` — the open
 * request's own prompt is among them, so its turn counts as carrying it (R21).
 */
export function getLimitResumeMessage(input: {
  heldPrompts: readonly string[];
  continueNudge: string;
  openRequestPrompt: string | undefined;
}): { text: string; isRequestPrompt: boolean } {
  if (input.heldPrompts.length === 0) return { text: input.continueNudge, isRequestPrompt: false };
  return {
    text: input.heldPrompts.join(heldPromptSeparator),
    isRequestPrompt: input.openRequestPrompt !== undefined && input.heldPrompts.includes(input.openRequestPrompt),
  };
}
