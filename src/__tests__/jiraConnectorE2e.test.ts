/**
 * @description The Jira connector end to end, at PROCESS level (Jira connector
 * plan J7, R6, R11): the BUILT charness, started the way an isolated instance
 * is started (`scripts/run-isolated.sh` with its own env file), serving Jira
 * only, against a fake Jira on loopback (`jiraE2e/fakeJira.ts`) and a fake
 * `claude` (`jiraE2e/fakeClaude.ts`, via `CLAUDE_BIN`) that answers through the
 * real bot MCP. One flow, in order:
 *
 *   isolation checked before the boot: a private tmux server, a temp HOME,
 *   DATA_DIR and WORK_ROOT with no Claude memory above, ports of its own, an env
 *   file without a bot token or Atlassian variables
 *   → the requester assigns four issues, plus one the AI assigned itself and one
 *     of a project outside the allowlist
 *   → answered: a comment by the AI account, the issue handed back
 *   → a silent first turn: woken, then answered
 *   → the agent process killed mid-turn: resumed in its own session, answered
 *   → a progress note: commented, the issue stays with the AI
 *   → the self-assigned and the foreign issue: no request, nothing posted
 *   → charness restarted: no request is opened a second time
 *   → every session launch carried the Jira flags (R11); no Telegram call (R6);
 *     nothing of the instance on the default tmux server
 *
 * Nothing leaves the machine: Jira and the bot MCP are on loopback, the agent is
 * the fake. Everything the test starts is stopped in `after` — charness, its
 * private tmux server (with the fake agents in it), the fake Jira — and the temp
 * folder removed.
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
import { checkHasFlag, fakeClaudeLogFileNames, requiredJiraSessionFlags } from './jiraE2e/fakeClaudeContract';
import { getAdfText } from '../connectors/jira/adf';
import { getClaudeMemoryAbove } from '../connectors/jira/config';
import { telegramCallRefusedLogPrefix } from '../connectors/telegram/telegramCallGuard';

const repoRoot = path.resolve(__dirname, '..', '..');
const cliPath = path.join(repoRoot, 'dist', 'cli.js');
const runIsolatedPath = path.join(repoRoot, 'scripts', 'run-isolated.sh');
const fakeClaudePath = path.join(__dirname, 'jiraE2e', 'fakeClaude.ts');
const tsxLoaderPath = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs');

const aiAccount = { accountId: 'ai-account', accountType: 'atlassian', displayName: 'AI' };
const requester = { accountId: 'requester-account', accountType: 'atlassian', displayName: 'Requester' };
const inProgress = { id: '10001', name: 'In Progress' };
const toDo = { id: '10000', name: 'To Do' };
const projectFolder = 'proj';
/** The shortest poll the config allows. */
const pollIntervalSeconds = 10;
/** A short backstop, so the killed agent's request is taken up within the sweep after it. */
const backstopMinutes = '0.1';

const flowTimeoutMs = 6 * 60 * 1000;
const bootTimeoutMs = 60 * 1000;
/** A poll, a session start and a turn, with room to spare. */
const answerTimeoutMs = 60 * 1000;
/** The backstop window plus the wake-up engine's one-minute sweep. */
const resumeTimeoutMs = 3 * 60 * 1000;
const stopTimeoutMs = 20 * 1000;
const waitStepMs = 250;

let tmpRoot: string;
let instanceHome: string;
let dataDir: string;
let workRoot: string;
let fakeLogDir: string;
let envFile: string;
let tmuxSocketName: string;
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

