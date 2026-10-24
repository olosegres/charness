/**
 * @description What the fake `claude` (`fakeClaude.ts`) and the process-level
 * Jira test agree on: the files it logs to, the flags it insists on, its exit
 * code on a missing flag, the environment it accepts. Kept apart from the
 * executable script, which starts running when it is loaded.
 */

import * as path from 'path';
import { agentEnvironmentNames } from '../../utils/agentEnvironment';

export const argvViolationExitCode = 3;
/**
 * Where the fake holds a conversation: the real CLI's transcript, `<config dir>/projects/<work dir slug>/<id>.jsonl`
 * (`CLAUDE_CONFIG_DIR`, else `<home>/.claude`). The bot reads that location before a resume — a conversation without a
 * transcript is started again under the same id — so the fake keeps its conversations exactly there. The fake writes a
 * line per message; a transcript with no conversation entry (empty, or only the metadata stub the real CLI leaves at
 * exit — `readClaudeTranscriptContent`) is a conversation the CLI cannot resume (`No conversation found`) nor start
 * again under its id (`already in use`).
 */
export function getFakeClaudeTranscriptPath(options: { homeDir: string; configDir?: string | undefined; workDir: string; sessionId: string }): string {
  const configDir = options.configDir || path.join(options.homeDir, '.claude');
  return path.join(configDir, 'projects', options.workDir.replace(/[^a-zA-Z0-9]/g, '-'), `${options.sessionId}.jsonl`);
}

/**
 * The name of a file in the fake's state dir that makes the fake refuse a `--resume` of conversation `sessionId` while it
 * exists, although its transcript holds messages: a conversation the CLI cannot restore (a corrupt or incompatible
 * transcript), which the bot cannot tell from a good one by reading it.
 */
export function getFakeClaudeUnrestorableConversationFileName(sessionId: string): string {
  return `unrestorable-${sessionId}`;
}

/** What the real CLI exits with when it refuses a `--resume` / `--session-id` it cannot serve. */
export const sessionViolationExitCode = 1;
/**
 * A file in the fake's state dir whose content is how many milliseconds after SIGTERM / SIGHUP a fake process that took
 * a turn writes its metadata entries back into its transcript and exits (no file: no flush, the process dies at once, as
 * it always did). The real CLI does exactly that at exit — into a FRESH file when its transcript was removed under it
 * (Claude Code's cleanup of old transcripts) — within 22 ms for a small conversation and well after the bot's next launch
 * decision for a heavy one (a live incident). A test of that incident writes a delay that puts the stub after the decision.
 */
export const fakeClaudeExitFlushDelayFileName = 'exit-flush-delay-ms';
/**
 * A file in the fake's state dir that, while it exists, makes every fake process ignore SIGTERM and SIGHUP: a CLI that does
 * not leave when it is asked to (only SIGKILL ends it). A test of a launch that must never run beside the process it replaces.
 */
export const fakeClaudeIgnoreStopSignalsFileName = 'ignore-stop-signals';
/**
 * A file in the fake's state dir that, while it exists, makes every SESSION launch exit at once with an error, before it
 * reads anything: a CLI that cannot start (broken install, refused account) — the bot's start of the conversation fails.
 */
export const fakeClaudeRefuseLaunchFileName = 'refuse-launch';
/** The CLI version the fake reports on `system/init` — the first one whose stream carries the background-task list (L-D10). */
export const fakeClaudeCodeVersion = '2.1.287';
export const fakeClaudeVersion = `${fakeClaudeCodeVersion} (Claude Code)`;
/**
 * A file in the fake's state dir whose content replaces {@link fakeClaudeCodeVersion} on every `system/init` while
 * it exists — a test puts an older CLI behind a conversation (the L-D10 per-turn refusal) without a second fake.
 */
export const fakeClaudeCodeVersionOverrideFileName = 'claude-code-version';
/**
 * What one answered turn of the fake costs, and a compaction turn: every `result` frame carries the conversation's
 * running total as `total_cost_usd` (kept per conversation in the state dir, so a resumed process continues it, as the
 * real CLI restores it from the transcript). A refused turn costs nothing.
 */
export const fakeTurnCostUsd = 0.25;
export const fakeCompactionCostUsd = 0.05;
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

/**
 * A file in the fake's state dir that, while it exists, makes EVERY turn end on a subscription limit whose reset is the
 * file's content — the bot's own "continue" nudge included, so a flow can drive a limit wait through all its attempts.
 */
export const fakeClaudeAlwaysUsageLimitFileName = 'always-usage-limit';

/**
 * A file in the fake's state dir that makes the NEXT turn end on an API error whose text is the file's content — any
 * provider wording a flow needs — and is removed by that turn.
 */
export const fakeClaudeApiErrorOnceFileName = 'api-error-once';
/** The file the fake's `auth login` writes into `CLAUDE_CONFIG_DIR` (`{ method: 'console' | 'claudeai' }`) — its stand-in for a stored login. */
export const fakeClaudeLoginFileName = 'fake-login.json';
/** The link the fake's `auth login` prints (the bot relays it into the topic). */
export const fakeClaudeLoginUrl = 'https://platform.example.test/oauth/authorize?client=fake';
/** Who a Console login of the fake signs in as. */
export const fakeConsoleLogin = { email: 'ops@example.com', orgName: 'Example Org' } as const;
/**
 * A file in the fake's state dir whose content is how many milliseconds that {@link fakeClaudeApiErrorOnceFileName} turn
 * works before it ends on its error — long enough for a test to restart the bot in between (the turn was taken in by
 * one bot, its error is read by the next).
 */
export const fakeClaudeApiErrorDelayFileName = 'api-error-delay-ms';
/**
 * The question the fake's `ask` mode puts to the user (an `AskUserQuestion`, the real CLI's tool): one short option,
 * one whose label is longer than a Telegram toast holds (200 characters).
 */
export const fakeAskQuestion = {
  header: 'Plan',
  question: 'Which way do we go?',
  shortOptionLabel: 'The short way',
  longOptionLabel: `The long way: ${'every step spelled out in detail, '.repeat(8)}and nothing left out.`,
} as const;
/** The tool name `ask` mode logs its outcome under in `tool-calls.jsonl`; the outcome is the answer the user gave. */
export const fakeAskToolName = 'AskUserQuestion';

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
/** How long a `slow-once` first turn works in silence (ms), set by the launcher; unset: the fake's own default. */
export const fakeClaudeSlowTurnMsEnvName = 'FAKE_CLAUDE_SLOW_TURN_MS';
/** The most an `answer-after-queued` turn waits for the next message (ms), set by the launcher; unset: the fake's default. */
export const fakeClaudeQueuedWaitMaxMsEnvName = 'FAKE_CLAUDE_QUEUED_WAIT_MAX_MS';
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
