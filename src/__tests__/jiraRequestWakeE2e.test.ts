/**
 * @description The Jira connector end to end, at PROCESS level: an issue's request is never reminded on a clock. The BUILT charness
 * serving Jira only — the request backstop an hour away, the wake-up engine's turn poll at 1 s and the progress follow-up shortened to
 * 15 s, so a reminder a topic's rules would arm comes well inside the windows below — against the fake Jira and the fake `claude`
 * (`jiraE2e/jiraFlowKit.ts`). One flow, in order:
 *
 *   isolation checked before the boot
 *   → a progress note with nothing armed (`progress`): ONE nudge at once — not the follow-up — saying nothing reminds on a clock and
 *     how to wait; the next turn ends the same way (another note): the alert comment, the issue handed back, nothing after it
 *   → a progress note with nothing armed, the nudge answered by arming a job and another note (`progress-then-armed`): the request
 *     waits for its schedule — no alert, the issue stays with the AI, nothing reaches the agent while the follow-up window passes
 *   → no Telegram path was reached
 *
 * The rule's branches are `wakeUpRules.test.ts` › "a tracker's rules", the engine's journeys `wakeUpEngine.test.ts` › "a tracker's
 * rules"; an agent that arms a worker watch at once and is woken by it is `jiraScheduleE2e.test.ts`, a request waiting on its job
 * through a restart with the backstop at 6 s `jiraConnectorE2e.test.ts` (PROJ-4). Nothing leaves the machine; everything the test
 * starts is stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildJiraAlertText } from '../connectors/jira/answerSink';
import { fakeJiraSearchRequest } from './jiraE2e/fakeJira';
import {
  aiAccount,
  answerTimeoutMs,
  bootJiraOnly,
  countAssigneeChanges,
  createIssue,
  fakeJira,
  getAnswers,
  getCharness,
  getCommentTexts,
  getPromptsOfRequest,
  getToolCalls,
  getTurns,
  handIssueToAi,
  itHoldsIsolationBeforeBoot,
  itReachedNoTelegramPath,
  registerJiraFlowHooks,
  requester,
  waitFor,
} from './jiraE2e/jiraFlowKit';

const msPerSecond = 1000;
/** The engine's turn poll in this flow: the nudge comes within a second of the turn end. */
const turnPollMs = msPerSecond;
/** A topic's follow-up after a progress note, shortened: a reminder on a clock would come this long after the note. */
const progressFollowUpMs = 15 * msPerSecond;
/** The window a reminder on a clock would have come in: two follow-up delays, counted in the instance's own Jira polls (2 s apart at least). */
const reminderWindowPolls = (2 * progressFollowUpMs) / (2 * msPerSecond);
/** What the bot's nudge says that no other reminder does. */
const nudgeLine = 'Nothing reminds you on a clock.';
const followUpLine = 'Some time has passed since your last progress note on it.';

function countSearches(): number {
  return fakeJira.requestLog.filter((request) => request === fakeJiraSearchRequest).length;
}

/** Let the window a reminder on a clock would come in pass: the instance's next {@link reminderWindowPolls} Jira polls. */
async function waitOutReminderWindow(): Promise<void> {
  const searchesBefore = countSearches();
  await waitFor(`${reminderWindowPolls} more polls`, answerTimeoutMs, () => countSearches() >= searchesBefore + reminderWindowPolls);
}

/** The request's prompt, then the bot's ONE nudge — which says how to wait, and is no follow-up on a clock. */
function assertOneNudge(requestId: string): void {
  const prompts = getPromptsOfRequest(requestId);
  assert.equal(prompts.length, 2, prompts.map((prompt) => prompt.text.slice(0, 80)).join(' | '));
  const nudge = prompts[1].text;
  assert.ok(nudge.includes(`[Reminder · request ${requestId} is still open]`), nudge);
  assert.ok(nudge.includes(nudgeLine), nudge);
  assert.ok(nudge.includes('arm a watch for it (schedule_create with a checkCommand)'), nudge);
  assert.ok(!nudge.includes(followUpLine), 'the nudge, not a follow-up');
}

describe('Jira connector end to end — a request is never reminded on a clock: built charness, fake Jira, fake claude', () => {
  registerJiraFlowHooks({
    layoutPrefix: 'charness-j-wake-',
    config: { adapter: 'claude-json-stream', backstopMinutes: '60', extraTimings: { requestTurnPollMs: turnPollMs, progressFollowUpMs } },
  });

  itHoldsIsolationBeforeBoot();

  it('boots Jira-only', async () => {
    await bootJiraOnly();
  });

  it('a progress note with nothing armed: ONE nudge at once, and the next turn that ends the same way — another note — gives the request up: the alert comment, the issue handed back', async () => {
    const issueKey = 'PROJ-71';
    createIssue(issueKey, 'progress');
    handIssueToAi(issueKey, requester);
    const issue = fakeJira.getIssue(issueKey);
    await waitFor(`${issueKey}: given up and handed back`, answerTimeoutMs, () => issue.assignee?.accountId === requester.accountId && issue.comments.length === 2);
    const turns = getTurns(issueKey);
    assert.deepEqual(turns.map((turn) => turn.isRequestPrompt), [true, false], 'the request, then the nudge');
    const requestId = turns[0].requestId ?? '';
    assertOneNudge(requestId);
    assert.deepEqual(getAnswers(issueKey).map((answer) => answer.kind), ['progress', 'progress']);
    const texts = getCommentTexts(issue);
    assert.ok(texts[0].startsWith(`Fake progress answer for ${issueKey} (progress, turn 2).`), 'one progress comment, edited by the second note');
    assert.equal(texts[1], buildJiraAlertText('silentTurns'));
    assert.equal(countAssigneeChanges(issueKey), 1, 'one hand-back, with the alert');
    assert.ok(getCharness().output.includes(`[jira] ${issueKey}: request ${requestId} given up (silentTurns); the alert comment is posted`));

    await waitOutReminderWindow();
    assert.equal(getTurns(issueKey).length, 2, 'given up: nothing wakes it again');
  });

  it('a progress note with nothing armed, the nudge answered by arming a job: the request waits for its schedule — no alert, the issue stays with the AI, nothing reaches the agent', async () => {
    const issueKey = 'PROJ-72';
    createIssue(issueKey, 'progress-then-armed');
    handIssueToAi(issueKey, requester);
    const issue = fakeJira.getIssue(issueKey);
    await waitFor(`${issueKey}: the nudge answered`, answerTimeoutMs, () => getAnswers(issueKey).length === 2);
    const turns = getTurns(issueKey);
    const requestId = turns[0].requestId ?? '';
    assertOneNudge(requestId);
    const armed = getToolCalls(issueKey).filter((call) => call.tool === 'schedule_create');
    assert.equal(armed.length, 1, 'the nudge\'s turn armed a job');
    assert.ok(!armed[0].outcome.startsWith('error:'), armed[0].outcome);

    await waitOutReminderWindow();
    assert.equal(getTurns(issueKey).length, 2, 'the job holds the request: no follow-up, no second nudge');
    assert.equal(issue.assignee?.accountId, aiAccount.accountId, 'not given up');
    assert.equal(getCommentTexts(issue).length, 1, 'the progress comment only: no alert');
  });

  itReachedNoTelegramPath();
});
