/**
 * @description What the Jira connector's process-level flows share (Jira connector plan J7, R6, R11, R32): the people,
 * statuses and project of the fake site, the fake Jira itself, the instance's layout and its env file, starting charness
 * the way an isolated instance is started (`scripts/run-isolated.sh` with only its env file), the readers of the fake
 * `claude`'s logs and the instance's request history, and the flow parts every flow runs — the isolation check before the
 * boot and the invariants after the last step. Matches neither runner glob.
 *
 * The flows are independent journeys, one file each (`jiraConnectorE2e` — requests and the session lifecycle,
 * `jiraPromptE2e` — what the prompts carry, `jiraTrustE2e` — the trusted group and mentions), so they run in parallel.
 * Each runs in a process of its own: the state below (the layout, the started charness, the fake Jira) is that flow's.
 */

import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FakeJira, type FakeJiraIssue } from './fakeJira';
import {
  assertMcpListeningOn,
  builtCliPath,
  createIsolatedInstanceLayout,
  exitOnSignal,
  getFlowDeadlineMs,
  getFreeFixedPort,
  getFreePort,
  getInstanceEnvNames,
  getProcessEnvNames,
  getTmuxEnv,
  getTmuxSocketDir,
  IsolatedCharness,
  isolatedLaunchEnvNames,
  listTmuxSessions,
  readClosedRequests as readClosedRequestsOf,
  readJsonLines,
  removeIsolatedInstanceSync,
  writeFakeClaudeLauncher,
  writeInstanceEnvFile,
  type IsolatedInstanceLayout,
} from '../e2e/isolatedCharness';
import { getPollJqlProjectKeys } from './charnessLog';
import {
  checkHasFlag,
  fakeClaudeLogFileNames,
  getFlagValues,
  getForeignAgentEnvNames,
  requiredJiraSessionFlags,
  type FakeClaudeAnswer,
  type FakeClaudePrompt,
  type FakeClaudeToolCall,
  type FakeClaudeTurn,
} from './fakeClaudeContract';
import { getAdfText } from '../../connectors/jira/adf';
import type { ClosedRequestRecord } from '../../requests/types';
import { notTelegramChatPhrase } from '../../connectors/telegram/foreignKeyFallbacks';
import { foreignKeyAccessorErrorPrefix } from '../../connectors/telegram/sessionKeyCodec';
import { TelegramDisabledError, telegramCallRefusedLogPrefix } from '../../connectors/telegram/telegramCallGuard';


export const aiAccount = { accountId: 'ai-account', accountType: 'atlassian', displayName: 'AI' };
const aiCredentials = { email: 'ai@example.com', apiToken: 'fake-token' };
export const requester = { accountId: 'requester-account', accountType: 'atlassian', displayName: 'Requester' };
/** A second person of the project, who hands an issue over while the requester's request is still open (R34). */
export const colleague = { accountId: 'colleague-account', accountType: 'atlassian', displayName: 'Colleague' };
/** The trusted group's members are the requester and the colleague; this person and the automation are not in it. */
export const outsider = { accountId: 'outsider-account', accountType: 'atlassian', displayName: 'Outsider' };
export const automation = { accountId: 'rule-account', accountType: 'app', displayName: 'Automation' };
export const trustedGroupName = 'ai-trusted';
const inProgress = { id: '10001', name: 'In Progress' };
export const toDo = { id: '10000', name: 'To Do' };
export const projectFolder = 'proj';
/** Project memory the agent loads from its working folder and every parent: one in the folder, one above it. */
const claudeMemoryFileName = 'CLAUDE.md';
/** The instance's secret: the AI account's token, which jira.json takes from the env file. */
const instanceTokenEnvName = 'CHARNESS_JIRA_AI_API_TOKEN';
/** The shortest poll the config allows. */
const pollIntervalSeconds = 10;
/** The shortest useful one, so the killed agent's request is taken up by the first sweep after it. */
const backstopMinutes = '0.1';
/** The idle mark (lifecycle plan L3): an answered issue's process is compacted and stopped this long after its last activity. */
const idleMinutes = '0.5';

