/**
 * @description The one cap on tracker task agents (decision D10) on a Jira-only instance, at PROCESS level: the BUILT charness,
 * started the way an isolated instance is started (`scripts/run-isolated.sh` with its own env file), against a fake Jira and
 * the fake `claude` (`jiraE2e/jiraFlowKit.ts`); `settings.json` caps the task agents at TWO. One flow, in order:
 *
 *   isolation checked before the boot; `taskAgents.maxConcurrent: 2` written; the boot
 *   → two issues handed over: both agents work (one held, one that never ends — the two slots are taken)
 *   → a third and a fourth handed over: each gets ONE comment saying it is queued (the third «next in line», the fourth «1 issue
 *     is ahead of it»), stays with the AI, opens no request and starts no agent, however many polls pass; the poll names them
 *     `queued`; the wait list, in order, is in `state.json`
 *   → the bot restarted: the list is the same, nobody is told again, and the two working agents — adopted — still hold their
 *     slots (the count is read off the open requests, so a restart cannot lose it)
 *   → the first agent hands back: the THIRD issue starts (the one that waited longest), the fourth keeps waiting until the
 *     third hands back — and at no moment did more than two hand-overs run at once (read off the request history)
 *   → a hand edit of settings.json to `0` (no limit), with no restart: a hand-over that waits for the still-full slots starts at
 *     once
 *   → a conversation handed over again after its idle stop (cap back to two, both slots held): queued like any other, and
 *     when a slot frees it RESUMES its own session
 *   → an agent the wake-up engine gives up on (every turn ends silent) frees its slot: the alert is out, the issue is handed back,
 *     and the issue waiting for the slot starts at once — the instance restarted with the poll at ten minutes, so no regular poll
 *     can be what starts it; only the give-up's own wake-up (the poll back at 2 s afterwards)
 *   → every session launch carried the Jira flags; no Telegram path was reached
 *
 * The General picker and the typed number are `taskAgentsE2e.test.ts`; the queue's logic is `taskAgentSlots.test.ts` and
 * `jiraInbound.test.ts`. Nothing leaves the machine; everything the test starts is stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { fakeJiraSearchRequest } from './jiraE2e/fakeJira';
import { getPolledDecisions } from './jiraE2e/charnessLog';
import { isolatedBaselineSettings, isolatedSettingsFileName } from './e2e/isolatedCharness';
import { buildJiraQueuedText } from '../connectors/jira/answerSink';
import { jiraPollIntervalMaxSeconds } from '../connectors/jira/config';
import { getFlagValues, getLaunchSessionId } from './jiraE2e/fakeClaudeContract';
import type { ClosedRequestRecord, OpenRequestState } from '../requests/types';
import type { TaskAgentWaitEntry } from '../trackers/types';
import {
  aiAccount,
  answerTimeoutMs,
  bootJiraOnly,
  countAssigneeChanges,
  createIssue,
  fakeJira,
  getCharness,
  checkIsProcessAlive,
  getCommentTexts,
  getLayout,
  getPrompts,
  getSessionLaunchOf,
  getTurns,
  handIssueToAi,
  idleStopTimeoutMs,
  itHoldsIsolationBeforeBoot,
  itHoldsTheInstanceInvariants,
  readClosedRequests,
  registerJiraFlowHooks,
  releaseHeldTurn,
  requester,
  restartPollWaitMs,
  resumeTimeoutMs,
  startCharness,
  startCharnessWithPoll,
  waitFor,
} from './jiraE2e/jiraFlowKit';

const maxConcurrent = 2;
/** How many polls a queued issue must stay untouched through before the step believes it waits: a poll is 2 s here. */
const quietPollCount = 3;
/** The poll of the give-up step: `jira.json`'s longest, so no regular poll comes within the step — only a wake-up can start the waiting issue. */
const stretchedPollSeconds = jiraPollIntervalMaxSeconds;
/** What «at once» means against that poll: a wake-up's poll runs, opens the request and starts the agent well inside this. */
const wakeStartMaxMs = 30 * 1000;
const giveUpAlertPrefix = '⚠️ The AI could not finish request';

