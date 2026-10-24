/**
 * @description The Jira connector end to end, at PROCESS level (Jira connector plan J7, R6, R11): requests and the
 * session lifecycle. The BUILT charness, started the way an isolated instance is started (`scripts/run-isolated.sh` with
 * its own env file), serving Jira only, against a fake Jira on loopback (`jiraE2e/fakeJira.ts`) and a fake `claude`
 * (`jiraE2e/fakeClaude.ts`, via `CLAUDE_BIN`) that answers through the real bot MCP. One flow, in order:
 *
 *   isolation checked before the boot: a private tmux server (named, in a private TMUX_TMPDIR), a temp HOME, DATA_DIR
 *   and WORK_ROOT, ports of its own, an env file without a bot token or Atlassian variables; the project folder holds
 *   Claude memory (a `CLAUDE.md` in it, one in WORK_ROOT above it) and the instance still boots and serves it, as any
 *   Claude Code session loads it
 *   → the requester assigns the issues, plus one the AI assigned itself and one of a project outside the allowlist
 *   → answered: a comment by the AI account, the issue handed back
 *   → a silent first turn: woken, then answered
 *   → a progress note: commented, the issue stays with the AI
 *   → an answered issue idles: compacted, its process stopped, the next hand-over resumes it (L3)
 *   → the agent process killed mid-turn: resumed in its own session, answered
 *   → the self-assigned and the foreign issue: no request, nothing posted
 *   → two people hand one issue over in turn: two open requests, two answers, the issue goes back to the person whose
 *     answer closed first (R34)
 *   → one person hands an issue over twice while the agent is mid-turn: the newer request replaces the first; the agent
 *     (Claude Code's timing: a message written mid-turn is read only after the turn ends) answers the first, then reads
 *     the second prompt — its header names the replaced one — and answers a short pointer; the issue goes back once (R34)
 *   → charness restarted: no request is opened a second time; adopted processes with a stale tool list are not
 *     stopped early — each follows the idle lifecycle, the one with a background task is kept (L4); new sessions run
 *     per turn from then on (L5)
 *   → every session launch carried the Jira flags (R11); no Telegram call (R6); every tmux call named the private
 *     server, nothing of the instance on the user's default tmux server
 *
 * The prompts' content is `jiraPromptE2e.test.ts`, the trusted group and mentions `jiraTrustE2e.test.ts` — independent
 * journeys, run in parallel; what they share is `jiraE2e/jiraFlowKit.ts`.
 *
 * Nothing leaves the machine: Jira and the bot MCP are on loopback, the agent is the fake. The instance's TMUX_TMPDIR lies
 * inside the temp folder, so even a broken `-L` guard could not reach the user's default tmux server — it would start a
 * default server of its own there, which the last step catches. Everything the test starts is stopped in `after` —
 * charness, its tmux servers (with the fake agents in them), the fake Jira — and the temp folder removed.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import { fakeJiraSearchRequest } from './jiraE2e/fakeJira';
import { fakeClaudePath, listTmuxSessions } from './e2e/isolatedCharness';
import { getPolledRequestIssueKeys } from './jiraE2e/charnessLog';
import { claudeJsonStreamUsageLogPrefix } from '../adapters/claudeJsonStreamAdapter';
import {
  fakeClaudeLogFileNames,
  fakeCompactionModelUsage,
  fakeTurnUsage,
  getFlagValues,
  getLaunchSessionId,
  type FakeClaudeTurn,
} from './jiraE2e/fakeClaudeContract';
import { requestRequesterAttribute } from '../requests/requestGroup';
import {
  aiAccount,
  answerTimeoutMs,
  bootJiraOnly,
  checkIsProcessAlive,
  colleague,
  countAssigneeChanges,
  createIssue,
  fakeJira,
  getAnswers,
  getCharness,
  getClosedRequest,
  getCommentTexts,
  getInstanceTmuxEnv,
  getLayout,
  getPrompts,
  getSessionLaunchOf,
  getTurns,
  handIssueToAi,
  idleStopTimeoutMs,
  isWholePrompt,
  itHoldsIsolationBeforeBoot,
  itHoldsTheInstanceInvariants,
  markToolDigestStale,
  perTurnStopTimeoutMs,
  readFakeLog,
  registerJiraFlowHooks,
  requester,
  restartPollWaitMs,
  resumeTimeoutMs,
  startCharness,
  waitFor,
  writeJiraConfig,
  type FakeCompaction,
} from './jiraE2e/jiraFlowKit';

describe('Jira connector end to end — requests and the session lifecycle: built charness, fake Jira, fake claude (J7)', () => {
  registerJiraFlowHooks({ layoutPrefix: 'charness-j7-', config: { adapter: 'claude-json-stream' } });

  itHoldsIsolationBeforeBoot();

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
    await bootJiraOnly();
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

  it('a restart opens no request a second time; a gone process is not re-spawned; an adopted one with a stale tool list is never stopped early — it follows the idle lifecycle (L4)', async () => {
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
    const staleToolListLine = (issueKey: string): string => `[reattach] jira:PROJ:${issueKey}: adopted with a stale tool list; it gets the current tools when it resumes after its idle stop`;
    for (const issueKey of ['PROJ-2', 'PROJ-8', 'PROJ-9']) assert.ok(bootOutput().includes(staleToolListLine(issueKey)), `${issueKey}'s stale tool list was seen at the adopt`);
    assert.ok(!bootOutput().includes('stopping the adopted process'), 'no early stop of an adopted process');
    // A stale process adopted MID-TURN (no frame since the persisted tail: a long tool call) is kept through its turn (L-D2).
    assert.ok(checkIsProcessAlive(midTurnAdoptedTurn.pid), 'PROJ-9\'s process survives the adopt mid-turn');
    assert.equal(fakeJira.getIssue('PROJ-9').comments.length, 0, 'still working');
    // The stale idle process follows the idle lifecycle: stopped by the idle fire, never right after the adopt.
    await waitFor('PROJ-2\'s stale process stopped at its idle mark', idleStopTimeoutMs, () => !checkIsProcessAlive(idleAdoptedTurn.pid));
    await waitFor('PROJ-2\'s idle stop logged', idleStopTimeoutMs, () => bootOutput().includes('[compact-on-idle] jira:PROJ:PROJ-2 process stopped; the session sleeps'));
    assert.ok(checkIsProcessAlive(workingAdoptedTurn.pid), 'PROJ-8 keeps working: its background task is never killed');
    await waitFor('PROJ-9 answered by the adopted process', 2 * answerTimeoutMs, () => fakeJira.getIssue('PROJ-9').comments.length > 0);
    assert.equal(getTurns('PROJ-9').length, 1, 'answered by the turn that was in flight, in the adopted process');
    await waitFor('PROJ-9\'s stale process stopped at its idle mark after the turn', idleStopTimeoutMs, () => !checkIsProcessAlive(midTurnAdoptedTurn.pid));
    await waitFor('PROJ-9\'s idle stop logged', idleStopTimeoutMs, () => bootOutput().includes('[compact-on-idle] jira:PROJ:PROJ-9 process stopped; the session sleeps'));
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

  it('per-turn mode (L5): from the restart that switched jira.json to it, a NEW session\'s process is gone right after its answer', async () => {
    // The resume that follows, its delta prompt and the second stop are the prompt flow's E1 (jiraPromptE2e), which boots
    // per-turn; what only this flow shows is the switch at a restart reaching the sessions started after it.
    fakeJira.assignIssue('PROJ-10', aiAccount, requester);
    await waitFor('PROJ-10 answered', answerTimeoutMs, () => fakeJira.getIssue('PROJ-10').comments.length === 1);
    const [firstTurn] = getTurns('PROJ-10');
    assert.ok(getLaunchSessionId(getSessionLaunchOf(firstTurn.pid)?.argv ?? []), 'PROJ-10\'s launch named its conversation');
    await waitFor('PROJ-10\'s process stopped right after its turn', perTurnStopTimeoutMs, () => !checkIsProcessAlive(firstTurn.pid));
    // The per-turn stop is the idle stop's teardown; its line follows the bot's own tmux kill, after the process is gone.
    await waitFor('the per-turn stop logged', perTurnStopTimeoutMs, () => getCharness().output.includes('[compact-on-idle] jira:PROJ:PROJ-10 process stopped; the session sleeps'));
    assert.ok(!getCharness().output.includes('[ClaudeJson] session jira:PROJ:PROJ-10 exited unexpectedly'));
    assert.equal(fakeJira.getIssue('PROJ-10').assignee?.accountId, requester.accountId, 'handed back');
  });


  itHoldsTheInstanceInvariants();
});
