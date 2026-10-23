import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  argvViolationExitCode,
  checkHasFlag,
  fakeClaudeLogFileNames,
  fakeClaudeCodeVersion,
  fakeClaudeCodeVersionOverrideFileName,
  fakeAskQuestion,
  fakeAskToolName,
  fakeClaudeCrashOnPromptFileName,
  fakeClaudeAlwaysUsageLimitFileName,
  fakeClaudeApiErrorDelayFileName,
  fakeClaudeApiErrorOnceFileName,
  fakeClaudeLoginFileName,
  fakeClaudeLoginUrl,
  fakeConsoleLogin,
  fakeClaudePlatformEnvName,
  fakeClaudeVersion,
  fakeCompactionCostUsd,
  fakeTurnCostUsd,
  fakeCompactionModelUsage,
  fakeCompactionResultUsage,
  fakeTurnUsage,
  fakeClaudeExitFlushDelayFileName,
  fakeClaudeIgnoreStopSignalsFileName,
  fakeClaudeRefuseLaunchFileName,
  getFakeClaudeTranscriptPath,
  getFakeClaudeUnrestorableConversationFileName,
  getFlagValues,
  getForeignAgentEnvNames,
  getLaunchSessionId,
  requiredJiraSessionFlags,
  sessionViolationExitCode,
} from './fakeClaudeContract';
import { readClaudeTranscriptContent } from '../../utils/claudeTranscriptContent';

/**
 * @description A stand-in for the `claude` CLI in the process-level tests (Jira
 * connector plan J7, R6, R11; request/answer plan S6–S9), started by charness
 * through `CLAUDE_BIN` in its private tmux server. It:
 *
 *  - for a Jira session (`FAKE_CLAUDE_PLATFORM=jira` from its launcher) refuses a
 *    session launch whose environment holds anything but the agent allowlist
 *    (R32) — an instance variable such as the tracker token;
 *  - records every launch's argv and, for a Jira session launch, REFUSES to run
 *    (a violation line and a non-zero exit) without the flags a
 *    Jira session must carry — on every launch path, a fresh `--session-id` and
 *    a `--resume` alike (R11); a Telegram topic's session carries neither;
 *  - like the real CLI, refuses a `--resume` of a conversation it never held and
 *    a `--session-id` already in use (a conversation exists once a transcript holds
 *    a message — a metadata-only file is none), so a resume by the wrong id cannot
 *    pass for the right one (a test can also make one conversation unrestorable: its transcript is fine and the CLI
 *    refuses it anyway, `getFakeClaudeUnrestorableConversationFileName`); a refused `--resume` answers with the CLI's
 *    own `error_during_execution` result on stdout before it exits;
 *  - like the real CLI, writes its metadata entries back into its transcript when it
 *    is signalled to stop after a turn — into a new file when the transcript was
 *    removed meanwhile (the stub of a lost conversation);
 *  - speaks the stream-json protocol: the `initialize` control handshake,
 *    `system/init`, the `--replay-user-messages` echo, `result` at a turn's end (with the conversation's running `total_cost_usd`, `fakeTurnCostUsd` per answered turn, continued across its processes);
 *  - in every turn streams what a real turn does (R6): a `system/status` frame
 *    (dropped by the classifier, as the real one is), a thinking block, and a
 *    tool call with its result — the call is what makes the adapter emit its
 *    `status` event — so a stream event of a Jira conversation that reached
 *    Telegram would show;
 *  - answers through `answer_request` over the bot MCP named in its
 *    `--mcp-config`, as a scripted mode in the issue's summary says.
 *
 * A `KEY-n` token in the request's text (an issue key, or a label the Telegram
 * test puts in its message) names the request in the logs and the answer body.
 *
 * Modes (`[fake:<mode>]` in the request's text), counted per request across launches:
 *  - `answer`      — answers `final` at once;
 *  - `silent-once` — ends its first turn without answering, answers the next;
 *  - `silent`      — ends EVERY turn without answering (the wake-up rules give up and alert);
 *  - `hang-once`   — starts working on its first turn and never ends it (the
 *    test kills the process), answers in the next turn;
 *  - `slow-once`   — its first turn works in SILENCE (a long tool call: no frame)
 *    for 45 s, then answers; later turns answer at once;
 *  - `progress`    — sends a `progress` note and ends the turn;
 *  - `finish-together` — the first request of an issue gets a `progress` note
 *    (it stays open); the turn of a LATER request of the same issue answers
 *    `final` for every request of the issue still owed one, oldest first,
 *    itself last — except a request its own header names as replaced, which
 *    the newer one covers (request/answer core S11, Jira plan R34);
 *  - `answer-after-queued` — the real Claude Code timing of a message written
 *    mid-turn: the first turn sends a `progress` note, then HOLDS until another
 *    user message is queued on stdin (at most `queuedMessageWaitMaxMs`), answers
 *    `final` and ends; the queued message then runs as the next turn. A turn
 *    whose header names requests this one replaced answers with a short pointer
 *    to the answer above instead of the result again (the header's rule);
 *  - `compact`     — asks the bot to compact the conversation (`compact_conversation`, as the agent does when a
 *    person asks it to), then answers `final`; the bot compacts when the turn ends;
 *  - `overflow`    — the CLI's own overflow compaction: a `compact_boundary` frame (trigger `auto`) that nobody
 *    asked for, then `final`;
 *  - `fetch-attachment` — calls `jira_get_attachment` for each id of a `[fetch:<id>,<id>]` token in the request's
 *    text, logs every outcome to `tool-calls.jsonl`, then answers `final`;
 *  - `run-tool`    — runs `e2e-tool` BY NAME on its own PATH and logs what it printed, then answers `final`;
 *  - `reply-to`    — answers `final` naming the comments of a `[reply-to:<id>,<id>]` token in the request's text in
 *    `replyToCommentIds` (what the bot then mentions; the answer's outcome is in `answers.jsonl`);
 *  - `background`  — answers `final`, then reports a background task that never
 *    ends (`system/background_tasks_changed`), so the process is WORKING between
 *    turns and the idle stop must keep it (lifecycle plan L-D2);
 *  - `ask`         — puts `fakeAskQuestion` to the user the way the real CLI does (an `AskUserQuestion` control
 *    request on stdout, blocked on the bot's `control_response`), logs the answer it got to `tool-calls.jsonl`, then
 *    answers `final` (in a turn without a request: ends the turn);
 *  - an `apiKeyHelper` in the launch's `--settings` (a file path or inline JSON; only the LAST `--settings` counts,
 *    as in the real CLI) is run through `/bin/sh` the way the CLI runs it: a plausible API key out of it makes the
 *    session report `apiKeySource: "apiKeyHelper"` in its init frames (else `"none"`, the subscription login) and a
 *    non-session `auth status --json` answer `api_key_helper`; the launch log says whether the helper produced a key
 *    (`isHelperKeyPlausible`) — never the key;
 *  - `auth login [--console|--claudeai]` behaves like the real subcommand in the bot's pty: it prints the sign-in link
 *    and the paste prompt, takes ONE code line, records the login in `CLAUDE_CONFIG_DIR` (`fakeClaudeLoginFileName`) and
 *    exits 0; `auth status --json` then answers for that login — a Console one as the CLI does (`api_key`, `/login
 *    managed key`, the email and organization of `fakeConsoleLogin`), a subscription one as `claude.ai`;
 *  - (while `fakeClaudeAlwaysUsageLimitFileName` exists in the state dir, EVERY turn ends on a limit, whatever its mode;
 *    `fakeClaudeApiErrorOnceFileName` ends the NEXT turn on the API error its content spells, after the delay in
 *    `fakeClaudeApiErrorDelayFileName` while that exists);
 *  - `usage-limit-once` — its first turn ends the way a subscription limit does: an error `result` saying the
 *    session limit is hit and when it resets (the text of a `[limit-resets:<ISO instant or clock>]` token in the
 *    request's text); the next turn — the one the bot sends after it moved the topic to another account —
 *    answers `final`. Also honoured by a turn WITHOUT a request (a topic whose view has requests off), for the
 *    prompt carrying the token.
 *
 * Like the real CLI, a user message that arrives mid-turn is NEVER read inside
 * that turn: turns run one at a time, in arrival order.
 *
 * A `/compact` user turn is answered like the real CLI's: a `compact_status`
 * success, a `compact_boundary` with token counts and a `result` whose `usage`
 * is all zero with the summary call under `modelUsage` — logged to
 * `compactions.jsonl` with the session it compacted.
 *
 * Paths come from the environment its launcher script sets:
 * `FAKE_CLAUDE_LOG_DIR` (launches, violations, answers, turns) and
 * `FAKE_CLAUDE_STATE_DIR` (per-request turn counts, the conversations held).
 */