function getSettingsFilePath(): string {
  return path.join(path.dirname(getLayout().envFile), isolatedSettingsFileName);
}

/** A hand edit the way an editor saves it: a new file renamed over the old, so the bot's change stamp moves. */
function writeSettingsFileByHand(settings: object): void {
  const tempPath = `${getSettingsFilePath()}.by-hand`;
  fs.writeFileSync(tempPath, `${JSON.stringify(settings)}\n`);
  fs.renameSync(tempPath, getSettingsFilePath());
}

/** The wait list as `state.json` holds it: the issue keys, in order (a Jira conversation's thread IS its issue key). */
function readPersistedWaitList(): string[] {
  const persisted: { taskAgentWaitList?: TaskAgentWaitEntry[] } = JSON.parse(fs.readFileSync(path.join(getLayout().dataDir, 'state.json'), 'utf8'));
  return (persisted.taskAgentWaitList ?? []).map((entry) => entry.conversationKey.split(':').at(-1) ?? entry.conversationKey);
}

/** The requests `state.json` holds open. */
function readOpenRequests(): OpenRequestState[] {
  const persisted: { openRequests?: Record<string, OpenRequestState> } = JSON.parse(fs.readFileSync(path.join(getLayout().dataDir, 'state.json'), 'utf8'));
  return Object.values(persisted.openRequests ?? {});
}

function countSearches(): number {
  return fakeJira.requestLog.filter((request) => request === fakeJiraSearchRequest).length;
}

/** Wait until the instance polled `pollCount` more times: what a queued issue sat through without starting. */
function waitForPolls(pollCount: number): Promise<void> {
  const searchesBefore = countSearches();
  return waitFor(`${pollCount} more polls`, restartPollWaitMs + pollCount * 5_000, () => countSearches() >= searchesBefore + pollCount);
}

function getRequestOf(issueKey: string): ClosedRequestRecord {
  const requests = readClosedRequests().filter((record) => record.origin.attributes.issueKey === issueKey);
  assert.equal(requests.length, 1, `${issueKey}: one request in the history`);
  return requests[0];
}

/** The most hand-overs that were open at the same moment, by the request history. */
function getMaxOverlap(intervals: ReadonlyArray<{ from: number; to: number }>): number {
  const edges = intervals.flatMap(({ from, to }) => [{ at: from, change: 1 }, { at: to, change: -1 }]);
  // At one instant a close counts before an open: a slot freed at that moment is what the next one takes.
  edges.sort((left, right) => left.at - right.at || left.change - right.change);
  let open = 0;
  let most = 0;
  for (const edge of edges) {
    open += edge.change;
    most = Math.max(most, open);
  }
  return most;
}

