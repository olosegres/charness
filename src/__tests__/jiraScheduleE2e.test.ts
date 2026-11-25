/**
 * @description Scheduling in a Jira issue's conversation end to end, at PROCESS level: the BUILT charness serving Jira only,
 * against the fake Jira and the fake `claude` (`jiraE2e/jiraFlowKit.ts`), whose agent orchestrates a REAL worker process
 * (`sleep`) the way the `charness-orchestration` skill says — arms the real worker-watch recipe through the bot MCP's
 * `schedule_create`, answers `progress` and ENDS its turn. One flow, in order:
 *
 *   isolation checked before the boot; the boot
 *   → the agent arms the watch, answers `progress` (ONE comment), ends its turn: the job is stored under the issue's key with the
 *     request it was armed under (`requestId`)
 *   → the watch passes for several runs and the progress follow-up window passes: no comment, no engine wake, no status line
 *     (a tracker conversation posts nothing), and the agent's idle process stops — the conversation sleeps
 *   → a bot restart while it waits: the job is re-armed and NO `restarted` wake starts a turn
 *   → the worker exits: the check fails, the sleeping session is resumed BY ID (`--resume`), its prompt is the tracker header
 *     naming the open request + the `[Scheduled check … failed]` block; the woken agent only keeps the watch and ends silently:
 *     no comment, no reminder, no give-up alert, the request still open
 *   → a second issue: the worker exits, the agent cancels the watch and answers `final` to the request id its header names:
 *     ONE comment, the issue handed back, the request closed, the job gone
 *   → a third issue: a one-shot armed, then `final`, then it fires: its header says no request is open and names the finished
 *     one; the agent's answer is a comment and hands nothing back
 *   → a fourth issue: the agent, woken by its failed check, drops the watch and says nothing: the request is no longer waiting, and
 *     the normal rules take it back (the backstop wakes it)
 *   → a fifth issue: the project's folder goes missing, a fire pauses the job (a log line, nothing on the issue); the folder is back
 *     and the issue is handed over again: the next request's bind step resumes the job, its next run counted from then
 *   → the instance invariants (R11, R32, and R6 — no Telegram primitive was reached, which is what a status line, an
 *     announcement or an alert posted for an issue would have hit)
 *
 * The watch runs every minute (the production minimum is five): the test shortens it. Nothing leaves the machine; everything the
 * test starts is stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  fakeClaudeLogFileNames,
  fakeDropWatchWakeMarker,
  fakeKeepWatchWakeMarker,
  fakeOneShotDelaySeconds,
  fakeStatusWatchJobName,
  fakeStatusWatchTargetFileName,
  type FakeClaudePrompt,
  type FakeStatusWatchTarget,
} from './jiraE2e/fakeClaudeContract';
import {
  answerTimeoutMs,
  bootJiraOnly,
  checkIsProcessAlive,
  countAssigneeChanges,
  createIssue,
  fakeJira,
  getCharness,
  getClosedRequest,
  getCommentTexts,
  getLayout,
  getPrompts,
  getToolCalls,
  getTurns,
  handIssueToAi,
  projectFolder,
  handOverAndAwaitAnswer,
  idleStopTimeoutMs,
  itHoldsIsolationBeforeBoot,
  itHoldsTheInstanceInvariants,
  readFakeLog,
  registerJiraFlowHooks,
  requester,
  resumeTimeoutMs,
  startCharness,
  waitFor,
} from './jiraE2e/jiraFlowKit';
import { readJsonLines } from './e2e/isolatedCharness';
import type { ScheduleRunRecord } from '../scheduler/runLedger';
import type { ScheduleRecord } from '../scheduler/types';
import type { OpenRequestState } from '../requests/types';

const msPerSecond = 1000;
/** The watch ticks every minute (the production minimum is five): a tick is up to a minute and a little away, on a loaded machine more. */
const watchTickTimeoutMs = 3 * 60 * msPerSecond;
/** The follow-up a progress note would get 15 min later in production; this instance's windows are seconds, so a wrongly woken request shows quickly. */
const progressFollowUpMs = 15 * msPerSecond;
/** How long the flow watches for something that must NOT happen: several of the windows above (the sweep is 10 s). */
const quietObservationMs = 3 * progressFollowUpMs;
/** The passing check runs the first issue's watch must complete before the quiet is judged. */
const passingRunCount = 3;
const restartWakeStaggerMs = 2 * msPerSecond;
/** After the restart, the engine's boot wake would come this much later, plus the sweep: nothing may have started by then. */
const restartObservationMs = 4 * restartWakeStaggerMs + 10 * msPerSecond;
/**
 * The request backstop of this flow: longer than the quiet the flow observes after a wake (a failing check nobody handled falls to
 * it, as it should), shorter than what the dropped-watch case waits for it.
 */
