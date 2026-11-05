/**
 * @description The «transcribing…» note of a voice message: a silent message in the topic that appears only when the
 * text is late and is deleted the moment the text arrives (or the transcription fails). A warm engine answers within
 * {@link voiceProgressNoteDelayMs} and the topic shows nothing; a local engine that is still loading its model (up to 2
 * minutes, see `stt/README.md`) would otherwise leave the topic silent, and the voice note would look lost.
 *
 * Pure timing over three ports — the bot posts and deletes the message and keeps the id where a restart can still clean it
 * up (`bot.ts`, the transient-message set). Nothing here rejects: a note is cosmetic and must never fail a voice, and it must
 * never hold the answer back for long: {@link VoiceProgressNote.finish} waits for the cleanup at most
 * {@link voiceProgressNoteCleanupBudgetMs}; a cleanup that is still going then ends by itself in the background.
 */

/**
 * How long a voice message may wait for its text before the topic gets the note. Counted from the moment the voice
 * ARRIVES, so a voice waiting in line behind an earlier one in the same topic gets its note too. Long enough that a
 * warm engine (recognition ≈ 1.5 s for an 18 s voice) and a hosted one never flash it.
 */
export const voiceProgressNoteDelayMs = 3_000;

/**
 * How long the voice's own job (and the shutdown) waits for the note to be gone before it goes on with the answer. A delete is
 * one Bot API round trip (tens of milliseconds); this bound is for a stalled one — a 429 wait, a dead connection — which must
 * not hold the 🎤 transcript back. What the bound cuts short is not abandoned: it finishes in the background.
 */
export const voiceProgressNoteCleanupBudgetMs = 1_500;

export interface VoiceProgressNotePorts {
  /**
   * Send the silent note. Resolves its message id, or `null` when nothing was sent (the sender reports its own failure, and
   * stays quiet about a send that `signal` cancelled). `signal` aborts a send that has NOT started yet — one waiting out a 429;
   * a request already on the wire cannot be called back.
   */
  postNote: (signal: AbortSignal) => Promise<number | null>;
  /** The note is on screen and still wanted: keep its id where a restart can find it. */
  rememberNote: (messageId: number) => void;
  /** Delete a note that was sent, and forget it. Best effort: a message that is already gone is no failure. */
  deleteNote: (messageId: number) => Promise<void>;
  /** A port threw, which it should not: one line for the log, the voice goes on. */
  logProblem: (line: string) => void;
}

export interface VoiceProgressNote {
  /**
   * The text is here (or the transcription failed, or the voice was dropped): no note is posted from now on, a send that has
   * not started is cancelled, and a note that is on screen — or being sent right now — is deleted. Resolves when the note is
   * gone, or after {@link voiceProgressNoteCleanupBudgetMs} when the cleanup stalls (it then goes on in the background: a send
   * that lands late is deleted at once and never remembered). Safe to call any number of times; never rejects.
   */
  finish: () => Promise<void>;
}

export interface VoiceProgressNoteOptions {
  delayMs?: number;
  cleanupBudgetMs?: number;
  /** Called once when the cleanup after `finish()` has fully ended — also when `finish()` stopped waiting for it. */
  onSettled?: () => void;
}

/** `pending`, or the end of `budgetMs`, whichever comes first; `pending` itself runs on either way. */
async function waitAtMost(pending: Promise<void>, budgetMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<void>((resolve) => { timer = setTimeout(resolve, budgetMs); });
  try {
    await Promise.race([pending, budget]);
  } finally {
    clearTimeout(timer);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

/**
 * @description Arm the note for one voice message. Call it when the voice arrives and {@link VoiceProgressNote.finish}
 * when its text arrives or the transcription fails; an armed note that is never finished posts itself after the delay.
 */
export function createVoiceProgressNote(
  ports: VoiceProgressNotePorts,
  options: VoiceProgressNoteOptions = {},
): VoiceProgressNote {
  const delayMs = options.delayMs ?? voiceProgressNoteDelayMs;
  const cleanupBudgetMs = options.cleanupBudgetMs ?? voiceProgressNoteCleanupBudgetMs;
  const sendAbort = new AbortController();
  let isFinished = false;
  let postedMessageId: number | null = null;
  let posting: Promise<void> = Promise.resolve();
  let cleanup: Promise<void> | null = null;

  const removeNote = async (): Promise<void> => {
    const messageId = postedMessageId;
    if (messageId === null) return;
    // Taken before the await: a second caller must not delete the same note twice.
    postedMessageId = null;
    try {
      await ports.deleteNote(messageId);
    } catch (error) {
      ports.logProblem(`[voice] could not delete the transcribing note: ${describeError(error)}`);
    }
  };

  const postNote = async (): Promise<void> => {
    let messageId: number | null;
    try {
      messageId = await ports.postNote(sendAbort.signal);
    } catch (error) {
      if (!sendAbort.signal.aborted) ports.logProblem(`[voice] could not post the transcribing note: ${describeError(error)}`);
      return;
    }
    if (messageId === null) return;
    postedMessageId = messageId;
    // The text came (or the bot is shutting down) while the note was on its way: it is deleted at once and never remembered as live.
    if (isFinished) {
      await removeNote();
      return;
    }
    try {
      ports.rememberNote(messageId);
    } catch (error) {
      ports.logProblem(`[voice] could not remember the transcribing note: ${describeError(error)}`);
    }
  };

  const timer = setTimeout(() => {
    if (!isFinished) posting = postNote();
  }, delayMs);
  // An armed note never keeps a stopping process alive.
  timer.unref?.();

  const runCleanup = async (): Promise<void> => {
    try {
      await posting;
      await removeNote();
    } finally {
      options.onSettled?.();
    }
  };

  return {
    finish: async () => {
      isFinished = true;
      clearTimeout(timer);
      sendAbort.abort();
      cleanup ??= runCleanup();
      await waitAtMost(cleanup, cleanupBudgetMs);
    },
  };
}

export interface VoiceProgressNoteRegistry {
  /** Arm a note. After {@link shutDown} began, an inert one: it never posts anything. */
  start: (ports: VoiceProgressNotePorts) => VoiceProgressNote;
  /**
   * The bot is shutting down: every note that is armed stops posting (timers cleared, unstarted sends cancelled) and gets
   * cleaned up — a note on screen is deleted, a send in flight is waited for (bounded) and its message deleted when it lands.
   * The stopping part runs synchronously, before the first await, so it can sit in a sync shutdown step. Idempotent.
   */
  shutDown: () => Promise<void>;
}

const inertNote: VoiceProgressNote = { finish: async () => {} };

/**
 * @description The notes that are armed right now, so a shutdown can stop them: the timer of a note and its send in flight
 * belong to nobody else, and one that fires or lands after the shutdown sweep would strand a message past the final state flush.
 */
export function createVoiceProgressNoteRegistry(options: VoiceProgressNoteOptions = {}): VoiceProgressNoteRegistry {
  const activeNotes = new Set<VoiceProgressNote>();
  let shutDownPromise: Promise<void> | null = null;

  return {
    start: (ports) => {
      if (shutDownPromise !== null) return inertNote;
      const note: VoiceProgressNote = createVoiceProgressNote(ports, { ...options, onSettled: () => { activeNotes.delete(note); } });
      activeNotes.add(note);
      return note;
    },
    shutDown: () => {
      shutDownPromise ??= (async () => {
        await Promise.all([...activeNotes].map((note) => note.finish()));
      })();
      return shutDownPromise;
    },
  };
}
