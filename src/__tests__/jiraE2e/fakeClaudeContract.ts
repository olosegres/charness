/**
 * @description What the fake `claude` (`fakeClaude.ts`) and the process-level
 * tests agree on: the files it logs to and its exit code when it refuses a
 * session. Kept apart from the executable script, which starts running when it
 * is loaded.
 */

/** What the real CLI exits with when it refuses a `--resume` / `--session-id` it cannot serve. */
export const sessionViolationExitCode = 1;
export const fakeClaudeVersion = '2.1.287 (Claude Code)';
export const fakeClaudeLogFileNames = {
  launches: 'launches.jsonl',
  violations: 'violations.jsonl',
  answers: 'answers.jsonl',
  turns: 'turns.jsonl',
} as const;

/** @description Whether `argv` carries `flag` followed by its values. */
export function checkHasFlag(argv: readonly string[], flag: readonly string[]): boolean {
  return argv.some((_, index) => flag.every((part, offset) => argv[index + offset] === part));
}

/** @description The value after every occurrence of the single-value option `name`. */
export function getFlagValues(argv: readonly string[], name: string): string[] {
  return argv.flatMap((arg, index) => (arg === name && index + 1 < argv.length ? [argv[index + 1]] : []));
}

/** @description The conversation a session launch runs: its `--session-id`, or the `--resume` id. */
export function getLaunchSessionId(argv: readonly string[]): string | undefined {
  return getFlagValues(argv, '--session-id')[0] ?? getFlagValues(argv, '--resume')[0];
}
