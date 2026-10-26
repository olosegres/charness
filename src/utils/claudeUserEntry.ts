/**
 * @description Tells what a Claude transcript `user` entry shows a person. Besides the messages somebody typed, the
 * CLI records the slash commands and `!` shell commands run directly in it (with their output), loads skill bodies,
 * writes the summary of a compaction and wraps text it injects itself (`<system-reminder>`, `<task-notification>`) in
 * tags. Every surface that shows a transcript's user entries — the "Resumed" preview, the reattach recap, the context
 * bridge, the `/sessions` titles — decides through this one module what counts as a real message, so none of them
 * prints a tag, a skill's text or a compaction summary as something the user said.
 *
 * Three signals, from the sturdiest: the CLI's own flags on an entry ({@link checkIsCliWrittenUserEntry}); an entry that
 * is nothing but known tag blocks; the few untagged texts the CLI writes ({@link injectedTextPrefixes}). A typed
 * message is never cut: text that holds anything beyond whole known blocks is shown as it is, tags included.
 *
 * Pure (string-in, value-out) so it is unit-tested in isolation.
 */

/** Tags the CLI wraps around text it injects itself; an entry that is only blocks of these shows nothing. */
const injectedTagNames = ['local-command-[a-z]+', 'system-reminder', 'task-notification', 'tool-use-[a-z]+', 'bash-stdout', 'bash-stderr', 'fork-boilerplate'];

/** A slash command run directly in the CLI is recorded as these three blocks, in either order; the name is what is shown. */
const commandNameTag = 'command-name';
const commandTagNames = [commandNameTag, 'command-message', 'command-args'];

/** A `!` shell command run directly in the CLI is recorded in this block (its output follows in `bash-stdout` / `bash-stderr`). */
const shellInputTag = 'bash-input';
const shellInputPrefix = '!';

/**
 * Hooks append `<system-reminder>` blocks to the prompts people type, so this one tag is also cut off the START and the
 * END of an entry that holds more than blocks; no other tag is ever cut off a typed message.
 */
const reminderTag = 'system-reminder';
const reminderOpening = `<${reminderTag}>`;
const reminderClosing = `</${reminderTag}>`;
const leadingReminderRe = new RegExp(`^${reminderOpening}[\\s\\S]*?${reminderClosing}`);

const wholeEntryTagPattern = [...injectedTagNames, ...commandTagNames, shellInputTag].join('|');
const leadingBlockRe = new RegExp(`^\\s*<(${wholeEntryTagPattern})>([\\s\\S]*?)</\\1>`);

/** Untagged entries the CLI writes itself. */
const injectedTextPrefixes = [
  'Base directory for this skill:', // the body of a skill the CLI loaded
  'Caveat: The messages below', // the caveat of CLI versions that wrote it without a tag
  '[Request interrupted', // the marker of a turn the user interrupted
];

/**
 * The flags with which the CLI marks the `user` entries it wrote itself: `isMeta` (a loaded skill's body, the caveat
 * before a command, an image note, a message from another session), `isCompactSummary` and
 * `isVisibleInTranscriptOnly` (the summary a compaction leaves, which the CLI shows in the transcript only).
 */
const cliWrittenEntryFlags = ['isMeta', 'isCompactSummary', 'isVisibleInTranscriptOnly'];

/**
 * @description What a `user` entry is, for display:
 * - `message` — text somebody typed (`text`: as it is, bar `<system-reminder>` blocks at its ends);
 * - `command` — a command run in the CLI (`command`: just the slash command's name, e.g. `/compact`, never its
 *   arguments; a shell command as `!` + the command);
 * - `injected` — nothing a person typed: the caveat and output around a command, a reminder, a notification, a skill.
 */
export type ClaudeUserEntry =
  | { kind: 'message'; text: string }
  | { kind: 'command'; command: string }
  | { kind: 'injected' };

interface TagBlock {
  tag: string;
  body: string;
}

/** Cut the closed `<system-reminder>` blocks off the start and the end of `text`, repeatedly. */
function cutReminderEdges(text: string): string {
  let rest = text;
  for (;;) {
    const leading = leadingReminderRe.exec(rest);
    if (leading) {
      rest = rest.slice(leading[0].length).trim();
      continue;
    }
    const openingAt = rest.endsWith(reminderClosing) ? rest.lastIndexOf(reminderOpening, rest.length - reminderClosing.length) : -1;
    if (openingAt === -1) return rest;
    rest = rest.slice(0, openingAt).trim();
  }
}

/**
 * @description The closed known blocks `text` consists of, in order — `null` when it holds anything else (a word
 * between the blocks, an unclosed or unknown tag); whitespace between the blocks is allowed. No text: no blocks.
 */
function readWholeEntryBlocks(text: string): TagBlock[] | null {
  const blocks: TagBlock[] = [];
  let rest = text;
  while (rest.trim()) {
    const block = leadingBlockRe.exec(rest);
    if (!block) return null;
    blocks.push({ tag: block[1], body: block[2] });
    rest = rest.slice(block[0].length);
  }
  return blocks;
}

function checkIsInjectedText(text: string): boolean {
  return injectedTextPrefixes.some((prefix) => text.startsWith(prefix));
}

/**
 * @description Classify the text of a transcript `user` entry. It is a `command` or `injected` ONLY when the whole
 * entry (bar `<system-reminder>` blocks at its ends) consists of closed known tag blocks, or is one of the CLI's
 * untagged texts; anything else is the person's own wording and is a `message` shown whole — also one that pastes or
 * mentions a tag, unclosed, in the middle or at an end. The entry's flags are not read here: the caller checks
 * {@link checkIsCliWrittenUserEntry} on the entry itself.
 */
export function classifyClaudeUserEntry(rawText: string): ClaudeUserEntry {
  const text = cutReminderEdges(rawText.trim());
  const blocks = readWholeEntryBlocks(text);
  if (blocks === null) return checkIsInjectedText(text) ? { kind: 'injected' } : { kind: 'message', text };
  const slashCommand = blocks.find((block) => block.tag === commandNameTag)?.body.trim();
  if (slashCommand) return { kind: 'command', command: slashCommand };
  const shellCommand = blocks.find((block) => block.tag === shellInputTag)?.body.trim();
  return shellCommand ? { kind: 'command', command: `${shellInputPrefix}${shellCommand}` } : { kind: 'injected' };
}

/**
 * @description The text a surface shows for a `user` entry: the typed message, or the command; `null` for an entry
 * that shows nothing (the surface skips it).
 */
export function getClaudeUserEntryDisplayText(rawText: string): string | null {
  const entry = classifyClaudeUserEntry(rawText);
  if (entry.kind === 'message') return entry.text;
  return entry.kind === 'command' ? entry.command : null;
}

/**
 * @description Whether the CLI wrote a transcript entry itself, by its own flags ({@link cliWrittenEntryFlags}): never
 * something a person typed, whatever its text says. The flags outrank any reading of the text; the typed `/compact`
 * command and its stdout entry carry none and are told apart by their tags.
 */
export function checkIsCliWrittenUserEntry(entry: Record<string, unknown>): boolean {
  return cliWrittenEntryFlags.some((flag) => entry[flag] === true);
}
