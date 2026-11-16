import type { ThreadSendOutcome } from './sendOutcome';

/**
 * @description The one-notice slots of a kind of pinned notice (the logged-out notice, the limit-resumed notice), by topic: the id
 * of the notice pinned this episode, or {@link pinnedNoticePendingSentinel} while its post is under way. A taken slot means the
 * notice was surfaced this episode, and the next event of the same episode posts no second one.
 */
export type PinnedNoticeSlots = Map<string, number>;

/**
 * @description What a slot holds between its reservation and the pin, so a burst of events cannot race two notices out. A real
 * Telegram message id is always positive, so `-1` can never collide with one.
 */
export const pinnedNoticePendingSentinel = -1;

/** @description The two Bot API moves of a pinned notice, bound to its topic and text by the bot. */
export interface PinnedNoticePorts {
  send: () => Promise<ThreadSendOutcome>;
  /** Pin the posted notice so the muted topic fires a notification. */
  pin: (messageId: number) => Promise<void>;
}

/**
 * @description Post and pin the notice of `topic` once per episode. The slot is reserved BEFORE the post, so a burst of events
 * posts one notice. A post that FAILED releases it — a later event of the episode tries again. A post whose outcome is unknown
 * keeps it: the notice may be in the topic, and a second one would be posted under it; its id is not known, so it is not pinned.
 * A slot released while the post was under way (a teardown) is not taken back, and the notice is left unpinned.
 */
export async function surfacePinnedNotice(slots: PinnedNoticeSlots, topic: string, ports: PinnedNoticePorts): Promise<void> {
  if (slots.has(topic)) return;
  slots.set(topic, pinnedNoticePendingSentinel);
  const outcome = await ports.send();
  if (outcome.kind === 'failed') {
    if (slots.get(topic) === pinnedNoticePendingSentinel) slots.delete(topic);
    return;
  }
  if (outcome.kind === 'unknown' || !slots.has(topic)) return;
  slots.set(topic, outcome.messageId);
  await ports.pin(outcome.messageId);
}

/**
 * @description End the episode of `topic`'s notice: free its slot, so a later episode notifies again, and give back the id of the
 * notice to unpin — `null` when none was pinned (no slot, or one whose pin never landed).
 */
export function releasePinnedNoticeSlot(slots: PinnedNoticeSlots, topic: string): number | null {
  const pinnedId = slots.get(topic);
  if (pinnedId === undefined) return null;
  slots.delete(topic);
  return pinnedId === pinnedNoticePendingSentinel ? null : pinnedId;
}
