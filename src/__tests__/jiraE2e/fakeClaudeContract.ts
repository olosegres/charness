/**
 * @description What the fake `claude` (`fakeClaude.ts`) and the process-level
 * Jira test agree on: the files it logs to, the flags it insists on, its exit
 * code on a missing flag, the environment it accepts. Kept apart from the
 * executable script, which starts running when it is loaded.
 */

import * as fs from 'fs';
import * as path from 'path';
import { agentEnvironmentNames } from '../../utils/agentEnvironment';
import { claudeConfigDirVariableName } from '../../utils/claudeProfiles';
import { claudeSessionStateEventsVariableName } from '../../utils/jsonStreamHost';

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
 * A file in the fake's state dir that, while it exists, makes the fake drain the prompts that arrive while a prompt turn runs
 * the way the real CLI does (measured on 2.1.329, `-p`, stream-json, `--replay-user-messages`): as ONE turn, the one echo of
 * which carries their texts joined by a newline — N written messages, one echo. Without the file every prompt runs as a turn
 * of its own, with its own echo.
 */
export const fakeClaudeMergeQueuedPromptsFileName = 'merge-queued-prompts';

/**
 * A file in the fake's state dir that, while it exists, makes EVERY turn end on a subscription limit whose reset is the
 * file's content — the bot's own "continue" nudge included, so a flow can drive a limit wait through all its attempts.
 */
export const fakeClaudeAlwaysUsageLimitFileName = 'always-usage-limit';

/**
 * A file in the fake's state dir (JSON, {@link FakeClaudeUsageWindows}) that makes every turn start the way a real one does:
 * ONE `rate_limit_event` frame carrying the usage windows of the account the process runs on (the account its
 * `CLAUDE_CONFIG_DIR` names, `default` for none). A flow needs it because an isolated instance has no sign-in: the bot's own
 * poller finds no token and marks every snapshot stale, so a frame is the only way an account's figures are fresh.
 */
export const fakeClaudeUsageWindowsFileName = 'usage-windows.json';

/**
 * A file in the fake's state dir whose content is a number of tokens: while it exists, every turn the fake ends writes an `assistant`
 * record carrying that `usage` (all of it as `input_tokens`) into the conversation's transcript just before its `result` — what the
 * real CLI leaves there, and what the bot reads as the size of the context (`utils/claudeRuntimeInfo.ts`) for the idle compaction's
 * growth gate. No file: the transcript holds no such record, the bot can tell no size, and the gate holds nothing back.
 */
export const fakeClaudeContextTokensFileName = 'context-tokens';

/** The account name of a process started without `CLAUDE_CONFIG_DIR`. */
export const fakeDefaultAccountName = 'default';

/** The five-hour and weekly windows one account reports; the reset instants are ISO strings. */
export interface FakeClaudeAccountWindows {
  sessionPercent: number;
  sessionResetsAt: string;
  weeklyPercent: number;
  weeklyResetsAt: string;
}

/** What {@link fakeClaudeUsageWindowsFileName} holds, by account name. */
export type FakeClaudeUsageWindows = Record<string, FakeClaudeAccountWindows>;

/**
 * A file in the fake's state dir whose content is the SUMMARY every compaction of the fake leaves in its transcript while
 * the file exists — the `isCompactSummary` message the real CLI writes, which the bot reads for the compaction summary and
 * its self-review section. No file: a compaction writes none (every other flow's compactions are unchanged).
 */
export const fakeClaudeCompactionSummaryFileName = 'compaction-summary';
/**
 * A file in the fake's state dir that makes the NEXT turn end on an API error whose text is the file's content — any
 * provider wording a flow needs — and is removed by that turn.
 */
