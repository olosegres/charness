import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { randomUUID } from 'crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  argvViolationExitCode,
  checkHasFlag,
  fakeClaudeLogFileNames,
  fakeClaudePlatformEnvName,
  fakeClaudeVersion,
  getFlagValues,
  getForeignAgentEnvNames,
  getLaunchSessionId,
  requiredJiraSessionFlags,
  sessionViolationExitCode,
} from './fakeClaudeContract';

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
 *    a `--session-id` already in use (a conversation exists once its first
 *    message arrived), so a resume by the wrong id cannot pass for the right one;
 *  - speaks the stream-json protocol: the `initialize` control handshake,
 *    `system/init`, the `--replay-user-messages` echo, `result` at a turn's end;
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
 *  - `progress`    — sends a `progress` note and ends the turn;
 *  - `finish-together` — the first request of an issue gets a `progress` note
 *    (it stays open); the turn of a LATER request of the same issue answers
 *    `final` for every request of the issue still owed one, oldest first,
 *    itself last — except a request its own header names as replaced, which
 *    the newer one covers (request/answer core S11, Jira plan R34).
 *
 * Paths come from the environment its launcher script sets:
 * `FAKE_CLAUDE_LOG_DIR` (launches, violations, answers, turns) and
 * `FAKE_CLAUDE_STATE_DIR` (per-request turn counts, the conversations held).
 */

export type FakeClaudeMode = 'answer' | 'silent-once' | 'silent' | 'hang-once' | 'progress' | 'finish-together';
const fakeModes: readonly FakeClaudeMode[] = ['answer', 'silent-once', 'silent', 'hang-once', 'progress', 'finish-together'];

const requestIdRe = /req_[A-Za-z0-9_-]+/;
const issueKeyRe = /\b([A-Z][A-Z0-9]+-\d+)\b/;
const modeRe = /\[fake:([a-z-]+)\]/;
const answerToolName = 'answer_request';
/** The request header's line that the requester does not see the agent's plain text (`requests/requestHeader.ts`). */
const requesterDoesNotSeePlainTextPhrase = 'does not see your plain text';
/** The request header's line naming the requests this one replaced (`requests/requestHeader.ts`); group 1 lists their ids. */
const supersededRequestsLineRe = /It replaces the same requester's earlier requests? ((?:req_[A-Za-z0-9_-]+(?:, )?)+)\. If you already answered/;
/** How much of a stdin line that is not JSON the error message quotes. */
const skippedLinePreviewChars = 200;

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
};

