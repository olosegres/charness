/**
 * @description A stand-in for the INTERACTIVE Claude Code TUI in the process-level tests of the tmux backend (`claude`):
 * the bot starts it in a tmux pane, types prompts into it with `send-keys` and scrapes the pane. It draws only what the
 * scrape pipeline reads — a `❯` input box, the typed prompt's echo, `●` output rows — and a usage row on demand:
 *
 *   • `[fake:usage-warning]` in a prompt — the turn prints Claude Code's non-blocking warning row
 *     (`Approaching session limit · resets 11:29pm`) and then answers `● Done with <label>.`;
 *   • `[fake:usage-limit]` — the turn ends on the blocking row (`You've hit your session limit · resets 11:29pm`), no answer;
 *   • anything else — answers `● Done with <label>.`.
 *
 * A launch without `--session-id` (`claude --version`, `claude auth status`) prints the version and exits, like the
 * stream-json fake. Matches neither runner glob; started through `writeFakeClaudeTuiLauncher` (`e2e/isolatedCharness.ts`).
 */

import * as readline from 'readline';

const fakeClaudeTuiVersion = '2.1.304 (Claude Code)';
/** The first row the TUI draws — the greeting the bot relays for a tmux start. */
export const fakeClaudeTuiBanner = '✻ Welcome to the fake Claude Code TUI';
/** The wordings Claude Code 2.1.304 builds for the `allowed_warning` and `rejected` statuses of the session window. */
export const fakeUsageWarningRow = 'Approaching session limit · resets 11:29pm';
export const fakeUsageLimitRow = "You've hit your session limit · resets 11:29pm";
const usageWarningToken = '[fake:usage-warning]';
const usageLimitToken = '[fake:usage-limit]';
const promptLabelRe = /\b([A-Z][A-Z0-9]+-\d+)\b/;
const inputBoxRow = '❯ ';

function writeRows(rows: readonly string[]): void {
  process.stdout.write(`${rows.join('\n')}\n`);
}

function runTurn(prompt: string): void {
  const label = promptLabelRe.exec(prompt)?.[1] ?? 'the task';
  writeRows(['', `● Working on ${label}.`, '']);
  if (prompt.includes(usageLimitToken)) {
    writeRows([fakeUsageLimitRow, '']);
  } else {
    if (prompt.includes(usageWarningToken)) writeRows([fakeUsageWarningRow, '']);
    writeRows([`● Done with ${label}.`, '']);
  }
  process.stdout.write(inputBoxRow);
}

function main(): void {
  if (!process.argv.includes('--session-id')) {
    process.stdout.write(`${fakeClaudeTuiVersion}\n`);
    return;
  }
  writeRows([` ${fakeClaudeTuiBanner}`, '']);
  process.stdout.write(inputBoxRow);
  const lines = readline.createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    if (line.trim()) runTurn(line);
  });
}

main();
