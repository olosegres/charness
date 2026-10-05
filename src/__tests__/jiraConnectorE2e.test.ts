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

/** Test case: N/A — TelegramCode has no Jira tracker. */

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
import {
  checkHasFlag,
  fakeClaudeLogFileNames,
  getFlagValues,
  getForeignAgentEnvNames,
  getLaunchSessionId,
  requiredJiraSessionFlags,
  type FakeClaudeAnswer,
  type FakeClaudeTurn,
} from './jiraE2e/fakeClaudeContract';
import { getAdfText } from '../connectors/jira/adf';
import { requestRequesterAttribute } from '../requests/requestGroup';
import type { ClosedRequestRecord } from '../requests/types';
import { getClaudeMemoryAbove } from '../connectors/jira/config';
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
/** The instance's secret: the AI account's token, which jira.json takes from the env file. */
const instanceTokenEnvName = 'CHARNESS_JIRA_AI_API_TOKEN';
/** The shortest poll the config allows. */
const pollIntervalSeconds = 10;
/** The shortest useful one, so the killed agent's request is taken up by the first sweep after it. */
const backstopMinutes = '0.1';

const bootTimeoutMs = 60 * 1000;
/** A poll, a session start and a turn, with room to spare. */
const answerTimeoutMs = 60 * 1000;
/** The backstop window plus the wake-up engine's one-minute sweep, twice over. */
const resumeTimeoutMs = 3 * 60 * 1000;
/** The grace the shared instance helper gives a stop before killing. */
const stopTimeoutMs = 20 * 1000;
/** The restart step waits for this many polls. */
const restartPollWaitMs = 3 * pollIntervalSeconds * 1000;
/** Room for the steps' own work between their waits. */
const flowMarginMs = 60 * 1000;
/**
 * Every wait the flow can spend, added up — two boots, the answer waits of five
 * steps plus the two of each R34 step, the resume, the restart's polls, two
 * stops (the restart's and `after`'s) — so a slow run fails at the step that is
 * late, never at the suite.
 */
const flowTimeoutMs = 2 * bootTimeoutMs + 9 * answerTimeoutMs + resumeTimeoutMs + restartPollWaitMs + 2 * stopTimeoutMs + flowMarginMs;

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
 * Ready = the poll started, which the boot does only after the bot MCP is up on its fixed port.
 */
async function startCharness(): Promise<void> {
  charness ??= new IsolatedCharness(getLayout());
  const outputStart = charness.output.length;
  await charness.start(bootTimeoutMs, (runOutput) => runOutput.includes(`[jira] polling PROJ every ${pollIntervalSeconds} s`));
  assertMcpListeningOn(charness.output.slice(outputStart), botMcpPort);
}

