/**
 * @name BufferedPromptOutcome
 * @description How a buffered prompt's wait ended. `replayed`: it was handed to the
 * session — a forward that threw is logged and not retried, so it counts, since
 * nobody re-delivers it. `dropped`: it can never reach a session (the start failed,
 * or the session is not active once the window closes).
 */
export type BufferedPromptOutcome = 'replayed' | 'dropped';

/** Called once, when a buffered prompt's wait ends. */
export type BufferedPromptSettled = (outcome: BufferedPromptOutcome) => void;

interface BufferedPrompt {
  text: string;
  onSettled?: BufferedPromptSettled;
}

/** What {@link StartupPromptBuffer.replayPrompts} replays through. */
export interface ReplayPromptsOptions {
  /** Whether the session is up now; `false` drops every buffered prompt. */
  isSessionActive: boolean;
  /** Hand one prompt to the live session. */
  forward: (text: string) => Promise<void>;
}

/** A callback that throws must not break the replay or the failed-start path that called it. */
function settleBufferedPrompt(prompt: BufferedPrompt, outcome: BufferedPromptOutcome): void {
  try {
    prompt.onSettled?.(outcome);
  } catch (err) {
    console.error('[startupPromptBuffer] a settle callback threw:', err);
  }
}

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

  /** Mark a thread as mid-startup; inbound text should now be buffered. */
  markStarting(threadId: string): void {
    this.startingThreads.add(threadId);
  }

  /** Whether a thread's session is currently starting. */
  checkIsStarting(threadId: string): boolean {
    return this.startingThreads.has(threadId);
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
   * Buffer one prompt for a starting thread.
   * @param onSettled Told once how the prompt's wait ended ({@link BufferedPromptOutcome}).
   * @returns `true` if this is the first buffered prompt for the current
   * startup window (the caller uses it to send the ack only once).
   */
  addPrompt(threadId: string, text: string, onSettled?: BufferedPromptSettled): boolean {
    const prompts = this.bufferedPrompts.get(threadId) ?? [];
    prompts.push({ text, onSettled });
    this.bufferedPrompts.set(threadId, prompts);

    const isFirstForWindow = !this.ackedThreads.has(threadId);
    this.ackedThreads.add(threadId);
    return isFirstForWindow;
  }

  /**
   * End the startup window and hand the buffered prompts, in FIFO order, to the
   * session. Call on a successful start. The window closes and the buffer empties
   * BEFORE the first await, so a caller that does not await it still leaves no
   * prompt able to slip into a second buffer.
   *
   * With no active session nothing is forwarded and every prompt is `dropped`;
   * otherwise each is forwarded in turn (one that throws is logged, the rest still
   * go) and settles as `replayed` after its own forward.
   */
  async replayPrompts(threadId: string, options: ReplayPromptsOptions): Promise<void> {
    const prompts = this.takePrompts(threadId);
    if (!options.isSessionActive) {
      for (const prompt of prompts) settleBufferedPrompt(prompt, 'dropped');
      return;
    }
    // Sequential await keeps the forwards in arrival order even when each one awaits its own loader send first.
    for (const prompt of prompts) {
      try {
        await options.forward(prompt.text);
      } catch (err) {
        console.error('[replayBufferedPrompts] forward failed:', err);
      }
      settleBufferedPrompt(prompt, 'replayed');
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
