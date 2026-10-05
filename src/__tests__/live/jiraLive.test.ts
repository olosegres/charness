/**
 * @description The Jira connector LIVE, against a real Jira Cloud site (Jira
 * connector plan J8): the built charness started as an isolated Jira-only
 * instance (`scripts/run-isolated.sh` with its own env file), a real Claude agent,
 * a real sandbox project. Skipped unless `JIRA_LIVE_ENV_FILE` is set, so `yarn
 * test` never reaches the network.
 *
 * Inputs — every name comes from the environment, nothing of a site is in here:
 *   JIRA_LIVE_ENV_FILE                  the instance's env file (absolute): CONNECTORS=jira,
 *                                       DATA_DIR (with jira.json), WORK_ROOT, TMUX_SOCKET_NAME,
 *                                       TMUX_TMPDIR, REQUEST_BACKSTOP_MINUTES, the AI account's
 *                                       credentials that jira.json takes as ${VAR}s
 *   JIRA_LIVE_SITE                      the site host the instance must name (a guard: the run
 *                                       refuses a jira.json that points anywhere else)
 *   JIRA_LIVE_REQUESTER_STORAGE_STATE   a Playwright login state of the REQUESTER account on that
 *                                       site (R33: the requester acts only through its browser)
 *
 * The AI account's token is used by this test only against the configured site:
 * to prove it belongs to the AI account, for the AI assigning an issue to itself,
 * and for the comment-size probe (R19). The requester's login never reaches
 * charness (D2).
 *
 * One flow, in order, on fresh issues of the one allowlisted project:
 *   pre-flight: the env file, jira.json, the AI token, the private tmux server,
 *     the ports, the working folder — checked before anything starts
 *   → boot: Jira-only, nothing but run-isolated.sh's variables; the poll's JQL
 *     names only the allowlisted project
 *   → the requester assigns five issues to the AI; the AI assigns one to itself
 *   → R34: the requester hands an issue over twice while its agent still works
 *     (Claude Code reads the second prompt only after the running turn ends):
 *     the first request superseded and answered in full, the second — whose
 *     header names the first — answered with only what the second hand-over
 *     added (a new ask in a comment), or with a short pointer when it added
 *     nothing; the issue handed back once. Two issues, one per variant
 *   → the agents hold no instance variable (R32)
 *   → one agent killed mid-turn
 *   → final: a comment by the AI, the issue back with the requester, closed `final`
 *   → progress: the issue stays with the AI while it works, then the final answer
 *   → long answer: comments in order; the size limit Jira enforces probed (R19)
 *   → question: a question comment, the issue back; the requester's reply and
 *     re-assignment bring a final answer that uses the reply
 *   → charness restarted: no request opened again
 *   → the killed agent's request still answered
 *   → every Jira session's MCP servers: only the bot's own (R8)
 *   → the self-assigned issue: no request, nothing posted
 *   end: charness stopped, its private tmux server removed, the issues moved to a
 *   finished status (left in place as test data), the default tmux server unchanged
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { parse as parseEnvFile } from 'dotenv';
import { JiraLiveRequester, type LiveComment, type LiveIssueState } from './jiraLiveRequester';
import { getPollJqlProjectKeys, getPolledDecisions } from '../jiraE2e/charnessLog';
import { getForeignAgentEnvNames } from '../jiraE2e/fakeClaudeContract';
import { getClaudeMemoryAbove, validateJiraConfig, type JiraConfig } from '../../connectors/jira/config';
import { createJiraClient, type JiraClient } from '../../connectors/jira/client';
import { jiraCommentAdfMaxChars, jiraCommentMarkdownMaxChars, type AdfDocument } from '../../connectors/jira/adf';
import { makeJiraKey } from '../../connectors/jira/sessionKeyCodec';
import { getJiraConfigPath } from '../../connectors/jira/configFile';
import { getJsonStreamSessionPaths, resolveJsonStreamSessionDir } from '../../utils/jsonStreamHost';
import { keyToString } from '../../sessionKey';
import { TelegramDisabledError, telegramCallRefusedLogPrefix } from '../../connectors/telegram/telegramCallGuard';
import { notTelegramChatPhrase } from '../../connectors/telegram/foreignKeyFallbacks';
import { buildSupersededRequestsLine } from '../../requests/requestHeader';

const liveEnvFile = process.env.JIRA_LIVE_ENV_FILE;
const liveSite = process.env.JIRA_LIVE_SITE;
const requesterStorageState = process.env.JIRA_LIVE_REQUESTER_STORAGE_STATE;

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const cliPath = path.join(repoRoot, 'dist', 'cli.js');
const runIsolatedPath = path.join(repoRoot, 'scripts', 'run-isolated.sh');

/** The only variables `run-isolated.sh` passes to the instance. */
const isolatedLaunchEnvNames = ['HOME', 'PATH', 'USER', 'SHELL', 'LANG', 'TERM', 'ENV_FILE'];
/** What a Jira-only instance's env file must set. */
const requiredInstanceEnvNames = ['CONNECTORS', 'DATA_DIR', 'WORK_ROOT', 'TMUX_SOCKET_NAME', 'TMUX_TMPDIR', 'REQUEST_BACKSTOP_MINUTES'];
const telegramTokenEnvName = 'TELEGRAM_BOT_TOKEN';
const atlassianEnvPrefix = 'ATLASSIAN_';
/** The bot's own MCP server — the only one a Jira session may load (R8). */
const botMcpServerName = 'telegramBot';

