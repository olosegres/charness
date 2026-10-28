/**
 * Which `/bind` picker messages a bind has already claimed. A leaf module (no `bot.ts`, no environment), so a test can
 * reach it.
 */
import type { SessionKey } from '../../sessionKey';
import { buildMessageSnapshotKey } from './commands/callbackMessage';

/** How many claims are kept: the oldest is dropped past it, as a keyboard that old has long been out of reach. */
export const bindPickerClaimLimit = 200;

/**
 * The `/bind` picker is spent by the bind (or the leave) it leads to, and a bind takes seconds (the folder's facts are probed, the sends
 * are paced): a second tap on the same keyboard inside that time must not bind again. A handler claims the picker message
 * in the same synchronous step that decides to act, before its first await, so of two taps landing together exactly one wins;
 * a bind that is refused gives the claim back, and the picker works on.
 */
export class BindPickerClaims {
  private readonly claimed = new Set<string>();
  /** The messages {@link retire} holds until {@link unretire}; not subject to the limit. */
  private readonly retired = new Set<string>();

  constructor(private readonly limit: number = bindPickerClaimLimit) {}

  /** @description Claim the picker message; `false` when a bind already holds it. */
  claim(key: SessionKey, messageId: number): boolean {
    const claimKey = buildMessageSnapshotKey(key, messageId);
    if (this.claimed.has(claimKey) || this.retired.has(claimKey)) return false;
    this.claimed.add(claimKey);
    while (this.claimed.size > this.limit) {
      const oldest = this.claimed.values().next().value;
      if (oldest === undefined) break;
      this.claimed.delete(oldest);
    }
    return true;
  }

  /** @description Whether a bind (or a leave) holds the picker message: nothing else may act on it. */
  has(key: SessionKey, messageId: number): boolean {
    const claimKey = buildMessageSnapshotKey(key, messageId);
    return this.claimed.has(claimKey) || this.retired.has(claimKey);
  }

  /**
   * @description Hold the picker message outside the limit, until {@link unretire}: the sweep that closes a topic's open pickers
   * takes dozens at once, which must neither push a tap's claim out of the limited list (a second tap would then bind again)
   * nor be pushed out by newer claims (a picker that keeps its buttons — too old to delete, past the strip bound — has nothing
   * else between a stale tap and a rebind). The hold lasts as long as the process: a restart forgets it, and a picker still
   * carrying buttons then works again.
   */
  retire(key: SessionKey, messageId: number): void {
    this.retired.add(buildMessageSnapshotKey(key, messageId));
  }

  /** @description Let go of a {@link retire}d message that is gone: nobody can tap it, and the hold would only grow. */
  unretire(key: SessionKey, messageId: number): void {
    this.retired.delete(buildMessageSnapshotKey(key, messageId));
  }

  /** @description Give a claim back: the bind it was for was refused, so the picker stays usable. */
  release(key: SessionKey, messageId: number): void {
    this.claimed.delete(buildMessageSnapshotKey(key, messageId));
  }

  /**
   * @description Run `work` holding the picker message. `'busy'`: a bind already holds it, `work` did not run. `'done'`: `work`
   * resolved `true` — it did what the tap asked, and the picker stays claimed (it is spent). `'undone'`: it resolved `false`
   * (a refused bind), or threw — the claim goes back and the picker works on, so nothing between the claim and a finished
   * bind can leave it held for a bind that never happened. The claim is taken before the first await: call this straight
   * from the handler, with no await in front of it. `messageId` is `null` for a tap Telegram attached no message to: the
   * work runs, with nothing to claim.
   */
  async runClaimed(key: SessionKey, messageId: number | null, work: () => Promise<boolean>): Promise<'busy' | 'done' | 'undone'> {
    if (messageId === null) return (await work()) ? 'done' : 'undone';
    if (!this.claim(key, messageId)) return 'busy';
    let isDone = false;
    try {
      isDone = await work();
      return isDone ? 'done' : 'undone';
    } finally {
      if (!isDone) this.release(key, messageId);
    }
  }
}