export type FakeClaudeMode = 'answer' | 'silent-once' | 'silent' | 'hang-once' | 'slow-once' | 'progress' | 'finish-together' | 'answer-after-queued' | 'background' | 'compact' | 'overflow' | 'fetch-attachment' | 'run-tool' | 'reply-to' | 'usage-limit-once' | 'ask';
const fakeModes: readonly FakeClaudeMode[] = ['answer', 'silent-once', 'silent', 'hang-once', 'slow-once', 'progress', 'finish-together', 'answer-after-queued', 'background', 'compact', 'overflow', 'fetch-attachment', 'run-tool', 'reply-to', 'usage-limit-once', 'ask'];
/** How long an `answer-after-queued` turn waits for the next message before it answers anyway (a poll is 10 s in the tests). */
const queuedMessageWaitMaxMs = 40 * 1000;
/** How long a `slow-once` first turn works in silence before it answers — longer than a bot stop plus a boot. */
const slowTurnMs = 45_000;
/** The literal slash command the bot writes as a user turn to compact the session. */
const compactCommandText = '/compact';
/** The `task_id` of the background task a `background` turn leaves running (never ends: the test kills the process). */
const backgroundTaskId = 'fake-background-task';

const requestIdRe = /req_[A-Za-z0-9_-]+/;
const issueKeyRe = /\b([A-Z][A-Z0-9]+-\d+)\b/;
const modeRe = /\[fake:([a-z-]+)\]/;
const answerToolName = 'answer_request';
const compactToolName = 'compact_conversation';
const attachmentToolName = 'jira_get_attachment';
/** The program `run-tool` runs by name: found only on a PATH the connector's `agentBinaries` put it on. */
const probeToolName = 'e2e-tool';
const fetchIdsRe = /\[fetch:([0-9,]+)\]/;
const replyToIdsRe = /\[reply-to:([0-9,]+)\]/;
const limitResetsRe = /\[limit-resets:([^\]]+)\]/;
/** The request header's line that the requester sees neither the agent's plain text nor its thinking (`requests/requestHeader.ts`). */
const requesterDoesNotSeePlainTextPhrase = 'does not see your plain text output or your thinking';
/** The request header's line naming the requests this one replaced (`requests/requestHeader.ts`); group 1 lists their ids. */
const supersededRequestsLineRe = /It replaces the same requester's earlier requests? ((?:req_[A-Za-z0-9_-]+(?:, )?)+)\. If you already answered/;
/** How much of a stdin line that is not JSON the error message quotes. */
const skippedLinePreviewChars = 200;

