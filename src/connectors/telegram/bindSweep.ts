/**
 * The sweep that closes the open `/bind` messages of a topic once it is bound or has left its folder, written over ports so a
 * test can reach it: the Telegram calls and the claim list are the caller's. A leaf module (no `bot.ts`, no environment).
 */
import { keyboardStripsPerSweepLimit, splitByDeleteWindow, type OpenBindMessage } from './openBindMessages';

/** What a sweep does to the messages of ONE topic. */
export interface BindSweepPorts {
  /** Hold a picker message: a tap on it is refused until {@link BindSweepPorts.unretire} (`BindPickerClaims.retire`). */
  retire: (messageId: number) => void;
  /** Let go of a message that has nothing left to tap (`BindPickerClaims.unretire`). */
  unretire: (messageId: number) => void;
  /** ONE bulk delete; `false` when Telegram refused the call. */
  deleteMessages: (messageIds: readonly number[]) => Promise<boolean>;
  /** Remove one message's keyboard; `false` when the edit failed. */
  removeKeyboard: (messageId: number) => Promise<boolean>;
}

/**
 * @description Remove the keyboards of messages that can no longer be deleted or must stay as history, the newest
 * `keyboardStripsPerSweepLimit` of them (`messageIds` oldest first: the newest sit nearest the bottom of the topic): each strip
 * is a paced send of the bot's one global gate. Resolves the ids whose keyboard is gone — the older rest and every failed edit
 * still carry theirs.
 */
export async function stripStaleKeyboards(
  messageIds: readonly number[],
  removeKeyboard: (messageId: number) => Promise<boolean>,
): Promise<number[]> {
  const strippedMessageIds: number[] = [];
  for (const messageId of messageIds.slice(-keyboardStripsPerSweepLimit)) {
    if (await removeKeyboard(messageId)) strippedMessageIds.push(messageId);
  }
  return strippedMessageIds;
}

/**
 * @description Close `entries`, the messages a topic had open. Every one is held FIRST, before the first await, so a tap on it is
 * refused whatever becomes of its message; the hold is let go of for the ones with nothing left to tap — deleted by the bulk
 * call, or stripped of their buttons. A message too old for Telegram to delete loses its buttons instead, and so does every one
 * of a bulk call Telegram refused (no delete per picker: two paced sends each) — only the newest
 * `keyboardStripsPerSweepLimit` of them; the older rest and any failed edit keep their buttons, and with them the hold.
 */
export async function sweepOpenBindMessages(entries: readonly OpenBindMessage[], nowMs: number, ports: BindSweepPorts): Promise<void> {
  for (const { messageId } of entries) ports.retire(messageId);
  const releaseAll = (messageIds: readonly number[]): void => {
    for (const messageId of messageIds) ports.unretire(messageId);
  };
  const { deletable, tooOld } = splitByDeleteWindow(entries, nowMs);
  if (deletable.length > 0) {
    if (await ports.deleteMessages(deletable)) releaseAll(deletable);
    else releaseAll(await stripStaleKeyboards(deletable, ports.removeKeyboard));
  }
  releaseAll(await stripStaleKeyboards(tooOld, ports.removeKeyboard));
}
