/**
 * @description The Jira connector end to end, at PROCESS level (Jira connector
 * plan J7, R6, R11): the BUILT charness, started the way an isolated instance
 * is started (`scripts/run-isolated.sh` with its own env file), serving Jira
 * only, against a fake Jira on loopback (`jiraE2e/fakeJira.ts`) and a fake
 * `claude` (`jiraE2e/fakeClaude.ts`, via `CLAUDE_BIN`) that answers through the
 * real bot MCP. One flow, in order:
 *
 *   isolation checked before the boot: a private tmux server (named, in a
 *   private TMUX_TMPDIR), a temp HOME, DATA_DIR and WORK_ROOT with no Claude
 *   memory above, ports of its own, an env file without a bot token or Atlassian
 *   variables
 *   → the requester assigns four issues, plus one the AI assigned itself and one
 *     of a project outside the allowlist
 *   → answered: a comment by the AI account, the issue handed back
 *   → a silent first turn: woken, then answered
 *   → the agent process killed mid-turn: resumed in its own session, answered
 *   → a progress note: commented, the issue stays with the AI
 *   → the self-assigned and the foreign issue: no request, nothing posted
 *   → charness restarted: no request is opened a second time
 *   → every session launch carried the Jira flags (R11); no Telegram call (R6);
 *     every tmux call named the private server, nothing of the instance on the
 *     user's default tmux server
 *
 * Nothing leaves the machine: Jira and the bot MCP are on loopback, the agent is
 * the fake. The instance's TMUX_TMPDIR lies inside the temp folder, so even a
 * broken `-L` guard could not reach the user's default tmux server — it would
 * start a default server of its own there, which the last step catches.
 * Everything the test starts is stopped in `after` — charness, its tmux servers
 * (with the fake agents in them), the fake Jira — and the temp folder removed.
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
import { pathToFileURL } from 'url';
import { FakeJira, fakeJiraSearchRequest, type FakeJiraIssue } from './jiraE2e/fakeJira';
import { checkHasFlag, fakeClaudeLogFileNames, getFlagValues, getLaunchSessionId, requiredJiraSessionFlags } from './jiraE2e/fakeClaudeContract';
import { getAdfText } from '../connectors/jira/adf';
import { getClaudeMemoryAbove } from '../connectors/jira/config';
import { notTelegramChatPhrase } from '../connectors/telegram/foreignKeyFallbacks';
import { foreignKeyAccessorErrorPrefix } from '../connectors/telegram/sessionKeyCodec';
import { TelegramDisabledError, telegramCallRefusedLogPrefix } from '../connectors/telegram/telegramCallGuard';

const repoRoot = path.resolve(__dirname, '..', '..');
const cliPath = path.join(repoRoot, 'dist', 'cli.js');
const runIsolatedPath = path.join(repoRoot, 'scripts', 'run-isolated.sh');
const fakeClaudePath = path.join(__dirname, 'jiraE2e', 'fakeClaude.ts');
const tsxLoaderPath = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs');

const aiAccount = { accountId: 'ai-account', accountType: 'atlassian', displayName: 'AI' };
const aiCredentials = { email: 'ai@example.com', apiToken: 'fake-token' };
const requester = { accountId: 'requester-account', accountType: 'atlassian', displayName: 'Requester' };
const inProgress = { id: '10001', name: 'In Progress' };
const toDo = { id: '10000', name: 'To Do' };
const projectFolder = 'proj';
/** The shortest poll the config allows. */
const pollIntervalSeconds = 10;
/**
 * Short, so the killed agent's request is taken up within a sweep or two — yet
 * longer than any session start: the sweep reads a request whose first post is
 * still starting its session as one nobody works on, and would wake it again.
 */
const backstopMinutes = '0.5';

const flowTimeoutMs = 6 * 60 * 1000;
const bootTimeoutMs = 60 * 1000;
/** A poll, a session start and a turn, with room to spare. */
const answerTimeoutMs = 60 * 1000;
/** The backstop window plus the wake-up engine's one-minute sweep, twice over. */
const resumeTimeoutMs = 3 * 60 * 1000;
const stopTimeoutMs = 20 * 1000;
const waitStepMs = 250;
/** How much of charness's output a failed wait quotes. */
const outputTailChars = 4000;