/** A stdin line of the stream-json protocol — only the fields the fake reads. */
interface StdinFrame {
  type?: string;
  request_id?: string;
  request?: { subtype?: string };
  message?: { content?: string };
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

function getStatePath(requestId: string): string {
  return path.join(getStateDir(), `${requestId}.json`);
}

/** Marks a conversation as held — the real CLI's on-disk transcript, written once its first message arrives. */
function getConversationMarkerPath(sessionId: string): string {
  return path.join(getStateDir(), `session-${sessionId}`);
}

/** @description What the real CLI says when it refuses this launch's conversation id, or `null` when it would run. */
function getSessionViolation(argv: readonly string[]): string | null {
  const resumeId = getFlagValues(argv, '--resume')[0];
  if (resumeId !== undefined && !fs.existsSync(getConversationMarkerPath(resumeId))) {
    return `No conversation found with session ID: ${resumeId}`;
  }
  const freshId = getFlagValues(argv, '--session-id')[0];
  if (freshId !== undefined && fs.existsSync(getConversationMarkerPath(freshId))) {
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

function getMode(text: string): FakeClaudeMode {
  const named = modeRe.exec(text)?.[1];
  return fakeModes.find((mode) => mode === named) ?? 'answer';
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

async function callAnswerRequest(server: McpServerConfig, args: AnswerRequestArgs): Promise<string> {
  if (!server.url) throw new Error('the bot MCP server has no url');
  const client = new Client({ name: 'fake-claude', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers ?? {} } }));
  try {
    const result = CallToolResultSchema.parse(await client.callTool({ name: answerToolName, arguments: args }));
    const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
    return result.isError ? `error: ${text}` : text;
  } finally {
    await client.close();
  }
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
  writeStdout({ type: 'result', subtype: 'success', is_error: false, result: resultText, session_id: sessionId });
}

async function runTurn(argv: readonly string[], sessionId: string, content: string): Promise<void> {
  fs.writeFileSync(getConversationMarkerPath(sessionId), '');
  writeStdout({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake-model', apiKeySource: 'none', tools: [], mcp_servers: [] });
  writeStdout({ type: 'user', message: { role: 'user', content }, session_id: sessionId });
  const requestId = requestIdRe.exec(content)?.[0];
  if (!requestId) {
    // A turn without a request (a topic whose view has requests off): logged, so a test can prove none was opened.
    appendJsonLine(fakeClaudeLogFileNames.turns, { requestId: null, issueKey: issueKeyRe.exec(content)?.[1] ?? 'unknown', isRequestPrompt: false, isPlainTextHidden: false, supersededRequestIds: [], turnCount: 1, pid: process.pid });
    emitTurnActivity(sessionId, issueKeyRe.exec(content)?.[1] ?? 'unknown');
    endTurn(sessionId, 'Nothing to do.');
    return;
  }
  const isRequestPrompt = content.includes(`[Request ${requestId}`);
  // The header's line for a requester who never sees the agent's plain text (a Telegram answers-only topic, a tracker).
  const isPlainTextHidden = content.includes(requesterDoesNotSeePlainTextPhrase);
  const supersededRequestIds = supersededRequestsLineRe.exec(content)?.[1].split(', ') ?? [];
  const previous = readRequestState(requestId);
  const state: RequestTurnState = previous ?? { mode: getMode(content), issueKey: issueKeyRe.exec(content)?.[1] ?? 'unknown', turnCount: 0, firstTurnAt: Date.now() };
  state.turnCount += 1;
  writeRequestState(requestId, state);
  appendJsonLine(fakeClaudeLogFileNames.turns, { requestId, issueKey: state.issueKey, isRequestPrompt, isPlainTextHidden, supersededRequestIds, turnCount: state.turnCount, pid: process.pid });

  emitTurnActivity(sessionId, state.issueKey);
  const isFirstTurn = state.turnCount === 1;
  if (state.mode === 'silent' || (state.mode === 'silent-once' && isFirstTurn)) {
    endTurn(sessionId, 'Thinking about it.');
    return;
  }
  if (state.mode === 'hang-once' && isFirstTurn) {
    await new Promise<never>(() => {});
  }
  const server = getBotMcpServer(argv);
  const answer = async (answeredRequestId: string, kind: string, turnCount: number): Promise<string> => {
    const body = `Fake ${kind} answer for ${state.issueKey} (${state.mode}, turn ${turnCount}).`;
    const outcome = server ? await callAnswerRequest(server, { requestId: answeredRequestId, kind, body }) : 'error: no bot MCP server in --mcp-config';
    appendJsonLine(fakeClaudeLogFileNames.answers, { requestId: answeredRequestId, issueKey: state.issueKey, kind, outcome });
    return body;
  };
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
  const kind = state.mode === 'progress' ? 'progress' : 'final';
  endTurn(sessionId, await answer(requestId, kind, state.turnCount));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const isSessionLaunch = checkHasFlag(argv, ['--input-format', 'stream-json']);
  // Variable NAMES only — the test checks what reached the agent, never a value.
  appendJsonLine(fakeClaudeLogFileNames.launches, { argv, isSessionLaunch, pid: process.pid, envNames: Object.keys(process.env), home: process.env.HOME });
  if (!isSessionLaunch) {
    process.stdout.write(`${fakeClaudeVersion}\n`);
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
  const sessionViolation = getSessionViolation(argv);
  if (sessionViolation !== null) {
    appendJsonLine(fakeClaudeLogFileNames.violations, { reason: sessionViolation, argv });
    process.stderr.write(`${sessionViolation}\n`);
    process.exit(sessionViolationExitCode);
  }
  const sessionId = getLaunchSessionId(argv) ?? randomUUID();

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
    if (frame.type !== 'user' || typeof frame.message?.content !== 'string') return;
    const content = frame.message.content;
    turnChain = turnChain.then(() => runTurn(argv, sessionId, content)).catch((error: Error) => {
      process.stderr.write(`fake claude: turn failed: ${error.stack ?? error.message}\n`);
      endTurn(sessionId, 'The turn failed.');
    });
  });
}

void main();
