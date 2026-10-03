import { keyToString, type SessionKey } from '../sessionKey';
import { checkIsTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import type { StartupPromptBuffer } from '../startupPromptBuffer';

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
 */
export async function deliverPromptOrBuffer(
  deps: PromptDeliveryDeps,
  key: SessionKey,
  text: string,
  isStarting: boolean,
): Promise<void> {
  if (!isStarting) {
    await deps.forwardPrompt(key, text);
    return;
  }
  const isFirstBuffered = deps.startupBuffer.addPrompt(keyToString(key), text);
  if (isFirstBuffered && checkIsTelegramKey(key)) await deps.announceQueued(key);
}
