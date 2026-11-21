/**
 * @description The SHAPE of an accounts note and how one is attached to a text and taken off it again — kept apart from `plan.ts` (the
 * decisions and the figures) because the readers that must cut a note off — the resume context, the fallback hand-over, the session
 * titles, the renderer of a tool result — need only this, and none should load the planner for it: this module imports nothing.
 * `plan.ts` builds every note from the constants here, so what it writes and what {@link stripLimitNote} recognises cannot drift.
 *
 * A note is attached as the LAST block of the text it rides on, after a blank line: at the end of a prompt (after the todo lines) and
 * at the end of a bot tool's result. A stored user turn may hold more after it — the CLI merges messages queued behind a prompt into
 * ONE turn (their texts joined by a newline) — so the strip follows the note's own shape, wherever it sits:
 *   - a change summary is its header line alone;
 *   - a reminder is its header line, at most one line starting `Then …` / `ChatGPT: …`, and the fixed instruction line.
 */

/** What a note text starts with (`[Accounts · 14:05] …`). A person's words never open a line with `[` (the author marks escape it). */
export const limitNoteMarker = '[Accounts';

/** What a change summary's header carries before its `]`: `[Accounts · 16:40 · changed]`. */
export const limitNoteChangedMark = ' · changed';

/** The reminder's last line: the instruction the summary leaves out. */
export const limitNoteReminderInstructionLine = 'Call claude_profiles right before your next launch or resume — the pick moves as limits fill and reset. No reply is needed.';

/** What the reminder's optional second line starts with when it names the accounts after the pick. */
export const limitNoteNextAccountsPrefix = 'Then ';

/** What the reminder's optional second line starts with when it names the ChatGPT window (alone, or after the accounts). */
export const limitNoteChatGptPrefix = 'ChatGPT: ';

/** @description The first line's head of a note: `[Accounts · 14:05]`, or `[Accounts · 14:05 · changed]` for the change summary. */
export function formatLimitNoteHeader(clock: string, isChange: boolean): string {
  return `${limitNoteMarker} · ${clock}${isChange ? limitNoteChangedMark : ''}]`;
}

const noteSeparator = '\n\n';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const headerStartPattern = `${escapeRegExp(limitNoteMarker)} · \\d{2}:\\d{2}`;
/** A change summary: its header line alone. */
const summaryPattern = `${headerStartPattern}${escapeRegExp(limitNoteChangedMark)}\\][^\\n]*`;
/** A reminder: its header line, at most one line of accounts / ChatGPT, then the instruction line — nothing past it. */
const reminderPattern = `${headerStartPattern}\\][^\\n]*(?:\\n(?:${[limitNoteNextAccountsPrefix, limitNoteChatGptPrefix].map(escapeRegExp).join('|')})[^\\n]*)?\\n${escapeRegExp(limitNoteReminderInstructionLine)}`;
const noteBlockPattern = new RegExp(`${noteSeparator}(?:${summaryPattern}|${reminderPattern})`, 'g');

/** @description `text` with `note` as its last block. */
export function appendLimitNote(text: string, note: string): string {
  return `${text}${noteSeparator}${note}`;
}

/**
 * @description `text` without every accounts note it holds, each cut by its own shape ({@link limitNoteMarker}): the blank line before
 * it and the note's lines go, whatever follows it (`\n` and the next merged message) stays. `text` itself when it holds none; a block
 * that only starts like a note but has no such shape (no blank line before it, another header, a missing instruction line) is not one.
 */
export function stripLimitNote(text: string): string {
  return text.replace(noteBlockPattern, '');
}