function writeInstanceFiles(ports: { openCode: number; botMcp: number }, jiraBaseUrl: string): void {
  const instance = getLayout();
  fs.writeFileSync(path.join(instance.dataDir, 'jira.json'), JSON.stringify({
    site: 'example.atlassian.net',
    baseUrl: jiraBaseUrl,
    email: aiCredentials.email,
    apiToken: `\${${instanceTokenEnvName}}`,
    accountId: aiAccount.accountId,
    projects: { PROJ: { folder: projectFolder, triggerStatuses: [inProgress.name] } },
    pollIntervalSeconds,
    adapter: 'claude-json-stream',
  }, null, 2));

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

describe('Jira connector end to end: built charness, fake Jira, fake claude (J7)', { timeout: flowTimeoutMs }, () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-j7-', [projectFolder]);
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeJira = new FakeJira({ aiAccount, credentials: aiCredentials, statuses: [toDo, inProgress] });
    const jiraBaseUrl = await fakeJira.start();
    botMcpPort = await getFreeFixedPort();
    writeInstanceFiles({ openCode: await getFreePort(), botMcp: botMcpPort }, jiraBaseUrl);
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
    assert.equal(getClaudeMemoryAbove(path.join(instance.workRoot, projectFolder)), null, 'no Claude memory in or above the working folder');
    const envNames = getInstanceEnvNames(instance);
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
    createIssue('PROJ-6', 'finish-together');
    createIssue('PROJ-7', 'answer-after-queued');
    createIssue('OTHER-1', 'answer');
    await startCharness();
    const pid = getCharness().pid;
    const envNames = pid === undefined ? null : getProcessEnvNames(pid);
    if (envNames !== null) assert.deepEqual([...envNames].sort(), [...isolatedLaunchEnvNames].sort());
    // The allowlist as Jira receives it: the poll's JQL names the configured project and nothing else.
    assert.deepEqual(getPollJqlProjectKeys(getCharness().output), [['PROJ']]);
  });

  it('the requester assigns the issues: each in-scope one becomes one request', async () => {
    for (const key of ['PROJ-1', 'PROJ-2', 'PROJ-3', 'PROJ-4', 'OTHER-1']) fakeJira.assignIssue(key, aiAccount, requester);
    fakeJira.assignIssue('PROJ-5', aiAccount, aiAccount);
    // The polls also name each request they open — what the restart step reads back.
    await waitFor('the first turn of every in-scope issue, and its request in the poll log', answerTimeoutMs, () =>
      ['PROJ-1', 'PROJ-2', 'PROJ-3', 'PROJ-4'].every((key) => getTurns(key).length > 0 && getPolledRequestIssueKeys(getCharness().output).includes(key)));
    for (const key of ['PROJ-1', 'PROJ-2', 'PROJ-3', 'PROJ-4']) {
      assert.equal(getTurns(key)[0].isRequestPrompt, true, `${key}'s first turn is its request prompt`);
    }
    assert.deepEqual([...getPolledRequestIssueKeys(getCharness().output)].sort(), ['PROJ-1', 'PROJ-2', 'PROJ-3', 'PROJ-4'], 'one request each');
    assert.ok(listTmuxSessions(['-L', getLayout().tmuxSocketName], getInstanceTmuxEnv()).length >= 4, 'the agents run on the private server');
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

  it('a restart opens no request a second time', async () => {
    const requestPromptCount = (): number => readFakeLog<FakeClaudeTurn>(fakeClaudeLogFileNames.turns).filter((turn) => turn.isRequestPrompt).length;
    const promptsBefore = requestPromptCount();
    const commentsBefore = ['PROJ-1', 'PROJ-2', 'PROJ-3', 'PROJ-4', 'PROJ-5', 'PROJ-6', 'PROJ-7'].map((key) => fakeJira.getIssue(key).comments.length);
    await getCharness().stop();

    const searchesBefore = fakeJira.requestLog.filter((request) => request === fakeJiraSearchRequest).length;
    const outputBeforeRestart = getCharness().output.length;
    await startCharness();
    // Two polls after the restart: the first one decided every issue again.
    await waitFor('two polls after the restart', restartPollWaitMs, () =>
      fakeJira.requestLog.filter((request) => request === fakeJiraSearchRequest).length >= searchesBefore + 2);

    // Deterministic, whereas the counts below could be read before a re-opened request's post (not awaited) lands.
    assert.deepEqual(getPolledRequestIssueKeys(getCharness().output.slice(outputBeforeRestart)), [], 'no poll opened a request again');
    assert.equal(requestPromptCount(), promptsBefore, 'no request prompt was posted again');
    // One request per issue. Its PROMPT may reach the agent twice: a request whose taking-in was not yet
    // seen when the agent died is re-posted to the resumed session (R21) — same request, not a second one.
    for (const key of ['PROJ-1', 'PROJ-2', 'PROJ-3', 'PROJ-4']) {
      assert.equal(new Set(getTurns(key).map((turn) => turn.requestId)).size, 1, `${key} was one request, from start to end`);
    }
    assert.deepEqual(['PROJ-1', 'PROJ-2', 'PROJ-3', 'PROJ-4', 'PROJ-5', 'PROJ-6', 'PROJ-7'].map((key) => fakeJira.getIssue(key).comments.length), commentsBefore);
    assert.equal(fakeJira.getIssue('PROJ-4').assignee?.accountId, aiAccount.accountId, 'PROJ-4 still matches — its trigger was remembered');
  });

  it('the agent and its tmux server hold no instance variable: the allowlist only (R32)', () => {
    const sessionLaunches = readFakeLog<FakeLaunch>(fakeClaudeLogFileNames.launches).filter((launch) => launch.isSessionLaunch);
    assert.ok(sessionLaunches.length > 0);
    for (const launch of sessionLaunches) {
      assert.equal(launch.home, getLayout().instanceHome, 'HOME is the launch environment\'s');
      assert.deepEqual(getForeignAgentEnvNames(launch.envNames), [], 'nothing but the allowlist');
      assert.ok(!launch.envNames.includes(instanceTokenEnvName), 'not the tracker token');
    }
    // Every session inherits the server's global environment, and any process on the server can read it back.
    const serverEnvironment = spawnSync('tmux', ['-L', getLayout().tmuxSocketName, 'show-environment', '-g'], { encoding: 'utf8', env: getInstanceTmuxEnv() });
    assert.equal(serverEnvironment.status, 0, 'the private server answered');
    const serverEnvNames = serverEnvironment.stdout.split('\n').filter(Boolean).map((line) => line.replace(/^-/, '').split('=')[0]);
    assert.ok(serverEnvNames.includes('HOME'), 'the server environment was read');
    assert.deepEqual(getForeignAgentEnvNames(serverEnvNames.filter((name) => name !== 'TMUX_TMPDIR')), [], 'the server started clean');
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