/** Session names on a tmux server — read-only; an empty list when that server is not running. */
function listTmuxSessions(socketArgs: readonly string[]): string[] {
  const result = spawnSync('tmux', [...socketArgs, 'list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.split('\n').filter(Boolean) : [];
}

/** Where tmux puts a named server's socket: `$TMUX_TMPDIR` (else `/tmp`) / `tmux-<uid>` / name. */
function getTmuxSocketPath(socketName: string): string {
  return path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid?.() ?? 0}`, socketName);
}

function checkIsTmuxServerRunning(socketName: string): boolean {
  return spawnSync('tmux', ['-L', socketName, 'list-sessions'], { encoding: 'utf8' }).status === 0;
}

function readFakeLog<TRecord>(fileName: string): TRecord[] {
  const filePath = path.join(fakeLogDir, fileName);
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
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
  envNames: string[];
  home: string;
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

function getCommentTexts(issue: FakeJiraIssue): string[] {
  return issue.comments.map((comment) => getAdfText(comment.body));
}

async function waitFor(description: string, timeoutMs: number, check: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${description}; charness output tail:\n${charnessOutput.slice(-4000)}`);
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
    cwd: tmpRoot,
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
    email: 'ai@example.com',
    apiToken: '${CHARNESS_JIRA_AI_API_TOKEN}',
    accountId: aiAccount.accountId,
    projects: { PROJ: { folder: projectFolder, triggerStatuses: [inProgress.name] } },
    pollIntervalSeconds,
    adapter: 'claude-json-stream',
  }, null, 2));

  const fakeStateDir = path.join(tmpRoot, 'fake-claude-state');
  fs.mkdirSync(fakeStateDir);
  const claudeBin = path.join(tmpRoot, 'bin', 'claude');
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
    CLAUDE_BIN: claudeBin,
    OPENCODE_URL: `http://127.0.0.1:${ports.openCode}`,
    SCHEDULER_MCP_PORT: ports.botMcp.toString(),
    REQUEST_BACKSTOP_MINUTES: backstopMinutes,
    CHARNESS_JIRA_AI_API_TOKEN: 'fake-token',
  };
  fs.writeFileSync(envFile, `${Object.entries(instanceEnv).map(([name, value]) => `${name}=${value}`).join('\n')}\n`, { mode: 0o600 });
}

function createIssue(key: string, mode: string): void {
  fakeJira.createIssue({ key, summary: `[fake:${mode}] Task ${key}`, description: `Please handle ${key}.`, statusId: inProgress.id, reporter: requester });
}

