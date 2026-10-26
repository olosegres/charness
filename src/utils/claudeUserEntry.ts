/**
 * @description Tells what a Claude transcript `user` entry shows a person. Besides the messages somebody typed, the
 * CLI records the slash commands run directly in it (`<command-name>…`, with their argument text, and the
 * `<local-command-caveat>` / `<local-command-stdout>` entries around them) and wraps text it injects itself
 * (`<system-reminder>`, `<task-notification>`) in tags too. Every surface that shows a transcript's user entries —
 * the "Resumed" preview, the reattach recap, the context bridge, the `/sessions` titles — goes through this one
 * classification, so none of them prints a tag.
 *
 * Pure (string-in, value-out) so it is unit-tested in isolation.
 */

/**
 * @description The tag names the CLI and its tooling wrap around text the user never typed. A block runs to its
 * closing tag, or to the end of the entry when that is missing (a cut-off entry is still all injected text).
 */
const injectedTagNamePattern = 'local-command-[a-z]+|system-reminder|task-notification|tool-use-[a-z]+';
const injectedBlockRe = new RegExp(`<(${injectedTagNamePattern})>[\\s\\S]*?(?:</\\1>|$)`, 'g');

/** A slash command run directly in the CLI is recorded as `<command-message>` / `<command-name>` / `<command-args>`, in either order. */
const commandEntryPrefix = '<command-';
const commandNameRe = /<command-name>([\s\S]*?)<\/command-name>/;

/**
 * @description What a `user` entry is, for display:
 * - `message` — text somebody typed (`text`: with any injected blocks cut out of it);
 * - `command` — a slash command run in the CLI (`command`: just its name, e.g. `/compact`, never the arguments);
 * - `injected` — nothing a person typed: the caveat and stdout around a command, a reminder, a notification.
 */
export type ClaudeUserEntry =
  | { kind: 'message'; text: string }
  | { kind: 'command'; command: string }
  | { kind: 'injected' };

export function classifyClaudeUserEntry(rawText: string): ClaudeUserEntry {
  const text = rawText.trim();
  if (text.startsWith(commandEntryPrefix)) {
    const command = commandNameRe.exec(text)?.[1].trim();
    return command ? { kind: 'command', command } : { kind: 'injected' };
  }
  const message = text.replace(injectedBlockRe, '').trim();
  return message ? { kind: 'message', text: message } : { kind: 'injected' };
}

/**
 * @description The text a surface shows for a `user` entry: the typed message, or the bare command name; `null` for
 * an entry that shows nothing (the surface skips it).
 */
export function getClaudeUserEntryDisplayText(rawText: string): string | null {
  const entry = classifyClaudeUserEntry(rawText);
  if (entry.kind === 'message') return entry.text;
  return entry.kind === 'command' ? entry.command : null;
}
