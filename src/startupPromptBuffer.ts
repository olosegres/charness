import type { PromptDeliveryOptions } from './utils/promptDelivery';

/**
 * @name BufferedPromptOutcome
 * @description How a buffered prompt's wait ended. `replayed`: it was handed to the
 * session. `dropped`: it never reached the agent — the start failed, the session is
 * not active once the window closes, or its forward threw (its write into the agent
 * failed): a sender that keeps something until the prompt arrived keeps it.
 */
export type BufferedPromptOutcome = 'replayed' | 'dropped';

/** Called once, when a buffered prompt's wait ends. */
export type BufferedPromptSettled = (outcome: BufferedPromptOutcome) => void;

interface BufferedPrompt {
  text: string;
  onSettled?: BufferedPromptSettled;
  /**
   * How it is forwarded at the replay, as it was buffered (`PromptDeliveryOptions`): a person's own does not wait for its write, a
   * carrier of the accounts note is decorated with the figures of that moment, a lost-work note riding it may be told optional.
   */
  options: PromptDeliveryOptions;
}

/** What {@link StartupPromptBuffer.replayPrompts} replays through. */
export interface ReplayPromptsOptions {
  /** Whether the session is up now; `false` drops every buffered prompt. */
  isSessionActive: boolean;
  /** Hand one prompt to the live session, with the options it was buffered with. */
  forward: (text: string, options: PromptDeliveryOptions) => Promise<void>;
  /**
   * Written after the buffered prompts, still inside the replay (only into a live session): what the start carries besides them — the
   * bot's prompts held over a usage-limit wait. A throw rejects the replay, which still ends.
   */
  afterReplay?: () => Promise<void>;
}

/** A callback that throws must not break the replay or the failed-start path that called it. */
function settleBufferedPrompt(prompt: BufferedPrompt, outcome: BufferedPromptOutcome): void {
  try {
    prompt.onSettled?.(outcome);
  } catch (err) {
    console.error('[startupPromptBuffer] a settle callback threw:', err);
  }
}

/** @description What {@link StartupPromptBuffer.addPrompt} did with a prompt. */
export type PromptBufferAddResult = 'refused' | 'firstInWindow' | 'added';

/**
 * @description FIFO buffer for prompts typed while an agent session is still
 * starting up.
 *
 * Both backends have a startup window where the session is not yet ready to
 * receive input: Claude boots a tmux pane + `node-pty`, OpenCode boots the
 * local server and `POST /session`. A message typed during that window used to
 * be dropped — the bot saw `checkIsActive === false`, routed the text to the
 * "no agent running" guidance, and the user had to retype once the session was
 * up. This buffer captures those prompts and replays them, in arrival order,
 * the moment the session becomes active.
 *
 * The buffer lives in memory: a bot restart mid-start loses what it holds. A
 * prompt whose sender must not lose it that way (the API-error retry's nudge — its
 * saved record fires it again after a restart) passes `onSettled` and is told when
 * its wait ends, one way or the other. Every way out of the window settles its
 * prompts, so no caller can close the window and leave one waiting.
 *
 * Adapter-agnostic on purpose: the startup race is identical for Claude and
 * OpenCode, so the fix lives in the bot layer instead of being duplicated in
 * each adapter. Keyed by `keyToString(SessionKey)`.
 */
export class StartupPromptBuffer {
  private startingThreads = new Set<string>();
  private bufferedPrompts = new Map<string, BufferedPrompt[]>();
  /** Threads that already received the "queued while starting" ack, so we
   *  ack once per startup window rather than on every buffered prompt. */
  private ackedThreads = new Set<string>();
  /** Threads whose buffered prompts are being written, by how many replays run (one at a time in practice). */
  private replayingThreads = new Map<string, number>();

  /** Mark a thread as mid-startup; inbound text should now be buffered. */
  markStarting(threadId: string): void {
    this.startingThreads.add(threadId);
  }

  /** Whether a thread's session is currently starting. */
  checkIsStarting(threadId: string): boolean {
    return this.startingThreads.has(threadId);
  }

  /**
   * Whether a thread's buffered prompts are being replayed into its new session. The window is already closed (a prompt arriving now
   * is forwarded, not buffered again), but for the wake-up engine's turn probe the replay is still the start: nothing it writes has
   * started a turn yet, so no watch made during the start may be read as a turn that ended.
   */
  checkIsReplaying(threadId: string): boolean {
    return this.replayingThreads.has(threadId);
  }

