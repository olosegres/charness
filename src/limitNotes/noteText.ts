/**
 * @description How an accounts note is attached to a text and taken off it again — kept apart from `plan.ts` (the decisions and the
 * texts) because the readers that must cut a note off — the resume context, the fallback hand-over, the renderer of a tool
 * result — need only this, and none should load the planner for it: this module imports nothing.
 *
 * A note ({@link limitNoteMarker}) is always the LAST block of the text it rides on, after a blank line: at the end of a prompt (after
 * the todo lines) and at the end of a bot tool's result. It is never followed by anything, and its own lines hold no blank line, so
 * one rule finds it from either side.
 */

/** What a note text starts with (`[Accounts · 14:05] …`). A person's words never open a line with `[` (the author marks escape it). */
export const limitNoteMarker = '[Accounts';

/** The note's first line starts like this, then `HH:MM`, optionally ` · changed`, then `]`. */
const limitNoteHeaderPattern = /^\[Accounts · \d{2}:\d{2}(?: · changed)?\]/;

const noteSeparator = '\n\n';

/** @description `text` with `note` as its last block. */
export function appendLimitNote(text: string, note: string): string {
  return `${text}${noteSeparator}${note}`;
}

/**
 * @description `text` without the accounts note that ends it ({@link appendLimitNote}); `text` itself when it ends in none. A block
 * that merely starts like a note but is followed by a further blank line, or whose first line is no note header, is not one.
 */
export function stripLimitNote(text: string): string {
  const noteStart = text.lastIndexOf(`${noteSeparator}${limitNoteMarker} · `);
  if (noteStart === -1) return text;
  const note = text.slice(noteStart + noteSeparator.length);
  if (!limitNoteHeaderPattern.test(note) || note.includes(noteSeparator)) return text;
  return text.slice(0, noteStart);
}