const bootTimeoutMs = 60 * 1000;
/** A poll, a session start and a turn, with room to spare. */
export const answerTimeoutMs = 60 * 1000;
/** The backstop window plus the wake-up engine's one-minute sweep, twice over. */
export const resumeTimeoutMs = 3 * 60 * 1000;
/** The idle window, the compaction turn and the stop, with room to spare. */
export const idleStopTimeoutMs = 2 * 60 * 1000;
/** A per-turn stop follows the answer at once — well inside the 30 s idle window, which would stop the process too (L5). */
export const perTurnStopTimeoutMs = 15 * 1000;
/** The restart step waits for this many polls. */
export const restartPollWaitMs = 3 * pollIntervalSeconds * 1000;

let layout: IsolatedInstanceLayout | null = null;
/** The fake Jira of this flow's process; started by {@link registerJiraFlowHooks}. */
export const fakeJira = new FakeJira({ aiAccount, credentials: aiCredentials, statuses: [toDo, inProgress] });
let charness: IsolatedCharness | null = null;
let defaultTmuxSessionsBefore: string[] = [];
/** The bot MCP's port, the same on every start: a re-adopted agent keeps the address of its launch (see {@link assertMcpListeningOn}). */
let botMcpPort = 0;

export function getLayout(): IsolatedInstanceLayout {
  if (!layout) throw new Error('the instance layout is not created yet');
  return layout;
}

export function getCharness(): IsolatedCharness {
  if (!charness) throw new Error('charness is not started yet');
  return charness;
}

/** The instance's tmux servers: the private TMUX_TMPDIR it is given. */
export function getInstanceTmuxEnv(): NodeJS.ProcessEnv {
  return getTmuxEnv(getLayout().tmuxTmpDir);
}

export function readFakeLog<TRecord>(fileName: string): TRecord[] {
  return readJsonLines<TRecord>(path.join(getLayout().fakeLogDir, fileName));
}

interface FakeLaunch {
  argv: string[];
  isSessionLaunch: boolean;
  pid: number;
  envNames: string[];
  home: string;
  /** The PATH the agent started with. */
  path: string;
}

/** A `/compact` turn the fake ran, with the session it compacted (`compactions.jsonl`). */
export interface FakeCompaction {
  sessionId: string;
  pid: number;
}

/** Rewrite the persisted tool digests of the given conversations, as a bot build with other tools would find them (L4). */
export function markToolDigestStale(conversationKeys: string[]): void {
  const statePath = path.join(getLayout().dataDir, 'state.json');
  const persisted: { agents?: Record<string, { mcpToolDigest?: string }> } = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  for (const conversationKey of conversationKeys) {
    const agent = persisted.agents?.[conversationKey];
    assert.ok(agent?.mcpToolDigest, `${conversationKey} has a persisted tool digest to make stale`);
    agent.mcpToolDigest = 'a-digest-of-an-earlier-build';
  }
  fs.writeFileSync(statePath, JSON.stringify(persisted));
}

/** Signal 0 probes the pid without touching it: alive (or not ours) → true, gone → `ESRCH`. */
export function checkIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}

export function getTurns(issueKey: string): FakeClaudeTurn[] {
  return readFakeLog<FakeClaudeTurn>(fakeClaudeLogFileNames.turns).filter((turn) => turn.issueKey === issueKey);
}

export function getAnswers(issueKey: string): FakeClaudeAnswer[] {
  return readFakeLog<FakeClaudeAnswer>(fakeClaudeLogFileNames.answers).filter((answer) => answer.issueKey === issueKey);
}

/** The last session launch the process `pid` was started by. */
export function getSessionLaunchOf(pid: number): FakeLaunch | undefined {
  return readFakeLog<FakeLaunch>(fakeClaudeLogFileNames.launches).filter((launch) => launch.isSessionLaunch && launch.pid === pid).at(-1);
}