const flowBackstopMinutes = '1.5';
const backstopMs = 90 * msPerSecond;
const keepIssueKey = 'PROJ-1';
const cancelIssueKey = 'PROJ-2';
const oneShotIssueKey = 'PROJ-3';
const dropIssueKey = 'PROJ-4';
const folderIssueKey = 'PROJ-5';
/** What the bot says of a job a fire paused for an unusable folder, and of the resume; both lines name the conversation. */
const pausedLogMark = 'paused: its folder is not usable';
const resumedLogMark = 'resumed: its folder is usable again';
const jiraConversationKey = (issueKey: string): string => `jira:PROJ:${issueKey}`;

let keptWorker: ChildProcess | null = null;
let cancelledWorker: ChildProcess | null = null;
let droppedWorker: ChildProcess | null = null;
let folderWorker: ChildProcess | null = null;
let keepRunDir = '';
let keepRequestId = '';

async function startWorker(runDirName: string): Promise<{ worker: ChildProcess; runDir: string; pid: number }> {
  const runDir = path.join(getLayout().testRoot, runDirName);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'yarn test' } }] } })}\n`);
  const worker = spawn('sleep', ['3600'], { stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => {
    worker.once('spawn', resolve);
    worker.once('error', reject);
  });
  if (worker.pid === undefined) throw new Error('the worker has no process id');
  return { worker, runDir, pid: worker.pid };
}

/** Name the worker the fake agent's next `watch-progress` turn arms its watch on. */
function nameWatchTarget(target: FakeStatusWatchTarget): void {
  fs.writeFileSync(path.join(getLayout().fakeStateDir, fakeStatusWatchTargetFileName), JSON.stringify(target));
}

function readPersistedSchedules(): ScheduleRecord[] {
  const persisted: { schedules?: Record<string, ScheduleRecord> } = JSON.parse(fs.readFileSync(path.join(getLayout().dataDir, 'state.json'), 'utf8'));
  return Object.values(persisted.schedules ?? {});
}

function readOpenRequests(): OpenRequestState[] {
  const persisted: { openRequests?: Record<string, OpenRequestState> } = JSON.parse(fs.readFileSync(path.join(getLayout().dataDir, 'state.json'), 'utf8'));
  return Object.values(persisted.openRequests ?? {});
}

function readRunsOf(jobId: string): ScheduleRunRecord[] {
  return readJsonLines<ScheduleRunRecord>(path.join(getLayout().dataDir, 'scheduler-runs.jsonl')).filter((run) => run.jobId === jobId);
}

function countFinishedRunsOf(jobId: string): number {
  return readRunsOf(jobId).filter((run) => run.deliveredAt !== undefined).length;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** What an issue's agent was told, in order: the texts of every prompt it read. */
function getPromptTexts(issueKey: string): string[] {
  return getPrompts(issueKey).map((prompt) => prompt.text);
}

/**
 * Every prompt that names the request, in order: its own prompt, a scheduled run's header, and the engine's reminders — which carry
 * the request's id but no issue key, so `getPromptTexts(issueKey)` does not see them.
 */
function getRequestPromptTexts(requestId: string): string[] {
  return readFakeLog<FakeClaudePrompt>(fakeClaudeLogFileNames.prompts).filter((prompt) => prompt.requestId === requestId).map((prompt) => prompt.text);
}

/** The comments the AI wrote on the issue, oldest first. */
function getAiComments(issueKey: string): string[] {
  return getCommentTexts(fakeJira.getIssue(issueKey));
}

describe('Scheduling in a Jira issue end to end: built charness, fake Jira, fake claude, a real worker process', () => {
  registerJiraFlowHooks({
    layoutPrefix: 'charness-jira-schedule-',
    config: {
      adapter: 'claude-json-stream',
      backstopMinutes: flowBackstopMinutes,
      extraTimings: {
        scheduleMinFireIntervalMs: 60 * msPerSecond,
        progressFollowUpMs,
        requestRestartWakeStaggerMs: restartWakeStaggerMs,
        // A status line would be due at every run: a tracker conversation must still post none.
        checkStatusIntervalMs: 60 * msPerSecond,
      },
    },
  });

  after(() => {
    keptWorker?.kill('SIGKILL');
    cancelledWorker?.kill('SIGKILL');
    droppedWorker?.kill('SIGKILL');
    folderWorker?.kill('SIGKILL');
  });

  itHoldsIsolationBeforeBoot();

  it('boots', async () => {
    await bootJiraOnly();
  });

  it('the agent arms the worker watch, answers `progress` — one comment — and ends its turn; the job is stored under the issue with the request it was armed under', async () => {
    const started = await startWorker('worker-kept');
    keptWorker = started.worker;
    keepRunDir = started.runDir;
    nameWatchTarget({ pid: started.pid, runDir: started.runDir });
    createIssue(keepIssueKey, 'watch-progress', ` ${fakeKeepWatchWakeMarker}`);
    handIssueToAi(keepIssueKey, requester);
    await waitFor(`${keepIssueKey}: the watch armed and the progress note answered`, answerTimeoutMs, () =>
      getToolCalls(keepIssueKey).some((call) => call.tool === 'schedule_create') && getAiComments(keepIssueKey).length === 1);

    const [created] = getToolCalls(keepIssueKey).filter((call) => call.tool === 'schedule_create');
    assert.doesNotMatch(created.outcome, /^error:/, created.outcome);
    assert.match(created.outcome, new RegExp(`^Scheduled "${fakeStatusWatchJobName}": checks; next: `), 'the confirmation is one line');
    keepRequestId = getTurns(keepIssueKey)[0].requestId ?? '';
    assert.match(keepRequestId, /^req_/);
    await waitFor('the watch to be persisted', answerTimeoutMs, () => readPersistedSchedules().some((record) => record.name === fakeStatusWatchJobName));
    const watch = readPersistedSchedules().find((record) => record.name === fakeStatusWatchJobName);
    assert.ok(watch);
    assert.equal(watch.threadKey, jiraConversationKey(keepIssueKey), 'stored under the issue\'s key');
    assert.equal(watch.deliveryKind, 'check');
    assert.equal(watch.requestId, keepRequestId, 'armed under the request that was open');
    assert.equal(watch.statusWorkerRunDir, keepRunDir, 'the status arguments are accepted and recorded: they mark the worker watch');
    assert.equal(getAiComments(keepIssueKey).length, 1, 'the progress note is the only comment');
    assert.equal(getClosedRequest(keepRequestId), undefined, 'the request is still open: progress answers close nothing');
  });

  it('the watch passes for several runs and the follow-up window passes: nothing is posted, nobody is woken, and the idle process stops — the conversation sleeps', async () => {
    const watch = readPersistedSchedules().find((record) => record.name === fakeStatusWatchJobName);
    assert.ok(watch);
    const promptsAfterArming = getRequestPromptTexts(keepRequestId).length;
    const turnsAfterArming = getTurns(keepIssueKey).length;
    const agentPid = getTurns(keepIssueKey)[0].pid;
    await waitFor(`${passingRunCount} passing runs of the watch`, passingRunCount * watchTickTimeoutMs, () => countFinishedRunsOf(watch.id) >= passingRunCount);
    await sleep(quietObservationMs);

    assert.equal(getRequestPromptTexts(keepRequestId).length, promptsAfterArming, 'no prompt: neither the engine\'s follow-up nor a check wake');
    assert.equal(getTurns(keepIssueKey).length, turnsAfterArming, 'no turn started');
    assert.equal(getAiComments(keepIssueKey).length, 1, 'no comment: no status line, no announcement, no reminder');
    assert.equal(readOpenRequests().find((request) => request.id === keepRequestId)?.nextWakeAt, undefined, 'a progress note under a watch schedules no follow-up');
    await waitFor('the idle agent process to stop', idleStopTimeoutMs, () => !checkIsProcessAlive(agentPid));
    assert.ok(!getCharness().output.includes('[scheduler] job'), 'no job was paused, held or failed');
  });

  it('a bot restart while it waits: the job is re-armed and no `restarted` wake starts a turn', async () => {
    const watch = readPersistedSchedules().find((record) => record.name === fakeStatusWatchJobName);
    assert.ok(watch);
    const promptsBefore = getRequestPromptTexts(keepRequestId).length;
    const runsBefore = countFinishedRunsOf(watch.id);
    await getCharness().stop();
    const outputStart = getCharness().output.length;
    await startCharness();
    await waitFor('the watch to run again after the restart', watchTickTimeoutMs, () => countFinishedRunsOf(watch.id) > runsBefore);
    await sleep(restartObservationMs);

    const bootOutput = getCharness().output.slice(outputStart);
    assert.ok(!bootOutput.includes(`${jiraConversationKey(keepIssueKey)}: woken after a restart`), 'the request waits for its watch: a restart wakes nobody');
    assert.equal(getRequestPromptTexts(keepRequestId).length, promptsBefore, 'no prompt reached the agent');
    assert.equal(getAiComments(keepIssueKey).length, 1);
  });

  it('the worker exits: the sleeping session is resumed by id, behind the tracker header naming the open request and the failed check; the agent only keeps the watch — no comment, no reminder, no alert', async () => {
    const promptsBefore = getRequestPromptTexts(keepRequestId).length;
    const launchesBefore = readFakeLog<{ argv: string[]; isSessionLaunch: boolean }>(fakeClaudeLogFileNames.launches).filter((launch) => launch.isSessionLaunch).length;
    keptWorker?.kill('SIGKILL');
    await waitFor('the failed check to wake the agent', watchTickTimeoutMs, () => getRequestPromptTexts(keepRequestId).length > promptsBefore);

    const wakePrompt = getRequestPromptTexts(keepRequestId)[promptsBefore];
    // After the issue-context preamble the first prompt of a started process carries, the tracker header leads the run.
    assert.ok(wakePrompt.includes(`[Scheduled run "${fakeStatusWatchJobName}" · Jira issue ${keepIssueKey} (`), wakePrompt);
    assert.ok(wakePrompt.includes(`· request ${keepRequestId} is open]`), 'the header names the open request');
    assert.ok(wakePrompt.includes('Nothing of this run is shown on the issue.'), wakePrompt);
    assert.ok(wakePrompt.includes(`[Scheduled check "${fakeStatusWatchJobName}" failed]`), wakePrompt);
    assert.ok(wakePrompt.includes('posts nothing on the issue when it passes again'), 'the tracker wording of the check prompt');
    assert.ok(!wakePrompt.includes('tells the topic'), 'no word of a topic');
    const launches = readFakeLog<{ argv: string[]; isSessionLaunch: boolean }>(fakeClaudeLogFileNames.launches).filter((launch) => launch.isSessionLaunch);
    assert.ok(launches.length > launchesBefore, 'a process was launched for the wake');
    assert.ok(launches.at(-1)?.argv.includes('--resume'), 'the conversation\'s own session was resumed by its id');
    const wakeTurn = getTurns(keepIssueKey).at(-1);
    assert.equal(wakeTurn?.requestId, keepRequestId, 'the turn is the open request\'s');

    // The woken agent kept the watch and ended silently: nothing follows — no reminder, no silent-turn wake, no alert comment.
    await sleep(quietObservationMs);
    assert.equal(getRequestPromptTexts(keepRequestId).length, promptsBefore + 1, 'one wake, no reminder after it');
    assert.equal(getAiComments(keepIssueKey).length, 1, 'no comment: a woken agent with nothing to report stays silent');
    assert.equal(getClosedRequest(keepRequestId), undefined, 'the request is still open');
    const request = readOpenRequests().find((open) => open.id === keepRequestId);
    assert.equal(request?.isWakeStopped, false, 'the rules did not give up on it');
    assert.equal(request?.wakeCount, 0, 'a scheduler fire is not one of the engine\'s wake-ups');
    assert.equal(request?.silentTurnCount, 0, 'the silent turn of a scheduled run is not silence');
  });

  it('a second issue: the worker exits, the agent cancels the watch and answers `final` to the request its header names — one comment, handed back, the job gone', async () => {
    const started = await startWorker('worker-cancelled');
    cancelledWorker = started.worker;
    nameWatchTarget({ pid: started.pid, runDir: started.runDir });
    createIssue(cancelIssueKey, 'watch-progress');
    handIssueToAi(cancelIssueKey, requester);
    await waitFor(`${cancelIssueKey}: the progress note answered`, answerTimeoutMs, () => getAiComments(cancelIssueKey).length === 1);
    const requestId = getTurns(cancelIssueKey)[0].requestId ?? '';
    await waitFor('the second watch to be persisted', answerTimeoutMs, () => readPersistedSchedules().some((record) => record.threadKey === jiraConversationKey(cancelIssueKey)));
    const handBacksBefore = countAssigneeChanges(cancelIssueKey);

    cancelledWorker?.kill('SIGKILL');
    await waitFor(`${cancelIssueKey}: the watch cancelled, the request answered and the issue handed back`, watchTickTimeoutMs, () =>
      fakeJira.getIssue(cancelIssueKey).assignee?.accountId === requester.accountId && getClosedRequest(requestId) !== undefined);

    assert.equal(getClosedRequest(requestId)?.closeReason, 'final');
    assert.equal(getAiComments(cancelIssueKey).length, 2, 'the progress note and the final answer — nothing else');
    assert.ok(countAssigneeChanges(cancelIssueKey) > handBacksBefore, 'the final answer handed the issue back');
    assert.ok(getToolCalls(cancelIssueKey).some((call) => call.tool === 'schedule_cancel' && !call.outcome.startsWith('error:')), 'the watch was cancelled by its agent');
    // `state.json` is written a moment after the change (the save is debounced): wait for the job to leave it.
    await waitFor('the cancelled job to leave state.json', answerTimeoutMs, () => readPersistedSchedules().every((record) => record.threadKey !== jiraConversationKey(cancelIssueKey)));
  });

  it('a third issue: a one-shot armed under a request that is answered `final` before it fires — its header says no request is open and names the finished one; the answer is a comment and hands nothing back', async () => {
    const issueStartedAt = Date.now();
    createIssue(oneShotIssueKey, 'one-shot-then-final');
    await handOverAndAwaitAnswer(oneShotIssueKey);
    const requestId = getTurns(oneShotIssueKey)[0].requestId ?? '';
    assert.equal(getClosedRequest(requestId)?.closeReason, 'final');
    const handBacksAfterFinal = countAssigneeChanges(oneShotIssueKey);
    const commentsAfterFinal = getAiComments(oneShotIssueKey).length;

    await waitFor(`${oneShotIssueKey}: the one-shot fired and its agent answered`, answerTimeoutMs + fakeOneShotDelaySeconds * msPerSecond, () => getAiComments(oneShotIssueKey).length > commentsAfterFinal);
    const firePrompt = getPromptTexts(oneShotIssueKey).find((text) => text.includes('no request is open'));
    assert.ok(firePrompt, 'the fire reached the agent with the «no request is open» header');
    assert.ok(firePrompt.includes(`(${requestId}) is finished`), 'it names the request the job was armed under');
    assert.ok(firePrompt.includes('still becomes a comment and hands nothing back'), firePrompt);
    assert.equal(countAssigneeChanges(oneShotIssueKey), handBacksAfterFinal, 'an answer to a finished request hands nothing back');
    await waitFor('the one-shot to leave state.json after its fire', answerTimeoutMs, () => readPersistedSchedules().every((record) => record.threadKey !== jiraConversationKey(oneShotIssueKey)));
    assert.ok(Date.now() - issueStartedAt > fakeOneShotDelaySeconds * msPerSecond, 'it fired at its time, not at once');
  });

  it('a fourth issue: the woken agent drops its watch and says nothing — that turn is quiet, then the request is no longer waiting and the backstop takes it', async () => {
    const started = await startWorker('worker-dropped');
    droppedWorker = started.worker;
    nameWatchTarget({ pid: started.pid, runDir: started.runDir });
    createIssue(dropIssueKey, 'watch-progress', ` ${fakeDropWatchWakeMarker}`);
    handIssueToAi(dropIssueKey, requester);
    await waitFor(`${dropIssueKey}: the progress note answered`, answerTimeoutMs, () => getAiComments(dropIssueKey).length === 1);
    const requestId = getTurns(dropIssueKey)[0].requestId ?? '';
    await waitFor('the watch to be persisted', answerTimeoutMs, () => readPersistedSchedules().some((record) => record.threadKey === jiraConversationKey(dropIssueKey)));
    const promptsBefore = getRequestPromptTexts(requestId).length;

    droppedWorker?.kill('SIGKILL');
    await waitFor(`${dropIssueKey}: the watch cancelled by its agent, which said nothing`, watchTickTimeoutMs, () =>
      getToolCalls(dropIssueKey).some((call) => call.tool === 'schedule_cancel' && !call.outcome.startsWith('error:')));
    await waitFor('the dropped job to leave state.json', answerTimeoutMs, () => readPersistedSchedules().every((record) => record.threadKey !== jiraConversationKey(dropIssueKey)));
    assert.equal(getRequestPromptTexts(requestId).length, promptsBefore + 1, 'the check\'s wake was the only prompt so far: that quiet turn drew no silent-turn wake');
    assert.equal(getAiComments(dropIssueKey).length, 1, 'no comment: the agent said nothing');
    assert.equal(getClosedRequest(requestId), undefined, 'the request is still open');

    // Nothing waits for it any more: the normal rules take the request back — the backstop, counted from the last turn.
    await waitFor(`${dropIssueKey}: the request woken by the normal rules`, backstopMs + resumeTimeoutMs, () => getRequestPromptTexts(requestId).length > promptsBefore + 1);
    const reminder = getRequestPromptTexts(requestId)[promptsBefore + 1];
    assert.ok(reminder.includes(`[Reminder · request ${requestId} is still open]`), reminder);
    assert.ok(reminder.includes('Nothing has been seen working on it for a long time'), 'the backstop\'s reason');
    await waitFor(`${dropIssueKey}: answered and handed back`, answerTimeoutMs, () => getClosedRequest(requestId)?.closeReason === 'final');
  });

  it('a fifth issue: the folder goes missing and a fire pauses the job — a log line, nothing on the issue; the folder is back and the next hand-over resumes it, its next run counted from then', async () => {
    const started = await startWorker('worker-folder');
    folderWorker = started.worker;
    nameWatchTarget({ pid: started.pid, runDir: started.runDir });
    createIssue(folderIssueKey, 'watch-progress');
    handIssueToAi(folderIssueKey, requester);
    await waitFor(`${folderIssueKey}: the progress note answered`, answerTimeoutMs, () => getAiComments(folderIssueKey).length === 1);
    await waitFor('the watch to be persisted', answerTimeoutMs, () => readPersistedSchedules().some((record) => record.threadKey === jiraConversationKey(folderIssueKey)));
    const job = readPersistedSchedules().find((record) => record.threadKey === jiraConversationKey(folderIssueKey));
    assert.ok(job);

    const folderPath = path.join(getLayout().workRoot, projectFolder);
    const awayPath = `${folderPath}-away`;
    fs.renameSync(folderPath, awayPath);
    try {
      await waitFor('the job paused for the folder', watchTickTimeoutMs, () => {
        const persisted = readPersistedSchedules().find((record) => record.id === job.id);
        return persisted?.isPaused === true && persisted.pauseReason === 'unbound';
      });
      assert.ok(getCharness().output.includes(`[scheduler] job ${job.id} of ${jiraConversationKey(folderIssueKey)} ${pausedLogMark}`), 'the pause is one log line');
      assert.equal(getAiComments(folderIssueKey).length, 1, 'nothing is posted on the issue for the pause');
    } finally {
      fs.renameSync(awayPath, folderPath);
    }

    const runsBefore = countFinishedRunsOf(job.id);
    const outputBefore = getCharness().output.length;
    const resumedAfterMs = Date.now();
    // The same issue is handed over again: a new request, and its bind step finds the folder usable.
    handIssueToAi(folderIssueKey, requester);
    await waitFor('the job resumed', answerTimeoutMs, () => {
      const persisted = readPersistedSchedules().find((record) => record.id === job.id);
      return persisted !== undefined && persisted.isPaused !== true;
    });
    const resumed = readPersistedSchedules().find((record) => record.id === job.id);
    assert.ok(resumed);
    assert.ok((resumed.nextRunAt ?? 0) > resumedAfterMs, 'its next run is counted from the resume, not replayed from the pause');
    assert.ok(getCharness().output.slice(outputBefore).includes(`${jiraConversationKey(folderIssueKey)} ${resumedLogMark}`), 'the resume is one log line');
    await waitFor('a run of the resumed job to finish', watchTickTimeoutMs, () => countFinishedRunsOf(job.id) > runsBefore);
    await waitFor(`${folderIssueKey}: the new request answered`, answerTimeoutMs, () => getAiComments(folderIssueKey).length === 2);
    assert.equal(getAiComments(folderIssueKey).length, 2, 'the progress note and the new request\'s answer — the pause and the resume posted nothing');
  });

  itHoldsTheInstanceInvariants();
});
