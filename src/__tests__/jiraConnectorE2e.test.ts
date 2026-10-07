/**
 * @description The Jira connector end to end, at PROCESS level (Jira connector
 * plan J7, R6, R11): the BUILT charness, started the way an isolated instance
 * is started (`scripts/run-isolated.sh` with its own env file), serving Jira
 * only, against a fake Jira on loopback (`jiraE2e/fakeJira.ts`) and a fake
 * `claude` (`jiraE2e/fakeClaude.ts`, via `CLAUDE_BIN`) that answers through the
 * real bot MCP. One flow, in order:
 *
 *   isolation checked before the boot: a private tmux server (named, in a
 *   private TMUX_TMPDIR), a temp HOME, DATA_DIR and WORK_ROOT, ports of its own,
 *   an env file without a bot token or Atlassian variables; the project folder
 *   holds Claude memory (a `CLAUDE.md` in it, one in WORK_ROOT above it) and the
 *   instance still boots and serves it, as any Claude Code session loads it
 *   → the requester assigns four issues, plus one the AI assigned itself and one
 *     of a project outside the allowlist
 *   → answered: a comment by the AI account, the issue handed back
 *   → a silent first turn: woken, then answered
 *   → the agent process killed mid-turn: resumed in its own session, answered
 *   → a progress note: commented, the issue stays with the AI
 *   → the self-assigned and the foreign issue: no request, nothing posted
 *   → two people hand one issue over in turn: two open requests, two answers,
 *     the issue goes back to the person whose answer closed first (R34)
 *   → one person hands an issue over twice while the agent is mid-turn: the
 *     newer request replaces the first; the agent (Claude Code's timing: a
 *     message written mid-turn is read only after the turn ends) answers the
 *     first, then reads the second prompt — its header names the replaced one —
 *     and answers a short pointer; the issue goes back once (R34)
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

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FakeJira, fakeJiraSearchRequest, type FakeJiraIssue } from './jiraE2e/fakeJira';
import {
  assertMcpListeningOn,
  builtCliPath,
  createIsolatedInstanceLayout,
  exitOnSignal,
  fakeClaudePath,
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
} from './e2e/isolatedCharness';
import { getPollJqlProjectKeys, getPolledRequestIssueKeys } from './jiraE2e/charnessLog';
import { claudeJsonStreamUsageLogPrefix } from '../adapters/claudeJsonStreamAdapter';
import {
  checkHasFlag,
  fakeClaudeCrashOnPromptFileName,
  fakeClaudeLogFileNames,
  fakeCompactionModelUsage,
  fakeTurnUsage,
  getFlagValues,
  getForeignAgentEnvNames,
  getLaunchSessionId,
  requiredJiraSessionFlags,
  type FakeClaudeAnswer,
  type FakeClaudePrompt,
  type FakeClaudeToolCall,
  type FakeClaudeTurn,
} from './jiraE2e/fakeClaudeContract';
import { getAdfText } from '../connectors/jira/adf';
import { resolveThreadFilesDir } from '../botFileStorage';
import { makeJiraKey } from '../connectors/jira/sessionKeyCodec';
import { requestRequesterAttribute } from '../requests/requestGroup';
import type { ClosedRequestRecord } from '../requests/types';
import { notTelegramChatPhrase } from '../connectors/telegram/foreignKeyFallbacks';
import { foreignKeyAccessorErrorPrefix } from '../connectors/telegram/sessionKeyCodec';
import { TelegramDisabledError, telegramCallRefusedLogPrefix } from '../connectors/telegram/telegramCallGuard';

const aiAccount = { accountId: 'ai-account', accountType: 'atlassian', displayName: 'AI' };
const aiCredentials = { email: 'ai@example.com', apiToken: 'fake-token' };
const requester = { accountId: 'requester-account', accountType: 'atlassian', displayName: 'Requester' };
/** A second person of the project, who hands an issue over while the requester's request is still open (R34). */
const colleague = { accountId: 'colleague-account', accountType: 'atlassian', displayName: 'Colleague' };
const inProgress = { id: '10001', name: 'In Progress' };
const toDo = { id: '10000', name: 'To Do' };
const projectFolder = 'proj';
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
const answerTimeoutMs = 60 * 1000;
/** The backstop window plus the wake-up engine's one-minute sweep, twice over. */
const resumeTimeoutMs = 3 * 60 * 1000;
/** The idle window, the compaction turn and the stop, with room to spare. */
const idleStopTimeoutMs = 2 * 60 * 1000;
/** A per-turn stop follows the answer at once — well inside the 30 s idle window, which would stop the process too (L5). */
const perTurnStopTimeoutMs = 15 * 1000;
/** The restart step waits for this many polls. */
const restartPollWaitMs = 3 * pollIntervalSeconds * 1000;

let layout: IsolatedInstanceLayout | null = null;
let fakeJira: FakeJira;
let charness: IsolatedCharness | null = null;
let defaultTmuxSessionsBefore: string[] = [];
/** The bot MCP's port, the same on every start: a re-adopted agent keeps the address of its launch (see {@link assertMcpListeningOn}). */
let botMcpPort = 0;

function getLayout(): IsolatedInstanceLayout {
  if (!layout) throw new Error('the instance layout is not created yet');
  return layout;
}

function getCharness(): IsolatedCharness {
  if (!charness) throw new Error('charness is not started yet');
  return charness;
}

/** The instance's tmux servers: the private TMUX_TMPDIR it is given. */
function getInstanceTmuxEnv(): NodeJS.ProcessEnv {
  return getTmuxEnv(getLayout().tmuxTmpDir);
}