/** Every user message the fake agent read for the issue, in order — the prompts, whole or delta. */
export function getPrompts(issueKey: string): FakeClaudePrompt[] {
  return readFakeLog<FakeClaudePrompt>(fakeClaudeLogFileNames.prompts).filter((prompt) => prompt.issueKey === issueKey);
}

export function getToolCalls(issueKey: string): FakeClaudeToolCall[] {
  return readFakeLog<FakeClaudeToolCall>(fakeClaudeLogFileNames.toolCalls).filter((call) => call.issueKey === issueKey);
}

/** The fake's launches of the process that read this prompt. */
export function getLaunchOfPrompt(prompt: FakeClaudePrompt): FakeLaunch | undefined {
  return getSessionLaunchOf(prompt.pid);
}

/** What a delta prompt says first; a whole prompt starts its issue with the fields block instead. */
const deltaPromptPhrase = 'what changed since your last prompt:';
export const isDeltaPrompt = (text: string): boolean => text.includes(deltaPromptPhrase);
export const isWholePrompt = (text: string): boolean => !isDeltaPrompt(text) && text.includes('\nFields:\n') && /\nComments(?: \(\d+, oldest first\):|: none)/.test(text);

export function getCommentTexts(issue: FakeJiraIssue): string[] {
  return issue.comments.map((comment) => getAdfText(comment.body));
}

export function readClosedRequests(): ClosedRequestRecord[] {
  return readClosedRequestsOf(getLayout());
}

export function getClosedRequest(requestId: string): ClosedRequestRecord | undefined {
  return readClosedRequests().find((record) => record.id === requestId);
}

/** The hand-backs Jira received for the issue: every assignee change the connector made. */
export function countAssigneeChanges(issueKey: string): number {
  return fakeJira.requestLog.filter((request) => request === `PUT /rest/api/3/issue/${issueKey}/assignee`).length;
}

/** How many requests of the issue are closed (final, question, superseded) in the history. */
export function countClosedRequestsOf(issueKey: string): number {
  return readClosedRequests().filter((record) => record.origin.attributes.issueKey === issueKey).length;
}

/**
 * Hand the issue over as `person` and wait until the agent got the prompt, answered, the request closed and the
 * issue is back with `person` (the sink comments, closes, then hands back — a next hand-over must not race it).
 * Resolves the text of the prompt this hand-over brought.
 */
export async function handOverAndAwaitAnswer(issueKey: string, person: typeof requester = requester): Promise<string> {
  const closedBefore = countClosedRequestsOf(issueKey);
  const promptsBefore = getPrompts(issueKey).length;
  handIssueToAi(issueKey, person);
  await waitFor(`${issueKey}: its prompt read, answered and closed`, answerTimeoutMs, () =>
    getPrompts(issueKey).length > promptsBefore && countClosedRequestsOf(issueKey) > closedBefore);
  await waitFor(`${issueKey} handed back`, answerTimeoutMs, () => fakeJira.getIssue(issueKey).assignee?.accountId === person.accountId);
  return getPrompts(issueKey)[promptsBefore].text;
}

/** Hand the issue to the AI as `person`: they take it first, as one does in Jira before assigning it on. */
export function handIssueToAi(issueKey: string, person: typeof requester): void {
  fakeJira.assignIssue(issueKey, person, person);
  fakeJira.assignIssue(issueKey, aiAccount, person);
}

export function waitFor(description: string, timeoutMs: number, check: () => boolean): Promise<void> {
  return getCharness().waitFor(description, timeoutMs, check);
}

/**
 * Start charness the way an isolated instance is started: `run-isolated.sh` with only its env file.
 * Ready = the poll started, which the boot does only after the bot MCP is up on its fixed port, and its JQL is
 * logged: the connector logs that line right after the "polling" one, and a read between the two sees only the first.
 */