let testRoot: string;
let instanceHome: string;
let dataDir: string;
let workRoot: string;
let fakeLogDir: string;
let envFile: string;
let tmuxSocketName: string;
/** The instance's TMUX_TMPDIR — inside the temp folder, apart from the user's own servers. */
let tmuxTmpDir: string;
let fakeJira: FakeJira;
let charness: ChildProcess | null = null;
/** Everything every charness run printed, stdout and stderr together. */
let charnessOutput = '';
let defaultTmuxSessionsBefore: string[] = [];

async function getFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === 'string') throw new Error('no TCP port was assigned');
  return address.port;
}

/**
 * The test's own environment with `TMUX_TMPDIR` set to `dir`, or removed (tmux then uses `/tmp`) for `null`.
 * `TMUX` / `TMUX_PANE` are always removed: run from inside a tmux session, a command without `-L` / `-S`
 * goes to the server `$TMUX` names — the user's default one — whatever `TMUX_TMPDIR` says.
 */
function getTmuxEnv(dir: string | null): NodeJS.ProcessEnv {
  const { TMUX_TMPDIR: _userTmuxTmpDir, TMUX: _userTmuxServer, TMUX_PANE: _userTmuxPane, ...env } = process.env;
  return dir === null ? env : { ...env, TMUX_TMPDIR: dir };
}

/** The instance's tmux servers: the private TMUX_TMPDIR it is given. */
function getInstanceTmuxEnv(): NodeJS.ProcessEnv {
  return getTmuxEnv(tmuxTmpDir);
}

/** Session names on a tmux server — read-only; an empty list when that server is not running. */
function listTmuxSessions(socketArgs: readonly string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const result = spawnSync('tmux', [...socketArgs, 'list-sessions', '-F', '#{session_name}'], { encoding: 'utf8', env });
  return result.status === 0 ? result.stdout.split('\n').filter(Boolean) : [];
}

/** The folder tmux keeps this user's sockets in under a TMUX_TMPDIR: `<dir>/tmux-<uid>`. */
function getTmuxSocketDir(dir: string): string {
  return path.join(dir, `tmux-${process.getuid?.() ?? 0}`);
}

/** Lines another process may still be appending to: only those already ended by a newline are read. */
function readFakeLog<TRecord>(fileName: string): TRecord[] {
  const filePath = path.join(fakeLogDir, fileName);
  if (!fs.existsSync(filePath)) return [];
  const completeLines = fs.readFileSync(filePath, 'utf8').split('\n').slice(0, -1);
  return completeLines.filter(Boolean).map((line) => JSON.parse(line));
}

interface FakeTurn {
  requestId: string;
  issueKey: string;
  isRequestPrompt: boolean;
  turnCount: number;
  pid: number;
}

interface FakeLaunch {
  argv: string[];
  isSessionLaunch: boolean;
  pid: number;
  envNames: string[];
  home: string;
}

interface FakeAnswer {
  requestId: string;
  issueKey: string;
  kind: string;
  /** The tool result the agent got back; `error: …` when `answer_request` refused. */
  outcome: string;
}

/** The only variables `run-isolated.sh` passes to the instance. */
const isolatedLaunchEnvNames = ['HOME', 'PATH', 'USER', 'SHELL', 'LANG', 'TERM', 'ENV_FILE'];
/** Variables of another bot or of the operator's Atlassian account — never in the instance, never in its agent. */
const foreignEnvNameRe = /^(TELEGRAM_BOT_TOKEN|ATLASSIAN_|TELEGRAMCODE_)/;

/** The variable NAMES a running process was started with (Linux `/proc`); `null` where `/proc` is not available. */
function getProcessEnvNames(pid: number): string[] | null {
  const environPath = `/proc/${pid}/environ`;
  if (!fs.existsSync(environPath)) return null;
  return fs.readFileSync(environPath, 'utf8').split('\0').filter(Boolean).map((entry) => entry.slice(0, entry.indexOf('=')));
}