/** An Anthropic API key, as the helper of a launch's settings must print it. */
const plausibleApiKeyRe = /^sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}$/;

/** Where this launch takes its API key from, as the real CLI would decide it (see the module's modes): set by `main`. */
let launchApiKeySource: 'apiKeyHelper' | 'none' = 'none';

/**
 * @description The API key source of a launch: the `apiKeyHelper` of its LAST `--settings` (a JSON string or a file), run
 * through `/bin/sh`; `isHelperKeyPlausible` is `null` without a helper. The key itself never leaves this function.
 */
function readLaunchApiKeySource(argv: readonly string[]): { source: 'apiKeyHelper' | 'none'; isHelperKeyPlausible: boolean | null } {
  const settingsArg = getFlagValues(argv, '--settings').at(-1);
  if (settingsArg === undefined) return { source: 'none', isHelperKeyPlausible: null };
  let settings: unknown;
  try {
    settings = JSON.parse(settingsArg.trimStart().startsWith('{') ? settingsArg : fs.readFileSync(settingsArg, 'utf8'));
  } catch {
    return { source: 'none', isHelperKeyPlausible: null };
  }
  const helper = settings && typeof settings === 'object' ? (settings as { apiKeyHelper?: unknown }).apiKeyHelper : undefined;
  if (typeof helper !== 'string') return { source: 'none', isHelperKeyPlausible: null };
  const output = spawnSync('/bin/sh', ['-c', helper], { encoding: 'utf8' }).stdout?.trim() ?? '';
  const isHelperKeyPlausible = plausibleApiKeyRe.test(output);
  return { source: isHelperKeyPlausible ? 'apiKeyHelper' : 'none', isHelperKeyPlausible };
}

/** The login `auth login` recorded in a config directory (`fakeClaudeLoginFileName`), `null` when there is none. */
function readFakeLogin(): { method: 'console' | 'claudeai' } | null {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (!configDir) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(configDir, fakeClaudeLoginFileName), 'utf8')) as { method: 'console' | 'claudeai' };
  } catch {
    return null;
  }
}

/** `auth status --json` the way the real CLI words it: the helper's key outranks a login's; `null` = no sign-in known. */
function getFakeAuthStatus(apiKeySource: 'apiKeyHelper' | 'none'): Record<string, unknown> | null {
  if (apiKeySource === 'apiKeyHelper') return { loggedIn: true, authMethod: 'api_key_helper', apiProvider: 'firstParty', apiKeySource: 'apiKeyHelper' };
  const login = readFakeLogin();
  if (login?.method === 'console') return { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty', apiKeySource: '/login managed key', ...fakeConsoleLogin };
  if (login?.method === 'claudeai') return { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: fakeConsoleLogin.email, subscriptionType: 'max' };
  return null;
}

/**
 * @description `claude auth login` in the bot's pty: the link and the paste prompt, then ONE line — the code — recorded
 * as the directory's login, and exit 0 (the bot reads the outcome from `auth status`). A stopped login records nothing.
 */
async function runFakeAuthLogin(argv: readonly string[]): Promise<void> {
  const method = argv.includes('--console') ? 'console' : 'claudeai';
  process.stdout.write(`Opening browser to sign in…\nIf the browser didn't open, visit: ${fakeClaudeLoginUrl}&method=${method}\nPaste code here if prompted > `);
  const code = await new Promise<string>((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (line: string) => resolve(line.trim()));
  });
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (configDir && code !== '') fs.writeFileSync(path.join(configDir, fakeClaudeLoginFileName), JSON.stringify({ method }));
  process.stdout.write('\nLogin successful.\n');
  process.exit(0);
}

/** Resolved when a user message is queued on stdin while a turn runs (`answer-after-queued`). */
let queuedUserMessageWaiters: Array<() => void> = [];

function notifyUserMessageQueued(): void {
  const waiters = queuedUserMessageWaiters;
  queuedUserMessageWaiters = [];
  for (const resolve of waiters) resolve();
}

/** Wait until a user message is queued behind the running turn, or `queuedMessageWaitMaxMs` passed. */
function waitForQueuedUserMessage(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      queuedUserMessageWaiters = queuedUserMessageWaiters.filter((waiter) => waiter !== onQueued);
      resolve();
    }, queuedMessageWaitMaxMs);
    const onQueued = (): void => {
      clearTimeout(timer);
      resolve();
    };
    queuedUserMessageWaiters.push(onQueued);
  });
}

interface RequestTurnState {
  mode: FakeClaudeMode;
  issueKey: string;
  turnCount: number;
  /** Epoch ms of the request's first turn: the order `finish-together` answers in. */
  firstTurnAt: number;
  /** Set once a closing answer was sent for the request (`finish-together`). */
  isAnswered?: boolean;
}

/** A request's state with the request id its file is named after. */
interface KnownRequest extends RequestTurnState {
  requestId: string;
}

interface McpServerConfig {
  type?: string;
  url?: string;
  headers?: Record<string, string>;
}

/** A type alias, not an interface: the MCP client takes the arguments as a string-keyed record. */
type AnswerRequestArgs = {
  requestId: string;
  kind: string;
  body: string;
  replyToCommentIds?: string[];
};

/** A stdin line of the stream-json protocol — only the fields the fake reads. */
interface StdinFrame {
  type?: string;
  request_id?: string;
  request?: { subtype?: string };
  message?: { content?: string };
  /** A `control_response` the bot wrote: the verdict on a `can_use_tool` request, with the answers an `AskUserQuestion` collected. */
  response?: { request_id?: string; response?: { behavior?: string; updatedInput?: { answers?: Record<string, string> } } };
}