export async function startCharness(): Promise<void> {
  charness ??= new IsolatedCharness(getLayout());
  const outputStart = charness.output.length;
  await charness.start(
    bootTimeoutMs,
    (runOutput) => runOutput.includes(`[jira] polling PROJ every ${pollIntervalSeconds} s`) && getPollJqlProjectKeys(runOutput).length > 0,
  );
  assertMcpListeningOn(charness.output.slice(outputStart), botMcpPort);
}

/** E7: a file well beyond what a prompt or a buffered download would hold. */
export const largeAttachmentBytes = 5 * 1024 * 1024;
/** E8: a comment over the prompt's per-text spill limit. */
export const spilledCommentWords = 1200;
export const spilledCommentWord = 'abcdefghij';

/** E9: the tool the agents are given by `agentBinaries`: not an `ffmpeg` — one already on the box's PATH would pass without the link. */
export const probeToolName = 'e2e-tool';
export const probeToolMarker = 'e2e-tool-marker';

export function getProbeToolPath(): string {
  const toolPath = path.join(getLayout().testRoot, 'tools', 'real-e2e-tool');
  fs.mkdirSync(path.dirname(toolPath), { recursive: true });
  fs.writeFileSync(toolPath, `#!/bin/sh\necho ${probeToolMarker}\n`, { mode: 0o755 });
  return toolPath;
}

/** The fake Jira's base url, kept for a `jira.json` rewrite between a stop and a restart. */
let jiraBaseUrl = '';

/** Write `jira.json` for the instance; `adapter` is the json-stream lifecycle its sessions run on, `trustedGroup` the group that filters whose text counts. */
export function writeJiraConfig(adapter: 'claude-json-stream' | 'claude-per-turn', trustedGroup?: string): void {
  fs.writeFileSync(path.join(getLayout().dataDir, 'jira.json'), JSON.stringify({
    site: 'example.atlassian.net',
    baseUrl: jiraBaseUrl,
    email: aiCredentials.email,
    apiToken: `\${${instanceTokenEnvName}}`,
    accountId: aiAccount.accountId,
    projects: { PROJ: { folder: projectFolder, triggerStatuses: [inProgress.name] } },
    pollIntervalSeconds,
    adapter,
    ...(trustedGroup === undefined ? {} : { trustedGroup }),
    // E9: a name found on no PATH of the box, mapped to a stub; the agents must find it by name.
    agentBinaries: { [probeToolName]: getProbeToolPath() },
  }, null, 2));
}

/** The `jira.json` a flow boots with: the json-stream lifecycle its sessions run on, and the trusted group, if any. */
export interface JiraFlowConfig {
  adapter: 'claude-json-stream' | 'claude-per-turn';
  trustedGroup?: string;
}

function writeInstanceFiles(ports: { openCode: number; botMcp: number }, config: JiraFlowConfig): void {
  const instance = getLayout();
  writeJiraConfig(config.adapter, config.trustedGroup);

  const claudeBin = writeFakeClaudeLauncher(instance, 'jira');
  writeInstanceEnvFile(instance, {
    CONNECTORS: 'jira',
    DATA_DIR: instance.dataDir,
    WORK_ROOT: instance.workRoot,
    TMUX_SOCKET_NAME: instance.tmuxSocketName,
    TMUX_TMPDIR: instance.tmuxTmpDir,
    CLAUDE_BIN: claudeBin,
    OPENCODE_URL: `http://127.0.0.1:${ports.openCode}`,
    SCHEDULER_MCP_PORT: ports.botMcp.toString(),
    REQUEST_BACKSTOP_MINUTES: backstopMinutes,
    AGENT_IDLE_MINUTES: idleMinutes,
    [instanceTokenEnvName]: aiCredentials.apiToken,
  });
}

/** The fake Jira dies with the process; everything else the flow started is swept by the shared helper. */
function removeInstanceSync(): void {
  removeIsolatedInstanceSync(layout, charness);
}