const bootTimeoutMs = 90 * 1000;
/** A poll, a real agent's session start and a short turn. */
const answerTimeoutMs = 5 * 60 * 1000;
/** The 3-minute backstop, the one-minute sweep, a resume and the agent's two-minute sleep, with room. */
const killedAnswerTimeoutMs = 12 * 60 * 1000;
const stopTimeoutMs = 30 * 1000;
const waitStepMs = 3000;
/** Polls happen at once on start, then one interval apart: two and a half intervals hold two polls. */
const restartPollIntervals = 2.5;
const flowTimeoutMs = 60 * 60 * 1000;
const outputTailChars = 4000;

/** R19 probe sizes: Jira's documented comment limit is 32 767 characters; each probe lands on one side of it by one count only. */
const jiraCommentLimitChars = 32_767;
const probeListItemCount = 500;
const probeLongTextChars = 33_000;
const longAnswerItemCount = 400;

/**
 * A shell command that just waits. Not `sleep`: Claude Code refuses a long `sleep`
 * in its shell tool and tells the agent to background it, which ends the turn early.
 */
function getWaitCommand(seconds: number): string {
  return `python3 -c 'import time; time.sleep(${seconds})'`;
}
const waitCommandMarker = 'time.sleep(';
const progressWaitSeconds = 45;
const killedWaitSeconds = 120;
/** Long enough for a poll to pick the second hand-over up while the agent still waits on the first request. */
const repeatWaitSeconds = 90;
/** A token no answer could carry by chance: the R34 asks are told apart by these, one per ask. */
function createAskToken(prefix: string): string {
  return `${prefix}-${randomBytes(3).toString('hex').toUpperCase()}`;
}
/** R34: the deliverable of the first hand-over, per variant, and the extra ask the second hand-over adds. */
const repeatTokens = {
  repeatAdd: createAskToken('FIRST'),
  repeatSame: createAskToken('FIRST'),
  extraAsk: createAskToken('EXTRA'),
} as const;
/**
 * R34: an answer that only points at the one above stays short; the real "not a redo" proof is that the
 * second turn ran none of the task's steps again. Sonnet's pointer recaps the steps in a paragraph (432
 * chars seen live), so the cap leaves room for that and still excludes a repeated deliverable of any size.
 */
const pointerAnswerMaxChars = 800;

function getRepeatScenarioText(token: string): string {
  return [
    'Do these steps in order:',
    '1. Send a progress answer whose text is exactly: TAKEN',
    `2. Run this shell command in the foreground and wait for it: \`${getWaitCommand(repeatWaitSeconds)}\``,
    `3. Send a final answer whose text is exactly: ${token}`,
  ].join('\n');
}

const scenarioTexts = {
  final: 'Reply with a final answer whose text is exactly: PONG',
  question: [
    'Before doing anything else, ask the requester which colour they prefer, as a question answer, and end your turn.',
    'Once they have answered in a comment, reply with a final answer whose text is exactly that colour in upper case, nothing else.',
  ].join(' '),
  progress: [
    'Do these steps in order:',
    '1. Send a progress answer whose text is exactly: STARTED',
    `2. Run this shell command in the foreground and wait for it: \`${getWaitCommand(progressWaitSeconds)}\``,
    '3. Send a final answer whose text is exactly: FINISHED',
  ].join('\n'),
  killed: `Run this shell command in the foreground and wait for it to finish (it takes two minutes): \`${getWaitCommand(killedWaitSeconds)}\`. Then send a final answer whose text is exactly: SLEPT`,
  repeatAdd: getRepeatScenarioText(repeatTokens.repeatAdd),
  repeatSame: getRepeatScenarioText(repeatTokens.repeatSame),
  long: `Send a final answer that is a Markdown bullet list of the numbers 1 to ${longAnswerItemCount} in order, one list item per number, written as \`- item 1\`, \`- item 2\`, … \`- item ${longAnswerItemCount}\`, and nothing else.`,
  idle: 'Test data of a live run; there is nothing to do here.',
} as const;
type Scenario = keyof typeof scenarioTexts;
const answeredScenarios: readonly Scenario[] = ['final', 'question', 'progress', 'killed', 'long'];
/** Every scenario whose issue gets an agent session: the batch above, plus the two handed over twice (R34). */
const sessionScenarios: readonly Scenario[] = [...answeredScenarios, 'repeatAdd', 'repeatSame'];
const questionReply = 'Blue';

let instanceEnv: Record<string, string> = {};
let config: JiraConfig;
let projectKey: string;
let aiClient: JiraClient;
let requester: JiraLiveRequester | null = null;
let dataDir: string;
let socketPath: string;
let runLogPath: string;
let charness: ChildProcess | null = null;
let charnessOutput = '';
let defaultTmuxSessionsBefore: string[] | null = null;
const issueKeys = new Map<Scenario | 'self' | 'probe', string>();

function getIssueKey(scenario: Scenario | 'self' | 'probe'): string {
  const issueKey = issueKeys.get(scenario);
  if (!issueKey) throw new Error(`no issue was created for ${scenario}`);
  return issueKey;
}

function getRequester(): JiraLiveRequester {
  if (!requester) throw new Error('the requester\'s browser is not open');
  return requester;
}

function report(line: string): void {
  console.log(`[live] ${line}`);
  if (runLogPath) fs.appendFileSync(runLogPath, `[live] ${line}\n`);
}

/** The test's own environment for a tmux client: never `$TMUX` (it would redirect a call to the server it names), never a TMUX_TMPDIR. */
function getTmuxClientEnv(): NodeJS.ProcessEnv {
  const { TMUX: _server, TMUX_PANE: _pane, TMUX_TMPDIR: _tmpDir, ...env } = process.env;
  return env;
}