function getTurns(issueKey: string): FakeTurn[] {
  return readFakeLog<FakeTurn>(fakeClaudeLogFileNames.turns).filter((turn) => turn.issueKey === issueKey);
}

function getAnswers(issueKey: string): FakeAnswer[] {
  return readFakeLog<FakeAnswer>(fakeClaudeLogFileNames.answers).filter((answer) => answer.issueKey === issueKey);
}

/** The last session launch the process `pid` was started by. */
function getSessionLaunchOf(pid: number): FakeLaunch | undefined {
  return readFakeLog<FakeLaunch>(fakeClaudeLogFileNames.launches).filter((launch) => launch.isSessionLaunch && launch.pid === pid).at(-1);
}

/** The issues the connector's polls decided to open a request for, from its `[jira] poll: KEY decision, …` lines. */
function getPolledRequestIssueKeys(output: string): string[] {
  const pollLinePrefix = '[jira] poll: ';
  return output.split('\n')
    .filter((line) => line.startsWith(pollLinePrefix))
    .flatMap((line) => line.slice(pollLinePrefix.length).split(', '))
    .map((entry) => entry.split(' '))
    .filter(([, decision]) => decision === 'request')
    .map(([issueKey]) => issueKey);
}

function getCommentTexts(issue: FakeJiraIssue): string[] {
  return issue.comments.map((comment) => getAdfText(comment.body));
}

async function waitFor(description: string, timeoutMs: number, check: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${description}; charness output tail:\n${charnessOutput.slice(-outputTailChars)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, waitStepMs));
  }
}