export const fakeClaudeApiErrorOnceFileName = 'api-error-once';
/**
 * A file in the fake's state dir that makes the fake's `mcp_status` control answer list MCP servers: `[{ "name": …, "status": … }]`, as
 * the real CLI's `mcpServers` do. No file: the answer lists none (a heal finds nothing to act on). An `mcp_reconnect` of a listed
 * server rewrites its status to `connected`, as a reconnect that lands does — and is logged in `mcp-reconnects.jsonl`.
 */
export const fakeClaudeMcpServersFileName = 'mcp-servers.json';
/** The file the fake's `auth login` writes into `CLAUDE_CONFIG_DIR` (`{ method: 'console' | 'claudeai' }`) — its stand-in for a stored login. */
export const fakeClaudeLoginFileName = 'fake-login.json';
/**
 * The `method` a test writes into {@link fakeClaudeLoginFileName} to make the login EXPIRE: `auth status --json` then answers as the real CLI
 * does for a directory whose login is gone — `{"loggedIn": false, "authMethod": "none", …}` on stdout and exit code 1 — until an
 * `auth login` records a new one.
 */
export const fakeClaudeExpiredLoginMethod = 'expired';
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
/**
 * `arm-watch` / `cancel-watch` (the worker-watch flow): the name of the watch the fake arms on a worker that is gone —
 * a PID above any Linux `pid_max` (4194304), so the recipe's `kill -0` fails as for a worker that exited — and the
 * token the watch's own prompt carries, so the check's wake runs `cancel-watch`.
 */
export const fakeWatchJobName = 'watch worker W-1';
export const fakeGoneWorkerPid = 4_194_305;
export const fakeCancelWatchToken = '[fake:cancel-watch]';

/**
 * `arm-status-watch` (the worker-status flow): the watch of a worker the TEST started (a real process) with the real recipe
 * AND its status arguments (`scheduler/workerWatch.ts`). The worker and its run directory come from
 * {@link fakeStatusWatchTargetFileName} in the fake's state dir; the wake of its failure runs `cancel-watch` as for
 * {@link fakeWatchJobName}.
 */
export const fakeStatusWatchJobName = 'watch builder S2';
/**
 * The file in the fake's state dir (JSON, {@link FakeStatusWatchTarget}) `arm-status-watch` reads: the worker to watch. While it
 * exists `arm-watch` watches that worker too (a live one) instead of the gone one.
 */
export const fakeStatusWatchTargetFileName = 'status-watch-target.json';
/** The worker a status watch is armed on: its process id and the run directory its event log is written in. */
export interface FakeStatusWatchTarget {
  pid: number;
  runDir: string;
}

/**
 * While this file exists, `ask` mode streams its content as one assistant text right after it puts the question, while the
 * turn is still blocked on the answer — as a sub-agent or a parallel branch of the real CLI does. The text lands BELOW
 * the question in the topic, which is what makes the bot bring the question back to the bottom.
 */
export const fakeClaudeOutputWhileAskedFileName = 'output-while-asked';

/**
 * While `ask` mode waits for the answer, a flow may write this file to make the agent stream one more text (the file's
 * content, which the fake then deletes): a flow that needs several bursts of output under one question writes it once per
 * burst, after it saw the bot answer the previous one — no timing between the bursts is guessed.
 */
export const fakeClaudeNextOutputWhileAskedFileName = 'next-output-while-asked';

/** How often `ask` mode looks for {@link fakeClaudeNextOutputWhileAskedFileName} while the question is open. */
export const fakeOutputWhileAskedPollMs = 100;

/**
 * The second question of `ask-two` mode, put in the SAME `AskUserQuestion` call as {@link fakeAskQuestion}: the bot shows
 * them one after the other and replies to the agent once both are answered.
 */
export const fakeAskSecondQuestion = {
  header: 'Order',
  question: 'In which order do we go?',
  firstOptionLabel: 'Front to back',
  secondOptionLabel: 'Back to front',
} as const;

/**
 * The description each option of `ask-long` mode carries: ~1.8k characters, so the two options together nearly fill a
 * Telegram message (4096) — the question fits when posted, but not with an answer note added under it.
 */