function appendJsonLine(fileName: string, record: object): void {
  const logDir = process.env.FAKE_CLAUDE_LOG_DIR;
  if (!logDir) throw new Error('FAKE_CLAUDE_LOG_DIR is not set');
  fs.appendFileSync(path.join(logDir, fileName), `${JSON.stringify(record)}\n`);
}

function writeStdout(frame: object): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function getStateDir(): string {
  const stateDir = process.env.FAKE_CLAUDE_STATE_DIR;
  if (!stateDir) throw new Error('FAKE_CLAUDE_STATE_DIR is not set');
  return stateDir;
}

/** Add `amountUsd` to the conversation's running cost (kept in the state dir across its processes); the new total. */
function addConversationCost(sessionId: string, amountUsd: number): number {
  const costPath = path.join(getStateDir(), `conversation-cost-${sessionId}`);
  const total = (fs.existsSync(costPath) ? Number(fs.readFileSync(costPath, 'utf8')) : 0) + amountUsd;
  fs.writeFileSync(costPath, total.toString());
  return total;
}

function getStatePath(requestId: string): string {
  return path.join(getStateDir(), `${requestId}.json`);
}

/** The CLI version this launch reports on `init`: the override file's content while a test keeps one, else the fake's own. */
function getReportedClaudeCodeVersion(): string {
  const overridePath = path.join(getStateDir(), fakeClaudeCodeVersionOverrideFileName);
  return fs.existsSync(overridePath) ? fs.readFileSync(overridePath, 'utf8').trim() : fakeClaudeCodeVersion;
}

/** The real CLI's on-disk transcript of a conversation ({@link getFakeClaudeTranscriptPath}), a line per message. */
function getTranscriptPath(sessionId: string): string {
  return getFakeClaudeTranscriptPath({ homeDir: os.homedir(), configDir: process.env.CLAUDE_CONFIG_DIR, workDir: process.cwd(), sessionId });
}

/** A conversation is held once its transcript holds a message; a missing, emptied or metadata-only file is a lost one. */
async function checkIsConversationHeld(sessionId: string): Promise<boolean> {
  return (await readClaudeTranscriptContent(getTranscriptPath(sessionId))) === 'conversation';
}

/** What this process last recorded into its transcript: the `last-prompt` its exit flush writes back. */
let lastRecordedPrompt: string | null = null;

function recordTranscriptMessage(sessionId: string, content: string): void {
  lastRecordedPrompt = content;
  const transcriptPath = getTranscriptPath(sessionId);
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.appendFileSync(transcriptPath, `${JSON.stringify({ type: 'user', sessionId, message: { role: 'user', content } })}\n`);
}

/**
 * The metadata entries the real CLI writes back into its transcript at exit (probe, CLI 2.1.302): the whole content of a
 * transcript that was removed under a live process. They carry no message, so no launch flag accepts the file.
 */
function writeExitMetadata(sessionId: string): void {
  const transcriptPath = getTranscriptPath(sessionId);
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  const entries = [
    { type: 'last-prompt', lastPrompt: lastRecordedPrompt, leafUuid: randomUUID(), sessionId },
    { type: 'atis-latch', atis: '', sessionId },
    { type: 'cost-state', sessionId, totalCostUSD: 0 },
  ];
  fs.appendFileSync(transcriptPath, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
}

/**
 * How long after a stop signal the exit flush runs: the content of {@link fakeClaudeExitFlushDelayFileName} while a test
 * keeps one, else `null` (no flush: the process dies at once).
 */
function getExitFlushDelayMs(): number | null {
  const delayPath = path.join(getStateDir(), fakeClaudeExitFlushDelayFileName);
  return fs.existsSync(delayPath) ? Number(fs.readFileSync(delayPath, 'utf8').trim()) : null;
}

/**
 * Stopped by a signal, a process that took a turn writes its metadata entries back and exits after
 * {@link getExitFlushDelayMs} — when a test asked for the flush; one that never took a turn writes nothing (the real CLI
 * too) and exits at once, and so does every process while no test asked: a flush at a teardown would race its removal of
 * the instance's directories. While a test keeps {@link fakeClaudeIgnoreStopSignalsFileName} the signals are ignored.
 */
function exitOnStopSignal(sessionId: string): void {
  let isExiting = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (isExiting || fs.existsSync(path.join(getStateDir(), fakeClaudeIgnoreStopSignalsFileName))) return;
    isExiting = true;
    const exitCode = 128 + (signal === 'SIGHUP' ? 1 : 15);
    const flushDelayMs = getExitFlushDelayMs();
    if (lastRecordedPrompt === null || flushDelayMs === null) process.exit(exitCode);
    setTimeout(() => {
      writeExitMetadata(sessionId);
      process.exit(exitCode);
    }, flushDelayMs);
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);
}

/**
 * @description What the real CLI says when it refuses this launch's conversation id, or `null` when it would run. The
 * refusal of a `--resume` is told on stdout first, as the CLI does: an `error_during_execution` result naming it.
 */
async function getSessionViolation(argv: readonly string[]): Promise<string | null> {
  const resumeId = getFlagValues(argv, '--resume')[0];
  if (resumeId !== undefined && (!(await checkIsConversationHeld(resumeId)) || fs.existsSync(path.join(getStateDir(), getFakeClaudeUnrestorableConversationFileName(resumeId))))) {
    const reason = `No conversation found with session ID: ${resumeId}`;
    writeStdout({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, session_id: resumeId, usage: { input_tokens: 0, output_tokens: 0 }, errors: [reason] });
    return reason;
  }
  const freshId = getFlagValues(argv, '--session-id')[0];
  if (freshId !== undefined && await checkIsConversationHeld(freshId)) {
    return `Session ID ${freshId} is already in use.`;
  }
  return null;
}