function readFakeLog<TRecord>(fileName: string): TRecord[] {
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
interface FakeCompaction {
  sessionId: string;
  pid: number;
}

/** Rewrite the persisted tool digests of the given conversations, as a bot build with other tools would find them (L4). */
function markToolDigestStale(conversationKeys: string[]): void {
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
function checkIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}

function getTurns(issueKey: string): FakeClaudeTurn[] {
  return readFakeLog<FakeClaudeTurn>(fakeClaudeLogFileNames.turns).filter((turn) => turn.issueKey === issueKey);
}

function getAnswers(issueKey: string): FakeClaudeAnswer[] {
  return readFakeLog<FakeClaudeAnswer>(fakeClaudeLogFileNames.answers).filter((answer) => answer.issueKey === issueKey);
}

/** The last session launch the process `pid` was started by. */
function getSessionLaunchOf(pid: number): FakeLaunch | undefined {
  return readFakeLog<FakeLaunch>(fakeClaudeLogFileNames.launches).filter((launch) => launch.isSessionLaunch && launch.pid === pid).at(-1);
}

/** Every user message the fake agent read for the issue, in order — the prompts, whole or delta. */
function getPrompts(issueKey: string): FakeClaudePrompt[] {
  return readFakeLog<FakeClaudePrompt>(fakeClaudeLogFileNames.prompts).filter((prompt) => prompt.issueKey === issueKey);
}

function getToolCalls(issueKey: string): FakeClaudeToolCall[] {
  return readFakeLog<FakeClaudeToolCall>(fakeClaudeLogFileNames.toolCalls).filter((call) => call.issueKey === issueKey);
}

/** The fake's launches of the process that read this prompt. */
function getLaunchOfPrompt(prompt: FakeClaudePrompt): FakeLaunch | undefined {
  return getSessionLaunchOf(prompt.pid);
}

/** What a delta prompt says first; a whole prompt starts its issue with the fields block instead. */
const deltaPromptPhrase = 'what changed since your last prompt:';
const isDeltaPrompt = (text: string): boolean => text.includes(deltaPromptPhrase);
const isWholePrompt = (text: string): boolean => !isDeltaPrompt(text) && text.includes('\nFields:\n') && /\nComments(?: \(\d+, oldest first\):|: none)/.test(text);

function getCommentTexts(issue: FakeJiraIssue): string[] {
  return issue.comments.map((comment) => getAdfText(comment.body));
}

function readClosedRequests(): ClosedRequestRecord[] {
  return readClosedRequestsOf(getLayout());
}

function getClosedRequest(requestId: string): ClosedRequestRecord | undefined {
  return readClosedRequests().find((record) => record.id === requestId);
}

/** The hand-backs Jira received for the issue: every assignee change the connector made. */
function countAssigneeChanges(issueKey: string): number {
  return fakeJira.requestLog.filter((request) => request === `PUT /rest/api/3/issue/${issueKey}/assignee`).length;
}

/** How many requests of the issue are closed (final, question, superseded) in the history. */
function countClosedRequestsOf(issueKey: string): number {
  return readClosedRequests().filter((record) => record.origin.attributes.issueKey === issueKey).length;
}

/**
 * Hand the issue over as `person` and wait until the agent got the prompt, answered, the request closed and the
 * issue is back with `person` (the sink comments, closes, then hands back — a next hand-over must not race it).
 * Resolves the text of the prompt this hand-over brought.
 */
async function handOverAndAwaitAnswer(issueKey: string, person: typeof requester = requester): Promise<string> {
  const closedBefore = countClosedRequestsOf(issueKey);
  const promptsBefore = getPrompts(issueKey).length;
  handIssueToAi(issueKey, person);
  await waitFor(`${issueKey}: its prompt read, answered and closed`, answerTimeoutMs, () =>
    getPrompts(issueKey).length > promptsBefore && countClosedRequestsOf(issueKey) > closedBefore);
  await waitFor(`${issueKey} handed back`, answerTimeoutMs, () => fakeJira.getIssue(issueKey).assignee?.accountId === person.accountId);
  return getPrompts(issueKey)[promptsBefore].text;
}

/** Hand the issue to the AI as `person`: they take it first, as one does in Jira before assigning it on. */
function handIssueToAi(issueKey: string, person: typeof requester): void {
  fakeJira.assignIssue(issueKey, person, person);
  fakeJira.assignIssue(issueKey, aiAccount, person);
}

function waitFor(description: string, timeoutMs: number, check: () => boolean): Promise<void> {
  return getCharness().waitFor(description, timeoutMs, check);
}

/**
 * Start charness the way an isolated instance is started: `run-isolated.sh` with only its env file.
 * Ready = the poll started, which the boot does only after the bot MCP is up on its fixed port, and its JQL is
 * logged: the connector logs that line right after the "polling" one, and a read between the two sees only the first.
 */
async function startCharness(): Promise<void> {
  charness ??= new IsolatedCharness(getLayout());
  const outputStart = charness.output.length;
  await charness.start(
    bootTimeoutMs,
    (runOutput) => runOutput.includes(`[jira] polling PROJ every ${pollIntervalSeconds} s`) && getPollJqlProjectKeys(runOutput).length > 0,
  );
  assertMcpListeningOn(charness.output.slice(outputStart), botMcpPort);
}

/** E7: a file well beyond what a prompt or a buffered download would hold. */
const largeAttachmentBytes = 5 * 1024 * 1024;
/** E8: a comment over the prompt's per-text spill limit. */
const spilledCommentWords = 1200;
const spilledCommentWord = 'abcdefghij';

/** E9: the tool the agents are given by `agentBinaries`: not an `ffmpeg` — one already on the box's PATH would pass without the link. */
const probeToolName = 'e2e-tool';
const probeToolMarker = 'e2e-tool-marker';

function getProbeToolPath(): string {
  const toolPath = path.join(getLayout().testRoot, 'tools', 'real-e2e-tool');
  fs.mkdirSync(path.dirname(toolPath), { recursive: true });
  fs.writeFileSync(toolPath, `#!/bin/sh\necho ${probeToolMarker}\n`, { mode: 0o755 });
  return toolPath;
}

/** The fake Jira's base url, kept for a `jira.json` rewrite between a stop and a restart. */
let jiraBaseUrl = '';

/** Write `jira.json` for the instance; `adapter` is the json-stream lifecycle its sessions run on. */
function writeJiraConfig(adapter: 'claude-json-stream' | 'claude-per-turn'): void {
  fs.writeFileSync(path.join(getLayout().dataDir, 'jira.json'), JSON.stringify({
    site: 'example.atlassian.net',
    baseUrl: jiraBaseUrl,
    email: aiCredentials.email,
    apiToken: `\${${instanceTokenEnvName}}`,
    accountId: aiAccount.accountId,
    projects: { PROJ: { folder: projectFolder, triggerStatuses: [inProgress.name] } },
    pollIntervalSeconds,
    adapter,
    // E9: a name found on no PATH of the box, mapped to a stub; the agents must find it by name.
    agentBinaries: { [probeToolName]: getProbeToolPath() },
  }, null, 2));
}

function writeInstanceFiles(ports: { openCode: number; botMcp: number }): void {
  const instance = getLayout();
  writeJiraConfig('claude-json-stream');

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

function createIssue(key: string, mode: string): void {
  fakeJira.createIssue({ key, summary: `[fake:${mode}] Task ${key}`, description: `Please handle ${key}.`, statusId: inProgress.id, reporter: requester });
}

describe('Jira connector end to end: built charness, fake Jira, fake claude (J7)', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-j7-', [projectFolder], getFlowDeadlineMs());
    for (const memoryFolder of [layout.workRoot, path.join(layout.workRoot, projectFolder)]) {
      fs.writeFileSync(path.join(memoryFolder, claudeMemoryFileName), '# Project memory\n');
    }
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeJira = new FakeJira({ aiAccount, credentials: aiCredentials, statuses: [toDo, inProgress] });
    jiraBaseUrl = await fakeJira.start();
    botMcpPort = await getFreeFixedPort();
    writeInstanceFiles({ openCode: await getFreePort(), botMcp: botMcpPort });
  });

  after(async () => {
    // A graceful stop first (the normal end); the synchronous sweep is the same one a signal or a crash runs.
    await charness?.stop();
    removeInstanceSync();
    await fakeJira?.stop();
    process.off('exit', removeInstanceSync);
    process.off('SIGINT', exitOnSignal);
    process.off('SIGTERM', exitOnSignal);
  });

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

  it('the project folder holds Claude memory, in it and above it — the instance below must still boot and serve it', () => {
    const instance = getLayout();
    for (const memoryFolder of [instance.workRoot, path.join(instance.workRoot, projectFolder)]) {
      assert.ok(fs.existsSync(path.join(memoryFolder, claudeMemoryFileName)), `${claudeMemoryFileName} in ${memoryFolder}`);
    }
  });

  it('boots Jira-only, started with nothing but run-isolated.sh\'s variables', async () => {
    createIssue('PROJ-1', 'answer');
    createIssue('PROJ-2', 'silent-once');
    createIssue('PROJ-3', 'hang-once');
    createIssue('PROJ-4', 'progress');
    createIssue('PROJ-5', 'answer');
    createIssue('PROJ-6', 'finish-together');
    createIssue('PROJ-7', 'answer-after-queued');
    createIssue('PROJ-8', 'background');
    createIssue('PROJ-9', 'slow-once');
    createIssue('PROJ-10', 'answer');
    createIssue('OTHER-1', 'answer');
    await startCharness();
    const pid = getCharness().pid;
    const envNames = pid === undefined ? null : getProcessEnvNames(pid);
    if (envNames !== null) assert.deepEqual([...envNames].sort(), [...isolatedLaunchEnvNames].sort());
    // The allowlist as Jira receives it: the poll's JQL names the configured project and nothing else.
    assert.deepEqual(getPollJqlProjectKeys(getCharness().output), [['PROJ']]);
  });

  it('the requester assigns the issues: each in-scope one becomes one request', async () => {
    for (const key of ['PROJ-1', 'PROJ-2', 'PROJ-3', 'PROJ-4', 'PROJ-8', 'OTHER-1']) fakeJira.assignIssue(key, aiAccount, requester);
    fakeJira.assignIssue('PROJ-5', aiAccount, aiAccount);
    // The polls also name each request they open — what the restart step reads back.
    await waitFor('the first turn of every in-scope issue, and its request in the poll log', answerTimeoutMs, () =>
      ['PROJ-1', 'PROJ-2', 'PROJ-3', 'PROJ-4', 'PROJ-8'].every((key) => getTurns(key).length > 0 && getPolledRequestIssueKeys(getCharness().output).includes(key)));
    for (const key of ['PROJ-1', 'PROJ-2', 'PROJ-3', 'PROJ-4', 'PROJ-8']) {
      assert.equal(getTurns(key)[0].isRequestPrompt, true, `${key}'s first turn is its request prompt`);
    }
    assert.deepEqual([...getPolledRequestIssueKeys(getCharness().output)].sort(), ['PROJ-1', 'PROJ-2', 'PROJ-3', 'PROJ-4', 'PROJ-8'], 'one request each');
    assert.ok(listTmuxSessions(['-L', getLayout().tmuxSocketName], getInstanceTmuxEnv()).length >= 4, 'the agents run on the private server');
  });

  it('an answer becomes a comment by the AI account and the issue goes back to the requester', async () => {
    const issue = fakeJira.getIssue('PROJ-1');
    await waitFor('PROJ-1 handed back', answerTimeoutMs, () => issue.assignee?.accountId === requester.accountId);
    assert.deepEqual(getCommentTexts(issue), ['Fake final answer for PROJ-1 (answer, turn 1).']);
    assert.ok(issue.comments.every((comment) => comment.author.accountId === aiAccount.accountId));
    // L-D11: the turn's token accounting is logged from the stream — the live cache check reads these lines. The
    // answer arrives through the MCP before the turn's own `result` frame is tailed, so the line is waited for.
    const expectedUsage = `cacheRead=${fakeTurnUsage.cache_read_input_tokens} cacheWrite=${fakeTurnUsage.cache_creation_input_tokens}`;
    const getUsageLines = (): string[] => getCharness().output.split('\n').filter((line) => line.startsWith(claudeJsonStreamUsageLogPrefix));
    await waitFor(`a usage line with the fake's counts (${expectedUsage})`, answerTimeoutMs, () => getUsageLines().some((line) => line.includes(expectedUsage)));
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

  it('an answered issue idles: compacted, its process stopped, the next hand-over resumes the same conversation; a background task keeps its process (L3)', async () => {
    const [firstTurn] = getTurns('PROJ-1');
    const firstLaunch = getSessionLaunchOf(firstTurn.pid);
    const sessionId = getLaunchSessionId(firstLaunch?.argv ?? []);
    assert.ok(sessionId, 'PROJ-1\'s first launch named its conversation');
    const compactions = (): FakeCompaction[] => readFakeLog<FakeCompaction>(fakeClaudeLogFileNames.compactions);
    await waitFor('PROJ-1\'s session compacted at the idle mark', idleStopTimeoutMs, () => compactions().some((compaction) => compaction.sessionId === sessionId));
    assert.equal(compactions().find((compaction) => compaction.sessionId === sessionId)?.pid, firstTurn.pid, 'compacted in the same process');
    // L-D11: the compaction turn's accounting comes from the result's `modelUsage` (its `usage` is all zero on the real CLI).
    const compactionUsage = `jira:PROJ:PROJ-1: input=${fakeCompactionModelUsage['fake-model'].inputTokens} cacheRead=${fakeCompactionModelUsage['fake-model'].cacheReadInputTokens} cacheWrite=${fakeCompactionModelUsage['fake-model'].cacheCreationInputTokens}`;
    await waitFor('the compaction turn\'s usage line', idleStopTimeoutMs, () => getCharness().output.includes(`${claudeJsonStreamUsageLogPrefix}${compactionUsage}`));
    await waitFor('PROJ-1\'s process stopped after the compaction', idleStopTimeoutMs, () => !checkIsProcessAlive(firstTurn.pid));
    // The process dies at the stop's SIGTERM; the bot logs the stop only once its own teardown (the tmux kill) converged.
    await waitFor('the stop logged', idleStopTimeoutMs, () => getCharness().output.includes('[compact-on-idle] jira:PROJ:PROJ-1 process stopped; the session sleeps'));
    assert.ok(!getCharness().output.includes('[ClaudeJson] session jira:PROJ:PROJ-1 exited unexpectedly'), 'an idle stop is not an unexpected exit');

    // PROJ-8 answered but left a background task running: its process is working and stays (L-D2).
    const [backgroundTurn] = getTurns('PROJ-8');
    assert.ok(backgroundTurn, 'PROJ-8 reached its agent');
    assert.deepEqual(getCommentTexts(fakeJira.getIssue('PROJ-8')), ['Fake final answer for PROJ-8 (background, turn 1).']);
    assert.ok(checkIsProcessAlive(backgroundTurn.pid), 'a process with a background task is never stopped');
    // Its idle mark counts from its own last activity, so its fire may follow PROJ-1's stop: wait for the line, don't read it early.
    await waitFor('the idle fire saw PROJ-8 working', idleStopTimeoutMs, () => getCharness().output.includes('[compact-on-idle] jira:PROJ:PROJ-8 process kept: working'));

    // The next hand-over resumes PROJ-1's own conversation in a new process.
    const commentsBefore = fakeJira.getIssue('PROJ-1').comments.length;
    handIssueToAi('PROJ-1', requester);
    await waitFor('PROJ-1 answered again', answerTimeoutMs, () => fakeJira.getIssue('PROJ-1').comments.length > commentsBefore);
    const turns = getTurns('PROJ-1');
    assert.equal(turns.length, 2, 'one more turn');
    assert.notEqual(turns[1].pid, firstTurn.pid, 'answered by a new process');
    const resumedLaunch = getSessionLaunchOf(turns[1].pid);
    assert.deepEqual(getFlagValues(resumedLaunch?.argv ?? [], '--resume'), [sessionId], 'the new process resumed the same conversation');
    // The sink posts the comment first and hands the issue back right after: wait for that state, don't read it a tick early.
    await waitFor('PROJ-1 handed back again', answerTimeoutMs, () => fakeJira.getIssue('PROJ-1').assignee?.accountId === requester.accountId);
    // E5: the idle compaction completed, so the conversation's summary replaced what it was told — the resume gets the whole issue.
    const [, resumedPrompt] = getPrompts('PROJ-1');
    assert.ok(isWholePrompt(resumedPrompt.text), `after the bot's idle compaction the prompt is whole:\n${resumedPrompt.text}`);
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
      /PROJ-5 selfAuthored/.test(getCharness().output) && /OTHER-1 notAllowed/.test(getCharness().output));
    for (const key of ['PROJ-5', 'OTHER-1']) {
      assert.deepEqual(getTurns(key), [], `${key} reached no agent`);
      assert.deepEqual(fakeJira.getIssue(key).comments, [], `${key} got no comment`);
      assert.equal(fakeJira.getIssue(key).assignee?.accountId, aiAccount.accountId, `${key} was not handed anywhere`);
    }
  });

  it('two people hand one issue over in turn: two requests, two answers, handed back to the first answered (R34)', async () => {
    const issue = fakeJira.getIssue('PROJ-6');
    fakeJira.assignIssue('PROJ-6', aiAccount, requester);
    await waitFor('the requester\'s request of PROJ-6 answered with a progress note', answerTimeoutMs, () => getAnswers('PROJ-6').length > 0);
    const [requesterTurn] = getTurns('PROJ-6');
    assert.ok(requesterTurn.requestId, 'the requester\'s request reached the agent');
    assert.deepEqual(getCommentTexts(issue), ['Fake progress answer for PROJ-6 (finish-together, turn 1).']);
    assert.equal(issue.assignee?.accountId, aiAccount.accountId, 'still the AI\'s: the request is open');

    // While the first request is open, a colleague takes the issue and hands it to the AI again.
    handIssueToAi('PROJ-6', colleague);
    // An answer is logged once its tool result came back, i.e. after the comment, the hand-back and the close.
    await waitFor('both requests of PROJ-6 answered', answerTimeoutMs, () => getAnswers('PROJ-6').length >= 3);
    const turns = getTurns('PROJ-6');
    assert.deepEqual(turns.map((turn) => turn.isRequestPrompt), [true, true], 'each hand-over was a request of its own');
    const colleagueTurn = turns[1];
    assert.notEqual(colleagueTurn.requestId, requesterTurn.requestId);
    assert.deepEqual(colleagueTurn.supersededRequestIds, [], 'the colleague\'s request replaced nothing: the requester\'s is not theirs');

    // Both closed by their own final answer — neither replaced the other — and each names its own requester.
    const requesterRequest = getClosedRequest(requesterTurn.requestId ?? '');
    const colleagueRequest = getClosedRequest(colleagueTurn.requestId ?? '');
    assert.equal(requesterRequest?.closeReason, 'final');
    assert.equal(colleagueRequest?.closeReason, 'final');
    assert.equal(requesterRequest?.origin.attributes[requestRequesterAttribute], requester.accountId);
    assert.equal(colleagueRequest?.origin.attributes[requestRequesterAttribute], colleague.accountId);

    // Two answers, two comments; the first closing answer (the requester's, answered first) took the issue back
    // to its sender, and the colleague's found the issue no longer the AI's and left the assignee alone.
    assert.deepEqual(getCommentTexts(issue), [
      'Fake progress answer for PROJ-6 (finish-together, turn 1).',
      'Fake final answer for PROJ-6 (finish-together, turn 1).',
      'Fake final answer for PROJ-6 (finish-together, turn 1).',
    ]);
    assert.deepEqual(getAnswers('PROJ-6').map((answer) => [answer.requestId, answer.kind]), [
      [requesterTurn.requestId, 'progress'],
      [requesterTurn.requestId, 'final'],
      [colleagueTurn.requestId, 'final'],
    ]);
    assert.ok(getAnswers('PROJ-6').every((answer) => answer.outcome.startsWith('Delivered.')), 'every answer was delivered');
    assert.equal(issue.assignee?.accountId, requester.accountId, 'handed back to the requester, whose answer closed first');
    assert.equal(countAssigneeChanges('PROJ-6'), 1, 'the colleague\'s answer changed no assignee');
  });

  it('one person hands an issue over twice while the agent is mid-turn: the first request is answered, the second gets a pointer, handed back once (R34)', async () => {
    const issue = fakeJira.getIssue('PROJ-7');
    fakeJira.assignIssue('PROJ-7', aiAccount, requester);
    await waitFor('the first request of PROJ-7 answered with a progress note', answerTimeoutMs, () => getAnswers('PROJ-7').length > 0);
    const [firstTurn] = getTurns('PROJ-7');
    assert.ok(firstTurn.requestId, 'the first request reached the agent');
    assert.equal(getTurns('PROJ-7').length, 1, 'the agent still holds its first turn');

    // The agent is mid-turn: the second hand-over's prompt is queued and read only after that turn ends.
    handIssueToAi('PROJ-7', requester);
    await waitFor('both requests of PROJ-7 answered', answerTimeoutMs, () => getAnswers('PROJ-7').length >= 3);
    const turns = getTurns('PROJ-7');
    assert.deepEqual(turns.map((turn) => turn.isRequestPrompt), [true, true]);
    const secondTurn = turns[1];
    assert.deepEqual(secondTurn.supersededRequestIds, [firstTurn.requestId], 'the second request\'s header names the first as replaced');
    const firstRequest = getClosedRequest(firstTurn.requestId ?? '');
    assert.equal(firstRequest?.closeReason, 'superseded');
    assert.equal(firstRequest?.supersededBy, secondTurn.requestId, 'the history names the request that replaced it');
    assert.equal(getClosedRequest(secondTurn.requestId ?? '')?.closeReason, 'final');

    // In this order: the first request's final answer is delivered to the already superseded request (content is
    // never dropped) and its tool result points at the queued prompt; that prompt's answer is then a pointer.
    const answers = getAnswers('PROJ-7');
    assert.deepEqual(answers.map((answer) => [answer.requestId, answer.kind]), [
      [firstTurn.requestId, 'progress'],
      [firstTurn.requestId, 'final'],
      [secondTurn.requestId, 'final'],
    ]);
    assert.match(answers[1].outcome, new RegExp(`^Delivered\\. Request ${firstTurn.requestId} was already closed \\(superseded by request ${secondTurn.requestId} from the same requester; its prompt follows`));
    assert.match(answers[2].outcome, /^Delivered\. Request req_[A-Za-z0-9_-]+ is now closed \(final\)/);
    assert.deepEqual(getCommentTexts(issue), [
      'Fake progress answer for PROJ-7 (answer-after-queued, turn 1).',
      'Fake final answer for PROJ-7 (answer-after-queued, turn 1).',
      `Answered above for PROJ-7 (covers ${firstTurn.requestId}).`,
    ]);
    // The superseded request's answer hands nothing back; the second request's final answer does, once. The
    // count alone cannot tell which answer did it (a hand-back by the first leaves nothing for the second to
    // change), so the order proves it: the sink comments first, then hands back — the one assignee change
    // follows the third comment.
    assert.equal(issue.assignee?.accountId, requester.accountId);
    assert.equal(countAssigneeChanges('PROJ-7'), 1, 'handed back once');
    const issueCalls = fakeJira.requestLog.filter((request) => request.includes('/issue/PROJ-7/'));
    const thirdCommentIndex = issueCalls.flatMap((request, index) => (request === 'POST /rest/api/3/issue/PROJ-7/comment' ? [index] : []))[2];
    assert.ok(issueCalls.indexOf('PUT /rest/api/3/issue/PROJ-7/assignee') > thirdCommentIndex, 'handed back by the second answer only, after its comment');
  });

  it('a restart opens no request a second time; a gone process is not re-spawned; an adopted one with a stale tool list is stopped once idle (L4)', async () => {
    // PROJ-2 is handed over once more right before the restart, so its process is alive and IDLE at the boot.
    const proj2CommentsBefore = fakeJira.getIssue('PROJ-2').comments.length;
    handIssueToAi('PROJ-2', requester);
    await waitFor('PROJ-2 answered again', answerTimeoutMs, () => fakeJira.getIssue('PROJ-2').comments.length > proj2CommentsBefore);
    const idleAdoptedTurn = getTurns('PROJ-2').at(-1)!;
    const idleAdoptedSessionId = getLaunchSessionId(getSessionLaunchOf(idleAdoptedTurn.pid)?.argv ?? []);
    assert.ok(idleAdoptedSessionId && checkIsProcessAlive(idleAdoptedTurn.pid), 'PROJ-2\'s process is alive going into the restart');
    const [workingAdoptedTurn] = getTurns('PROJ-8');
    assert.ok(checkIsProcessAlive(workingAdoptedTurn.pid), 'PROJ-8\'s process (a background task) is alive going into the restart');
    // PROJ-9's first turn works in silence for longer than the restart takes: its process is adopted MID-TURN.
    handIssueToAi('PROJ-9', requester);
    await waitFor('PROJ-9\'s slow turn under way', answerTimeoutMs, () => getTurns('PROJ-9').length === 1);
    const [midTurnAdoptedTurn] = getTurns('PROJ-9');
    const midTurnSessionId = getLaunchSessionId(getSessionLaunchOf(midTurnAdoptedTurn.pid)?.argv ?? []);
    assert.ok(midTurnSessionId && fakeJira.getIssue('PROJ-9').comments.length === 0, 'PROJ-9 has not answered yet');

    const requestPromptCount = (): number => readFakeLog<FakeClaudeTurn>(fakeClaudeLogFileNames.turns).filter((turn) => turn.isRequestPrompt).length;
    const promptsBefore = requestPromptCount();
    const commentsBefore = ['PROJ-1', 'PROJ-2', 'PROJ-3', 'PROJ-4', 'PROJ-5', 'PROJ-6', 'PROJ-7'].map((key) => fakeJira.getIssue(key).comments.length);
    await getCharness().stop();
    // A bot upgrade that changed the tools: the digests the two live processes were started with no longer match.
    markToolDigestStale(['jira:PROJ:PROJ-2', 'jira:PROJ:PROJ-8', 'jira:PROJ:PROJ-9']);
    // From this boot, NEW Jira sessions run the per-turn lifecycle (L5); the adopted and sleeping ones keep theirs.
    writeJiraConfig('claude-per-turn');

    const searchesBefore = fakeJira.requestLog.filter((request) => request === fakeJiraSearchRequest).length;
    const outputBeforeRestart = getCharness().output.length;
    await startCharness();
    const bootOutput = (): string => getCharness().output.slice(outputBeforeRestart);
    assert.match(bootOutput(), /\[reattach\] claude-json-stream: adopted [1-9]\d*, sleeping [1-9]\d*, killed 0 orphans/, 'the live processes adopted; the stopped ones sleep');
    assert.ok(!bootOutput().includes('resume=true'), 'no sleeping conversation was re-spawned at boot');
    assert.ok(bootOutput().includes('[reattach] jira:PROJ:PROJ-2: adopted with a stale tool list (idle: stopped now)'));
    assert.ok(bootOutput().includes('[reattach] jira:PROJ:PROJ-8: adopted with a stale tool list (working: stopped once idle)'));
    await waitFor('PROJ-2\'s stale process stopped right after the adopt', answerTimeoutMs, () => !checkIsProcessAlive(idleAdoptedTurn.pid));
    assert.ok(checkIsProcessAlive(workingAdoptedTurn.pid), 'PROJ-8 keeps working: its background task is never killed');
    // A stale process adopted MID-TURN (no frame since the persisted tail: a long tool call) is kept until its result (L-D2).
    assert.ok(bootOutput().includes('[reattach] jira:PROJ:PROJ-9: adopted with a stale tool list (working: stopped once idle)'), 'the turn in flight was seen at the adopt');
    assert.ok(checkIsProcessAlive(midTurnAdoptedTurn.pid), 'PROJ-9\'s process survives the adopt mid-turn');
    assert.equal(fakeJira.getIssue('PROJ-9').comments.length, 0, 'still working');
    await waitFor('PROJ-9 answered by the adopted process', 2 * answerTimeoutMs, () => fakeJira.getIssue('PROJ-9').comments.length > 0);
    assert.equal(getTurns('PROJ-9').length, 1, 'answered by the turn that was in flight, in the adopted process');
    await waitFor('PROJ-9\'s stale process stopped once its turn ended', answerTimeoutMs, () => !checkIsProcessAlive(midTurnAdoptedTurn.pid));
    assert.ok(bootOutput().includes('[reattach] jira:PROJ:PROJ-9: stopping the adopted process (the stale tool list)'));
    // Two polls after the restart: the first one decided every issue again.
    await waitFor('two polls after the restart', restartPollWaitMs, () =>
      fakeJira.requestLog.filter((request) => request === fakeJiraSearchRequest).length >= searchesBefore + 2);

    // Deterministic, whereas the counts below could be read before a re-opened request's post (not awaited) lands.
    assert.deepEqual(getPolledRequestIssueKeys(getCharness().output.slice(outputBeforeRestart)), [], 'no poll opened a request again');
    assert.equal(requestPromptCount(), promptsBefore, 'no request prompt was posted again');
    // One request per issue. Its PROMPT may reach the agent twice: a request whose taking-in was not yet
    // seen when the agent died is re-posted to the resumed session (R21) — same request, not a second one.
    for (const key of ['PROJ-3', 'PROJ-4', 'PROJ-8', 'PROJ-9']) {
      assert.equal(new Set(getTurns(key).map((turn) => turn.requestId)).size, 1, `${key} was one request, from start to end`);
    }
    assert.equal(new Set(getTurns('PROJ-1').map((turn) => turn.requestId)).size, 2, 'PROJ-1: its first request and the hand-over after the idle stop, no third');
    assert.equal(new Set(getTurns('PROJ-2').map((turn) => turn.requestId)).size, 2, 'PROJ-2: its first request and the hand-over before the restart, none opened by the restart');
    assert.deepEqual(['PROJ-1', 'PROJ-2', 'PROJ-3', 'PROJ-4', 'PROJ-5', 'PROJ-6', 'PROJ-7'].map((key) => fakeJira.getIssue(key).comments.length), commentsBefore);
    assert.equal(fakeJira.getIssue('PROJ-4').assignee?.accountId, aiAccount.accountId, 'PROJ-4 still matches — its trigger was remembered');

    // The next hand-over resumes the stopped conversation in a new process, with the current tools.
    const proj2CommentsAfterRestart = fakeJira.getIssue('PROJ-2').comments.length;
    handIssueToAi('PROJ-2', requester);
    await waitFor('PROJ-2 answered after the refresh', answerTimeoutMs, () => fakeJira.getIssue('PROJ-2').comments.length > proj2CommentsAfterRestart);
    const refreshedTurn = getTurns('PROJ-2').at(-1)!;
    assert.notEqual(refreshedTurn.pid, idleAdoptedTurn.pid, 'a new process');
    assert.deepEqual(getFlagValues(getSessionLaunchOf(refreshedTurn.pid)?.argv ?? [], '--resume'), [idleAdoptedSessionId], 'the same conversation, resumed');
  });

  it('per-turn mode (L5): the process is gone right after each answer; the next hand-over resumes the same conversation', async () => {
    fakeJira.assignIssue('PROJ-10', aiAccount, requester);
    await waitFor('PROJ-10 answered', answerTimeoutMs, () => fakeJira.getIssue('PROJ-10').comments.length === 1);
    const [firstTurn] = getTurns('PROJ-10');
    const sessionId = getLaunchSessionId(getSessionLaunchOf(firstTurn.pid)?.argv ?? []);
    assert.ok(sessionId, 'PROJ-10\'s launch named its conversation');
    await waitFor('PROJ-10\'s process stopped right after its turn', perTurnStopTimeoutMs, () => !checkIsProcessAlive(firstTurn.pid));
    // The per-turn stop is the idle stop's teardown; its line follows the bot's own tmux kill, after the process is gone.
    await waitFor('the per-turn stop logged', perTurnStopTimeoutMs, () => getCharness().output.includes('[compact-on-idle] jira:PROJ:PROJ-10 process stopped; the session sleeps'));
    assert.ok(!getCharness().output.includes('[ClaudeJson] session jira:PROJ:PROJ-10 exited unexpectedly'));

    handIssueToAi('PROJ-10', requester);
    await waitFor('PROJ-10 answered again', answerTimeoutMs, () => fakeJira.getIssue('PROJ-10').comments.length === 2);
    const secondTurn = getTurns('PROJ-10').at(-1)!;
    assert.notEqual(secondTurn.pid, firstTurn.pid, 'a new process per turn');
    assert.deepEqual(getFlagValues(getSessionLaunchOf(secondTurn.pid)?.argv ?? [], '--resume'), [sessionId], 'the same conversation, resumed');
    await waitFor('PROJ-10\'s second process stopped too', perTurnStopTimeoutMs, () => !checkIsProcessAlive(secondTurn.pid));
    assert.equal(fakeJira.getIssue('PROJ-10').assignee?.accountId, requester.accountId, 'handed back');
    // E4: the process stopped after its turn and the session slept — the resume is not a new conversation, so it gets only the changes.
    const [firstPrompt, secondPrompt] = getPrompts('PROJ-10');
    assert.ok(isWholePrompt(firstPrompt.text) && isDeltaPrompt(secondPrompt.text), secondPrompt.text);
    assert.ok(secondPrompt.text.includes('Nothing in the issue changed since your last prompt.'));
  });

  it('E1 E2 E4 E6: the first prompt carries every block; later ones only what changed — across a stop, a restart and a deleted comment; the agent\'s own answer is never sent back', async () => {
    const issueKey = 'PROJ-11';
    createIssue(issueKey, 'answer');
    fakeJira.addComment(issueKey, requester, 'First report: the export fails.');
    const firstText = await handOverAndAwaitAnswer(issueKey);
    // E1: the whole issue — every block, the person's comment included.
    assert.ok(isWholePrompt(firstText), firstText);
    for (const phrase of ['\nFields:\nSummary: [fake:answer] Task PROJ-11\n', '\nDescription:\n> Please handle PROJ-11.\n', 'Sub-tasks (0):', '\nLinks:\n', 'Attachments (0):', 'Comments (1, oldest first):', '> First report: the export fails.']) {
      assert.ok(firstText.includes(phrase), `the first prompt carries ${JSON.stringify(phrase)}`);
    }
    const [firstTurn] = getTurns(issueKey);
    const sessionId = getLaunchSessionId(getSessionLaunchOf(firstTurn.pid)?.argv ?? []);
    assert.ok(sessionId, 'the first launch named the conversation');
    await waitFor(`${issueKey}'s process stopped (per-turn)`, perTurnStopTimeoutMs, () => !checkIsProcessAlive(firstTurn.pid));

    // E1 + E4 + E6: one new comment and an edited description; the process is gone, so this is a RESUME — still a delta.
    const stillFailsId = fakeJira.addComment(issueKey, requester, 'Still fails on Monday.');
    fakeJira.setDescription(issueKey, 'Please handle PROJ-11. It fails on Mondays.');
    const stillFailsCreated = fakeJira.getIssue(issueKey).comments.find((comment) => comment.id === stillFailsId)?.created ?? '';
    const secondText = await handOverAndAwaitAnswer(issueKey);
    assert.ok(isDeltaPrompt(secondText), secondText);
    assert.ok(secondText.includes(`Jira issue ${issueKey} — what changed since your last prompt:`));
    assert.ok(secondText.includes('Description (changed since your last prompt):\n> Please handle PROJ-11. It fails on Mondays.'));
    assert.ok(secondText.includes(`Comment ${stillFailsId} by Requester, ${stillFailsCreated} (new):\n> Still fails on Monday.`));
    // The summary line names everything left out: the unchanged blocks, and the person's first comment and the agent's own answer.
    assert.ok(secondText.includes('Unchanged since your last prompt: fields, hierarchy, links, attachments, 2 comments.'), secondText);
    assert.ok(!secondText.includes('First report: the export fails.'), 'a comment already told is not told again');
    assert.ok(!secondText.includes('Fake final answer for PROJ-11'), 'E6: the agent\'s own answer is not sent back');
    const secondLaunch = getLaunchOfPrompt(getPrompts(issueKey)[1]);
    assert.deepEqual(getFlagValues(secondLaunch?.argv ?? [], '--resume'), [sessionId], 'E4: the delta went to a RESUMED session');

    // E4: a bot restart between two requests — the sent-state is on disk, the next prompt is still a delta. The
    // conversation sleeps between them (its process stopped after the turn), so the restart adopts nothing.
    const secondTurn = getTurns(issueKey).at(-1);
    assert.ok(secondTurn);
    await waitFor(`${issueKey}'s process stopped (per-turn)`, perTurnStopTimeoutMs, () => !checkIsProcessAlive(secondTurn.pid));
    await waitFor('the per-turn stop logged', perTurnStopTimeoutMs, () => getCharness().output.includes(`[compact-on-idle] jira:PROJ:${issueKey} process stopped; the session sleeps`));
    await getCharness().stop();
    await startCharness();
    // E2: a comment deleted between requests — one line, then never again.
    fakeJira.deleteComment(issueKey, stillFailsId);
    const thirdText = await handOverAndAwaitAnswer(issueKey);
    assert.ok(isDeltaPrompt(thirdText), `E4: after a restart the prompt is still a delta: ${thirdText}`);
    assert.ok(thirdText.includes(`comment ${stillFailsId} by Requester from ${stillFailsCreated} was deleted`), thirdText);
    const fourthText = await handOverAndAwaitAnswer(issueKey);
    assert.ok(!fourthText.includes('was deleted'), 'then it is forgotten');
    assert.ok(fourthText.includes('Nothing in the issue changed since your last prompt.'), fourthText);
  });

  it('E3: a prompt that reached the agent but was never taken in counts for nothing — a new trigger still carries what it carried, the re-post is the stored whole prompt, and after the take-in the next one is a delta', async () => {
    const issueKey = 'PROJ-19';
    createIssue(issueKey, 'answer');
    await handOverAndAwaitAnswer(issueKey);
    const [firstTurn] = getTurns(issueKey);
    await waitFor(`${issueKey}'s process stopped (per-turn)`, perTurnStopTimeoutMs, () => !checkIsProcessAlive(firstTurn.pid));

    const observationId = fakeJira.addComment(issueKey, requester, 'Second observation: the export hangs.');
    const crashSwitch = path.join(getLayout().fakeStateDir, fakeClaudeCrashOnPromptFileName);
    fs.writeFileSync(crashSwitch, '');
    try {
      // Every agent process now reads its message and dies before it echoes it: built, forwarded, never taken in.
      handIssueToAi(issueKey, requester);
      await waitFor(`${issueKey}: the agent read the second prompt and died`, answerTimeoutMs, () => getPrompts(issueKey).length === 2);
      const secondPrompt = getPrompts(issueKey)[1].text;
      assert.ok(isDeltaPrompt(secondPrompt) && secondPrompt.includes(`Comment ${observationId} by Requester`), secondPrompt);
      assert.equal(getTurns(issueKey).length, 1, 'it was never taken in: no turn began');

      // A new trigger before any take-in: built against what the agent really has — the first prompt's blocks.
      handIssueToAi(issueKey, requester);
      await waitFor(`${issueKey}: the agent read the third prompt and died`, answerTimeoutMs, () => getPrompts(issueKey).length === 3);
      const thirdPrompt = getPrompts(issueKey)[2].text;
      assert.ok(isDeltaPrompt(thirdPrompt), 'a delta against the last prompt TAKEN IN');
      assert.ok(thirdPrompt.includes(`Comment ${observationId} by Requester`) && thirdPrompt.includes('(new)'), `the comment the dead prompt carried is still new:\n${thirdPrompt}`);
      assert.ok(thirdPrompt.includes('It replaces the same requester\'s earlier request'), 'the header names the replaced request');
    } finally {
      fs.rmSync(crashSwitch, { force: true });
    }

    // The wake-up engine re-posts the request that was never taken in: the stored WHOLE prompt (R21), never a delta.
    await waitFor(`${issueKey}: the request re-posted to a resumed agent and answered`, resumeTimeoutMs, () => getPrompts(issueKey).length >= 4 && countClosedRequestsOf(issueKey) >= 3);
    const repost = getPrompts(issueKey)[3].text;
    assert.ok(isWholePrompt(repost), `the re-post is the stored whole prompt:\n${repost}`);
    assert.ok(repost.includes(`> Second observation: the export hangs.`) && repost.includes('Fake final answer for PROJ-19'), 'whole: the comment and the agent\'s own answer');
    await waitFor(`${issueKey} handed back`, answerTimeoutMs, () => fakeJira.getIssue(issueKey).assignee?.accountId === requester.accountId);

    // After the take-in the next prompt is a delta again, and the comment taken in is not repeated.
    fakeJira.addComment(issueKey, requester, 'Third observation: also on import.');
    const nextPrompt = await handOverAndAwaitAnswer(issueKey);
    assert.ok(isDeltaPrompt(nextPrompt), nextPrompt);
    assert.ok(nextPrompt.includes('> Third observation: also on import.') && !nextPrompt.includes('Second observation'), nextPrompt);
  });

  it('E5: a compaction the bot ran, and one the CLI ran by itself, each make the next prompt the whole issue again', async () => {
    const compactions = (): FakeCompaction[] => readFakeLog<FakeCompaction>(fakeClaudeLogFileNames.compactions);
    // The bot's: the agent asks for it (`compact_conversation`), the bot runs it when the turn ends.
    createIssue('PROJ-12', 'compact');
    const compactionsBefore = compactions().length;
    const firstText = await handOverAndAwaitAnswer('PROJ-12');
    assert.ok(isWholePrompt(firstText));
    await waitFor('PROJ-12\'s compaction ran', answerTimeoutMs, () => compactions().length > compactionsBefore);
    await waitFor('the bot noted the reset', answerTimeoutMs, () => getCharness().output.includes('[jira] PROJ-12: its context was reset (compaction (manual))'));
    assert.ok(isWholePrompt(await handOverAndAwaitAnswer('PROJ-12')), 'after the bot\'s compaction the prompt is whole');

    // The CLI's own: a `compact_boundary` nobody asked for.
    createIssue('PROJ-13', 'overflow');
    assert.ok(isWholePrompt(await handOverAndAwaitAnswer('PROJ-13')));
    await waitFor('the bot noted the reset', answerTimeoutMs, () => getCharness().output.includes('[jira] PROJ-13: its context was reset (compaction (auto))'));
    assert.ok(isWholePrompt(await handOverAndAwaitAnswer('PROJ-13')), 'after the CLI\'s own compaction the prompt is whole');
  });

  it('E4: a resume that fails starts a fresh session, and the fresh session gets the whole issue', async () => {
    const issueKey = 'PROJ-14';
    createIssue(issueKey, 'answer');
    await handOverAndAwaitAnswer(issueKey);
    const [firstTurn] = getTurns(issueKey);
    const sessionId = getLaunchSessionId(getSessionLaunchOf(firstTurn.pid)?.argv ?? []);
    assert.ok(sessionId);
    await waitFor(`${issueKey}'s process stopped (per-turn)`, perTurnStopTimeoutMs, () => !checkIsProcessAlive(firstTurn.pid));
    // The conversation is lost: the real CLI would answer `No conversation found with session ID`.
    fs.rmSync(path.join(getLayout().fakeStateDir, `session-${sessionId}`));
    const text = await handOverAndAwaitAnswer(issueKey);
    assert.ok(isWholePrompt(text), `a fresh session knows nothing of the issue:\n${text}`);
    assert.ok(text.includes('Fake final answer for PROJ-14'), 'it learns what its predecessor already answered');
    const prompt = getPrompts(issueKey)[1];
    assert.ok(getFlagValues(getLaunchOfPrompt(prompt)?.argv ?? [], '--session-id').length === 1, 'the answering process started a NEW conversation');
    const refusals = readFakeLog<{ reason: string }>(fakeClaudeLogFileNames.violations).filter((violation) => violation.reason === `No conversation found with session ID: ${sessionId}`);
    assert.equal(refusals.length, 1, 'the resume was tried once and refused');
  });

  it('E7: the attachment tool saves the issue\'s own file whole under files/<conversation>/jira, and refuses another issue\'s id', async () => {
    createIssue('PROJ-15', 'fetch-attachment');
    createIssue('PROJ-16', 'answer');
    const ownBytes = Buffer.alloc(largeAttachmentBytes, 'own-file-bytes ');
    const ownId = fakeJira.addAttachment('PROJ-15', { filename: 'screen shot.png', mimeType: 'image/png', content: ownBytes });
    const foreignId = fakeJira.addAttachment('PROJ-16', { filename: 'private.png', mimeType: 'image/png', content: Buffer.from('another issue\'s file') });
    fakeJira.getIssue('PROJ-15').summary = `[fake:fetch-attachment] [fetch:${ownId},${foreignId}] Task PROJ-15`;
    const text = await handOverAndAwaitAnswer('PROJ-15');
    assert.ok(text.includes(`${ownId} screen shot.png (image/png, ${ownBytes.length} bytes`), 'the attachments block lists the file');
    const [ownCall, foreignCall] = getToolCalls('PROJ-15');
    const savedAt = path.join(resolveThreadFilesDir(getLayout().dataDir, makeJiraKey('PROJ-15')), 'jira', `${ownId}-screen shot.png`);
    assert.equal(ownCall.tool, 'jira_get_attachment');
    assert.ok(ownCall.outcome.includes(`is saved at ${savedAt}`), ownCall.outcome);
    assert.ok(fs.readFileSync(savedAt).equals(ownBytes), 'the file is the original, whole');
    assert.ok(foreignCall.outcome.startsWith(`error: Attachment ${foreignId} is not an attachment of PROJ-15.`), foreignCall.outcome);
    const contentRequests = fakeJira.requestLog.filter((request) => request.startsWith('GET /rest/api/3/attachment/content/'));
    assert.deepEqual(contentRequests, [`GET /rest/api/3/attachment/content/${ownId}`], 'the other issue\'s file was never even requested');
  });

  it('E8: a comment of 12 000 characters is written whole to a file and the prompt names it; E9: the agent runs a tool linked by agentBinaries by its name', async () => {
    const longText = spilledCommentWord.repeat(spilledCommentWords);
    createIssue('PROJ-17', 'answer');
    const commentId = fakeJira.addComment('PROJ-17', requester, longText);
    const text = await handOverAndAwaitAnswer('PROJ-17');
    const spillDir = path.join(resolveThreadFilesDir(getLayout().dataDir, makeJiraKey('PROJ-17')), 'jira', 'text');
    const spillPath = new RegExp(`Comment ${commentId} by Requester, \\S+\\nwritten whole to (${spillDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/comment-${commentId}-[0-9a-f]{8}\\.txt) \\(${longText.length} chars\\) — read it`).exec(text)?.[1];
    assert.ok(spillPath, text);
    assert.equal(fs.readFileSync(spillPath, 'utf8'), longText, 'the file holds the comment whole');
    assert.ok(!text.includes(spilledCommentWord.repeat(10)), 'none of it is in the prompt');

    // E9: found on no PATH of the box — only the link in DATA_DIR/agent-bin makes it runnable by name.
    assert.equal(spawnSync(probeToolName).error?.message.includes('ENOENT'), true, 'the box has no such tool of its own');
    createIssue('PROJ-18', 'run-tool');
    await handOverAndAwaitAnswer('PROJ-18');
    assert.deepEqual(getToolCalls('PROJ-18').map((call) => [call.tool, call.outcome]), [[probeToolName, probeToolMarker]]);
    assert.equal(fs.readlinkSync(path.join(getLayout().dataDir, 'agent-bin', probeToolName)), getProbeToolPath());
  });

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
});
