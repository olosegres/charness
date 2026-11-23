/**
 * @description The Jira connector end to end, at PROCESS level: ONE progress comment per request. The BUILT charness serving
 * Jira only, with a `trustedGroup` (so the comment scan of an issue handed to the AI runs, which is what an edit by the AI account
 * could set off), against the fake Jira — which serves `PUT …/comment/{id}` like Jira (the edit's text, `updated` and `updateAuthor`
 * change, the issue's `updated` moves) — and the fake `claude`, whose `progress-edits` mode sends three `progress` notes, held
 * apart by the test, and a `final` answer (`jiraE2e/jiraFlowKit.ts`). One flow, in order:
 *
 *   isolation checked before the boot
 *   → progress → progress → progress → final: the first note is a comment, the next two EDIT it (to the newest text, ending
 *     with a line saying when it was updated; the edit notifies nobody), the final answer is a second comment and hands the
 *     issue back; between the notes the polls read the issue's comments — the edit moved the issue's `updated` — and decide
 *     NOTHING: no update for the agent, no request, no comment decision (an edit by the AI account triggers nothing); the
 *     comment's id is on disk, and let go with the final answer
 *   → the edit is refused (the comment is gone): the next note is a NEW comment with the newest text, and the one after edits THAT one
 *   → a person comments between two notes (an issue update reaches the request): the next note is a NEW comment below theirs, never a
 *     silent edit above it, and the note after it edits that one
 *   → charness restarted between two notes: the next note edits the SAME comment
 *   → no Telegram path was reached
 *
 * Nothing leaves the machine; everything the test starts is stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { fakeJiraSearchRequest } from './jiraE2e/fakeJira';
import { getPolledDecisions, getPolledRequestIssueKeys } from './jiraE2e/charnessLog';
import { fakeProgressEditsBody } from './jiraE2e/fakeClaudeContract';
import { jiraProgressCommentsFileName } from '../connectors/jira/progressComments';
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
  getCommentTexts,
  getLayout,
  getPrompts,
  getTurns,
  handIssueToAi,
  itHoldsIsolationBeforeBoot,
  itReachedNoTelegramPath,
  readClosedRequests,
  registerJiraFlowHooks,
  releaseHeldTurn,
  requester,
  restartPollWaitMs,
  startCharness,
  trustedGroupName,
  waitFor,
} from './jiraE2e/jiraFlowKit';

const updatedLineSuffix = /\nLast updated \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/;

/** Wait for the instance's next `pollCount` polls to END (each is a search, and the next starts a poll interval after it). */
async function waitForPolls(pollCount: number): Promise<void> {
  const searchesBefore = fakeJira.requestLog.filter((request) => request === fakeJiraSearchRequest).length;
  await waitFor(`${pollCount} more polls`, restartPollWaitMs, () => fakeJira.requestLog.filter((request) => request === fakeJiraSearchRequest).length >= searchesBefore + pollCount);
}

/** How many times the polls (or the sink) read the issue's comments as a list — what an issue that changed is scanned with. */
function countCommentListReads(issueKey: string): number {
  return fakeJira.requestLog.filter((request) => request === `GET /rest/api/3/issue/${issueKey}/comment`).length;
}

function countRequests(method: string, issueKey: string, commentId?: string): number {
  const route = commentId === undefined ? `${method} /rest/api/3/issue/${issueKey}/comment` : `${method} /rest/api/3/issue/${issueKey}/comment/${commentId}`;
  return fakeJira.requestLog.filter((request) => request === route).length;
}

/** The decisions the polls logged for the issue's comments (`KEY#comment:<id>`, `KEY#mention:<id>`): none, while nobody but the AI account commented. */
function listCommentDecisionsOf(issueKey: string): Array<{ issueKey: string; decision: string }> {
  return getPolledDecisions(getCharness().output).filter((entry) => entry.issueKey.startsWith(`${issueKey}#`));
}

