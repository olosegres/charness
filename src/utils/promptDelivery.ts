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

/**
 * @name LatePromptRoute
 * @description How a prompt decided on when it ARRIVED is delivered once its handler is ready to forward it:
 * `buffer` — a start or the idle stop is under way (its window is open: the prompt waits there, and the stop resumes the
 * session for it); `wake` — the process is gone meanwhile (the conversation sleeps: wake it, then forward); `forward`.
 */
export type LatePromptRoute = 'buffer' | 'wake' | 'forward';

/**
 * @description The {@link LatePromptRoute} of a prompt, read at the moment it is forwarded. The idle stop posts a
 * re-asked question just before it stops the process, and a handler awaits between reading the session's state and the
 * forward (the tap's toast, the request it opens): written into a process being stopped the prompt was lost, and
 * into one already gone it was dropped.
 */
export function getLatePromptRoute(input: { isWindowOpen: boolean; isSessionActive: boolean }): LatePromptRoute {
  if (input.isWindowOpen) return 'buffer';
  return input.isSessionActive ? 'forward' : 'wake';
}

/** @description What a wake did: whether a session is up to forward to, and whether it already told the topic something. */
export interface LateWakeResult {
  isAwake: boolean;
  /** The wake posted a notice of its own (a start that failed says why): the report adds none. */
  isNoticePosted: boolean;
}

/**
 * @name LatePromptDeliveryPorts
 * @description What {@link deliverLatePrompt} acts through, for one prompt: the session's state read NOW, and the three
 * ways out. `reportNoSession` runs when the wake found nothing to resume (the ids released, the topic unbound, a start
 * that failed): it closes what the prompt opened and tells the person, as the arrival-time paths do — unless the wake
 * already said why (`isAlreadyTold`), where a second, generic line would contradict it.
 */
export interface LatePromptDeliveryPorts {
  checkIsWindowOpen: () => boolean;
  checkIsSessionActive: () => boolean;
  buffer: () => Promise<void>;
  wake: () => Promise<LateWakeResult>;
  forward: () => Promise<void>;
  reportNoSession: (isAlreadyTold: boolean) => Promise<void>;
}

/** @description Where {@link deliverLatePrompt} put the prompt; `noSession` — nowhere: nothing to deliver it to. */
export type LatePromptOutcome = 'buffered' | 'forwarded' | 'noSession';

/**
 * @description Deliver a prompt whose handler decided, when it arrived, that the session is live — routed again by
 * {@link getLatePromptRoute} now, after the handler's awaits. A wake that finds nothing never forwards: the forward
 * would show the topic as working while the adapter drops the text.
 */
export async function deliverLatePrompt(ports: LatePromptDeliveryPorts): Promise<LatePromptOutcome> {
  const route = getLatePromptRoute({ isWindowOpen: ports.checkIsWindowOpen(), isSessionActive: ports.checkIsSessionActive() });
  if (route === 'buffer') {
    await ports.buffer();
    return 'buffered';
  }
  if (route === 'wake') {
    const wake = await ports.wake();
    if (!wake.isAwake) {
      await ports.reportNoSession(wake.isNoticePosted);
      return 'noSession';
    }
  }
  await ports.forward();
  return 'forwarded';
}
