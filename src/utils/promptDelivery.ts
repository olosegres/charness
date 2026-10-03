import { keyToString, type SessionKey } from '../sessionKey';
import { checkIsTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import type { BufferedPromptSettled, StartupPromptBuffer } from '../startupPromptBuffer';

/**
 * @name PromptDeliveryDeps
 * @description What {@link deliverPromptOrBuffer} acts through. `announceQueued`
 * tells the person their prompt waits for the session to come up — a topic
 * message, so it is only called for a Telegram conversation.
 */
export interface PromptDeliveryDeps {
  startupBuffer: Pick<StartupPromptBuffer, 'addPrompt'>;
  forwardPrompt: (key: SessionKey, text: string) => Promise<void>;
  announceQueued: (key: SessionKey) => Promise<void>;
}

/**
 * @name PromptDelivery
 * @description Where {@link deliverPromptOrBuffer} put the prompt: `forwarded` to the
 * session (done), or `buffered` behind a session start (it waits in memory until the
 * start ends — see `onBufferedSettled`).
 */
export type PromptDelivery = 'forwarded' | 'buffered';

/**
 * @description Deliver `text` to a conversation's agent while honouring the startup
 * window: mid-startup the prompt is buffered (it replays in order once the session
 * is up, exactly like a text typed during boot); otherwise it is forwarded at once.
 * The one "buffer-or-forward" unit shared by the text and voice handlers' mid-startup
 * buffering, file/album intake, `/schedule`, the Jira connector's posts and an
 * API-error retry's "continue" nudge — the last two reach it with a session another
 * caller's start may still be bringing up, where a direct forward would hit an
 * adapter that is not there yet.
 *
 * `isStarting` is passed in (not read here) because the album collector captures
 * it AT FLUSH TIME — a session that finished booting mid-burst must forward, not
 * buffer.
 *
 * The "queued while starting" notice is posted once per startup window, and only
 * for a Telegram conversation: a tracker issue has no topic to say it in (R6).
 *
 * A buffered prompt lives in memory, so a restart before the start ends loses it.
 * A caller that must know how the wait ended — to keep what would re-send the prompt
 * until it reached a session — passes `onBufferedSettled`; it is called once, only
 * for a prompt that was buffered (a forwarded one is already done when this resolves).
 * A failed "queued" notice is logged and does not change the answer: the prompt was
 * buffered before the notice went out.
 */
export async function deliverPromptOrBuffer(
  deps: PromptDeliveryDeps,
  key: SessionKey,
  text: string,
  isStarting: boolean,
  onBufferedSettled?: BufferedPromptSettled,
): Promise<PromptDelivery> {
  if (!isStarting) {
    await deps.forwardPrompt(key, text);
    return 'forwarded';
  }
  const isFirstBuffered = deps.startupBuffer.addPrompt(keyToString(key), text, onBufferedSettled);
  if (isFirstBuffered && checkIsTelegramKey(key)) {
    // The prompt IS buffered by now (and its settle callback registered), so a notice that fails must not
    // read as a delivery that failed: a caller keeping something until the prompt reached a session would
    // otherwise treat the buffered prompt as spent.
    try {
      await deps.announceQueued(key);
    } catch (err) {
      console.error(`[promptDelivery] queued notice for ${keyToString(key)} failed:`, err);
    }
  }
  return 'buffered';
}
