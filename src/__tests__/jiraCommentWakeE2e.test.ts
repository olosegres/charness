/**
 * @description The Jira connector end to end, at PROCESS level: what reaches an agent besides a hand-over. The BUILT
 * charness serving Jira only, with a `trustedGroup` (so `wakeOnComment` is on by default), `mentionMode: "act"` and the
 * request backstop set to an hour, against the fake Jira and the fake `claude` (`jiraE2e/jiraFlowKit.ts`). One flow, in
 * order:
 *
 *   isolation checked before the boot; the boot says comments on a handed issue reach its agent and mentions act
 *   → a member comments on a handed issue while its agent is mid-turn: the comment waits for the turn, reaches the SAME
 *     request as an issue update (no request is opened), and the agent's final answer hands the issue back once
 *   → a member comments on an issue still handed to the AI after the final answer (its hand-back was refused): a new
 *     request of the commenter's, answered — and handed back to them
 *   → an @-mention on an issue NOT handed to the AI, act mode: the prompt carries the act note, the answer is a comment
 *     and nothing is handed back
 *   → charness and the agent killed mid-turn, charness started again with the backstop an hour away: the open request is
 *     woken at once (`restarted`) and answered within a minute — not by the backstop
 *   → the instance invariants (R11, R32, R6, the private tmux server)
 *
 * Nothing leaves the machine; everything the test starts is stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import { fakeClaudePath } from './e2e/isolatedCharness';
import { fakeJiraSearchRequest } from './jiraE2e/fakeJira';
import { getPolledDecisions } from './jiraE2e/charnessLog';
import { jiraCommentWakeOnLogLine, jiraMentionWakeActLogLine } from '../connectors/jira/connector';
import { requestRequesterAttribute } from '../requests/requestGroup';
import {
  aiAccount,
  answerTimeoutMs,
  automation,
  bootJiraOnly,
  colleague,
  countAssigneeChanges,
  createIssue,
  fakeJira,
  getAnswers,
  getCharness,
  getCommentTexts,
  getPrompts,
  getPromptsOfRequest,
  getTurns,
  handIssueToAi,
  itHoldsIsolationBeforeBoot,
  itHoldsTheInstanceInvariants,
  readClosedRequests,
  registerJiraFlowHooks,
  releaseHeldTurn,
  requester,
  startCharness,
  toDo,
  trustedGroupName,
  waitFor,
} from './jiraE2e/jiraFlowKit';

/** The request backstop of this flow: far beyond every wait below, so nothing in it can be the backstop's doing. */
const backstopMinutes = '60';
/** The stagger of the wakes after a restart, shortened from 30 s: the first wake follows the boot by this much. */
const restartWakeStaggerMs = 3_000;

/** The decisions the polls logged for the issue's comments and mentions (`KEY#comment:<id>`, `KEY#mention:<id>`), in order. */
function listCommentDecisionsOf(issueKey: string): Array<{ issueKey: string; decision: string }> {
  return getPolledDecisions(getCharness().output).filter((entry) => entry.issueKey.startsWith(`${issueKey}#`));
}

function getClosedRequestsOf(issueKey: string): ReturnType<typeof readClosedRequests> {
  return readClosedRequests().filter((record) => record.origin.attributes.issueKey === issueKey);
}