/** Start charness the way an isolated instance is started: `run-isolated.sh` with only its env file. */
async function startCharness(): Promise<void> {
  const outputStart = charnessOutput.length;
  const child = spawn(runIsolatedPath, [envFile], {
    // run-isolated.sh passes on only these; HOME is the instance's own temp home.
    // The running node first: under `yarn test` PATH starts with yarn's `node` shim, a shell script that would add its own variables.
    env: {
      HOME: instanceHome,
      PATH: [path.dirname(process.execPath), process.env.PATH ?? ''].join(path.delimiter),
      USER: process.env.USER ?? '',
      SHELL: '/bin/sh',
      LANG: 'C.UTF-8',
      TERM: 'dumb',
    },
    cwd: testRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  charness = child;
  child.stdout?.on('data', (chunk: Buffer) => { charnessOutput += chunk.toString('utf8'); });
  child.stderr?.on('data', (chunk: Buffer) => { charnessOutput += chunk.toString('utf8'); });
  await waitFor('charness to start polling', bootTimeoutMs, () => {
    if (child.exitCode !== null) throw new Error(`charness exited with ${child.exitCode}:\n${charnessOutput.slice(outputStart)}`);
    return charnessOutput.slice(outputStart).includes(`[jira] polling PROJ every ${pollIntervalSeconds} s`);
  });
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

function writeInstanceFiles(ports: { openCode: number; botMcp: number }, jiraBaseUrl: string): void {
  fs.writeFileSync(path.join(dataDir, 'jira.json'), JSON.stringify({
    site: 'example.atlassian.net',
    baseUrl: jiraBaseUrl,
    email: aiCredentials.email,
    apiToken: '${CHARNESS_JIRA_AI_API_TOKEN}',
    accountId: aiAccount.accountId,
    projects: { PROJ: { folder: projectFolder, triggerStatuses: [inProgress.name] } },
    pollIntervalSeconds,
    adapter: 'claude-json-stream',
  }, null, 2));

  const fakeStateDir = path.join(testRoot, 'fake-claude-state');
  fs.mkdirSync(fakeStateDir);
  const claudeBin = path.join(testRoot, 'bin', 'claude');
  fs.mkdirSync(path.dirname(claudeBin));
  fs.writeFileSync(claudeBin, [
    '#!/bin/sh',
    `export FAKE_CLAUDE_LOG_DIR='${fakeLogDir}'`,
    `export FAKE_CLAUDE_STATE_DIR='${fakeStateDir}'`,
    `exec '${process.execPath}' --import '${pathToFileURL(tsxLoaderPath).href}' '${fakeClaudePath}' "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });

  const instanceEnv: Record<string, string> = {
    CONNECTORS: 'jira',
    DATA_DIR: dataDir,
    WORK_ROOT: workRoot,
    TMUX_SOCKET_NAME: tmuxSocketName,
    TMUX_TMPDIR: tmuxTmpDir,
    CLAUDE_BIN: claudeBin,
    OPENCODE_URL: `http://127.0.0.1:${ports.openCode}`,
    SCHEDULER_MCP_PORT: ports.botMcp.toString(),
    REQUEST_BACKSTOP_MINUTES: backstopMinutes,
    CHARNESS_JIRA_AI_API_TOKEN: aiCredentials.apiToken,
  };
  fs.writeFileSync(envFile, `${Object.entries(instanceEnv).map(([name, value]) => `${name}=${value}`).join('\n')}\n`, { mode: 0o600 });
}

function createIssue(key: string, mode: string): void {
  fakeJira.createIssue({ key, summary: `[fake:${mode}] Task ${key}`, description: `Please handle ${key}.`, statusId: inProgress.id, reporter: requester });
}

describe('Jira connector end to end: built charness, fake Jira, fake claude (J7)', { timeout: flowTimeoutMs }, () => {
  before(async () => {
    if (!fs.existsSync(cliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    testRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'charness-j7-')));
    instanceHome = path.join(testRoot, 'home');
    dataDir = path.join(testRoot, 'data');
    workRoot = path.join(testRoot, 'work');
    fakeLogDir = path.join(testRoot, 'fake-claude-log');
    envFile = path.join(testRoot, 'instance.env');
    tmuxTmpDir = path.join(testRoot, 'tmux');
    for (const dir of [instanceHome, dataDir, path.join(workRoot, projectFolder), fakeLogDir]) fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(tmuxTmpDir, { mode: 0o700 });
    tmuxSocketName = `charness-j7-${randomBytes(4).toString('hex')}`;
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    fakeJira = new FakeJira({ aiAccount, credentials: aiCredentials, statuses: [toDo, inProgress] });
    const jiraBaseUrl = await fakeJira.start();
    writeInstanceFiles({ openCode: await getFreePort(), botMcp: await getFreePort() }, jiraBaseUrl);
  });

  after(async () => {
    await stopCharness();
    if (tmuxSocketName && tmuxTmpDir) {
      // Only the instance's own servers, which also ends the fake agents in them: its named server and any
      // default server a broken `-L` guard started — both in its private TMUX_TMPDIR, never the user's — and,
      // had the TMUX_TMPDIR hand-over broken, the named server in tmux's own default folder (`/tmp`). Each is
      // named by FULL PATH (`-S`): a bare `kill-server` run from inside a tmux session went to the server `$TMUX`
      // names — the user's default one — and killed every session on it.
      for (const socketPath of [
        path.join(getTmuxSocketDir(tmuxTmpDir), tmuxSocketName),
        path.join(getTmuxSocketDir(tmuxTmpDir), 'default'),
        path.join(getTmuxSocketDir('/tmp'), tmuxSocketName),
      ]) {
        spawnSync('tmux', ['-S', socketPath, 'kill-server'], { env: getTmuxEnv(null) });
      }
      fs.rmSync(path.join(getTmuxSocketDir('/tmp'), tmuxSocketName), { force: true });
    }
    await fakeJira?.stop();
    if (testRoot) fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it('isolation holds before the first boot', () => {
    assert.deepEqual(fs.readdirSync(tmuxTmpDir), [], 'no tmux server of the instance is running yet');
    const realHome = fs.realpathSync(os.homedir());
    for (const dir of [instanceHome, dataDir, workRoot, tmuxTmpDir]) {
      assert.ok(!dir.startsWith(`${realHome}${path.sep}`), `${dir} is outside the user's HOME`);
    }
    assert.equal(getClaudeMemoryAbove(path.join(workRoot, projectFolder)), null, 'no Claude memory in or above the working folder');
    const envNames = fs.readFileSync(envFile, 'utf8').split('\n').filter(Boolean).map((line) => line.split('=')[0]);
    assert.ok(!envNames.includes('TELEGRAM_BOT_TOKEN'), 'no bot token');
    assert.ok(!envNames.some((name) => name.startsWith('ATLASSIAN_')), 'no Atlassian variables');
    for (const name of ['TMUX_SOCKET_NAME', 'TMUX_TMPDIR', 'DATA_DIR', 'WORK_ROOT']) assert.ok(envNames.includes(name), `${name} is set`);
  });

  it('boots Jira-only, started with nothing but run-isolated.sh\'s variables', async () => {
    createIssue('PROJ-1', 'answer');
    createIssue('PROJ-2', 'silent-once');
    createIssue('PROJ-3', 'hang-once');
    createIssue('PROJ-4', 'progress');
    createIssue('PROJ-5', 'answer');
    createIssue('OTHER-1', 'answer');
    await startCharness();
    const envNames = charness?.pid === undefined ? null : getProcessEnvNames(charness.pid);
    if (envNames !== null) assert.deepEqual([...envNames].sort(), [...isolatedLaunchEnvNames].sort());
  });

  it('the requester assigns the issues: each in-scope one becomes one request', async () => {
    for (const key of ['PROJ-1', 'PROJ-2', 'PROJ-3', 'PROJ-4', 'OTHER-1']) fakeJira.assignIssue(key, aiAccount, requester);
    fakeJira.assignIssue('PROJ-5', aiAccount, aiAccount);
    // The polls also name each request they open — what the restart step reads back.
    await waitFor('the first turn of every in-scope issue, and its request in the poll log', answerTimeoutMs, () =>
      ['PROJ-1', 'PROJ-2', 'PROJ-3', 'PROJ-4'].every((key) => getTurns(key).length > 0 && getPolledRequestIssueKeys(charnessOutput).includes(key)));
    for (const key of ['PROJ-1', 'PROJ-2', 'PROJ-3', 'PROJ-4']) {
      assert.equal(getTurns(key)[0].isRequestPrompt, true, `${key}'s first turn is its request prompt`);
    }
    assert.deepEqual([...getPolledRequestIssueKeys(charnessOutput)].sort(), ['PROJ-1', 'PROJ-2', 'PROJ-3', 'PROJ-4'], 'one request each');
    assert.ok(listTmuxSessions(['-L', tmuxSocketName], getInstanceTmuxEnv()).length >= 4, 'the agents run on the private server');
  });

  it('an answer becomes a comment by the AI account and the issue goes back to the requester', async () => {
    const issue = fakeJira.getIssue('PROJ-1');
    await waitFor('PROJ-1 handed back', answerTimeoutMs, () => issue.assignee?.accountId === requester.accountId);
    assert.deepEqual(getCommentTexts(issue), ['Fake final answer for PROJ-1 (answer, turn 1).']);
    assert.ok(issue.comments.every((comment) => comment.author.accountId === aiAccount.accountId));
  });

  it('a turn that ends without an answer is woken, and the answer follows', async () => {
    const issue = fakeJira.getIssue('PROJ-2');
    await waitFor('PROJ-2 handed back', answerTimeoutMs, () => issue.assignee?.accountId === requester.accountId);
    const turns = getTurns('PROJ-2');
    assert.deepEqual(turns.map((turn) => turn.isRequestPrompt), [true, false], 'the request, then a reminder');
    assert.deepEqual(getCommentTexts(issue), ['Fake final answer for PROJ-2 (silent-once, turn 2).']);
  });

  it('a progress note is a comment; the issue stays with the AI', async () => {
    const issue = fakeJira.getIssue('PROJ-4');
    // Until `answer_request` returned, the sink may still be about to hand the issue back.
    await waitFor('PROJ-4 progress answer returned to the agent', answerTimeoutMs, () => getAnswers('PROJ-4').length > 0);
    const [answer] = getAnswers('PROJ-4');
    assert.equal(answer.kind, 'progress');
    assert.ok(!answer.outcome.startsWith('error:'), answer.outcome);
    assert.deepEqual(getCommentTexts(issue), ['Fake progress answer for PROJ-4 (progress, turn 1).']);
    assert.equal(issue.assignee?.accountId, aiAccount.accountId);
  });

  it('the agent killed mid-turn: its own session is resumed and the request is still answered', async () => {
    const [hangingTurn] = getTurns('PROJ-3');
    assert.ok(hangingTurn, 'PROJ-3 reached its agent');
    assert.equal(getTurns('PROJ-3').length, 1, 'its first turn is still running');
    assert.equal(fakeJira.getIssue('PROJ-3').comments.length, 0, 'nothing answered yet');
    const hangingSessionId = getLaunchSessionId(getSessionLaunchOf(hangingTurn.pid)?.argv ?? []);
    assert.ok(hangingSessionId, 'the hanging agent\'s launch named its conversation');
    const commandLinePath = `/proc/${hangingTurn.pid}/cmdline`;
    if (fs.existsSync('/proc/self')) {
      // Never a pid that has since gone to another process.
      assert.ok(fs.existsSync(commandLinePath) && fs.readFileSync(commandLinePath, 'utf8').includes(fakeClaudePath), 'the pid is still the fake agent');
    }
    process.kill(hangingTurn.pid, 'SIGKILL');

    const issue = fakeJira.getIssue('PROJ-3');
    await waitFor('PROJ-3 handed back after the kill', resumeTimeoutMs, () => issue.assignee?.accountId === requester.accountId);
    const turns = getTurns('PROJ-3');
    assert.equal(turns.length, 2);
    assert.notEqual(turns[1].pid, hangingTurn.pid, 'answered by a new agent process');
    assert.deepEqual(getCommentTexts(issue), ['Fake final answer for PROJ-3 (hang-once, turn 2).']);
    // The fake refuses a `--resume` of a conversation it never held, as the real CLI does.
    const answeringLaunch = getSessionLaunchOf(turns[1].pid);
    assert.ok(answeringLaunch, 'the answering agent\'s launch was logged');
    assert.deepEqual(getFlagValues(answeringLaunch.argv, '--resume'), [hangingSessionId], 'turn 2 ran in a resume of PROJ-3\'s own conversation');
  });

  it('an issue the AI assigned itself and an issue outside the allowlist are left alone', async () => {
    await waitFor('the poll that saw them', answerTimeoutMs, () =>
      /PROJ-5 selfAuthored/.test(charnessOutput) && /OTHER-1 notAllowed/.test(charnessOutput));
    for (const key of ['PROJ-5', 'OTHER-1']) {
      assert.deepEqual(getTurns(key), [], `${key} reached no agent`);
      assert.deepEqual(fakeJira.getIssue(key).comments, [], `${key} got no comment`);
      assert.equal(fakeJira.getIssue(key).assignee?.accountId, aiAccount.accountId, `${key} was not handed anywhere`);
    }
  });

  it('a restart opens no request a second time', async () => {
    const requestPromptCount = (): number => readFakeLog<FakeTurn>(fakeClaudeLogFileNames.turns).filter((turn) => turn.isRequestPrompt).length;
    const promptsBefore = requestPromptCount();
    const commentsBefore = ['PROJ-1', 'PROJ-2', 'PROJ-3', 'PROJ-4', 'PROJ-5'].map((key) => fakeJira.getIssue(key).comments.length);
    await stopCharness();

    const searchesBefore = fakeJira.requestLog.filter((request) => request === fakeJiraSearchRequest).length;
    const outputBeforeRestart = charnessOutput.length;
    await startCharness();
    // Two polls after the restart: the first one decided every issue again.
    await waitFor('two polls after the restart', 3 * pollIntervalSeconds * 1000, () =>
      fakeJira.requestLog.filter((request) => request === fakeJiraSearchRequest).length >= searchesBefore + 2);

    // Deterministic, whereas the counts below could be read before a re-opened request's post (not awaited) lands.
    assert.deepEqual(getPolledRequestIssueKeys(charnessOutput.slice(outputBeforeRestart)), [], 'no poll opened a request again');
    assert.equal(requestPromptCount(), promptsBefore, 'no request prompt was posted again');
    // One request per issue. Its PROMPT may reach the agent twice: a request whose taking-in was not yet
    // seen when the agent died is re-posted to the resumed session (R21) — same request, not a second one.
    for (const key of ['PROJ-1', 'PROJ-2', 'PROJ-3', 'PROJ-4']) {
      assert.equal(new Set(getTurns(key).map((turn) => turn.requestId)).size, 1, `${key} was one request, from start to end`);
    }
    assert.deepEqual(['PROJ-1', 'PROJ-2', 'PROJ-3', 'PROJ-4', 'PROJ-5'].map((key) => fakeJira.getIssue(key).comments.length), commentsBefore);
    assert.equal(fakeJira.getIssue('PROJ-4').assignee?.accountId, aiAccount.accountId, 'PROJ-4 still matches — its trigger was remembered');
  });

  it('the agent got the instance\'s temp HOME and no other bot\'s or Atlassian variables', () => {
    const launches = readFakeLog<FakeLaunch>(fakeClaudeLogFileNames.launches);
    assert.ok(launches.length > 0);
    for (const launch of launches) {
      assert.equal(launch.home, instanceHome);
      assert.deepEqual(launch.envNames.filter((name) => foreignEnvNameRe.test(name)), []);
    }
  });

  it('every session launch carried the Jira flags (R11)', () => {
    assert.deepEqual(readFakeLog(fakeClaudeLogFileNames.violations), [], 'no launch was refused by the fake');
    const sessionLaunches = readFakeLog<FakeLaunch>(fakeClaudeLogFileNames.launches).filter((launch) => launch.isSessionLaunch);
    assert.ok(sessionLaunches.some((launch) => launch.argv.includes('--session-id')), 'a fresh launch');
    assert.ok(sessionLaunches.some((launch) => launch.argv.includes('--resume')), 'a resume launch');
    for (const launch of sessionLaunches) {
      for (const flag of requiredJiraSessionFlags) assert.ok(checkHasFlag(launch.argv, flag), `${flag.join(' ')} in ${launch.argv.join(' ')}`);
    }
  });

  it('no Telegram path was reached for the Jira conversations (R6)', () => {
    assert.ok(!charnessOutput.includes(telegramCallRefusedLogPrefix), 'no Telegram API call reached the guard');
    assert.ok(!charnessOutput.includes(TelegramDisabledError.name));
    // What a Telegram primitive says when a Jira key reaches it (a skipped primitive, the send queue's refusal).
    assert.ok(!charnessOutput.includes(notTelegramChatPhrase), 'no Telegram primitive was handed a Jira conversation');
    assert.ok(!charnessOutput.includes(foreignKeyAccessorErrorPrefix), 'no Telegram id was read off a Jira key');
  });

  it('every tmux call named the private server; nothing of the instance runs on the default tmux server', () => {
    // A call without `-L` would have started (or reached) a `default` server beside it.
    assert.deepEqual(fs.readdirSync(getTmuxSocketDir(tmuxTmpDir)), [tmuxSocketName], 'one tmux server, the named one');
    const instanceSessions = new Set(listTmuxSessions(['-L', tmuxSocketName], getInstanceTmuxEnv()));
    assert.ok(instanceSessions.size > 0);
    const defaultSessionsNow = listTmuxSessions([]);
    assert.deepEqual(defaultSessionsNow.filter((name) => instanceSessions.has(name)), []);
    assert.deepEqual(defaultSessionsNow.filter((name) => !defaultTmuxSessionsBefore.includes(name) && name.includes('PROJ')), []);
  });
});