function readRequestState(requestId: string): RequestTurnState | null {
  const statePath = getStatePath(requestId);
  return fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
}

function writeRequestState(requestId: string, state: RequestTurnState): void {
  fs.writeFileSync(getStatePath(requestId), JSON.stringify(state));
}

/** Every request of `issueKey` this fake has seen, oldest first. */
function listKnownRequests(issueKey: string): KnownRequest[] {
  return fs.readdirSync(getStateDir())
    .filter((fileName) => requestIdRe.test(fileName) && fileName.endsWith('.json'))
    .map((fileName): KnownRequest => {
      const state: RequestTurnState = JSON.parse(fs.readFileSync(path.join(getStateDir(), fileName), 'utf8'));
      return { requestId: fileName.slice(0, -'.json'.length), ...state };
    })
    .filter((request) => request.issueKey === issueKey)
    .sort((a, b) => a.firstTurnAt - b.firstTurnAt);
}

/**
 * The mode the request's text names; a text that names none (a delta prompt leaves the unchanged summary out,
 * prompt context S4) keeps the mode the issue's earlier requests had — the conversation remembers it, as a
 * real agent's context does.
 */
function getMode(text: string, issueKey: string): FakeClaudeMode {
  const named = modeRe.exec(text)?.[1];
  return fakeModes.find((mode) => mode === named) ?? listKnownRequests(issueKey)[0]?.mode ?? 'answer';
}

/** The bot MCP server: the `http` entry of the `--mcp-config` files. */
function getBotMcpServer(argv: readonly string[]): McpServerConfig | null {
  for (const configPath of getFlagValues(argv, '--mcp-config')) {
    const config: { mcpServers?: Record<string, McpServerConfig> } = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const server = Object.values(config.mcpServers ?? {}).find((candidate) => candidate.type === 'http' && candidate.url);
    if (server) return server;
  }
  return null;
}

async function callBotTool(server: McpServerConfig, toolName: string, args: Record<string, string | string[]>): Promise<string> {
  if (!server.url) throw new Error('the bot MCP server has no url');
  const client = new Client({ name: 'fake-claude', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers ?? {} } }));
  try {
    const result = CallToolResultSchema.parse(await client.callTool({ name: toolName, arguments: args }));
    const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
    return result.isError ? `error: ${text}` : text;
  } finally {
    await client.close();
  }
}

function callAnswerRequest(server: McpServerConfig, args: AnswerRequestArgs): Promise<string> {
  return callBotTool(server, answerToolName, args);
}

/** R6: what a real turn streams before its answer — a `system/status` frame, a thinking block, a tool call and its result. */
function emitTurnActivity(sessionId: string, issueKey: string): void {
  writeStdout({ type: 'system', subtype: 'status', status: 'requesting', session_id: sessionId });
  writeStdout({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: `Looking at ${issueKey}.` } } });
  const toolUseId = `toolu_${randomUUID()}`;
  writeStdout({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Read', input: { file_path: 'README.md' } }] },
    parent_tool_use_id: null,
    session_id: sessionId,
  });
  writeStdout({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'no such file' }] },
    parent_tool_use_id: null,
    session_id: sessionId,
  });
  writeStdout({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: `Working on ${issueKey}.` } } });
}

function endTurn(sessionId: string, resultText: string): void {
  writeStdout({ type: 'result', subtype: 'success', is_error: false, result: resultText, session_id: sessionId, usage: fakeTurnUsage, total_cost_usd: addConversationCost(sessionId, fakeTurnCostUsd) });
}

/** A turn the provider refused for a usage limit: an error `result` whose text names the window and its reset. */
/**
 * A turn refused for a subscription limit, the way the real CLI records it: the API-error entry in the transcript
 * (`isApiErrorMessage`, with its `timestamp`), then the error `result` on stdout.
 */
function endTurnOnUsageLimit(sessionId: string, resetsAt: string): void {
  const errorText = `You've hit your session limit · resets ${resetsAt}`;
  const transcriptPath = getTranscriptPath(sessionId);
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.appendFileSync(transcriptPath, `${JSON.stringify({ type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', timestamp: new Date().toISOString(), sessionId, message: { role: 'assistant', content: [{ type: 'text', text: errorText }] } })}\n`);
  writeStdout({ type: 'result', subtype: 'success', is_error: true, result: errorText, session_id: sessionId, usage: fakeTurnUsage, total_cost_usd: addConversationCost(sessionId, 0) });
}

/** The `can_use_tool` requests the fake is blocked on, by `request_id`: resolved with the answers the bot's `control_response` carries. */
const controlResponseWaiters = new Map<string, (answers: Record<string, string>) => void>();

/**
 * The real CLI's `AskUserQuestion`: a `can_use_tool` control request on stdout, then the turn is blocked until the bot
 * writes the matching `control_response` on stdin. Resolves with what the user answered to the question.
 */
async function askUserQuestion(): Promise<string> {
  const askRequestId = `req_ask_${randomUUID()}`;
  const answered = new Promise<Record<string, string>>((resolve) => controlResponseWaiters.set(askRequestId, resolve));
  writeStdout({
    type: 'control_request',
    request_id: askRequestId,
    request: {
      subtype: 'can_use_tool',
      tool_name: fakeAskToolName,
      tool_use_id: `toolu_${randomUUID()}`,
      input: {
        questions: [{
          header: fakeAskQuestion.header,
          question: fakeAskQuestion.question,
          multiSelect: false,
          options: [
            { label: fakeAskQuestion.shortOptionLabel, description: 'Quick.' },
            { label: fakeAskQuestion.longOptionLabel, description: 'Thorough.' },
          ],
        }],
      },
    },
  });
  return (await answered)[fakeAskQuestion.question] ?? 'no answer';
}

