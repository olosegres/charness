/**
 * @description The «transcribing…» note of a voice message: a silent message in the topic that appears only when the
 * text is late and is deleted the moment the text arrives (or the transcription fails). A warm engine answers within
 * {@link voiceProgressNoteDelayMs} and the topic shows nothing; a local engine that is still loading its model (up to 2
 * minutes, see `stt/README.md`) would otherwise leave the topic silent, and the voice note would look lost.
 *
 * Pure timing over two ports — the bot posts and deletes the message and keeps the id where a restart can still clean it
 * up (`bot.ts`, the transient-frame set). Nothing here rejects: a note is cosmetic and must never fail a voice.
 */

/**
 * How long a voice message may wait for its text before the topic gets the note. Counted from the moment the voice
 * ARRIVES, so a voice waiting in line behind an earlier one in the same topic gets its note too. Long enough that a
 * warm engine (recognition ≈ 1.5 s for an 18 s voice) and a hosted one never flash it.
 */
export const voiceProgressNoteDelayMs = 3_000;

export interface VoiceProgressNotePorts {
  /** Post the silent note. Resolves its message id, or `null` when it could not be sent (the sender reports that itself). */
  postNote: () => Promise<number | null>;
  /** Delete a note that was posted. Best effort: a message that is already gone is no failure. */
  deleteNote: (messageId: number) => Promise<void>;
  /** A port threw, which it should not: one line for the log, the voice goes on. */
  logProblem: (line: string) => void;
}

export interface VoiceProgressNote {
  /**
   * The text is here (or the transcription failed, or the voice was dropped): no note is posted from now on, and one that
   * is on screen — or being sent right now — is deleted. Safe to call any number of times; never rejects.
   */
  finish: () => Promise<void>;
}

/**
 * @description Arm the note for one voice message. Call it when the voice arrives and {@link VoiceProgressNote.finish}
 * when its text arrives or the transcription fails; an armed note that is never finished posts itself after the delay.
 */
export function createVoiceProgressNote(
  ports: VoiceProgressNotePorts,
  delayMs: number = voiceProgressNoteDelayMs,
): VoiceProgressNote {
  let isFinished = false;
  let postedMessageId: number | null = null;
  let posting: Promise<void> = Promise.resolve();

  const removeNote = async (): Promise<void> => {
    const messageId = postedMessageId;
    if (messageId === null) return;
    // Taken before the await: a second caller (finish() racing the send) must not delete the same note twice.
    postedMessageId = null;
    try {
      await ports.deleteNote(messageId);
    } catch (error) {
      ports.logProblem(`[voice] could not delete the transcribing note: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  };

  const postNote = async (): Promise<void> => {
    try {
      postedMessageId = await ports.postNote();
    } catch (error) {
      ports.logProblem(`[voice] could not post the transcribing note: ${error instanceof Error ? error.message : 'unknown error'}`);
      return;
    }
    // The text arrived while the note was being sent: it is obsolete before anyone could read it.
    if (isFinished) await removeNote();
  };

  const timer = setTimeout(() => {
    if (!isFinished) posting = postNote();
  }, delayMs);
  // An armed note never keeps a stopping process alive.
  timer.unref?.();

  return {
    finish: async () => {
      isFinished = true;
      clearTimeout(timer);
      await posting;
      await removeNote();
    },
  };
}