export function createIssue(key: string, mode: string): void {
  fakeJira.createIssue({ key, summary: `[fake:${mode}] Task ${key}`, description: `Please handle ${key}.`, statusId: inProgress.id, reporter: requester });
}

/**
 * @description The flow's `before` and `after`: a fresh layout under `layoutPrefix` (Claude memory in the project folder
 * and in WORK_ROOT above it, which the instance must boot and serve with), the fake Jira, the env file and `jira.json`
 * with `config`; the teardown stops everything the flow started. Call once, inside the flow's `describe`.
 */
export function registerJiraFlowHooks(options: { layoutPrefix: string; config: JiraFlowConfig }): void {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout(options.layoutPrefix, [projectFolder], getFlowDeadlineMs());
    for (const memoryFolder of [layout.workRoot, path.join(layout.workRoot, projectFolder)]) {
      fs.writeFileSync(path.join(memoryFolder, claudeMemoryFileName), '# Project memory\n');
    }
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    jiraBaseUrl = await fakeJira.start();
    botMcpPort = await getFreeFixedPort();
    writeInstanceFiles({ openCode: await getFreePort(), botMcp: botMcpPort }, options.config);
  });

  after(async () => {
    // A graceful stop first (the normal end); the synchronous sweep is the same one a signal or a crash runs.
    await charness?.stop();
    removeInstanceSync();
    await fakeJira.stop();
    process.off('exit', removeInstanceSync);
    process.off('SIGINT', exitOnSignal);
    process.off('SIGTERM', exitOnSignal);
  });
}

/** @description The flow's first step: nothing of the instance runs yet, every folder is outside HOME, the env file is Jira's only. */
export function itHoldsIsolationBeforeBoot(): void {
  it('isolation holds before the first boot', () => {
    const instance = getLayout();
    assert.deepEqual(fs.readdirSync(instance.tmuxTmpDir), [], 'no tmux server of the instance is running yet');
    const realHome = fs.realpathSync(os.homedir());
    for (const dir of [instance.instanceHome, instance.dataDir, instance.workRoot, instance.tmuxTmpDir]) {
      assert.ok(!dir.startsWith(`${realHome}${path.sep}`), `${dir} is outside the user's HOME`);
    }
    const envNames = getInstanceEnvNames(instance);
    assert.ok(!envNames.includes('TELEGRAM_BOT_TOKEN'), 'no bot token');
    assert.ok(!envNames.some((name) => name.startsWith('ATLASSIAN_')), 'no Atlassian variables');
    for (const name of ['TMUX_SOCKET_NAME', 'TMUX_TMPDIR', 'DATA_DIR', 'WORK_ROOT']) assert.ok(envNames.includes(name), `${name} is set`);
  });
}

/** @description Boot the instance for the first time: charness runs with nothing but `run-isolated.sh`'s variables, and the poll names only the configured project. */
export async function bootJiraOnly(): Promise<void> {
  await startCharness();
  const pid = getCharness().pid;
  const envNames = pid === undefined ? null : getProcessEnvNames(pid);
  if (envNames !== null) assert.deepEqual([...envNames].sort(), [...isolatedLaunchEnvNames].sort());
  // The allowlist as Jira receives it: the poll's JQL names the configured project and nothing else.
  assert.deepEqual(getPollJqlProjectKeys(getCharness().output), [['PROJ']]);
}

