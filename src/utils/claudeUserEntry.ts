/**
 * @description Tells what a Claude transcript `user` entry shows a person. Besides the messages somebody typed, the
 * CLI records the slash commands and `!` shell commands run directly in it (with their output), loads skill bodies and
 * wraps text it injects itself (`<system-reminder>`, `<task-notification>`) in tags. Every surface that shows a
 * transcript's user entries — the "Resumed" preview, the reattach recap, the context bridge, the `/sessions` titles —
 * decides through this one module what counts as a real message, so none of them prints a tag or a skill's text.
 *
 * Three signals, from the sturdiest: the CLI's own `isMeta` mark on an entry ({@link checkIsMetaUserEntry}); the tag
 * blocks at the two ends of an entry; the few untagged texts the CLI writes ({@link injectedTextPrefixes}).
 *
 * Pure (string-in, value-out) so it is unit-tested in isolation.
 */

/** Tags the CLI wraps around text it injects itself. A block of one is cut off an entry; an entry left empty shows nothing. */
const injectedTagNames = ['local-command-[a-z]+', 'system-reminder', 'task-notification', 'tool-use-[a-z]+', 'bash-stdout', 'bash-stderr', 'fork-boilerplate'];

/** A slash command run directly in the CLI is recorded as these three blocks, in either order; the name is what is shown. */
const commandNameTag = 'command-name';
const commandTagNames = [commandNameTag, 'command-message', 'command-args'];

/** A `!` shell command run directly in the CLI is recorded in this block (its output follows in `bash-stdout` / `bash-stderr`). */
const shellInputTag = 'bash-input';
const shellInputPrefix = '!';

const edgeTagPattern = [...injectedTagNames, ...commandTagNames, shellInputTag].join('|');
const leadingBlockRe = new RegExp(`^<(${edgeTagPattern})>([\\s\\S]*?)</\\1>`);
const trailingClosingTagRe = new RegExp(`</(${edgeTagPattern})>$`);

/** Untagged entries the CLI writes itself; matched on what is left of an entry once its edge blocks are cut off. */
const injectedTextPrefixes = [
  'Base directory for this skill:', // the body of a skill the CLI loaded
  'Caveat: The messages below', // the caveat of CLI versions that wrote it without a tag
  '[Request interrupted', // the marker of a turn the user interrupted
];

/** The stdout of `/effort` and `/model` once it lost its `<local-command-stdout>` wrapper. */
const commandEchoRe = /^set (effort level|model) /i;

/**
 * @description What a `user` entry is, for display:
 * - `message` — text somebody typed (`text`: with the injected blocks at its ends cut off);
 * - `command` — a command run in the CLI (`command`: just the slash command's name, e.g. `/compact`, never its
 *   arguments; a shell command as `!` + the command);
 * - `injected` — nothing a person typed: the caveat and output around a command, a reminder, a notification, a skill.
 */
export type ClaudeUserEntry =
  | { kind: 'message'; text: string }
  | { kind: 'command'; command: string }
  | { kind: 'injected' };

interface EdgeBlock {
  tag: string;
  body: string;
}

/**
 * @description Cut the properly CLOSED blocks of the known tags off the start and the end of `text`, repeatedly, and
 * return them with what is left. A tag that is only mentioned — unclosed, or in the middle of the text — is the
 * person's own wording and stays.
 */
function splitEdgeBlocks(text: string): { blocks: EdgeBlock[]; rest: string } {
  const blocks: EdgeBlock[] = [];
  let rest = text;
  for (;;) {
    const leading = leadingBlockRe.exec(rest);
    if (leading) {
      blocks.push({ tag: leading[1], body: leading[2] });
      rest = rest.slice(leading[0].length).trim();
      continue;
    }
    const closing = trailingClosingTagRe.exec(rest);
    const openingTag = closing ? `<${closing[1]}>` : '';
    const openingAt = closing ? rest.lastIndexOf(openingTag, closing.index) : -1;
    if (!closing || openingAt === -1) return { blocks, rest };
    blocks.push({ tag: closing[1], body: rest.slice(openingAt + openingTag.length, closing.index) });
    rest = rest.slice(0, openingAt).trim();
  }
}

function checkIsInjectedText(text: string): boolean {
  return commandEchoRe.test(text) || injectedTextPrefixes.some((prefix) => text.startsWith(prefix));
}

export function classifyClaudeUserEntry(rawText: string): ClaudeUserEntry {
  const { blocks, rest } = splitEdgeBlocks(rawText.trim());
  if (rest) return checkIsInjectedText(rest) ? { kind: 'injected' } : { kind: 'message', text: rest };
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
 * @description Whether the CLI marked a transcript entry `isMeta`: its own injection (a loaded skill's body, the
 * caveat before a command, an image note, a message from another session), never something a person typed. The CLI's
 * mark outranks any reading of the text; the typed `/compact` command and its stdout entry carry none and are told
 * apart by their tags.
 */
export function checkIsMetaUserEntry(entry: Record<string, unknown>): boolean {
  return entry.isMeta === true;
}