/** Session names on a tmux server — read-only; `null` when no server answers there. */
function listTmuxSessions(socketArgs: readonly string[]): string[] | null {
  const result = spawnSync('tmux', [...socketArgs, 'list-sessions', '-F', '#{session_name}'], { encoding: 'utf8', env: getTmuxClientEnv() });
  return result.status === 0 ? result.stdout.split('\n').filter(Boolean) : null;
}

/** The instance's own tmux server, by the FULL path of its socket — never anything else. */
function killInstanceTmuxServer(): void {
  if (socketPath && fs.existsSync(socketPath)) spawnSync('tmux', ['-S', socketPath, 'kill-server'], { env: getTmuxClientEnv() });
}

/**
 * @description Stop what the run started, SYNCHRONOUSLY — so it also runs from
 * `process.on('exit')` after a signal or an uncaught failure, where nothing
 * asynchronous runs any more: charness (killed outright — left alone it would keep
 * polling the live site under the AI account's token) and the instance's own tmux
 * server, which ends the agents in it. The requester's browser is playwright's own
 * child and dies with this process.
 */
function removeInstanceSync(): void {
  if (charness && charness.exitCode === null && charness.signalCode === null) charness.kill('SIGKILL');
  charness = null;
  killInstanceTmuxServer();
}

/** A signal ends the run through `exit`, whose handler cleans up (a signal's default action would skip it). */
function exitOnSignal(signal: NodeJS.Signals): void {
  process.exit(128 + os.constants.signals[signal]);
}

function getProcessEnvNames(pid: number): string[] | null {
  const environPath = `/proc/${pid}/environ`;
  if (!fs.existsSync(environPath)) return null;
  return fs.readFileSync(environPath, 'utf8').split('\0').filter(Boolean).map((entry) => entry.slice(0, entry.indexOf('=')));
}

async function checkIsPortFree(port: number): Promise<boolean> {
  const server = net.createServer();
  return new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

function getInstancePorts(): number[] {
  const ports = [Number(instanceEnv.SCHEDULER_MCP_PORT)];
  if (instanceEnv.OPENCODE_URL) ports.push(Number(new URL(instanceEnv.OPENCODE_URL).port));
  return ports.filter((port) => Number.isInteger(port) && port > 0);
}

/** Replace `${NAME}` from the instance env file only — the test's own environment is never read for it. */
function expandFromInstanceEnv(value: object): object {
  const text = JSON.stringify(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_placeholder, name: string) => {
    const resolved = instanceEnv[name];
    if (resolved === undefined) throw new Error(`jira.json names \${${name}}, which the instance env file does not set`);
    return JSON.stringify(resolved).slice(1, -1);
  });
  return JSON.parse(text);
}

async function waitFor(description: string, timeoutMs: number, check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (charness && charness.exitCode !== null) throw new Error(`charness exited with ${charness.exitCode} while waiting for ${description}`);
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${description}; charness output tail:\n${charnessOutput.slice(-outputTailChars)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, waitStepMs));
  }
}

async function startCharness(): Promise<number> {
  if (!liveEnvFile) throw new Error('JIRA_LIVE_ENV_FILE is not set');
  const outputStart = charnessOutput.length;
  const child = spawn(runIsolatedPath, [liveEnvFile], {
    // run-isolated.sh passes on only these. HOME is the user's: the agent's Claude login lives there.
    // The running node first: under `yarn` PATH starts with a `node` shim that would add variables of its own.
    env: {
      HOME: os.homedir(),
      PATH: [path.dirname(process.execPath), process.env.PATH ?? ''].join(path.delimiter),
      USER: process.env.USER ?? '',
      SHELL: '/bin/sh',
      LANG: 'C.UTF-8',
      TERM: 'dumb',
    },
    cwd: dataDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  charness = child;
  const record = (chunk: Buffer): void => {
    const text = chunk.toString('utf8');
    charnessOutput += text;
    fs.appendFileSync(runLogPath, text);
  };
  child.stdout?.on('data', record);
  child.stderr?.on('data', record);
  const pollingLine = `[jira] polling ${projectKey} every ${config.pollIntervalMs / 1000} s`;
  await waitFor('charness to start polling', bootTimeoutMs, () => charnessOutput.slice(outputStart).includes(pollingLine));
  return outputStart;
}

async function stopCharness(): Promise<void> {
  const child = charness;
  charness = null;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  const isStopped = await Promise.race([exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), stopTimeoutMs))]);
  if (!isStopped) {
    child.kill('SIGKILL');
    await exited;
  }
}

/** The json-stream session files of an issue's conversation. */
function getSessionPaths(issueKey: string): ReturnType<typeof getJsonStreamSessionPaths> {
  return getJsonStreamSessionPaths(resolveJsonStreamSessionDir(dataDir, makeJiraKey(issueKey)));
}

interface StreamLine {
  type?: string;
  subtype?: string;
  mcp_servers?: Array<{ name: string; status: string }>;
  /** A user line's content may be a plain string. */
  message?: { content?: string | Array<{ type?: string; text?: string; name?: string; input?: { command?: string } }> };
}

/** The texts of the user turns an issue session's agent received so far (the request prompts and the wake-ups). */
function getUserTurnTexts(issueKey: string): string[] {
  return readStreamLines(issueKey).filter((line) => line.type === 'user').map((line) => {
    const content = line.message?.content;
    return typeof content === 'string' ? content : (content ?? []).map((block) => block.text ?? '').join('');
  });
}