  /** Whether any thread is mid-startup or holds prompts that wait for a session: they live in memory, a restart would lose them. */
  checkIsAnyPending(): boolean {
    return this.startingThreads.size > 0 || [...this.bufferedPrompts.values()].some((prompts) => prompts.length > 0);
  }

  /** Whether the thread holds prompts that wait for a session. */
  checkHasPrompts(threadId: string): boolean {
    return (this.bufferedPrompts.get(threadId)?.length ?? 0) > 0;
  }

  /**
   * End the window WITHOUT settling what it holds: the prompts stay for the
   * next window — the idle stop opens one so a prompt arriving while the process
   * stops is kept, and the resume that follows opens its own and replays them.
   */
  closeWindow(threadId: string): void {
    this.startingThreads.delete(threadId);
    this.ackedThreads.delete(threadId);
  }

  /**
   * Buffer one prompt for a starting thread — only while its window is OPEN (a start, or a stop under way). A closed window is
   * refused: its start or stop has already taken, or looked for, what it holds, so a prompt added now would wait for a replay
   * nobody starts (a person's message lost until the conversation's next start, and lost for good with a restart). The caller
   * routes a refused prompt again at that moment (`utils/promptDelivery.ts` `deliverPromptOrBuffer`).
   * @param onSettled Told once how the prompt's wait ended ({@link BufferedPromptOutcome}).
   * @param options How it is forwarded at the replay (`PromptDeliveryOptions`), kept with it.
   * @returns `refused` (no window is open), `firstInWindow` (the first buffered prompt of this window: the caller sends the
   * ack once) or `added`.
   */
  addPrompt(threadId: string, text: string, onSettled?: BufferedPromptSettled, options: PromptDeliveryOptions = {}): PromptBufferAddResult {
    if (!this.startingThreads.has(threadId)) return 'refused';
    const prompts = this.bufferedPrompts.get(threadId) ?? [];
    prompts.push({ text, onSettled, options });
    this.bufferedPrompts.set(threadId, prompts);

    const isFirstForWindow = !this.ackedThreads.has(threadId);
    this.ackedThreads.add(threadId);
    return isFirstForWindow ? 'firstInWindow' : 'added';
  }

  /**
   * End the startup window and hand the buffered prompts, in FIFO order, to the
   * session. Call on a successful start. The window closes and the buffer empties
   * BEFORE the first await, so a caller that does not await it still leaves no
   * prompt able to slip into a second buffer.
   *
   * With no active session nothing is forwarded and every prompt is `dropped`;
   * otherwise each is forwarded in turn and settles as `replayed` after its own
   * forward — or `dropped` when that forward threw (logged; the rest still go).
   */
  async replayPrompts(threadId: string, options: ReplayPromptsOptions): Promise<void> {
    // Marked replaying BEFORE the window closes, and until the last write and the after-step: the turn probe sees no gap between the
    // start and the replay.
    this.replayingThreads.set(threadId, (this.replayingThreads.get(threadId) ?? 0) + 1);
    try {
      const prompts = this.takePrompts(threadId);
      if (!options.isSessionActive) {
        for (const prompt of prompts) settleBufferedPrompt(prompt, 'dropped');
        return;
      }
      // Sequential await keeps the forwards in arrival order even when each one awaits its own loader send first.
      for (const prompt of prompts) {
        try {
          await options.forward(prompt.text, prompt.options);
        } catch (err) {
          console.error('[replayBufferedPrompts] forward failed:', err);
          settleBufferedPrompt(prompt, 'dropped');
          continue;
        }
        settleBufferedPrompt(prompt, 'replayed');
      }
      await options.afterReplay?.();
    } finally {
      const count = (this.replayingThreads.get(threadId) ?? 1) - 1;
      if (count > 0) this.replayingThreads.set(threadId, count);
      else this.replayingThreads.delete(threadId);
    }
  }

  /**
   * End the startup window and discard the buffer without replaying, settling
   * every prompt as `dropped`. Call when the start fails — the prompts would have
   * nowhere to go.
   */
  discardPrompts(threadId: string): void {
    for (const prompt of this.takePrompts(threadId)) settleBufferedPrompt(prompt, 'dropped');
  }

  /** Close the window and take what it held, clearing all per-thread state. */
  private takePrompts(threadId: string): BufferedPrompt[] {
    const prompts = this.bufferedPrompts.get(threadId) ?? [];
    this.startingThreads.delete(threadId);
    this.bufferedPrompts.delete(threadId);
    this.ackedThreads.delete(threadId);
    return prompts;
  }
}