/** @description The flow's last steps: what every session launch, the agents' environment and the tmux calls of the whole flow held. */
export function itHoldsTheInstanceInvariants(): void {
  it('the agent and its tmux server hold no instance variable: the allowlist only (R32)', () => {
    const sessionLaunches = readFakeLog<FakeLaunch>(fakeClaudeLogFileNames.launches).filter((launch) => launch.isSessionLaunch);
    assert.ok(sessionLaunches.length > 0);
    for (const launch of sessionLaunches) {
      assert.equal(launch.home, getLayout().instanceHome, 'HOME is the launch environment\'s');
      assert.deepEqual(getForeignAgentEnvNames(launch.envNames), [], 'nothing but the allowlist');
      assert.ok(!launch.envNames.includes(instanceTokenEnvName), 'not the tracker token');
      // E9: the tool folder leads every Jira agent's PATH.
      assert.ok(launch.path.startsWith(`${path.join(getLayout().dataDir, 'agent-bin')}:`), `PATH ${launch.path}`);
    }
    // Every session inherits the server's global environment, and any process on the server can read it back.
    const serverEnvironment = spawnSync('tmux', ['-L', getLayout().tmuxSocketName, 'show-environment', '-g'], { encoding: 'utf8', env: getInstanceTmuxEnv() });
    assert.equal(serverEnvironment.status, 0, 'the private server answered');
    const serverEnvNames = serverEnvironment.stdout.split('\n').filter(Boolean).map((line) => line.replace(/^-/, '').split('=')[0]);
    assert.ok(serverEnvNames.includes('HOME'), 'the server environment was read');
    assert.deepEqual(getForeignAgentEnvNames(serverEnvNames.filter((name) => name !== 'TMUX_TMPDIR')), [], 'the server started clean');
  });

  it('every session launch carried the Jira flags (R11)', () => {
    // The one refusal there is was provoked on purpose (E4: a conversation made unresumable).
    assert.deepEqual(readFakeLog<{ reason: string }>(fakeClaudeLogFileNames.violations).filter((violation) => !violation.reason.startsWith('No conversation found with session ID')), [], 'no launch was refused by the fake');
    const sessionLaunches = readFakeLog<FakeLaunch>(fakeClaudeLogFileNames.launches).filter((launch) => launch.isSessionLaunch);
    assert.ok(sessionLaunches.some((launch) => launch.argv.includes('--session-id')), 'a fresh launch');
    assert.ok(sessionLaunches.some((launch) => launch.argv.includes('--resume')), 'a resume launch');
    for (const launch of sessionLaunches) {
      for (const flag of requiredJiraSessionFlags) assert.ok(checkHasFlag(launch.argv, flag), `${flag.join(' ')} in ${launch.argv.join(' ')}`);
      // E11: a jira.json that names neither model nor effort — every launch still carries opus and high.
      assert.deepEqual(getFlagValues(launch.argv, '--model'), ['opus'], `--model in ${launch.argv.join(' ')}`);
      assert.deepEqual(getFlagValues(launch.argv, '--effort'), ['high'], `--effort in ${launch.argv.join(' ')}`);
    }
  });

  it('no Telegram path was reached for the Jira conversations (R6)', () => {
    const output = getCharness().output;
    assert.ok(!output.includes(telegramCallRefusedLogPrefix), 'no Telegram API call reached the guard');
    assert.ok(!output.includes(TelegramDisabledError.name));
    // What a Telegram primitive says when a Jira key reaches it (a skipped primitive, the send queue's refusal).
    assert.ok(!output.includes(notTelegramChatPhrase), 'no Telegram primitive was handed a Jira conversation');
    assert.ok(!output.includes(foreignKeyAccessorErrorPrefix), 'no Telegram id was read off a Jira key');
  });

  it('every tmux call named the private server; nothing of the instance runs on the default tmux server', () => {
    // A call without `-L` would have started (or reached) a `default` server beside it.
    const instance = getLayout();
    assert.deepEqual(fs.readdirSync(getTmuxSocketDir(instance.tmuxTmpDir)), [instance.tmuxSocketName], 'one tmux server, the named one');
    const instanceSessions = new Set(listTmuxSessions(['-L', instance.tmuxSocketName], getInstanceTmuxEnv()));
    assert.ok(instanceSessions.size > 0);
    const defaultSessionsNow = listTmuxSessions([]);
    assert.deepEqual(defaultSessionsNow.filter((name) => instanceSessions.has(name)), []);
    assert.deepEqual(defaultSessionsNow.filter((name) => !defaultTmuxSessionsBefore.includes(name) && name.includes('PROJ')), []);
  });
}