/** The shell commands an issue session's agent has started so far — after the prompt of `afterRequestId` only, when given. */
function getStartedCommands(issueKey: string, afterRequestId?: string): string[] {
  let isAfterPrompt = afterRequestId === undefined;
  return readStreamLines(issueKey).flatMap((line) => {
    const content = line.message?.content;
    if (typeof content === 'string') {
      if (afterRequestId !== undefined && content.includes(`[Request ${afterRequestId}`)) isAfterPrompt = true;
      return [];
    }
    if (!isAfterPrompt || !Array.isArray(content)) return [];
    return content.flatMap((block) => (block.type === 'tool_use' && block.input?.command ? [block.input.command] : []));
  });
}

/** The complete lines of an issue session's stdout so far (a line still being written is left out). */
function readStreamLines(issueKey: string): StreamLine[] {
  const { stdoutFile } = getSessionPaths(issueKey);
  if (!fs.existsSync(stdoutFile)) return [];
  return fs.readFileSync(stdoutFile, 'utf8').split('\n').slice(0, -1).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

function getAgentPid(issueKey: string): number | null {
  const { pidFile } = getSessionPaths(issueKey);
  if (!fs.existsSync(pidFile)) return null;
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  return Number.isInteger(pid) && pid > 0 && fs.existsSync(`/proc/${pid}`) ? pid : null;
}

interface ClosedRequestLine {
  id: string;
  conversationKey: string;
  closeReason: string;
  supersededBy?: string;
}

function getClosedRequests(issueKey: string): ClosedRequestLine[] {
  const historyPath = path.join(dataDir, 'requests.jsonl');
  if (!fs.existsSync(historyPath)) return [];
  const conversationKey = keyToString(makeJiraKey(issueKey));
  return fs.readFileSync(historyPath, 'utf8').split('\n').filter(Boolean)
    .map((line): ClosedRequestLine => JSON.parse(line))
    .filter((record) => record.conversationKey === conversationKey);
}

function getAiComments(state: LiveIssueState): LiveComment[] {
  return state.comments.filter((comment) => comment.authorAccountId === config.accountId);
}

/** Wait until the issue holds an AI comment matching `predicate` and is handed back to the requester. */
async function waitForHandBack(issueKey: string, timeoutMs: number, predicate: (comments: LiveComment[]) => boolean): Promise<LiveIssueState> {
  let state: LiveIssueState | null = null;
  await waitFor(`${issueKey} answered and handed back`, timeoutMs, async () => {
    state = await getRequester().getIssueState(issueKey);
    return state.assigneeAccountId === getRequester().accountId && predicate(getAiComments(state));
  });
  if (!state) throw new Error('unreachable');
  return state;
}

function adfOf(content: AdfDocument['content']): AdfDocument {
  return { type: 'doc', version: 1, content };
}

/** R19: post one comment of the given size through the AI account; what Jira said. */
async function probeCommentSize(issueKey: string, body: AdfDocument): Promise<string> {
  try {
    const result = await aiClient.addComment(issueKey, body);
    return result.outcome === 'created' ? `accepted (comment ${result.id})` : `unknown (${result.reason})`;
  } catch (error) {
    return `refused (${error instanceof Error ? error.message : String(error)})`;
  }
}

describe('Jira connector live run (J8)', { skip: liveEnvFile ? false : 'set JIRA_LIVE_ENV_FILE (and JIRA_LIVE_SITE, JIRA_LIVE_REQUESTER_STORAGE_STATE) to run', timeout: flowTimeoutMs }, () => {
  before(async () => {
    if (!liveEnvFile || !path.isAbsolute(liveEnvFile)) throw new Error('JIRA_LIVE_ENV_FILE must be an absolute path');
    if (!liveSite) throw new Error('JIRA_LIVE_SITE must name the site host the instance is configured for');
    if (!requesterStorageState) throw new Error('JIRA_LIVE_REQUESTER_STORAGE_STATE must point at the requester\'s stored browser login');
    if (!fs.existsSync(cliPath)) throw new Error('Built CLI is missing. Run `yarn build` first.');
    instanceEnv = parseEnvFile(fs.readFileSync(liveEnvFile));
    for (const name of requiredInstanceEnvNames) {
      if (!instanceEnv[name]) throw new Error(`the instance env file does not set ${name}`);
    }
    dataDir = instanceEnv.DATA_DIR;
    socketPath = path.join(instanceEnv.TMUX_TMPDIR, `tmux-${process.getuid?.() ?? 0}`, instanceEnv.TMUX_SOCKET_NAME);
    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);
    const runId = `live-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.mkdirSync(path.join(dataDir, 'live-runs'), { recursive: true, mode: 0o700 });
    runLogPath = path.join(dataDir, 'live-runs', `${runId}.log`);

    const parsedConfig: object = JSON.parse(fs.readFileSync(getJiraConfigPath(dataDir), 'utf8'));
    const validated = validateJiraConfig(expandFromInstanceEnv(parsedConfig), { workRoot: instanceEnv.WORK_ROOT, openCodeUrl: instanceEnv.OPENCODE_URL });
    if (!validated.ok) throw new Error(`jira.json is invalid: ${validated.errors.join('; ')}`);
    config = validated.config;
    // Nothing of this test's own may reach a host other than the configured site.
    if (config.site !== liveSite || config.baseUrl !== `https://${liveSite}`) throw new Error('jira.json does not name JIRA_LIVE_SITE');
    if (config.projects.size !== 1) throw new Error('the live run expects exactly one allowlisted project');
    [projectKey] = [...config.projects.keys()];
    aiClient = createJiraClient({ baseUrl: config.baseUrl, email: config.email, apiToken: config.apiToken });
    report(`run ${runId}: project ${projectKey}, poll every ${config.pollIntervalMs / 1000} s, model ${config.model ?? 'default'}, effort ${config.effort ?? 'default'}`);
  });

  after(async () => {
    // A graceful stop first (the normal end); the synchronous sweep is the same one a signal or a crash runs.
    await stopCharness();
    removeInstanceSync();
    if (requester) {
      // Left in place as test data, finished so that nothing about them matches a trigger any more.
      for (const issueKey of issueKeys.values()) {
        try {
          if (!(await requester.getIssueState(issueKey)).isDone) await requester.moveToDone(issueKey);
        } catch (error) {
          report(`${issueKey} not moved to a finished status: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      await requester.close();
    }
    report(`issues of this run: ${[...issueKeys].map(([scenario, issueKey]) => `${scenario}=${issueKey}`).join(', ')}`);
    process.off('exit', removeInstanceSync);
    process.off('SIGINT', exitOnSignal);
    process.off('SIGTERM', exitOnSignal);
  });

  it('pre-flight: the instance env file, jira.json, the AI token, tmux and ports', async () => {
    const envNames = Object.keys(instanceEnv);
    assert.equal(instanceEnv.CONNECTORS, 'jira', 'Jira-only');
    assert.ok(!envNames.includes(telegramTokenEnvName), 'no bot token');
    assert.deepEqual(envNames.filter((name) => name.startsWith(atlassianEnvPrefix)), [], 'no Atlassian variables');
    assert.notEqual(instanceEnv.TMUX_SOCKET_NAME, 'default', 'a private tmux server');
    assert.ok(path.isAbsolute(instanceEnv.TMUX_TMPDIR) && !instanceEnv.TMUX_TMPDIR.startsWith(os.tmpdir()), 'TMUX_TMPDIR is a folder of the instance\'s own');
    const realHome = fs.realpathSync(os.homedir());
    for (const dir of [dataDir, instanceEnv.WORK_ROOT, instanceEnv.TMUX_TMPDIR]) {
      assert.ok(!fs.realpathSync(dir).startsWith(`${realHome}${path.sep}`), `${dir} is outside HOME`);
    }
    const [project] = [...config.projects.values()];
    assert.equal(getClaudeMemoryAbove(path.join(instanceEnv.WORK_ROOT, project.folder)), null, 'no Claude memory in or above the working folder');

    assert.equal((await aiClient.getMyself()).accountId, config.accountId, 'the API token belongs to the configured AI account');
    requester = await JiraLiveRequester.open(liveSite ?? '', requesterStorageState ?? '');
    assert.notEqual(requester.accountId, config.accountId, 'the requester is another account than the AI');

    defaultTmuxSessionsBefore = listTmuxSessions([]);
    report(`default tmux server before: ${defaultTmuxSessionsBefore === null ? 'not running' : `${defaultTmuxSessionsBefore.length} session(s)`}`);
    // A leftover of a crashed run is the instance's own; nothing else is ever killed.
    killInstanceTmuxServer();
    assert.equal(listTmuxSessions(['-S', socketPath]), null, 'the private tmux server is not running yet');
    for (const port of getInstancePorts()) assert.ok(await checkIsPortFree(port), `port ${port} is free`);
  });

  it('boots Jira-only with nothing but run-isolated.sh\'s variables; the poll\'s JQL names only the allowlisted project', async () => {
    await startCharness();
    const envNames = charness?.pid === undefined ? null : getProcessEnvNames(charness.pid);
    assert.ok(envNames, 'the instance\'s environment was read');
    assert.deepEqual([...envNames].sort(), [...isolatedLaunchEnvNames].sort());
    assert.deepEqual(getPollJqlProjectKeys(charnessOutput), [[projectKey]]);
    report(`poll JQL projects: ${JSON.stringify(getPollJqlProjectKeys(charnessOutput))}`);
  });

  it('the requester assigns five issues to the AI and the AI assigns one to itself: five requests, one ignored', async () => {
    const runMarker = path.basename(runLogPath, '.log');
    for (const scenario of [...sessionScenarios, 'self', 'probe'] as const) {
      const text = scenario === 'self' || scenario === 'probe' ? scenarioTexts.idle : scenarioTexts[scenario];
      issueKeys.set(scenario, await getRequester().createIssue(projectKey, `[charness ${runMarker}] ${scenario}`, text));
    }
    report(`created: ${[...issueKeys].map(([scenario, issueKey]) => `${scenario}=${issueKey}`).join(', ')}`);
    for (const scenario of answeredScenarios) await getRequester().assignIssue(getIssueKey(scenario), config.accountId);
    await aiClient.assignIssue(getIssueKey('self'), config.accountId);

    const answeredKeys = answeredScenarios.map(getIssueKey);
    await waitFor('a request for every assigned issue and the self-assigned one ignored', answerTimeoutMs, () => {
      const decisions = getPolledDecisions(charnessOutput);
      return answeredKeys.every((issueKey) => decisions.some((entry) => entry.issueKey === issueKey && entry.decision === 'request'))
        && decisions.some((entry) => entry.issueKey === getIssueKey('self') && entry.decision === 'selfAuthored');
    });
    const requestKeys = getPolledDecisions(charnessOutput).filter((entry) => entry.decision === 'request').map((entry) => entry.issueKey);
    assert.deepEqual([...requestKeys].sort(), [...answeredKeys].sort(), 'one request each, none for the probe issue');
  });

  it('the agents and the private tmux server hold no instance variable (R32)', async () => {
    const instanceEnvNames = Object.keys(instanceEnv);
    await waitFor('an agent process for every request', answerTimeoutMs, () => answeredScenarios.every((scenario) => getAgentPid(getIssueKey(scenario)) !== null));
    for (const scenario of answeredScenarios) {
      const pid = getAgentPid(getIssueKey(scenario));
      const envNames = pid === null ? null : getProcessEnvNames(pid);
      assert.ok(envNames, `${scenario}: the agent's environment was read`);
      assert.deepEqual(envNames.filter((name) => instanceEnvNames.includes(name)), [], `${scenario}: no instance variable`);
      assert.deepEqual(getForeignAgentEnvNames(envNames), [], `${scenario}: nothing but the agent allowlist`);
      report(`${scenario} agent env: ${[...envNames].sort().join(' ')}`);
    }
    const serverEnvironment = spawnSync('tmux', ['-S', socketPath, 'show-environment', '-g'], { encoding: 'utf8', env: getTmuxClientEnv() });
    assert.equal(serverEnvironment.status, 0, 'the private server answered');
    const serverEnvNames = serverEnvironment.stdout.split('\n').filter(Boolean).map((line) => line.replace(/^-/, '').split('=')[0]);
    assert.deepEqual(serverEnvNames.filter((name) => instanceEnvNames.includes(name) && name !== 'TMUX_TMPDIR'), [], 'the server started clean');
    report(`private tmux server env: ${[...serverEnvNames].sort().join(' ')}`);
  });

  it('kills the agent of the long task mid-turn', async () => {
    const issueKey = getIssueKey('killed');
    await waitFor('the killed scenario\'s agent waiting in a shell command', answerTimeoutMs, () =>
      getStartedCommands(issueKey).some((command) => command.includes(waitCommandMarker)));
    const pid = getAgentPid(issueKey);
    assert.ok(pid, 'the agent is running');
    assert.ok(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('claude'), 'the pid is the agent');
    // A progress note may already be there; the final answer must not.
    assert.ok(!getAiComments(await getRequester().getIssueState(issueKey)).some((comment) => /SLEPT/.test(comment.text)), 'not answered yet');
    process.kill(pid, 'SIGKILL');
    report(`killed the agent of ${issueKey} (pid ${pid}) mid-turn`);
  });

  it('final: the answer is a comment by the AI, the issue goes back to the requester, the request closes `final`', async () => {
    const issueKey = getIssueKey('final');
    const state = await waitForHandBack(issueKey, answerTimeoutMs, (comments) => comments.some((comment) => /PONG/.test(comment.text)));
    assert.equal(getAiComments(state).length, 1, 'one comment');
    await waitFor('the request in the closed history', answerTimeoutMs, () => getClosedRequests(issueKey).length > 0);
    assert.deepEqual(getClosedRequests(issueKey).map((record) => record.closeReason), ['final']);
    report(`final ${issueKey}: comment ${getAiComments(state)[0].id} "${getAiComments(state)[0].text}"`);
  });

  it('progress: the progress note is a comment and the issue stays with the AI; the final answer then hands it back', async () => {
    const issueKey = getIssueKey('progress');
    let assigneeAtProgress: string | null = null;
    await waitFor('the progress comment', answerTimeoutMs, async () => {
      const state = await getRequester().getIssueState(issueKey);
      const comments = getAiComments(state);
      if (!comments.some((comment) => /STARTED/.test(comment.text))) return false;
      assigneeAtProgress = state.assigneeAccountId;
      // The agent sleeps 45 s after the note, so the final answer cannot have landed yet.
      assert.ok(!comments.some((comment) => /FINISHED/.test(comment.text)), 'read while the agent still works');
      return true;
    });
    assert.equal(assigneeAtProgress, config.accountId, 'the issue stays with the AI after a progress note');
    const state = await waitForHandBack(issueKey, answerTimeoutMs, (comments) => comments.some((comment) => /FINISHED/.test(comment.text)));
    report(`progress ${issueKey}: ${getAiComments(state).map((comment) => `${comment.id} "${comment.text}"`).join(', ')}`);
  });

  /**
   * R34, in Claude Code's timing: the requester hands the issue over again while the agent waits in its
   * shell command, so the second prompt is queued and read only after the first request was answered in
   * full. `extraAsk` is the comment the requester adds before the second hand-over (`null`: nothing new).
   * Returns the AI's comments once the second answer landed and the issue is back with the requester.
   */
  async function runRepeatVariant(scenario: 'repeatAdd' | 'repeatSame', extraAsk: string | null): Promise<LiveComment[]> {
    const issueKey = getIssueKey(scenario);
    const firstToken = repeatTokens[scenario];
    await getRequester().assignIssue(issueKey, config.accountId);
    await waitFor(`${scenario}: the first request's progress note`, answerTimeoutMs, async () =>
      getAiComments(await getRequester().getIssueState(issueKey)).some((comment) => /TAKEN/.test(comment.text)));
    // The agent now waits in its shell command: the requester takes the issue back and hands it over again, as one does in Jira.
    if (extraAsk !== null) await getRequester().addComment(issueKey, extraAsk);
    await getRequester().assignIssue(issueKey, getRequester().accountId);
    await getRequester().assignIssue(issueKey, config.accountId);
    await waitFor(`${scenario}: the first request superseded in the closed history`, answerTimeoutMs, () =>
      getClosedRequests(issueKey).some((record) => record.closeReason === 'superseded'));
    const commentsAtHandOver = getAiComments(await getRequester().getIssueState(issueKey));
    assert.ok(!commentsAtHandOver.some((comment) => comment.text.includes(firstToken)), `${scenario}: the second hand-over landed while the agent still worked on the first`);

    const state = await waitForHandBack(issueKey, answerTimeoutMs, (comments) => comments.length >= 3);
    await waitFor(`${scenario}: the second request in the closed history`, answerTimeoutMs, () => getClosedRequests(issueKey).length >= 2);
    const [superseded, final] = getClosedRequests(issueKey);
    assert.deepEqual(getClosedRequests(issueKey).map((record) => record.closeReason), ['superseded', 'final'], `${scenario}: the first replaced, the second answered`);
    assert.equal(superseded.supersededBy, final.id, `${scenario}: the history names the request that replaced it`);
    const secondPrompt = getUserTurnTexts(issueKey).find((text) => text.includes(`[Request ${final.id}`));
    assert.ok(secondPrompt, `${scenario}: the second request reached the agent`);
    assert.ok(secondPrompt.includes(buildSupersededRequestsLine([superseded.id])), `${scenario}: its header names the replaced request`);
    const comments = getAiComments(state);
    report(`R34 ${scenario} ${issueKey}: ${superseded.id} superseded by ${final.id}; comments ${comments.map((comment) => `${comment.id} "${comment.text}"`).join(', ')}`);
    const [progressComment, firstAnswer, secondAnswer, ...rest] = comments;
    assert.match(progressComment.text, /TAKEN/);
    assert.ok(firstAnswer.text.includes(firstToken), `${scenario}: the first request was answered in full (${firstToken})`);
    assert.ok(secondAnswer, `${scenario}: the second request got its own answer`);
    assert.deepEqual(rest, [], `${scenario}: no further answer`);
    // Not a redo: the second turn neither took the task up again (a second TAKEN) nor ran its 90 s wait.
    // Exactly the progress note's text: the pointer answer may quote it ("I already sent … TAKEN").
    assert.equal(comments.filter((comment) => comment.text.trim() === 'TAKEN').length, 1, `${scenario}: the task was taken up once`);
    assert.deepEqual(getStartedCommands(issueKey, final.id).filter((command) => command.includes(waitCommandMarker)), [], `${scenario}: the second turn did not run the task's wait again`);
    return comments;
  }

  it('R34, a new ask: the second hand-over adds a comment; the first request is answered in full, the second answer covers only the new ask', async () => {
    const extraAsk = `Additionally, reply with a final answer whose text is exactly: ${repeatTokens.extraAsk}`;
    const [, , secondAnswer] = await runRepeatVariant('repeatAdd', extraAsk);
    assert.ok(secondAnswer.text.includes(repeatTokens.extraAsk), 'the second answer carries the new ask\'s token');
    assert.ok(!secondAnswer.text.includes(repeatTokens.repeatAdd), 'the second answer does not repeat the first deliverable');
  });

  it('R34, nothing new: the second hand-over adds nothing; the first request is answered in full, the second answer is a short pointer', async () => {
    const [, , secondAnswer] = await runRepeatVariant('repeatSame', null);
    assert.ok(secondAnswer.text.length <= pointerAnswerMaxChars, `the second answer is a pointer, not a redo (${secondAnswer.text.length} chars)`);
  });

  it('long answer: its comments arrive in order, each within both size counts; the count Jira enforces is probed (R19)', async () => {
    const issueKey = getIssueKey('long');
    const state = await waitForHandBack(issueKey, answerTimeoutMs, (comments) => comments.length > 0);
    const comments = getAiComments(state);
    const itemNumbers = comments.flatMap((comment) => [...comment.text.matchAll(/item (\d+)/g)].map((match) => Number(match[1])));
    assert.deepEqual(itemNumbers, Array.from({ length: longAnswerItemCount }, (_, index) => index + 1), 'every item once, in order, across the comments');
    // The ADF Jira returns carries attributes of its own, so only the text is compared against charness's cap.
    for (const comment of comments) assert.ok(comment.text.length <= jiraCommentMarkdownMaxChars, `comment ${comment.id} fits`);
    report(`long ${issueKey}: ${comments.length} comment(s); text/ADF lengths (charness caps each piece at ${jiraCommentMarkdownMaxChars} / ${jiraCommentAdfMaxChars}) ${comments.map((comment) => `${comment.text.length}/${comment.adfLength}`).join(', ')}`);

    const probeKey = getIssueKey('probe');
    const listItems = Array.from({ length: probeListItemCount }, (_, index) => ({
      type: 'listItem',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: `p${index + 1}` }] }],
    }));
    const smallTextBigAdf = adfOf([{ type: 'bulletList', content: listItems }]);
    const bigText = adfOf([{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(probeLongTextChars) }] }]);
    const smallTextBigAdfLength = JSON.stringify(smallTextBigAdf).length;
    assert.ok(smallTextBigAdfLength > jiraCommentLimitChars, 'the list probe\'s ADF is over the limit');
    const listOutcome = await probeCommentSize(probeKey, smallTextBigAdf);
    const textOutcome = await probeCommentSize(probeKey, bigText);
    report(`R19 probe on ${probeKey}: text ~${probeListItemCount * 5} chars, ADF ${smallTextBigAdfLength} chars → ${listOutcome}`);
    report(`R19 probe on ${probeKey}: text ${probeLongTextChars} chars, ADF ${JSON.stringify(bigText).length} chars → ${textOutcome}`);
    assert.ok(textOutcome.startsWith('refused'), 'a body over the limit by its text is refused');
  });

  it('question: a question comment hands the issue back, closed `question`', async () => {
    const issueKey = getIssueKey('question');
    const state = await waitForHandBack(issueKey, answerTimeoutMs, (comments) => comments.length > 0);
    assert.equal(getAiComments(state).length, 1);
    await waitFor('the request in the closed history', answerTimeoutMs, () => getClosedRequests(issueKey).length > 0);
    assert.deepEqual(getClosedRequests(issueKey).map((record) => record.closeReason), ['question']);
    report(`question ${issueKey}: comment ${getAiComments(state)[0].id} "${getAiComments(state)[0].text}"`);
  });

  it('a restart opens no request again', async () => {
    const commentsBefore = new Map<string, number>();
    for (const issueKey of issueKeys.values()) commentsBefore.set(issueKey, (await getRequester().getIssueState(issueKey)).comments.length);
    await stopCharness();
    const outputStart = await startCharness();
    await new Promise((resolve) => setTimeout(resolve, restartPollIntervals * config.pollIntervalMs));
    const decisionsAfterRestart = getPolledDecisions(charnessOutput.slice(outputStart));
    assert.deepEqual(decisionsAfterRestart.filter((entry) => entry.decision === 'request'), [], 'no poll opened a request again');
    for (const [issueKey, count] of commentsBefore) {
      if (issueKey === getIssueKey('killed')) continue; // its answer may legitimately land now
      assert.equal((await getRequester().getIssueState(issueKey)).comments.length, count, `${issueKey}: no comment posted again`);
    }
    report(`restart: decisions after it ${JSON.stringify(decisionsAfterRestart)}`);
  });

  it('question, continued: the requester\'s reply and re-assignment bring a final answer that uses it', async () => {
    const issueKey = getIssueKey('question');
    await getRequester().addComment(issueKey, questionReply);
    await getRequester().assignIssue(issueKey, config.accountId);
    const state = await waitForHandBack(issueKey, answerTimeoutMs, (comments) => comments.length >= 2);
    const finalComment = getAiComments(state).at(-1);
    assert.ok(finalComment && finalComment.text.includes(questionReply.toUpperCase()), 'the final answer uses the reply');
    await waitFor('the second request in the closed history', answerTimeoutMs, () => getClosedRequests(issueKey).length >= 2);
    assert.deepEqual(getClosedRequests(issueKey).map((record) => record.closeReason), ['question', 'final']);
    report(`question ${issueKey} continued: comment ${finalComment.id} "${finalComment.text}"`);
  });

  it('killed: the request is still answered after the agent was killed', async () => {
    const issueKey = getIssueKey('killed');
    const state = await waitForHandBack(issueKey, killedAnswerTimeoutMs, (comments) => comments.some((comment) => /SLEPT/.test(comment.text)));
    assert.deepEqual(getClosedRequests(issueKey).map((record) => record.closeReason), ['final']);
    const initCount = readStreamLines(issueKey).filter((line) => line.type === 'system' && line.subtype === 'init').length;
    report(`killed ${issueKey}: comment(s) ${getAiComments(state).map((comment) => `${comment.id} "${comment.text}"`).join(', ')}; ${initCount} session init(s)`);
  });

  it('every Jira session loaded only the bot\'s MCP server (R8)', () => {
    for (const scenario of sessionScenarios) {
      const inits = readStreamLines(getIssueKey(scenario)).filter((line) => line.type === 'system' && line.subtype === 'init');
      assert.ok(inits.length > 0, `${scenario}: a session init was read`);
      for (const init of inits) {
        assert.deepEqual((init.mcp_servers ?? []).map((server) => server.name), [botMcpServerName], `${scenario}: only the bot MCP`);
      }
      report(`${scenario} mcp_servers: ${JSON.stringify(inits.map((init) => init.mcp_servers))}`);
    }
  });

  it('the self-assigned issue got no request and no comment; no Telegram path was reached', async () => {
    const state = await getRequester().getIssueState(getIssueKey('self'));
    assert.deepEqual(state.comments, []);
    assert.equal(state.assigneeAccountId, config.accountId, 'still with the AI, handed nowhere');
    assert.ok(!charnessOutput.includes(telegramCallRefusedLogPrefix), 'no Telegram API call reached the guard');
    assert.ok(!charnessOutput.includes(TelegramDisabledError.name));
    assert.ok(!charnessOutput.includes(notTelegramChatPhrase), 'no Telegram primitive was handed a Jira conversation');
  });

  it('stops cleanly: charness and its private tmux server gone, the ports free, the default tmux server unchanged', async () => {
    await stopCharness();
    killInstanceTmuxServer();
    assert.equal(listTmuxSessions(['-S', socketPath]), null, 'the private server is gone');
    for (const port of getInstancePorts()) assert.ok(await checkIsPortFree(port), `port ${port} is free`);
    const defaultTmuxSessionsAfter = listTmuxSessions([]);
    report(`default tmux server after: ${defaultTmuxSessionsAfter === null ? 'not running' : `${defaultTmuxSessionsAfter.length} session(s)`}`);
    assert.deepEqual((defaultTmuxSessionsBefore ?? []).filter((name) => !(defaultTmuxSessionsAfter ?? []).includes(name)), [], 'no session of the default server disappeared');
    assert.deepEqual((defaultTmuxSessionsAfter ?? []).filter((name) => name.includes(projectKey)), [], 'nothing of the instance on the default server');
  });
});
