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
/** The CLI version the fake reports on `system/init` — the first one whose stream carries the background-task list (L-D10). */
export const fakeClaudeCodeVersion = '2.1.287';
export const fakeClaudeVersion = `${fakeClaudeCodeVersion} (Claude Code)`;
/**
 * A file in the fake's state dir whose content replaces {@link fakeClaudeCodeVersion} on every `system/init` while
 * it exists — a test puts an older CLI behind a conversation (the L-D10 per-turn refusal) without a second fake.
 */
export const fakeClaudeCodeVersionOverrideFileName = 'claude-code-version';
/** The token accounting every fake turn's `result` reports (L-D11): distinctive values the e2e finds in the bot's usage line. */
export const fakeTurnUsage = { input_tokens: 7, cache_creation_input_tokens: 1301, cache_read_input_tokens: 24601, output_tokens: 43 } as const;
/**
 * What a real `/compact` turn's `result` reports (probe 2026-10-05): an all-zero `usage` and the summary
 * call — its cache read ≈ the context — only under `modelUsage`, per model.
 */
export const fakeCompactionResultUsage = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } as const;
export const fakeCompactionModelUsage = { 'fake-model': { inputTokens: 1446, outputTokens: 1276, cacheReadInputTokens: 23852, cacheCreationInputTokens: 23979 } } as const;
/**
 * A file in the fake's state dir that, while it exists, makes every process of the fake exit as soon as it reads a
 * user message — before it echoes or answers it: a prompt that reached the agent and was never taken in (E3).
 */
export const fakeClaudeCrashOnPromptFileName = 'crash-on-prompt';
export const fakeClaudeLogFileNames = {
  /** One record per user message the fake READ, the crashing ones too: `{ pid, issueKey, requestId, text }`. */
  prompts: 'prompts.jsonl',
  /** One record per tool the fake called on the bot MCP, or ran on its own PATH: `{ issueKey, tool, args, outcome }`. */
  toolCalls: 'tool-calls.jsonl',
  /** One record per `/compact` turn the fake ran: `{ sessionId, pid }`. */
  compactions: 'compactions.jsonl',
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
 * ids its header named as replaced by this request (it answers only what this one adds),
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

/** One line of the fake's `prompts.jsonl`: a user message it read. */
export interface FakeClaudePrompt {
  pid: number;
  issueKey: string;
  requestId: string | null;
  /** The whole text the agent was sent: header, issue, everything. */
  text: string;
}

/** One line of `tool-calls.jsonl`. */
export interface FakeClaudeToolCall {
  issueKey: string;
  tool: string;
  args: Record<string, string>;
  /** The tool's result text (`error: …` for a refusal), or what the program printed. */
  outcome: string;
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
