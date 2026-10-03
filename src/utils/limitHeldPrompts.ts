/**
 * @description Prompts that arrived during an armed usage-limit wait (Jira plan
 * R23): posting them would only run into the limit again, so they are HELD and
 * delivered once nothing holds them any more. They are never dropped: they ride
 * the first prompt forwarded after the wait — its resume, the operator's next
 * message, a later post — or, when a new session starts with nothing to
 * forward, go to it on their own. The scheduler's fire and a tracker's request
 * share the hold through `postToSession`.
 */

/** Held per conversation at most; a scheduler firing all through a long wait must not flood the resume. */
export const limitHeldPromptsMax = 10;
/** Between two prompts delivered as one: each carries its own header. */
const heldPromptSeparator = '\n\n';

/**
 * @description `held` with `text` added, the oldest dropped past {@link limitHeldPromptsMax}.
 * A text already held is not added twice — a recurring job firing all through a
 * long wait runs once after it, like the scheduler's one catch-up for missed runs.
 */
export function getHeldPromptsWith(held: readonly string[], text: string): { held: string[]; droppedCount: number } {
  if (held.includes(text)) return { held: [...held], droppedCount: 0 };
  const next = [...held, text];
  const droppedCount = Math.max(0, next.length - limitHeldPromptsMax);
  return { held: next.slice(droppedCount), droppedCount };
}

/**
 * @description The forwarded `text` with the held prompts after it, in arrival
 * order — one message, so nothing can slip between them. A held copy of `text`
 * itself is not repeated: it is being delivered right now.
 */
export function getTextWithHeldPrompts(text: string, held: readonly string[]): string {
  return [text, ...held.filter((prompt) => prompt !== text)].join(heldPromptSeparator);
}

/**
 * @description The held prompts as one message, for a session that starts with
 * nothing else to forward; `null` when nothing is held.
 */
export function getHeldPromptsText(held: readonly string[]): string | null {
  return held.length > 0 ? held.join(heldPromptSeparator) : null;
}

/**
 * @description What the resume of a usage-limit wait forwards: the open
 * request's prompt when the agent never took it in (R21 — it arrived during the
 * wait, or its post failed), else the "continue" nudge, which resumes the turn
 * the limit interrupted. Held prompts are not part of it: they ride whichever is
 * forwarded. `isRequestPrompt` — the turn carries the request's prompt.
 */
export function getLimitResumeMessage(input: {
  continueNudge: string;
  untakenRequestPrompt: string | undefined;
}): { text: string; isRequestPrompt: boolean } {
  return input.untakenRequestPrompt === undefined
    ? { text: input.continueNudge, isRequestPrompt: false }
    : { text: input.untakenRequestPrompt, isRequestPrompt: true };
}
