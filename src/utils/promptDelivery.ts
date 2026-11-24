import { keyToString, type SessionKey } from '../sessionKey';
import { checkIsTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import type { BufferedPromptSettled, StartupPromptBuffer } from '../startupPromptBuffer';
import type { LostWorkTelling } from './lostWork';

/**
 * @name PromptDeliveryDeps
 * @description What {@link deliverPromptOrBuffer} acts through, every state read at the moment of the write. `forwardPrompt` says
 * where the forward put the prompt ({@link LatePromptOutcome}); `checkIsSessionActive` and `wakeSession` let a prompt that finds no
 * window and no live session wake the conversation first; `reportNoSession` runs when that wake found nothing (the person is told,
 * unless the wake already said why; a bot-made prompt is only logged); `checkIsRefusingMessages` — a command ends or replaces the
 * conversation now, so a person's prompt is not delivered at all — and `reportRefused`, which tells the person so (also when the wake
 * found the conversation ended by a release while it waited; a bot-made prompt is only logged); `announceQueued` tells the person their
 * prompt waits for the session to come up — a topic message, so it is only called for a Telegram conversation.
 */
export interface PromptDeliveryDeps {
  startupBuffer: Pick<StartupPromptBuffer, 'addPrompt' | 'checkIsStarting'>;
  forwardPrompt: (key: SessionKey, text: string, options: PromptDeliveryOptions) => Promise<LatePromptOutcome>;
  checkIsSessionActive: (key: SessionKey) => boolean;
  wakeSession: (key: SessionKey) => Promise<LateWakeResult>;
  checkIsRefusingMessages: (key: SessionKey) => boolean;
  reportNoSession: (key: SessionKey, isAlreadyTold: boolean, options: PromptDeliveryOptions) => Promise<void>;
  reportRefused: (key: SessionKey, options: PromptDeliveryOptions) => Promise<void>;
  announceQueued: (key: SessionKey) => Promise<void>;
}

/**
 * @name PromptDeliveryOptions
 * @description `isPersonInput` — a person typed, spoke or sent it (a topic's text, voice, file or album): its forward does not
 * wait for the write into the agent (the topic's update queue must not hang on it), and a write that fails is told to them.
 * Every other prompt — a wake-up, a scheduled run, a retry's nudge, a tracker's post — waits for it, buffered or not.
 * `isAccountsNoteCarrier` — the prompt starts a turn the person or the scheduler made (a person's message that opened a request, a
 * tracker's post, a scheduled run), so its forward may attach the accounts note (`limitNotes/`); kept with the prompt through a startup
 * buffer, and decorated at the replay with the figures of that moment.
 * `lostWorkTelling` — how a lost-work note that rides this prompt asks to tell about the loss (`LostWorkTelling`; a tracker fire whose
 * ridden request owes nothing, or with none open, asks `runHeader`: its header already says when to answer); kept through a startup
 * buffer as well.
 */
export interface PromptDeliveryOptions {
  isPersonInput?: boolean;
  isAccountsNoteCarrier?: boolean;
  lostWorkTelling?: LostWorkTelling;
}

/**
 * @name PromptDelivery
 * @description Where {@link deliverPromptOrBuffer} put the prompt: `forwarded` to the
 * session (done), `buffered` behind a session start (it waits in memory until the
 * start ends — see `onBufferedSettled`), or `noSession` — the forward found no session
 * left to take it (a prompt that waited for a bot restart's replay; the person was
 * told), so nothing will ever answer it: what the caller opened for it must not wait
 * for a turn.
 */
export type PromptDelivery = 'forwarded' | 'buffered' | 'noSession';

/**
 * @description Deliver `text` to a conversation's agent, routed at the MOMENT OF THE WRITE ({@link deliverLatePrompt}): a start's or a
 * stop's window open → buffered behind it (it replays in order once the session is up, exactly like a text typed during boot); a live
 * session → forwarded; no window and no live session → the conversation is woken first, then forwarded. The one "buffer-or-forward"
 * unit of every prompt that may meet a session another caller is starting or stopping: a person's prompt (`deliverPromptByState` in
 * `bot.ts`), a scheduled run, a tracker's post, the lost-work post, a retry's «continue», a move's first prompt.
 *
 * Nothing a caller read before an await decides it: a window that closed during the caller's awaits (its request opened, a file
 * downloaded) never takes the prompt. The buffer is read and added to in the same tick, so it never refuses a prompt here
 * ({@link StartupPromptBuffer.addPrompt} refuses a closed window); a refusal would be a bug and throws.
 *
 * The "queued while starting" notice is posted once per startup window, and only
 * for a Telegram conversation: a tracker issue has no topic to say it in (R6). It is
 * NOT awaited (a topic send through the process-wide pacer can take seconds): this
 * resolves `buffered` in the tick the buffer took the prompt, so a caller that watches
 * the prompt's turn does so before any replay can write it, and before the agent can
 * answer it (review 20 #2). The pacer keeps the notice's place in the topic.
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
  onBufferedSettled?: BufferedPromptSettled,
  options: PromptDeliveryOptions = {},
): Promise<PromptDelivery> {
  const threadId = keyToString(key);
  let isBuffered = false;
  const outcome = await deliverLatePrompt({
    checkIsWindowOpen: () => deps.startupBuffer.checkIsStarting(threadId),
    checkIsSessionActive: () => deps.checkIsSessionActive(key),
    // Only a person's prompt is refused while a command ends or replaces the conversation: a bot-made one is settled by its caller.
    ...(options.isPersonInput === true ? { checkIsRefused: () => deps.checkIsRefusingMessages(key) } : {}),
    buffer: async () => {
      // Called in the tick the window was read open (`deliverLatePrompt` awaits nothing between), so it cannot be refused.
      const added = deps.startupBuffer.addPrompt(threadId, text, onBufferedSettled, options);
      if (added === 'refused') throw new Error(`[promptDelivery] the startup buffer of ${threadId} refused a prompt in the tick its window read open`);
      isBuffered = true;
      if (added !== 'firstInWindow' || !checkIsTelegramKey(key)) return;
      // The prompt IS buffered by now (and its settle callback registered), so a notice that fails must not read as a delivery
      // that failed: a caller keeping something until the prompt reached a session would otherwise treat it as spent.
      deps.announceQueued(key).catch((err) => console.error(`[promptDelivery] queued notice for ${threadId} failed:`, err));
    },
    wake: () => deps.wakeSession(key),
    forward: () => deps.forwardPrompt(key, text, options),
    reportNoSession: (isAlreadyTold) => deps.reportNoSession(key, isAlreadyTold, options),
    reportRefused: () => deps.reportRefused(key, options),
  });
  if (isBuffered) return 'buffered';
  // A forward that re-routed the prompt behind a stop window itself registered no `onBufferedSettled`: it reads as forwarded.
  return outcome === 'noSession' ? 'noSession' : 'forwarded';
}

/**
 * @name LatePromptRoute
 * @description How a prompt decided on when it ARRIVED is delivered once its handler is ready to forward it:
 * `buffer` — a start or the idle stop is under way (its window is open: the prompt waits there, and the stop resumes the
 * session for it); `wake` — the process is gone meanwhile (the conversation sleeps: wake it, then forward); `forward`;
 * `drop` — only for a technical prompt that finds no live session without a window: nothing is done for it;
 * `refuse` — only for a person's prompt while a command ends or replaces the conversation: it is not delivered, and the person is told.
 */
export type LatePromptRoute = 'buffer' | 'wake' | 'forward' | 'drop' | 'refuse';

/**
 * @description The {@link LatePromptRoute} of a prompt, read at the moment it is forwarded. The idle stop posts a
 * re-asked question just before it stops the process, and a handler awaits between reading the session's state and the
 * forward (the tap's toast, the request it opens): written into a process being stopped the prompt was lost, and
 * into one already gone it was dropped. A person's prompt that meets a command ending or replacing the conversation
 * (`isRefused`) is refused, whatever the session reads as (`requests/README.md` § Turn starts, review 25 #1).
 *
 * A bot-made TECHNICAL prompt (the todo list's standalone reminder) is posted only into a live session that is idle at
 * this moment — never a resume, never held for a later one, never reported to the person: where a user's prompt would be
 * buffered or wake the conversation, it is dropped.
 */
export function getLatePromptRoute(input: { isWindowOpen: boolean; isSessionActive: boolean; isTechnical?: boolean; isRefused?: boolean }): LatePromptRoute {
  if (input.isTechnical === true) return input.isWindowOpen || !input.isSessionActive ? 'drop' : 'forward';
  // Ahead of any window: the window open now is the stop of the conversation the command ends, or the start of the one it begins — a
  // message for the first is lost with it, and one for the second would reach that agent ahead of what the command hands it first.
  if (input.isRefused === true) return 'refuse';
  if (input.isWindowOpen) return 'buffer';
  return input.isSessionActive ? 'forward' : 'wake';
}

/** @description What a wake did: whether a session is up to forward to, and whether it already told the topic something. */
export interface LateWakeResult {
  isAwake: boolean;
  /** The wake posted a notice of its own (a start that failed says why): the report adds none. */
  isNoticePosted: boolean;
  /**
   * The conversation was there when the wake began and gone once its turn in the queue came: a release queued ahead ended it, so nothing
   * was started (review 25 #2). Reported as the release's refusal, not as a conversation that was never there.
   */
  isEnded?: boolean;
}

/**
 * @name LatePromptDeliveryPorts
 * @description What {@link deliverLatePrompt} acts through, for one prompt: the session's state read NOW, and the three
 * ways out. `reportNoSession` runs when the wake found nothing to resume (the ids released, the topic unbound, a start
 * that failed): it closes what the prompt opened and tells the person, as the arrival-time paths do — unless the wake
 * already said why (`isAlreadyTold`), where a second, generic line would contradict it.
 */
export interface LatePromptDeliveryPorts {
  /** A bot-made technical prompt: dropped, not buffered or woken for, where a session is not live (see {@link getLatePromptRoute}). */
  isTechnical?: boolean;
  checkIsWindowOpen: () => boolean;
  checkIsSessionActive: () => boolean;
  /** A person's prompt only: whether a command ends or replaces the conversation now (absent: never refused). */
  checkIsRefused?: () => boolean;
  buffer: () => Promise<void>;
  wake: () => Promise<LateWakeResult>;
  /** Where the forward put the prompt: `forwarded`, or what a forward that routes it again itself (a prompt that waited for an adopt replay) ended in — passed on as the answer. */
  forward: () => Promise<LatePromptOutcome>;
  reportNoSession: (isAlreadyTold: boolean) => Promise<void>;
  /**
   * The prompt was refused (a command ends or replaces the conversation), or its wake found the conversation ended by a release while it
   * waited: the person is told the command's line; whatever the prompt opened is closed by its caller (`noSession`). Absent: reported as
   * no session.
   */
  reportRefused?: () => Promise<void>;
}

/**
 * @description Where {@link deliverLatePrompt} put the prompt; `noSession` — nowhere: nothing to deliver it to (the wake found
 * nothing to resume, or the forward itself ended so); `dropped` — a technical prompt that found no live session, left alone
 * on purpose (nothing buffered, woken or said).
 */
export type LatePromptOutcome = 'buffered' | 'forwarded' | 'noSession' | 'dropped';

/**
 * How many times one prompt may wake its conversation: a wake awaits (its start, the notice it posts), and the session it brought up
 * may be stopping again, or gone, by the time it resolves — the prompt is then routed once more, and woken for at most once more.
 */
const latePromptMaxWakes = 2;

/**
 * @description Deliver a prompt whose handler decided, when it arrived, that the session is live — routed again by
 * {@link getLatePromptRoute} now, after the handler's awaits. A wake that finds nothing never forwards: the forward
 * would show the topic as working while the adapter drops the text. A wake that brought a session up is followed by
 * one more routing by the state at that moment, never a blind forward: during its awaits (a fresh start's notice is a
 * paced topic send) a prompt it replayed can end its turn and the per-turn stop open its window — a prompt written
 * into that stopping process would be lost (review 19 nit 2).
 */
export function deliverLatePrompt(ports: LatePromptDeliveryPorts): Promise<LatePromptOutcome> {
  return routeLatePrompt(ports, latePromptMaxWakes);
}

async function routeLatePrompt(ports: LatePromptDeliveryPorts, wakesLeft: number): Promise<LatePromptOutcome> {
  const route = getLatePromptRoute({
    isWindowOpen: ports.checkIsWindowOpen(),
    isSessionActive: ports.checkIsSessionActive(),
    isTechnical: ports.isTechnical,
    isRefused: ports.checkIsRefused?.() === true,
  });
  if (route === 'drop') return 'dropped';
  if (route === 'refuse') return reportRefused(ports);
  if (route === 'buffer') {
    await ports.buffer();
    return 'buffered';
  }
  if (route === 'forward') return ports.forward();
  if (wakesLeft === 0) {
    await ports.reportNoSession(false);
    return 'noSession';
  }
  const wake = await ports.wake();
  if (wake.isEnded === true) return reportRefused(ports);
  if (!wake.isAwake) {
    await ports.reportNoSession(wake.isNoticePosted);
    return 'noSession';
  }
  return routeLatePrompt(ports, wakesLeft - 1);
}

async function reportRefused(ports: LatePromptDeliveryPorts): Promise<LatePromptOutcome> {
  await (ports.reportRefused ? ports.reportRefused() : ports.reportNoSession(false));
  return 'noSession';
}