describe('Jira connector end to end — comments on a handed issue, an acting mention, the resume after a restart: built charness, fake Jira, fake claude', () => {
  registerJiraFlowHooks({
    layoutPrefix: 'charness-j-comment-wake-',
    config: {
      adapter: 'claude-json-stream',
      trustedGroup: trustedGroupName,
      mentionMode: 'act',
      backstopMinutes,
      extraTimings: { requestRestartWakeStaggerMs: restartWakeStaggerMs },
    },
  });

  itHoldsIsolationBeforeBoot();

  it('boots Jira-only: comments on a handed issue reach its agent (the default with a group), and mentions act on explicit asks', async () => {
    fakeJira.addGroup(trustedGroupName, [requester, colleague]);
    await bootJiraOnly();
    assert.equal(getCharness().output.split('\n').filter((line) => line === jiraCommentWakeOnLogLine).length, 1);
    assert.equal(getCharness().output.split('\n').filter((line) => line === jiraMentionWakeActLogLine).length, 1);
  });

  it('a member comments on a handed issue while its agent is mid-turn: the comment reaches the SAME request as an issue update after the turn — no request opened, the issue handed back once', async () => {
    const issueKey = 'PROJ-40';
    createIssue(issueKey, 'hold-progress-once');
    handIssueToAi(issueKey, requester);
    await waitFor(`${issueKey}: its first turn under way`, answerTimeoutMs, () => getTurns(issueKey).length === 1);
    const [firstTurn] = getTurns(issueKey);
    assert.ok(firstTurn.requestId, 'the hand-over reached the agent');

    const commentId = fakeJira.addComment(issueKey, colleague, 'Also export the totals row, please.');
    await waitFor(`${issueKey}: the comment decided as an update`, answerTimeoutMs, () =>
      listCommentDecisionsOf(issueKey).some((entry) => entry.issueKey === `${issueKey}#comment:${commentId}` && entry.decision === 'update'));
    assert.equal(getTurns(issueKey).length, 1, 'the update waits for the running turn: a comment never interrupts it');
    assert.equal(getPrompts(issueKey).length, 1);

    releaseHeldTurn();
    const issue = fakeJira.getIssue(issueKey);
    // The sink hands the issue back before the tool's result reaches the agent, which logs its answer only then: wait for both.
    await waitFor(`${issueKey}: answered and handed back`, answerTimeoutMs, () => issue.assignee?.accountId === requester.accountId && getAnswers(issueKey).length === 2);
    const turns = getTurns(issueKey);
    assert.equal(turns.length, 2);
    assert.equal(turns[1].requestId, firstTurn.requestId, 'the update\'s turn belongs to the same request');
    assert.equal(turns[1].isRequestPrompt, false, 'an update, not a request\'s prompt');
    const update = getPrompts(issueKey)[1].text;
    assert.ok(update.includes(`[Issue update · request ${firstTurn.requestId} is open]`), update);
    assert.ok(update.includes(`while you work on request ${firstTurn.requestId} (handed over by Requester): comment ${commentId} by Colleague.`), update);
    assert.ok(update.includes('> Also export the totals row, please.'), update);
    assert.deepEqual(getAnswers(issueKey).map((answer) => [answer.requestId, answer.kind]), [[firstTurn.requestId, 'progress'], [firstTurn.requestId, 'final']]);
    assert.deepEqual(getCommentTexts(issue).slice(-1), [`Fake final answer for ${issueKey} (hold-progress-once, turn 2).`]);
    assert.equal(countAssigneeChanges(issueKey), 1, 'one hand-back');
    const closed = getClosedRequestsOf(issueKey);
    assert.deepEqual(closed.map((record) => record.closeReason), ['final'], 'one request from start to end');
    assert.equal(closed[0].origin.attributes[requestRequesterAttribute], requester.accountId, 'still the requester\'s: the comment did not take it over');
  });

  it('a member comments on an issue still handed to the AI after its final answer (the hand-back was refused): a new request of the commenter\'s — answered, and handed back to them', async () => {
    const issueKey = 'PROJ-41';
    createIssue(issueKey, 'answer');
    fakeJira.refusedAssigneeIssueKeys.add(issueKey);
    handIssueToAi(issueKey, requester);
    const issue = fakeJira.getIssue(issueKey);
    await waitFor(`${issueKey}: answered`, answerTimeoutMs, () => getClosedRequestsOf(issueKey).length === 1 && issue.comments.length === 1);
    assert.equal(issue.assignee?.accountId, aiAccount.accountId, 'the hand-back was refused: the issue stays handed to the AI');
    fakeJira.refusedAssigneeIssueKeys.delete(issueKey);

    const commentId = fakeJira.addComment(issueKey, colleague, 'One more thing: the CSV needs a header row.');
    await waitFor(`${issueKey}: the comment's request answered and handed back to the commenter`, answerTimeoutMs, () =>
      getClosedRequestsOf(issueKey).length === 2 && issue.assignee?.accountId === colleague.accountId);
    assert.ok(listCommentDecisionsOf(issueKey).some((entry) => entry.issueKey === `${issueKey}#comment:${commentId}` && entry.decision === 'request'));
    const commentRequest = getClosedRequestsOf(issueKey)[1];
    assert.equal(commentRequest.origin.kind, 'trackerEvent');
    assert.equal(commentRequest.origin.attributes.triggerId, `comment:${commentId}`);
    assert.equal(commentRequest.origin.attributes[requestRequesterAttribute], colleague.accountId);
    assert.equal(commentRequest.closeReason, 'final');
    const prompt = getPrompts(issueKey)[1].text;
    assert.ok(prompt.includes(`[Request ${commentRequest.id} · from: ${issueKey}: Colleague commented (comment ${commentId})]`), prompt);
    assert.ok(prompt.includes('> One more thing: the CSV needs a header row.'), prompt);
  });

  it('act mode: a member\'s @-mention on an issue NOT handed to the AI — the prompt carries the act note, the answer is a comment, nothing is handed back', async () => {
    const issueKey = 'PROJ-42';
    fakeJira.createIssue({ key: issueKey, summary: `[fake:answer] Task ${issueKey}`, description: 'An epic to split.', statusId: toDo.id, reporter: requester });
    fakeJira.assignIssue(issueKey, requester, requester);
    const changesBefore = countAssigneeChanges(issueKey);
    const mentionId = fakeJira.addComment(issueKey, requester, 'please split this into stories and create them', { mentions: [aiAccount] });
    const issue = fakeJira.getIssue(issueKey);
    await waitFor(`${issueKey}: the mention answered`, answerTimeoutMs, () => getClosedRequestsOf(issueKey).length === 1 && issue.comments.length === 2);
    const [prompt] = getPrompts(issueKey);
    assert.ok(prompt.text.includes(`You were mentioned in comment ${mentionId} by Requester, a trusted account. The issue is not handed to you (assignee: Requester, status: To Do). `), prompt.text);
    assert.ok(prompt.text.includes('If the comment explicitly asks you to do something — create or split issues, take a transition, change the assignee, take up the work — do it as your rules allow'), prompt.text);
    assert.ok(!prompt.text.includes('Answer only'), prompt.text);
    const [mentionRequest] = getClosedRequestsOf(issueKey);
    assert.equal(mentionRequest.origin.kind, 'trackerMention');
    assert.equal(mentionRequest.origin.attributes.mayAct, 'true', 'an acting mention: it held a task-agent slot');
    assert.equal(issue.assignee?.accountId, requester.accountId);
    assert.equal(countAssigneeChanges(issueKey), changesBefore, 'nothing handed back');
    assert.equal(getCommentTexts(issue)[1], `@${requester.displayName}\nFake final answer for ${issueKey} (answer, turn 1).`);
  });

  it('an automation\'s comment on a handed issue wakes nothing: the only turn after the agent\'s progress note is the bot\'s nudge', async () => {
    const issueKey = 'PROJ-44';
    createIssue(issueKey, 'hold-progress-once');
    handIssueToAi(issueKey, requester);
    await waitFor(`${issueKey}: its first turn under way`, answerTimeoutMs, () => getTurns(issueKey).length === 1);
    const countSearches = (): number => fakeJira.requestLog.filter((request) => request === fakeJiraSearchRequest).length;
    const searchesBefore = countSearches();
    fakeJira.addComment(issueKey, automation, 'Build 42 passed.');
    await waitFor('two more polls', answerTimeoutMs, () => countSearches() >= searchesBefore + 2);
    assert.deepEqual(listCommentDecisionsOf(issueKey), [], 'no decision: an app\'s comment is no person\'s ask');
    releaseHeldTurn();
    // Its progress note leaves the request open with nothing armed: the bot's one nudge is the next turn (the backstop is an hour
    // away), never one the automation's comment started; the agent answers it.
    await waitFor(`${issueKey}: answered after the nudge`, answerTimeoutMs, () => getAnswers(issueKey).length === 2);
    const turns = getTurns(issueKey);
    assert.equal(turns.length, 2);
    assert.ok(getPromptsOfRequest(turns[0].requestId ?? '')[1]?.text.includes(`[Reminder · request ${turns[0].requestId} is still open]`), 'the second turn is the nudge');
    assert.deepEqual(getAnswers(issueKey).map((answer) => answer.kind), ['progress', 'final']);
    assert.deepEqual(listCommentDecisionsOf(issueKey), []);
  });

  it('charness and the agent killed mid-turn, charness started again with the backstop an hour away: the open request is woken at once and answered within a minute', async () => {
    const issueKey = 'PROJ-43';
    createIssue(issueKey, 'hang-once');
    handIssueToAi(issueKey, requester);
    await waitFor(`${issueKey}: its first turn under way`, answerTimeoutMs, () => getTurns(issueKey).length === 1);
    const [hangingTurn] = getTurns(issueKey);
    await getCharness().stop();
    const commandLinePath = `/proc/${hangingTurn.pid}/cmdline`;
    if (fs.existsSync('/proc/self')) {
      // Never a pid that has since gone to another process.
      assert.ok(fs.existsSync(commandLinePath) && fs.readFileSync(commandLinePath, 'utf8').includes(fakeClaudePath), 'the pid is still the fake agent');
    }
    process.kill(hangingTurn.pid, 'SIGKILL');

    const outputBefore = getCharness().output.length;
    const restartedAt = Date.now();
    await startCharness();
    const issue = fakeJira.getIssue(issueKey);
    await waitFor(`${issueKey}: answered after the restart`, answerTimeoutMs, () => issue.assignee?.accountId === requester.accountId);
    assert.ok(Date.now() - restartedAt < answerTimeoutMs, 'within a minute of the restart: the backstop is an hour away');
    const bootOutput = getCharness().output.slice(outputBefore);
    assert.match(bootOutput, new RegExp(`\\[requests\\] jira:PROJ:${issueKey}: its session did not come back with the boot while a request was open; its open request is woken shortly`));
    assert.match(bootOutput, new RegExp(`\\[requests\\] jira:PROJ:${issueKey}: woken after a restart for ${hangingTurn.requestId}`));
    const turns = getTurns(issueKey);
    assert.equal(turns.length, 2);
    assert.equal(turns[1].requestId, hangingTurn.requestId, 'the same request, resumed');
    assert.notEqual(turns[1].pid, hangingTurn.pid, 'in a new process');
    assert.deepEqual(getCommentTexts(issue), [`Fake final answer for ${issueKey} (hang-once, turn 2).`]);
  });

  itHoldsTheInstanceInvariants();
});