describe('The cap on task agents on a Jira-only instance: built charness, fake Jira, fake claude (D10)', () => {
  registerJiraFlowHooks({ layoutPrefix: 'charness-j-slots-', config: { adapter: 'claude-json-stream' } });

  itHoldsIsolationBeforeBoot();

  it(`boots Jira-only with settings.json capping the task agents at ${maxConcurrent}`, async () => {
    writeSettingsFileByHand({ ...isolatedBaselineSettings, taskAgents: { maxConcurrent } });
    createIssue('PROJ-1', 'hold-once');
    createIssue('PROJ-2', 'hang-once');
    createIssue('PROJ-3', 'answer');
    createIssue('PROJ-4', 'answer');
    createIssue('PROJ-5', 'answer');
    await bootJiraOnly();
  });

  it('two hand-overs fill the two slots: both agents work', async () => {
    handIssueToAi('PROJ-1', requester);
    handIssueToAi('PROJ-2', requester);
    await waitFor('both agents\' turns under way', answerTimeoutMs, () => getTurns('PROJ-1').length === 1 && getTurns('PROJ-2').length === 1);
    assert.deepEqual(readPersistedWaitList(), []);
    for (const issueKey of ['PROJ-1', 'PROJ-2']) assert.deepEqual(getCommentTexts(fakeJira.getIssue(issueKey)), [], `${issueKey} is worked on: no notice`);
  });

  it('the third and the fourth wait: ONE comment each saying so, the issue stays with the AI, no request and no agent — poll after poll', async () => {
    handIssueToAi('PROJ-3', requester);
    await waitFor('PROJ-3\'s queued comment', answerTimeoutMs, () => fakeJira.getIssue('PROJ-3').comments.length === 1);
    handIssueToAi('PROJ-4', requester);
    await waitFor('PROJ-4\'s queued comment', answerTimeoutMs, () => fakeJira.getIssue('PROJ-4').comments.length === 1);
    assert.deepEqual(getCommentTexts(fakeJira.getIssue('PROJ-3')), [buildJiraQueuedText(maxConcurrent, 0)]);
    assert.deepEqual(getCommentTexts(fakeJira.getIssue('PROJ-4')), [buildJiraQueuedText(maxConcurrent, 1)]);
    assert.match(getCommentTexts(fakeJira.getIssue('PROJ-3'))[0], /it is next in line/);
    assert.match(getCommentTexts(fakeJira.getIssue('PROJ-4'))[0], /1 issue is ahead of it/);

    await waitForPolls(quietPollCount);
    for (const issueKey of ['PROJ-3', 'PROJ-4']) {
      assert.equal(fakeJira.getIssue(issueKey).assignee?.accountId, aiAccount.accountId, `${issueKey} is still the AI's: nothing was handed back`);
      assert.equal(fakeJira.getIssue(issueKey).comments.length, 1, `${issueKey}: told once, not at every poll`);
      assert.deepEqual(getTurns(issueKey), [], `${issueKey}: no agent started`);
      assert.deepEqual(getPrompts(issueKey), [], `${issueKey}: nothing was posted to a session`);
      assert.equal(readClosedRequests().filter((record) => record.origin.attributes.issueKey === issueKey).length, 0);
    }
    const decisions = getPolledDecisions(getCharness().output).filter(({ issueKey }) => issueKey === 'PROJ-3' || issueKey === 'PROJ-4');
    assert.deepEqual(decisions, [{ issueKey: 'PROJ-3', decision: 'queued' }, { issueKey: 'PROJ-4', decision: 'queued' }], 'named once each; the polls that follow log nothing of them');
    assert.deepEqual(readPersistedWaitList(), ['PROJ-3', 'PROJ-4'], 'the list, in order, is on disk');
  });

  it('a restart keeps the list and the order, tells nobody again, and the adopted agents still hold their slots', async () => {
    const commentsBefore = ['PROJ-3', 'PROJ-4'].map((issueKey) => fakeJira.getIssue(issueKey).comments.length);
    await getCharness().stop();
    assert.deepEqual(readPersistedWaitList(), ['PROJ-3', 'PROJ-4'], 'the list survived the stop');
    await startCharness();
    await waitForPolls(quietPollCount);
    assert.deepEqual(readPersistedWaitList(), ['PROJ-3', 'PROJ-4'], 'and the start');
    assert.deepEqual(['PROJ-3', 'PROJ-4'].map((issueKey) => fakeJira.getIssue(issueKey).comments.length), commentsBefore, 'nobody is told a second time');
    for (const issueKey of ['PROJ-3', 'PROJ-4']) assert.deepEqual(getTurns(issueKey), [], `${issueKey} still waits: the two slots are still taken`);
  });

  it('the first agent hands back: the issue that waited longest starts, the next one keeps waiting for the next slot', async () => {
    releaseHeldTurn();
    await waitFor('PROJ-1 answered and handed back', answerTimeoutMs, () => fakeJira.getIssue('PROJ-1').assignee?.accountId === requester.accountId);
    await waitFor('PROJ-3 answered and handed back', answerTimeoutMs, () => fakeJira.getIssue('PROJ-3').assignee?.accountId === requester.accountId);
    assert.deepEqual(getCommentTexts(fakeJira.getIssue('PROJ-3')), [buildJiraQueuedText(maxConcurrent, 0), 'Fake final answer for PROJ-3 (answer, turn 1).']);
    assert.equal(countAssigneeChanges('PROJ-3'), 1, 'handed back once, by its answer');
    // PROJ-2 never ends, so PROJ-4 had only the slot PROJ-3 gave back to wait for.
    await waitFor('PROJ-4 answered and handed back', answerTimeoutMs, () => fakeJira.getIssue('PROJ-4').assignee?.accountId === requester.accountId);
    assert.deepEqual(getCommentTexts(fakeJira.getIssue('PROJ-4')), [buildJiraQueuedText(maxConcurrent, 1), 'Fake final answer for PROJ-4 (answer, turn 1).']);
    // state.json is saved a moment after the change: the read waits for the state it expects, it does not race the save.
    await waitFor('the list empty on disk and PROJ-2 the only open request', answerTimeoutMs, () => readPersistedWaitList().length === 0 && readOpenRequests().length === 1);

    const [first, third, fourth] = ['PROJ-1', 'PROJ-3', 'PROJ-4'].map(getRequestOf);
    assert.ok(third.createdAt >= first.closedAt, 'PROJ-3 started only once PROJ-1\'s slot was free');
    assert.ok(fourth.createdAt >= third.closedAt, 'PROJ-4 started only once PROJ-3\'s slot was free (PROJ-2 still holds the other)');
    assert.ok(third.createdAt < fourth.createdAt, 'first in, first out');
  });

  it('at no moment did more than two hand-overs run at once', () => {
    // PROJ-2's request never closes: it is in the open set, and holds its slot to the end.
    const intervals = [
      ...readClosedRequests().map((record) => ({ from: record.createdAt, to: record.closedAt })),
      ...readOpenRequests().map((request) => ({ from: request.createdAt, to: Number.MAX_SAFE_INTEGER })),
    ];
    assert.equal(intervals.length, 4, 'PROJ-1, PROJ-3 and PROJ-4 closed, PROJ-2 open');
    assert.ok(getMaxOverlap(intervals) <= maxConcurrent, `${getMaxOverlap(intervals)} hand-overs at once`);
    assert.equal(getMaxOverlap(intervals), maxConcurrent, 'and the cap was reached: the two slots were both in use');
  });

  it('a hand edit of settings.json to «no limit» applies with no restart: a hand-over waiting for the full slots starts at once', async () => {
    createIssue('PROJ-6', 'hold-once');
    handIssueToAi('PROJ-6', requester);
    await waitFor('PROJ-6\'s agent under way (the second slot again)', answerTimeoutMs, () => getTurns('PROJ-6').length === 1);
    handIssueToAi('PROJ-5', requester);
    await waitFor('PROJ-5\'s queued comment', answerTimeoutMs, () => fakeJira.getIssue('PROJ-5').comments.length === 1);
    assert.deepEqual(getTurns('PROJ-5'), []);
    const bootsBefore = getCharness().output.split('[jira] polling PROJ every').length;

    writeSettingsFileByHand({ ...isolatedBaselineSettings, taskAgents: { maxConcurrent: 0 } });
    await waitFor('PROJ-5 answered and handed back, no slot having freed', answerTimeoutMs, () => fakeJira.getIssue('PROJ-5').assignee?.accountId === requester.accountId);
    assert.equal(getCharness().output.split('[jira] polling PROJ every').length, bootsBefore, 'the bot was not restarted');
    await waitFor('the list empty on disk', answerTimeoutMs, () => readPersistedWaitList().length === 0);
  });

  it('a conversation handed over again after its idle stop waits for a slot like any other, and resumes its own session when it gets one', async () => {
    writeSettingsFileByHand({ ...isolatedBaselineSettings, taskAgents: { maxConcurrent } });
    const [earlierTurn] = getTurns('PROJ-3');
    await waitFor('PROJ-3\'s process stopped at its idle mark', idleStopTimeoutMs, () => !checkIsProcessAlive(earlierTurn.pid));
    // PROJ-2 and PROJ-6 hold the two slots again.
    handIssueToAi('PROJ-3', requester);
    await waitFor('PROJ-3\'s second queued comment', answerTimeoutMs, () => fakeJira.getIssue('PROJ-3').comments.length === 3);
    assert.equal(getCommentTexts(fakeJira.getIssue('PROJ-3')).at(-1), buildJiraQueuedText(maxConcurrent, 0));
    await waitForPolls(quietPollCount);
    assert.equal(getTurns('PROJ-3').length, 1, 'no second turn while the slots are taken');

    releaseHeldTurn();
    await waitFor('PROJ-3 answered again and handed back', answerTimeoutMs, () => getTurns('PROJ-3').length === 2 && fakeJira.getIssue('PROJ-3').assignee?.accountId === requester.accountId);
    const resumedTurn = getTurns('PROJ-3')[1];
    assert.notEqual(resumedTurn.pid, earlierTurn.pid, 'a new process');
    assert.deepEqual(getFlagValues(getSessionLaunchOf(resumedTurn.pid)?.argv ?? [], '--resume'), [getLaunchSessionId(getSessionLaunchOf(earlierTurn.pid)?.argv ?? [])], 'the same conversation, resumed');
    assert.ok(resumedTurn.requestId !== null && fakeJira.getIssue('PROJ-6').assignee?.accountId === requester.accountId, 'it started when PROJ-6 handed back');
  });

  it('a hand-over the wake-up engine gives up on holds no slot any more: the alert is out, the issue is handed back, and the issue waiting for the slot starts AT ONCE, the next regular poll being ten minutes away', async () => {
    // PROJ-2 still holds one slot; PROJ-7 never answers (every turn ends silent) and takes the other, so PROJ-8 has to wait. Both are
    // handed over while the bot is down, PROJ-7 first (the poll takes the oldest first): the boot poll starts the one and queues the
    // other, and the poll after it is `stretchedPollSeconds` off — only the give-up's wake can start PROJ-8 within this step's waits.
    createIssue('PROJ-7', 'silent');
    createIssue('PROJ-8', 'answer');
    await getCharness().stop();
    handIssueToAi('PROJ-7', requester);
    handIssueToAi('PROJ-8', requester);
    await startCharnessWithPoll(stretchedPollSeconds);
    try {
      await waitFor('PROJ-8\'s queued comment', answerTimeoutMs, () => fakeJira.getIssue('PROJ-8').comments.length === 1);
      await waitFor('PROJ-7\'s first turn', answerTimeoutMs, () => getTurns('PROJ-7').length >= 1);
      assert.deepEqual(getTurns('PROJ-8'), [], 'PROJ-8 waits while PROJ-7 holds the slot');

      // The rules give up after two turns without an answer: the alert is the comment, the issue goes back — and the slot is free.
      await waitFor('PROJ-7\'s alert and hand-back', resumeTimeoutMs, () =>
        getCommentTexts(fakeJira.getIssue('PROJ-7')).some((text) => text.startsWith(giveUpAlertPrefix))
        && fakeJira.getIssue('PROJ-7').assignee?.accountId === requester.accountId);
      await waitFor('PROJ-8 answered and handed back', answerTimeoutMs, () => fakeJira.getIssue('PROJ-8').assignee?.accountId === requester.accountId);
      assert.deepEqual(getCommentTexts(fakeJira.getIssue('PROJ-8')), [buildJiraQueuedText(maxConcurrent, 0), 'Fake final answer for PROJ-8 (answer, turn 1).']);
      // The given-up request is still open — nothing closed it — and it is what freed the slot.
      await waitFor('the given-up request marked in state.json', answerTimeoutMs, () =>
        readOpenRequests().some((request) => request.origin.attributes.issueKey === 'PROJ-7' && request.isWakeStopped));

      // No regular poll was due for ten minutes, so the start came from the give-up's own wake-up: it follows the alert within seconds.
      const alertIndex = getCommentTexts(fakeJira.getIssue('PROJ-7')).findIndex((text) => text.startsWith(giveUpAlertPrefix));
      const alertedAt = Date.parse(fakeJira.getIssue('PROJ-7').comments[alertIndex].created);
      const startedAt = getRequestOf('PROJ-8').createdAt;
      assert.ok(startedAt - alertedAt < wakeStartMaxMs, `PROJ-8 started ${startedAt - alertedAt} ms after the give-up's alert`);
    } finally {
      // The steps after this one hand issues over and wait on polls of seconds.
      await getCharness().stop();
      await startCharnessWithPoll(null);
    }
  });

  itHoldsTheInstanceInvariants();
});