export const fakeAskLongDescription = 'every step spelled out in detail, '.repeat(52);

/**
 * What `ask-repeat` mode puts under its options: the first option's description only says its label again (in lower case,
 * with a full stop), which the bot leaves out; the second's says something more, which stays.
 */
export const fakeAskRepeatDescriptions = {
  repeatingLabel: `${fakeAskQuestion.shortOptionLabel.toLowerCase()}.`,
  saysMore: 'Thorough.',
} as const;

/** What `ask-two` mode logs as its outcome: the two answers it got, in order, joined by this. */
export const fakeAskTwoOutcomeSeparator = ' / ';

/** The outcome `ask` mode logs for a question that was declined, not answered (the bot's `control_response` carries no answers). */
export const fakeAskNoAnswerOutcome = 'no answer';

/** The tool name `ask` mode logs its outcome under in `tool-calls.jsonl`; the outcome is the answer the user gave. */
export const fakeAskToolName = 'AskUserQuestion';

/**
 * How a question the bot SET ASIDE reads to the fake: a `can_use_tool` deny whose message opens with this (the bot's own
 * `[Charness] …` text, `utils/questionWaitPlan.ts`) — unlike the abandonment deny («User declined to answer the question.»),
 * which the bot follows with an interrupt. The turn then GOES ON: it ends with {@link fakeAskSetAsideTurnText}, so a test that
 * finds that text in the topic knows the agent carried on after the deny — the fake does not end its turn for any other reason.
 */
export const fakeSetAsideDenyMessagePrefix = '[Charness] ';
/** The outcome `ask` mode logs for a question that was set aside (the deny's whole message follows it in `control-responses.jsonl`). */
export const fakeAskSetAsideOutcome = 'set aside';
/** What the turn of a question that was set aside ends with: the proof that the agent went on after the deny. */
export const fakeAskSetAsideTurnText = 'Went on without the answer.';

/**
 * `[fake:schedule-once <seconds> <label>]` in a prompt: early in the turn (before it puts its question, if the mode asks one) the
 * fake creates a one-shot prompt schedule (`schedule_create` on the bot's MCP) that fires after that many seconds with the prompt
 * `<label> [fake:answer] scheduled` — a prompt the BOT delivers to the agent, not a person: while its question waits it is not an
 * answer to it and does not cancel it (a message the operator types does), and in a topic whose process sleeps it wakes the
 * conversation without clearing the idle-compaction latch (a person's message does).
 */
export const fakeScheduleOnceToken = (seconds: number, label: string): string => `[fake:schedule-once ${seconds} ${label}]`;

/**
 * `[fake:question-variant <n>]` in a prompt: the question an `ask` turn puts reads `<question> (<n>)` instead of {@link fakeAskQuestion}'s
 * bare text — so a flow that keeps several questions open at once asks DISTINCT ones (the bot does not post a question that repeats
 * an open one). `ask-again` puts the very same text a second time.
 */
export const fakeQuestionVariantToken = (variant: number): string => `[fake:question-variant ${variant}]`;
/** The text of the question an `ask` turn put for `variant` (`undefined`: no token, the bare text). */
export const getFakeAskQuestionText = (variant?: number): string => (variant === undefined ? fakeAskQuestion.question : `${fakeAskQuestion.question} (${variant})`);

/**
 * While this file is absent, the background task a `background-notify` turn leaves running keeps running; the test
 * writes it to END the task (its content is ignored) — the fake then writes the task's end and starts the task's turn.
 */
export const fakeClaudeBackgroundReleaseFileName = 'background-release';
/**
 * While this file is absent, the first turn of a `hold-once` conversation keeps working; the test writes it to END that
 * turn (its content is ignored) — the fake removes it and answers.
 */
export const fakeClaudeHoldReleaseFileName = 'hold-release';
/**
 * While this file exists, a released `background-notify` task's turn starts only this many ms (its content) after the
 * background list emptied, and with no `session_state_changed running`: the task's notification is then the ONLY sign
 * that a turn is coming — the gap a stop once landed in, stretched past an idle window.
 */