/** The real CLI's answer to a `/compact` turn: status, boundary with token counts, result. */
function runCompactionTurn(sessionId: string): void {
  writeStdout({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake-model', apiKeySource: launchApiKeySource, tools: [], mcp_servers: [], claude_code_version: getReportedClaudeCodeVersion() });
  writeStdout({ type: 'system', subtype: 'status', status: 'compacting', session_id: sessionId });
  writeStdout({ type: 'system', subtype: 'status', compact_result: 'success', session_id: sessionId });
  writeStdout({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 25_600, post_tokens: 2_800 }, session_id: sessionId });
  appendJsonLine(fakeClaudeLogFileNames.compactions, { sessionId, pid: process.pid });
  // The real CLI's compaction result: an all-zero `usage`, the summary call only under `modelUsage`.
  writeStdout({ type: 'result', subtype: 'success', is_error: false, result: '', session_id: sessionId, usage: fakeCompactionResultUsage, modelUsage: fakeCompactionModelUsage, total_cost_usd: addConversationCost(sessionId, fakeCompactionCostUsd) });
}

/** The model a turn reports on `system/init`: the one the process was launched with (`--model`), else the fake's own. */
function getReportedModel(argv: readonly string[]): string {
  return getFlagValues(argv, '--model')[0] ?? 'fake-model';
}

async function runTurn(argv: readonly string[], sessionId: string, content: string): Promise<void> {
  recordTranscriptMessage(sessionId, content);
  writeStdout({ type: 'system', subtype: 'init', session_id: sessionId, model: getReportedModel(argv), apiKeySource: launchApiKeySource, tools: [], mcp_servers: [], claude_code_version: getReportedClaudeCodeVersion() });
  writeStdout({ type: 'user', message: { role: 'user', content }, session_id: sessionId });
  const apiErrorOncePath = path.join(getStateDir(), fakeClaudeApiErrorOnceFileName);
  if (fs.existsSync(apiErrorOncePath)) {
    const errorText = fs.readFileSync(apiErrorOncePath, 'utf8').trim();
    fs.rmSync(apiErrorOncePath, { force: true });
    appendJsonLine(fakeClaudeLogFileNames.turns, { requestId: null, issueKey: issueKeyRe.exec(content)?.[1] ?? 'unknown', isRequestPrompt: false, isPlainTextHidden: false, supersededRequestIds: [], turnCount: 1, pid: process.pid });
    const apiErrorDelayPath = path.join(getStateDir(), fakeClaudeApiErrorDelayFileName);
    if (fs.existsSync(apiErrorDelayPath)) await new Promise((resolve) => setTimeout(resolve, Number(fs.readFileSync(apiErrorDelayPath, 'utf8').trim())));
    writeStdout({ type: 'result', subtype: 'success', is_error: true, result: errorText, session_id: sessionId, usage: fakeTurnUsage, total_cost_usd: addConversationCost(sessionId, 0) });
    return;
  }
  const alwaysUsageLimitPath = path.join(getStateDir(), fakeClaudeAlwaysUsageLimitFileName);
  if (fs.existsSync(alwaysUsageLimitPath)) {
    appendJsonLine(fakeClaudeLogFileNames.turns, { requestId: null, issueKey: issueKeyRe.exec(content)?.[1] ?? 'unknown', isRequestPrompt: false, isPlainTextHidden: false, supersededRequestIds: [], turnCount: 1, pid: process.pid });
    endTurnOnUsageLimit(sessionId, fs.readFileSync(alwaysUsageLimitPath, 'utf8').trim());
    return;
  }
  const requestId = requestIdRe.exec(content)?.[0];
  if (!requestId) {
    // A turn without a request (a topic whose view has requests off): logged, so a test can prove none was opened.
    appendJsonLine(fakeClaudeLogFileNames.turns, { requestId: null, issueKey: issueKeyRe.exec(content)?.[1] ?? 'unknown', isRequestPrompt: false, isPlainTextHidden: false, supersededRequestIds: [], turnCount: 1, pid: process.pid });
    const noRequestIssueKey = issueKeyRe.exec(content)?.[1] ?? 'unknown';
    emitTurnActivity(sessionId, noRequestIssueKey);
    // A turn without a request honours two modes, by the token in ITS OWN text: `ask` (a question needs no request
    // to be put to the user) and `usage-limit-once` (a limit needs none to stop the turn; the bot's later "continue"
    // nudge carries no token, so it is answered — the "once").
    const noRequestMode = modeRe.exec(content)?.[1];
    if (noRequestMode === 'usage-limit-once') {
      endTurnOnUsageLimit(sessionId, limitResetsRe.exec(content)?.[1] ?? 'in 1h');
      return;
    }
    if (noRequestMode === 'ask') {
      appendJsonLine(fakeClaudeLogFileNames.toolCalls, { issueKey: noRequestIssueKey, tool: fakeAskToolName, args: { question: fakeAskQuestion.question }, outcome: await askUserQuestion() });
    }
    endTurn(sessionId, 'Nothing to do.');
    return;
  }
  const isRequestPrompt = content.includes(`[Request ${requestId}`);
  // The header's line for a requester who never sees the agent's plain text (a Telegram answers-only topic, a tracker).
  const isPlainTextHidden = content.includes(requesterDoesNotSeePlainTextPhrase);
  const supersededRequestIds = supersededRequestsLineRe.exec(content)?.[1].split(', ') ?? [];
  const previous = readRequestState(requestId);
  const issueKey = issueKeyRe.exec(content)?.[1] ?? 'unknown';
  const state: RequestTurnState = previous ?? { mode: getMode(content, issueKey), issueKey, turnCount: 0, firstTurnAt: Date.now() };
  state.turnCount += 1;
  writeRequestState(requestId, state);
  appendJsonLine(fakeClaudeLogFileNames.turns, { requestId, issueKey: state.issueKey, isRequestPrompt, isPlainTextHidden, supersededRequestIds, turnCount: state.turnCount, pid: process.pid });

  emitTurnActivity(sessionId, state.issueKey);
  const isFirstTurn = state.turnCount === 1;
  if (state.mode === 'silent' || (state.mode === 'silent-once' && isFirstTurn)) {
    endTurn(sessionId, 'Thinking about it.');
    return;
  }
  if (state.mode === 'usage-limit-once' && isFirstTurn) {
    endTurnOnUsageLimit(sessionId, limitResetsRe.exec(content)?.[1] ?? 'in 1h');
    return;
  }
  if (state.mode === 'hang-once' && isFirstTurn) {
    await new Promise<never>(() => {});
  }
  if (state.mode === 'slow-once' && isFirstTurn) {
    await new Promise<void>((resolve) => setTimeout(resolve, slowTurnMs));
  }
  const server = getBotMcpServer(argv);
  const replyToCommentIds = state.mode === 'reply-to' ? (replyToIdsRe.exec(content)?.[1] ?? '').split(',').filter(Boolean) : [];
  const answer = async (answeredRequestId: string, kind: string, turnCount: number, body = `Fake ${kind} answer for ${state.issueKey} (${state.mode}, turn ${turnCount}).`): Promise<string> => {
    const outcome = server
      ? await callAnswerRequest(server, { requestId: answeredRequestId, kind, body, ...(replyToCommentIds.length > 0 ? { replyToCommentIds } : {}) })
      : 'error: no bot MCP server in --mcp-config';
    appendJsonLine(fakeClaudeLogFileNames.answers, { requestId: answeredRequestId, issueKey: state.issueKey, kind, outcome });
    return body;
  };
  if (state.mode === 'answer-after-queued') {
    if (supersededRequestIds.length > 0) {
      // The header's rule: the replaced requests were answered in the turn before — a pointer, not the result again.
      endTurn(sessionId, await answer(requestId, 'final', state.turnCount, `Answered above for ${state.issueKey} (covers ${supersededRequestIds.join(', ')}).`));
      return;
    }
    await answer(requestId, 'progress', state.turnCount);
    await waitForQueuedUserMessage();
    endTurn(sessionId, await answer(requestId, 'final', state.turnCount));
    return;
  }
  if (state.mode === 'finish-together') {
    const owedRequests = listKnownRequests(state.issueKey).filter((request) => request.requestId !== requestId && request.isAnswered !== true);
    if (owedRequests.length === 0) {
      endTurn(sessionId, await answer(requestId, 'progress', state.turnCount));
      return;
    }
    for (const { requestId: owedRequestId, ...owedState } of owedRequests) {
      // A replaced request is covered by this one: a real agent answers only the request in front of it.
      if (!supersededRequestIds.includes(owedRequestId)) await answer(owedRequestId, 'final', owedState.turnCount);
      writeRequestState(owedRequestId, { ...owedState, isAnswered: true });
    }
    writeRequestState(requestId, { ...state, isAnswered: true });
    endTurn(sessionId, await answer(requestId, 'final', state.turnCount));
    return;
  }
  const logToolCall = (tool: string, args: Record<string, string>, outcome: string): void => {
    appendJsonLine(fakeClaudeLogFileNames.toolCalls, { issueKey: state.issueKey, tool, args, outcome });
  };
  if (state.mode === 'compact' && server) {
    logToolCall(compactToolName, { reason: 'a person asked' }, await callBotTool(server, compactToolName, { reason: 'a person asked' }));
  }
  if (state.mode === 'overflow') {
    // The CLI's own compaction at a context overflow: nobody asked for it, and no `/compact` turn is running.
    writeStdout({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 190_000, post_tokens: 9_000 }, session_id: sessionId });
  }
  if (state.mode === 'fetch-attachment' && server) {
    for (const attachmentId of (fetchIdsRe.exec(content)?.[1] ?? '').split(',').filter(Boolean)) {
      logToolCall(attachmentToolName, { attachmentId }, await callBotTool(server, attachmentToolName, { attachmentId }));
    }
  }
  if (state.mode === 'ask') {
    logToolCall(fakeAskToolName, { question: fakeAskQuestion.question }, await askUserQuestion());
  }
  if (state.mode === 'run-tool') {
    const ran = spawnSync(probeToolName, [], { encoding: 'utf8' });
    logToolCall(probeToolName, {}, ran.error ? `error: ${ran.error.message}` : ran.stdout.trim());
  }
  const kind = state.mode === 'progress' ? 'progress' : 'final';
  endTurn(sessionId, await answer(requestId, kind, state.turnCount));
  if (state.mode === 'background') {
    // Reported AFTER the result, as the CLI does for a task the turn left running.
    writeStdout({ type: 'system', subtype: 'background_tasks_changed', session_id: sessionId, tasks: [{ task_id: backgroundTaskId, task_type: 'local_bash', description: 'sleep', status: 'running' }] });
  }
}

