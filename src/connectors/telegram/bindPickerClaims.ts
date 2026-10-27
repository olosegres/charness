/**
 * Which `/bind` picker messages a bind has already claimed. A leaf module (no `bot.ts`, no environment), so a test can
 * reach it.
 */
import type { SessionKey } from '../../sessionKey';
import { buildMessageSnapshotKey } from './commands/callbackMessage';

/** How many claims are kept: the oldest is dropped past it, as a keyboard that old has long been out of reach. */
export const bindPickerClaimLimit = 200;

/**
 * The `/bind` picker is spent by the bind it leads to, and a bind takes seconds (the folder's facts are probed, the sends
 * are paced): a second tap on the same keyboard inside that time must not bind again. A handler claims the picker message
 * in the same synchronous step that decides to act, before its first await, so of two taps landing together exactly one wins;
 * a bind that is refused gives the claim back, and the picker works on.
 */
export class BindPickerClaims {
  private readonly claimed = new Set<string>();

  constructor(private readonly limit: number = bindPickerClaimLimit) {}

  /** @description Claim the picker message; `false` when a bind already holds it. */
  claim(key: SessionKey, messageId: number): boolean {
    const claimKey = buildMessageSnapshotKey(key, messageId);
    if (this.claimed.has(claimKey)) return false;
    this.claimed.add(claimKey);
    while (this.claimed.size > this.limit) {
      const oldest = this.claimed.values().next().value;
      if (oldest === undefined) break;
      this.claimed.delete(oldest);
    }
    return true;
  }

  /** @description Give a claim back: the bind it was for was refused, so the picker stays usable. */
  release(key: SessionKey, messageId: number): void {
    this.claimed.delete(buildMessageSnapshotKey(key, messageId));
  }
}