describe('Jira connector end to end — one progress comment per request, edited by the next progress answer: built charness, fake Jira, fake claude', () => {
  registerJiraFlowHooks({
    layoutPrefix: 'charness-j-progress-',
    config: { adapter: 'claude-json-stream', trustedGroup: trustedGroupName, backstopMinutes: '60' },
  });

  itHoldsIsolationBeforeBoot();

  it('boots Jira-only with a trusted group, so the comment scan of a handed issue runs', async () => {
    fakeJira.addGroup(trustedGroupName, [requester, colleague]);
    await bootJiraOnly();
  });

  it('progress → progress → progress → final is two comments, the first edited twice; an edit by the AI account moves the issue and triggers nothing', async () => {
    const issueKey = 'PROJ-50';
    createIssue(issueKey, 'progress-edits');
    handIssueToAi(issueKey, requester);
    const issue = fakeJira.getIssue(issueKey);
    await waitFor(`${issueKey}: the first progress note commented`, answerTimeoutMs, () => issue.comments.length === 1);
    const [progressComment] = issue.comments;
    assert.deepEqual(getCommentTexts(issue), [fakeProgressEditsBody(issueKey, 1)], 'the first note, as it is: no line about an update yet');
    assert.equal(issue.assignee?.accountId, aiAccount.accountId, 'a progress note hands nothing back');
    // The post moved the issue: the polls read its comments once and decide nothing — the comment is the AI account's own.
    await waitForPolls(3);
    assert.equal(getTurns(issueKey).length, 1, 'the agent is held on its first turn');

    const readsBeforeEdit = countCommentListReads(issueKey);
    releaseHeldTurn();
    await waitFor(`${issueKey}: note 2 edited into the first comment`, answerTimeoutMs, () => issue.comments[0].updated !== undefined);
    assert.equal(issue.comments.length, 1, 'edited, not posted again');
    assert.equal(issue.comments[0].id, progressComment.id);
    assert.match(getCommentTexts(issue)[0], new RegExp(`^${fakeProgressEditsBody(issueKey, 2).replace('.', '\\.')}`));
    assert.match(getCommentTexts(issue)[0], updatedLineSuffix, 'a line saying when it was updated, after the text');
    assert.equal(issue.comments[0].updateAuthor?.accountId, aiAccount.accountId, 'edited by the AI account itself');
    assert.deepEqual(fakeJira.editRequests.filter((edit) => edit.issueKey === issueKey), [{ issueKey, commentId: progressComment.id, notifyUsers: 'false' }], 'one edit, which notifies nobody');
    // The edit moved the issue's `updated`: the next polls scan its comments again — and find nothing to wake anyone with.
    await waitFor(`${issueKey}: the polls read the edited issue`, restartPollWaitMs, () => countCommentListReads(issueKey) > readsBeforeEdit);
    await waitForPolls(3);
    assert.equal(getTurns(issueKey).length, 1, 'no issue update, no request: the edit woke nothing');
    assert.equal(getPrompts(issueKey).length, 1);
    assert.deepEqual(listCommentDecisionsOf(issueKey), [], 'no comment decision: the AI account\'s own comment is never decided');
    assert.equal(issue.comments.length, 1);

    releaseHeldTurn();
    await waitFor(`${issueKey}: answered and handed back`, answerTimeoutMs, () => issue.assignee?.accountId === requester.accountId && getAnswers(issueKey).length === 4);
    assert.deepEqual(getAnswers(issueKey).map((answer) => answer.kind), ['progress', 'progress', 'progress', 'final']);
    assert.equal(issue.comments.length, 2, 'two comments in all: the progress note, edited, and the final answer');
    assert.equal(issue.comments[0].id, progressComment.id);
    assert.match(getCommentTexts(issue)[0], new RegExp(`^${fakeProgressEditsBody(issueKey, 3).replace('.', '\\.')}`), 'the newest note');
    assert.match(getCommentTexts(issue)[0], updatedLineSuffix);
    assert.equal(getCommentTexts(issue)[1], `Fake final answer for ${issueKey} (progress-edits, turn 1).`, 'the final answer is a new comment');
    assert.equal(countRequests('POST', issueKey), 2);
    assert.equal(countRequests('PUT', issueKey, progressComment.id), 2);
    assert.equal(countAssigneeChanges(issueKey), 1, 'one hand-back, with the final answer');
    assert.deepEqual(readClosedRequests().filter((record) => record.origin.attributes.issueKey === issueKey).map((record) => record.closeReason), ['final']);
    assert.equal(getTurns(issueKey).length, 1, 'one turn from start to end');
    assert.deepEqual(getPolledRequestIssueKeys(getCharness().output).filter((key) => key === issueKey), [issueKey], 'one request');
    assert.deepEqual(listCommentDecisionsOf(issueKey), []);

    // On disk: the comment the request kept up to date, and let go with the final answer.
    const lines = fs.readFileSync(path.join(getLayout().dataDir, jiraProgressCommentsFileName), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { commentId: string | null; slot: string });
    assert.deepEqual(lines.map((line) => [line.slot, line.commentId]), [['progress', progressComment.id], ['progress', null]]);
  });

  it('an edit Jira refuses (the comment is gone): the next note is a NEW comment with the newest text — and the note after it edits that one', async () => {
    const issueKey = 'PROJ-51';
    createIssue(issueKey, 'progress-edits');
    handIssueToAi(issueKey, requester);
    const issue = fakeJira.getIssue(issueKey);
    await waitFor(`${issueKey}: the first progress note commented`, answerTimeoutMs, () => issue.comments.length === 1);
    const [firstComment] = issue.comments;
    fakeJira.editRefusals.push(404);
    releaseHeldTurn();
    await waitFor(`${issueKey}: note 2 posted as a new comment`, answerTimeoutMs, () => issue.comments.length === 2);
    assert.deepEqual(getCommentTexts(issue), [fakeProgressEditsBody(issueKey, 1), fakeProgressEditsBody(issueKey, 2)], 'the text was not lost; a new comment carries no updated line');
    const secondComment = issue.comments[1];
    assert.deepEqual(fakeJira.editRequests.filter((edit) => edit.issueKey === issueKey).map((edit) => edit.commentId), [firstComment.id], 'the refused edit');

    releaseHeldTurn();
    await waitFor(`${issueKey}: answered and handed back`, answerTimeoutMs, () => issue.assignee?.accountId === requester.accountId && getAnswers(issueKey).length === 4);
    assert.equal(issue.comments.length, 3, 'the old progress comment, the one that took over, the final answer');
    assert.equal(getCommentTexts(issue)[0], fakeProgressEditsBody(issueKey, 1), 'the old one is left as it was');
    assert.match(getCommentTexts(issue)[1], new RegExp(`^${fakeProgressEditsBody(issueKey, 3).replace('.', '\\.')}`), 'note 3 edited the new comment');
    assert.match(getCommentTexts(issue)[1], updatedLineSuffix);
    assert.deepEqual(fakeJira.editRequests.filter((edit) => edit.issueKey === issueKey).map((edit) => edit.commentId), [firstComment.id, secondComment.id]);
    assert.equal(countRequests('POST', issueKey), 3);
    assert.equal(getTurns(issueKey).length, 1);
  });

  it('a person comments between two progress notes: the next note is a NEW comment below theirs — never a silent edit above it — and the note after it edits that one', async () => {
    const issueKey = 'PROJ-53';
    createIssue(issueKey, 'progress-after-update');
    handIssueToAi(issueKey, requester);
    const issue = fakeJira.getIssue(issueKey);
    await waitFor(`${issueKey}: the first progress note commented`, answerTimeoutMs, () => issue.comments.length === 1);
    assert.equal(issue.assignee?.accountId, aiAccount.accountId, 'the request is open and the issue still handed to the AI');
    const [firstTurn] = getTurns(issueKey);

    const personsText = 'Also check the totals row, please.';
    const personsCommentId = fakeJira.addComment(issueKey, colleague, personsText);
    await waitFor(`${issueKey}: answered and handed back`, answerTimeoutMs, () => issue.assignee?.accountId === requester.accountId && getAnswers(issueKey).length === 4);
    // The person's comment reached the SAME request as an issue update, and nothing else opened one.
    const turns = getTurns(issueKey);
    assert.equal(turns.length, 2);
    assert.equal(turns[1].requestId, firstTurn.requestId);
    assert.equal(turns[1].isRequestPrompt, false, 'an update, not a request\'s prompt');
    assert.ok(getPrompts(issueKey)[1].text.includes(`comment ${personsCommentId} by Colleague`), getPrompts(issueKey)[1].text);
    assert.deepEqual(getAnswers(issueKey).map((answer) => answer.kind), ['progress', 'progress', 'progress', 'final']);

    // Four comments in the order of the issue: note 1, the person's, the notes after it as ONE comment, the final answer.
    const texts = getCommentTexts(issue);
    assert.equal(issue.comments.length, 4, texts.join(' | '));
    assert.equal(texts[0], fakeProgressEditsBody(issueKey, 1), 'note 1 was never edited');
    assert.equal(issue.comments[0].updated, undefined);
    assert.equal(texts[1], personsText);
    assert.match(texts[2], new RegExp(`^${fakeProgressEditsBody(issueKey, 3).replace('.', '\\.')}`), 'note 2 was a new comment below the person\'s; note 3 edited it');
    assert.match(texts[2], updatedLineSuffix);
    assert.equal(texts[3], `Fake final answer for ${issueKey} (progress-after-update, turn 2).`);
    assert.deepEqual(fakeJira.editRequests.filter((edit) => edit.issueKey === issueKey).map((edit) => edit.commentId), [issue.comments[2].id], 'one edit: of the new comment, not of note 1');
    assert.equal(countRequests('POST', issueKey), 3, 'note 1, note 2, the final answer');
    assert.equal(countAssigneeChanges(issueKey), 1);
  });

  it('charness restarted between two progress notes: the next note edits the SAME comment — it is remembered on disk', async () => {
    const issueKey = 'PROJ-52';
    createIssue(issueKey, 'progress-edits');
    handIssueToAi(issueKey, requester);
    const issue = fakeJira.getIssue(issueKey);
    await waitFor(`${issueKey}: the first progress note commented`, answerTimeoutMs, () => issue.comments.length === 1);
    const [progressComment] = issue.comments;
    const [agentTurn] = getTurns(issueKey);
    assert.ok(checkIsProcessAlive(agentTurn.pid), 'the agent, held on its turn, outlives the bot\'s restart');

    await getCharness().stop();
    await startCharness();
    assert.ok(checkIsProcessAlive(agentTurn.pid), 'adopted, not stopped');
    await waitForPolls(2);
    assert.equal(getTurns(issueKey).length, 1, 'the restart opened no request a second time');

    releaseHeldTurn();
    await waitFor(`${issueKey}: note 2 edited into the first comment, after the restart`, answerTimeoutMs, () => issue.comments[0].updated !== undefined);
    assert.equal(issue.comments.length, 1, 'edited, not posted again');
    assert.equal(issue.comments[0].id, progressComment.id);
    assert.match(getCommentTexts(issue)[0], new RegExp(`^${fakeProgressEditsBody(issueKey, 2).replace('.', '\\.')}`));
    assert.deepEqual(fakeJira.editRequests.filter((edit) => edit.issueKey === issueKey).map((edit) => edit.commentId), [progressComment.id]);

    releaseHeldTurn();
    await waitFor(`${issueKey}: answered and handed back`, answerTimeoutMs, () => issue.assignee?.accountId === requester.accountId && getAnswers(issueKey).length === 4);
    assert.equal(issue.comments.length, 2, 'the progress note, edited, and the final answer');
    assert.match(getCommentTexts(issue)[0], new RegExp(`^${fakeProgressEditsBody(issueKey, 3).replace('.', '\\.')}`));
    assert.equal(getTurns(issueKey).length, 1);
  });

  itReachedNoTelegramPath();
});