describe('Jira connector end to end: built charness, fake Jira, fake claude (J7)', { timeout: flowTimeoutMs }, () => {
  before(async () => {
    if (!fs.existsSync(cliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'charness-j7-')));
    instanceHome = path.join(tmpRoot, 'home');
    dataDir = path.join(tmpRoot, 'data');
    workRoot = path.join(tmpRoot, 'work');
    fakeLogDir = path.join(tmpRoot, 'fake-claude-log');
    envFile = path.join(tmpRoot, 'instance.env');
    for (const dir of [instanceHome, dataDir, path.join(workRoot, projectFolder), fakeLogDir]) fs.mkdirSync(dir, { recursive: true });
    tmuxSocketName = `charness-j7-${randomBytes(4).toString('hex')}`;
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    fakeJira = new FakeJira({ aiAccount, statuses: [toDo, inProgress] });
    const jiraBaseUrl = await fakeJira.start();
    writeInstanceFiles({ openCode: await getFreePort(), botMcp: await getFreePort() }, jiraBaseUrl);
  });

  after(async () => {
    await stopCharness();
    // Only the instance's PRIVATE server, which also ends the fake agents in it; tmux leaves its socket file behind.
    if (tmuxSocketName) {
      spawnSync('tmux', ['-L', tmuxSocketName, 'kill-server']);
      fs.rmSync(getTmuxSocketPath(tmuxSocketName), { force: true });
    }
    await fakeJira?.stop();
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('isolation holds before the first boot', () => {
    assert.ok(!checkIsTmuxServerRunning(tmuxSocketName), 'the private tmux server is not running yet');
    const realHome = fs.realpathSync(os.homedir());
    for (const dir of [instanceHome, dataDir, workRoot]) {
      assert.ok(!dir.startsWith(`${realHome}${path.sep}`), `${dir} is outside the user's HOME`);
    }
    assert.equal(getClaudeMemoryAbove(path.join(workRoot, projectFolder)), null, 'no Claude memory in or above the working folder');
    const envNames = fs.readFileSync(envFile, 'utf8').split('\n').filter(Boolean).map((line) => line.split('=')[0]);
    assert.ok(!envNames.includes('TELEGRAM_BOT_TOKEN'), 'no bot token');
    assert.ok(!envNames.some((name) => name.startsWith('ATLASSIAN_')), 'no Atlassian variables');
    assert.ok(envNames.includes('TMUX_SOCKET_NAME') && envNames.includes('DATA_DIR') && envNames.includes('WORK_ROOT'));
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
    await waitFor('the first turn of every in-scope issue', answerTimeoutMs, () =>
      ['PROJ-1', 'PROJ-2', 'PROJ-3', 'PROJ-4'].every((key) => getTurns(key).length > 0));
    for (const key of ['PROJ-1', 'PROJ-2', 'PROJ-3', 'PROJ-4']) {
      assert.equal(getTurns(key)[0].isRequestPrompt, true, `${key}'s first turn is its request prompt`);
    }
    assert.ok(listTmuxSessions(['-L', tmuxSocketName]).length >= 4, 'the agents run on the private server');
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
    await waitFor('PROJ-4 progress comment', answerTimeoutMs, () => issue.comments.length > 0);
    assert.deepEqual(getCommentTexts(issue), ['Fake progress answer for PROJ-4 (progress, turn 1).']);
    assert.equal(issue.assignee?.accountId, aiAccount.accountId);
  });

  it('the agent killed mid-turn: its own session is resumed and the request is still answered', async () => {
    const [hangingTurn] = getTurns('PROJ-3');
    assert.ok(hangingTurn, 'PROJ-3 reached its agent');
    assert.equal(getTurns('PROJ-3').length, 1, 'its first turn is still running');
    assert.equal(fakeJira.getIssue('PROJ-3').comments.length, 0, 'nothing answered yet');
    process.kill(hangingTurn.pid, 'SIGKILL');

    const issue = fakeJira.getIssue('PROJ-3');
    await waitFor('PROJ-3 handed back after the kill', resumeTimeoutMs, () => issue.assignee?.accountId === requester.accountId);
    const turns = getTurns('PROJ-3');
    assert.equal(turns.length, 2);
    assert.notEqual(turns[1].pid, hangingTurn.pid, 'answered by a new agent process');
    assert.deepEqual(getCommentTexts(issue), ['Fake final answer for PROJ-3 (hang-once, turn 2).']);
    const resumeLaunches = readFakeLog<FakeLaunch>(fakeClaudeLogFileNames.launches).filter((launch) => launch.isSessionLaunch && launch.argv.includes('--resume'));
    assert.ok(resumeLaunches.length >= 1, 'the session was resumed by its id');
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
    await startCharness();
    // Two polls after the restart: the first one decided every issue again.
    await waitFor('two polls after the restart', 3 * pollIntervalSeconds * 1000, () =>
      fakeJira.requestLog.filter((request) => request === fakeJiraSearchRequest).length >= searchesBefore + 2);

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
    assert.ok(!charnessOutput.includes('TelegramDisabledError'));
    // What a Telegram primitive says when a Jira key reaches it (the rate limiter's refusal, a skipped fallback).
    assert.doesNotMatch(charnessOutput, /is not a Telegram chat/);
  });

  it('nothing of the instance runs on the default tmux server', () => {
    const instanceSessions = new Set(listTmuxSessions(['-L', tmuxSocketName]));
    assert.ok(instanceSessions.size > 0);
    const defaultSessionsNow = listTmuxSessions([]);
    assert.deepEqual(defaultSessionsNow.filter((name) => instanceSessions.has(name)), []);
    assert.deepEqual(defaultSessionsNow.filter((name) => !defaultTmuxSessionsBefore.includes(name) && name.includes('PROJ')), []);
  });
});