/**
 * The pid of an EARLIER process of this launch's conversation that is still running, else `null`: two CLIs on one
 * conversation id at once is what a launch that does not wait for the process it replaces produces. Each launch of a
 * conversation records its pid in the state dir for the next one to look up.
 */
function takeOverlappingProcessPid(sessionId: string | undefined): number | null {
  if (sessionId === undefined) return null;
  const pidPath = path.join(getStateDir(), `conversation-${sessionId}.pid`);
  const previousPid = fs.existsSync(pidPath) ? Number(fs.readFileSync(pidPath, 'utf8')) : null;
  fs.writeFileSync(pidPath, process.pid.toString());
  if (previousPid === null || previousPid === process.pid) return null;
  try {
    process.kill(previousPid, 0);
    return previousPid;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const isSessionLaunch = checkHasFlag(argv, ['--input-format', 'stream-json']);
  const overlapsPid = isSessionLaunch ? takeOverlappingProcessPid(getLaunchSessionId(argv)) : null;
  const apiKey = readLaunchApiKeySource(argv);
  launchApiKeySource = apiKey.source;
  // Variable NAMES only — the test checks what reached the agent, never a value.
  appendJsonLine(fakeClaudeLogFileNames.launches, {
    argv, isSessionLaunch, pid: process.pid, overlapsPid, envNames: Object.keys(process.env), home: process.env.HOME, path: process.env.PATH,
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null, isHelperKeyPlausible: apiKey.isHelperKeyPlausible,
  });
  if (!isSessionLaunch) {
    if (argv.includes('auth') && argv.includes('login')) {
      await runFakeAuthLogin(argv);
      return;
    }
    // `claude auth status` of a directory with a key or a login the fake knows: what the real CLI answers (exit 0).
    // Every other call gets the version line it always got (a status the bot cannot parse is "unknown", never "signed out").
    const status = argv.includes('auth') && argv.includes('status') ? getFakeAuthStatus(apiKey.source) : null;
    process.stdout.write(status === null ? `${fakeClaudeVersion}\n` : `${JSON.stringify(status)}\n`);
    return;
  }
  if (process.env[fakeClaudePlatformEnvName] === 'jira') {
    const missingFlags = requiredJiraSessionFlags.filter((flag) => !checkHasFlag(argv, flag));
    if (missingFlags.length > 0) {
      const reason = `missing ${missingFlags.map((flag) => flag.join(' ')).join(', ')}`;
      appendJsonLine(fakeClaudeLogFileNames.violations, { reason, argv });
      process.stderr.write(`fake claude: ${reason}\n`);
      process.exit(argvViolationExitCode);
    }
    // R32: an agent of a tracker conversation starts with the allowlist only — no instance variable, no secret.
    const foreignEnvNames = getForeignAgentEnvNames(Object.keys(process.env));
    if (foreignEnvNames.length > 0) {
      const reason = `environment carries ${foreignEnvNames.join(', ')}`;
      appendJsonLine(fakeClaudeLogFileNames.violations, { reason, argv });
      process.stderr.write(`fake claude: ${reason}\n`);
      process.exit(argvViolationExitCode);
    }
  }
  if (fs.existsSync(path.join(getStateDir(), fakeClaudeRefuseLaunchFileName))) {
    process.stderr.write('fake claude: refused to start\n');
    process.exit(1);
  }
  const sessionViolation = await getSessionViolation(argv);
  if (sessionViolation !== null) {
    appendJsonLine(fakeClaudeLogFileNames.violations, { reason: sessionViolation, argv });
    process.stderr.write(`${sessionViolation}\n`);
    process.exit(sessionViolationExitCode);
  }
  const sessionId = getLaunchSessionId(argv) ?? randomUUID();
  exitOnStopSignal(sessionId);

  // One turn at a time, in arrival order, as the real CLI does.
  let turnChain: Promise<void> = Promise.resolve();
  const lines = readline.createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let frame: StdinFrame;
    try {
      frame = JSON.parse(line);
    } catch {
      process.stderr.write(`fake claude: skipped a stdin line that is not JSON: ${line.slice(0, skippedLinePreviewChars)}\n`);
      return;
    }
    if (frame.type === 'control_request') {
      writeStdout({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } });
      return;
    }
    if (frame.type === 'control_response') {
      const waiter = frame.response?.request_id ? controlResponseWaiters.get(frame.response.request_id) : undefined;
      if (waiter && frame.response?.request_id) {
        controlResponseWaiters.delete(frame.response.request_id);
        waiter(frame.response.response?.updatedInput?.answers ?? {});
      }
      return;
    }
    if (frame.type !== 'user' || typeof frame.message?.content !== 'string') return;
    const content = frame.message.content;
    // `/compact`, or `/compact <the bot's summary guidance>` (D3) — the real CLI parses either.
    if (content.trim() === compactCommandText || content.startsWith(`${compactCommandText} `)) {
      turnChain = turnChain.then(() => runCompactionTurn(sessionId));
      return;
    }
    const promptIssueKey = issueKeyRe.exec(content)?.[1] ?? 'unknown';
    appendJsonLine(fakeClaudeLogFileNames.prompts, { pid: process.pid, issueKey: promptIssueKey, requestId: requestIdRe.exec(content)?.[0] ?? null, text: content });
    if (fs.existsSync(path.join(getStateDir(), fakeClaudeCrashOnPromptFileName))) {
      // The message was read and neither echoed nor answered: the prompt never gets taken in.
      process.exit(1);
    }
    notifyUserMessageQueued();
    turnChain = turnChain.then(() => runTurn(argv, sessionId, content)).catch((error: Error) => {
      process.stderr.write(`fake claude: turn failed: ${error.stack ?? error.message}\n`);
      endTurn(sessionId, 'The turn failed.');
    });
  });
}

void main();