export const fakeClaudeBackgroundGapMsFileName = 'background-gap-ms';
/** How long a `background-notify` task's own turn takes from its start to its first output (the API round-trip). */
export const fakeNotificationTurnLatencyMs = 8000;
/** The description of the task a `background-notify` turn labelled `issueKey` starts (lower case: never read as a label). */
export function getFakeBackgroundTaskDescription(issueKey: string): string {
  return `watcher of ${issueKey.toLowerCase()}`;
}
/** The text the turn a finished `background-notify` task starts answers with: `<issueKey>` is the label of the turn that started the task. */
export function getFakeBackgroundTaskFinishedText(issueKey: string): string {
  return `Background task for ${issueKey} finished.`;
}

/** The sentence a `[text-chars:<n>]` turn's streamed text ENDS with: a test finds the LAST message of a long text by it. */
export function getFakeStreamTextEnd(label: string): string {
  return `End of the text of ${label}.`;
}

/** The one message the `send-messages` mode sends through `send_messages_to_user`. */
export function getFakeDigestMessageText(label: string): string {
  return `Fake digest message for ${label}.`;
}

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
  /** One record per `PostToolUse` hook output that carried `additionalContext`: `{ issueKey, pid, sessionId, additionalContext }`. */
  hooks: 'hooks.jsonl',
  /**
   * One record per compaction, the CLI's own and a `/compact` turn: what the launch's `PreCompact` hooks printed for it —
   * the instruction the real CLI appends to the compaction's — `{ sessionId, pid, trigger, instruction }`.
   */
  preCompactHooks: 'pre-compact-hooks.jsonl',
  /** One record per `mcp_reconnect` control request the bot sent the fake: `{ pid, serverName }`. */
  mcpReconnects: 'mcp-reconnects.jsonl',
  /**
   * One record per compaction: what the launch's `SessionStart` hooks for the `compact` source gave as `additionalContext`,
   * in the order the fake took them (the real CLI's is the order they finished) — `{ sessionId, pid, trigger, contexts }`.
   */
  sessionStartHooks: 'session-start-hooks.jsonl',
  /**
   * One record per model request the fake makes at a turn's start, and at the continuation after its own mid-turn
   * compaction: the hook contexts of the last compaction its transcript holds — what the real CLI sends the model with
   * every request after a compaction — `{ sessionId, pid, phase, contexts }`.
   */
  restoreContexts: 'restore-contexts.jsonl',
  /**
   * One record per `control_response` the bot wrote that the fake READ (the verdict on a `can_use_tool` request):
   * `{ readAt, pid, requestId, behavior, message, answerCount }` — `message` is a deny's, `null` for an allow.
   */
  controlResponses: 'control-responses.jsonl',
  /** One record per `control_request` the bot wrote that the fake READ (an interrupt among them): `{ readAt, pid, subtype }`. */
  controlRequests: 'control-requests.jsonl',
} as const;

/**
 * The variable the launcher of the fake interactive TUI (`tmuxE2e/fakeClaudeTui.ts`) sets to the file the TUI appends
 * one `{ argv, pid }` line to per session launch — what a flow of the tmux backend reads its launch flags from.
 */
export const fakeClaudeTuiLaunchesEnvName = 'FAKE_CLAUDE_TUI_LAUNCHES';

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
  /** When the fake read the message, `Date.now()` — comparable with the bot's own timestamps (same host). */
  readAt: number;
  pid: number;
  issueKey: string;
  requestId: string | null;
  /** The whole text the agent was sent: header, issue, everything. */
  text: string;
}

/** One line of `control-responses.jsonl`: a verdict the bot wrote on a `can_use_tool` request. */
export interface FakeClaudeControlResponse {
  readAt: number;
  pid: number;
  requestId: string | null;
  behavior: string | null;
  /** A deny's message — what the agent reads as the tool's result; `null` for an allow. */
  message: string | null;
  answerCount: number;
}

