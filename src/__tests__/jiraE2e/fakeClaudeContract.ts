/**
 * @description What the fake `claude` (`fakeClaude.ts`) and the process-level
 * Jira test agree on: the files it logs to, the flags it insists on, its exit
 * code on a missing flag, the environment it accepts. Kept apart from the
 * executable script, which starts running when it is loaded.
 */

import { agentEnvironmentNames } from '../../utils/agentEnvironment';

export const argvViolationExitCode = 3;
/** What the real CLI exits with when it refuses a `--resume` / `--session-id` it cannot serve. */
export const sessionViolationExitCode = 1;
export const fakeClaudeVersion = '2.1.287 (Claude Code)';
export const fakeClaudeLogFileNames = {
  launches: 'launches.jsonl',
  violations: 'violations.jsonl',
  answers: 'answers.jsonl',
  turns: 'turns.jsonl',
} as const;

/** The flags every session launch of a Jira conversation must carry (R7, R8, R11, D17). */
export const requiredJiraSessionFlags: ReadonlyArray<readonly string[]> = [
  ['--disallowedTools', 'AskUserQuestion'],
  ['--setting-sources', 'project,local'],
  ['--strict-mcp-config'],
];

/** What the fake's own launcher script exports: where it logs and keeps its state. */
export const fakeClaudeOwnEnvPrefix = 'FAKE_CLAUDE_';
/**
 * The platform whose session contract the fake enforces, set by its launcher:
 * `jira` insists on the Jira flags and the R32 environment on every session
 * launch; unset (a Telegram topic's session) enforces neither — a topic's
 * session inherits the tmux server's environment and carries no tracker flags.
 */
export const fakeClaudePlatformEnvName = 'FAKE_CLAUDE_PLATFORM';
export type FakeClaudePlatform = 'jira';

/**
 * @name FakeClaudeTurn
 * @description One line of the fake's `turns.jsonl`: the request the turn
 * belonged to (`null` for a prompt without a request header), the `KEY-n` label
 * of its text, whether the text was the request's own prompt (not a reminder),
 * whether its header said the requester does not see plain text, the request
 * ids its header named as replaced by this request (one answer covers them),
 * the turn's count for that request, and the fake's pid.
 */
export interface FakeClaudeTurn {
  requestId: string | null;
  issueKey: string;
  isRequestPrompt: boolean;
  isPlainTextHidden: boolean;
  supersededRequestIds: string[];
  turnCount: number;
  pid: number;
}

/**
 * @name FakeClaudeAnswer
 * @description One line of the fake's `answers.jsonl`: what it sent through
 * `answer_request` and the tool result it got back (`error: …` when refused).
 */
export interface FakeClaudeAnswer {
  requestId: string;
  issueKey: string;
  kind: string;
  outcome: string;
}
/** What `/bin/sh` adds by itself to the environment it runs a command with. */
const shellAddedEnvNames: readonly string[] = ['PWD'];

/**
 * @description The variables of an agent's environment R32 does not allow: anything
 * but the agent allowlist, what a shell adds, and the fake's own launcher variables.
 */
export function getForeignAgentEnvNames(envNames: readonly string[]): string[] {
  const allowedNames: readonly string[] = [...agentEnvironmentNames, ...shellAddedEnvNames];
  return envNames.filter((name) => !allowedNames.includes(name) && !name.startsWith(fakeClaudeOwnEnvPrefix));
}

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