/** One line of `control-requests.jsonl`: a control request the bot wrote (`interrupt`, `mcp_status`, …). */
export interface FakeClaudeControlRequest {
  readAt: number;
  pid: number;
  subtype: string | null;
}

/** One line of `tool-calls.jsonl`. */
/** The caption the fake's `send-file` mode sends its files with (`send_file_to_user`). */
export const fakeSendFileCaption = 'The run, recorded:';

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
 * but the agent allowlist, what a shell adds, the wrapper's own opt-in to the CLI's
 * session-state events, the account an agent runs under (`CLAUDE_CONFIG_DIR`: the bot sets it at the spawn of a conversation on a
 * non-default Claude account — a path, no secret) and the fake's own launcher variables.
 */
export function getForeignAgentEnvNames(envNames: readonly string[]): string[] {
  const allowedNames: readonly string[] = [...agentEnvironmentNames, ...shellAddedEnvNames, claudeSessionStateEventsVariableName, claudeConfigDirVariableName];
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

/** One server of the fake's `mcp_status` answer (see {@link fakeClaudeMcpServersFileName}). */
export interface FakeClaudeMcpServer {
  name: string;
  status: string;
}

/** One server of an `--mcp-config` file, as the fake and the process-level tests read it. */
export interface McpServerConfig {
  type?: string;
  url?: string;
  headers?: Record<string, string>;
}

/**
 * The name an agent's CLI sees the bot's MCP server under, written out here on purpose and not imported from the product: the
 * agent's tools read `mcp__charness__<tool>`, so a name that moves must break every flow that reaches the bot's tools.
 */
export const botMcpServerName = 'charness';

/** The bot MCP server: the entry named {@link botMcpServerName} of the `--mcp-config` files of a launch's `argv`. */
export function getBotMcpServer(argv: readonly string[]): McpServerConfig | null {
  for (const configPath of getFlagValues(argv, '--mcp-config')) {
    const config: { mcpServers?: Record<string, McpServerConfig> } = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const server = config.mcpServers?.[botMcpServerName];
    if (server?.type === 'http' && server.url) return server;
  }
  return null;
}

/** @description The conversation a session launch runs: its `--session-id`, or the `--resume` id. */
export function getLaunchSessionId(argv: readonly string[]): string | undefined {
  return getFlagValues(argv, '--session-id')[0] ?? getFlagValues(argv, '--resume')[0];
}

/** @name FakeClaudePreCompactHookRun @description One line of the fake's `pre-compact-hooks.jsonl`: what the `PreCompact` hooks printed for a compaction. */
export interface FakeClaudePreCompactHookRun {
  sessionId: string;
  pid: number;
  trigger: 'auto' | 'manual';
  instruction: string;
}

/** @name FakeClaudeSessionStartHookRun @description One line of the fake's `session-start-hooks.jsonl`: what the `SessionStart` `compact` hooks gave after a compaction. */
export interface FakeClaudeSessionStartHookRun {
  sessionId: string;
  pid: number;
  trigger: 'auto' | 'manual';
  contexts: string[];
}

/** @name FakeClaudeRestoreContext @description One line of the fake's `restore-contexts.jsonl`: the hook contexts a model request of the fake holds. */
export interface FakeClaudeRestoreContext {
  sessionId: string;
  pid: number;
  /** `turn`: a turn's first request; `continuation`: the request after the CLI's own mid-turn compaction. */
  phase: 'turn' | 'continuation';
  contexts: string[];
}

/** @name FakeClaudeHookContext @description One line of the fake's `hooks.jsonl`: what a `PostToolUse` hook gave the agent. */
export interface FakeClaudeHookContext {
  issueKey: string;
  pid: number;
  sessionId: string;
  additionalContext: string;
}
