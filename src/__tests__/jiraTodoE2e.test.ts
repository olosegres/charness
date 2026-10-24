/**
 * @description The shared todo lists in Jira conversations end to end, at PROCESS level (shared todo registry plan S3,
 * D54–D58): the BUILT charness serving Jira only, its project listing a repository in `repos`, against the fake Jira and
 * the fake `claude` (`jiraE2e/jiraFlowKit.ts`), which publishes through the real bot MCP's `todo_update` when its prompt
 * carries todo tokens. One flow, in order:
 *
 *   isolation checked before the boot; the boot
 *   → a Jira conversation publishes: `todo_update` is offered to it and the list is the issue's
 *   → a second issue of the project (one repository): its prompt carries the board, naming the first issue by its key
 *     and summary, with its item in work
 *   → an agent that keeps working on its own (a background task) past the reminder's interval gets the standalone
 *     reminder at a turn end — and nothing of it reaches the issue: no comment, no hand-back, no request (D58)
 *   → the second issue's conversation, resumed after its idle stop, gets the whole board again (a stop is a fresh context)
 *   → the instance invariants (R11, R32, R6, the private tmux server)
 *
 * Nothing leaves the machine; everything the test starts is stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { fakeClaudeBackgroundReleaseFileName, fakeClaudeLogFileNames, type FakeClaudePrompt } from './jiraE2e/fakeClaudeContract';
import {
  answerTimeoutMs,
  bootJiraOnly,
  countAssigneeChanges,
  countClosedRequestsOf,
  createIssue,
  fakeJira,
  getCharness,
  getLayout,
  getToolCalls,
  getTurns,
  handOverAndAwaitAnswer,
  idleStopTimeoutMs,
  itHoldsIsolationBeforeBoot,
  itHoldsTheInstanceInvariants,
  readFakeLog,
  registerJiraFlowHooks,
  waitFor,
} from './jiraE2e/jiraFlowKit';

/** The repository the project's issues work on (`jira.json` `repos`). */
const repositoryName = 'example-repo';
/** The staleness reminder's interval and poll for this instance (production: 1 h and 10 s). */
const reminderIntervalMs = 3000;
const reminderPollMs = 500;
/** What the agent reads in a reminder. */
const reminderMarker = '[Todo] Your published todo list was last updated';

describe('Shared todo lists in Jira conversations: built charness, fake Jira, fake claude (S3, D54–D58)', () => {
  registerJiraFlowHooks({
    layoutPrefix: 'charness-jtodo-',
    config: { adapter: 'claude-json-stream', repos: [repositoryName], extraTimings: { todoReminderPollMs: reminderPollMs, todoReminderIntervalMs: reminderIntervalMs } },
  });

  itHoldsIsolationBeforeBoot();

  it('boots Jira-only', async () => {
    await bootJiraOnly();
  });

  it('a Jira conversation publishes: todo_update is offered to it and the list is the issue\'s', async () => {
    createIssue('PROJ-1', 'answer', ' [todo:inWork:Export to PDF]');
    await handOverAndAwaitAnswer('PROJ-1');
    const [call] = getToolCalls('PROJ-1').filter((candidate) => candidate.tool === 'todo_update');
    assert.ok(call, 'the agent called todo_update');
    assert.match(call.outcome, /^Saved\. New item: t1\.\n\nYour published todo list:\n▶ in work:\n {2}t1 Export to PDF/);
    const stored = JSON.parse(fs.readFileSync(path.join(getLayout().dataDir, 'todos', 'jira_PROJ_PROJ-1.json'), 'utf8')) as { items: Array<{ title: string }> };
    assert.deepEqual(stored.items.map((item) => item.title), ['Export to PDF']);
  });

  it('a second issue of the project: its prompt carries the board naming the first issue by key and summary', async () => {
    createIssue('PROJ-2', 'answer');
    const prompt = await handOverAndAwaitAnswer('PROJ-2');
    assert.match(prompt, new RegExp(`\\[Project board · ${repositoryName} · 1 other topic\\]\\nPROJ-1 «\\[fake:answer\\] Task PROJ-1» — [^\\n]*\\n {2}▶ Export to PDF — since \\d\\d:\\d\\d`));
  });

  it('an agent that works on its own past the interval gets the standalone reminder, and nothing of it reaches the issue (D58)', async () => {
    createIssue('PROJ-3', 'background-notify', ' [todo:inWork:Watch the build]');
    await handOverAndAwaitAnswer('PROJ-3');
    const [turn] = getTurns('PROJ-3');
    // Precondition: the turn of the update was seen ending — only work after it counts (D10).
    await waitFor('the clock started after the update', answerTimeoutMs, () => {
      const stored = JSON.parse(fs.readFileSync(path.join(getLayout().dataDir, 'todos', 'jira_PROJ_PROJ-3.json'), 'utf8')) as { nag?: { clockStartedAt?: number } };
      return stored.nag?.clockStartedAt !== undefined;
    });
    const commentsBefore = fakeJira.getIssue('PROJ-3').comments.length;
    const closedBefore = countClosedRequestsOf('PROJ-3');
    const handBacksBefore = countAssigneeChanges('PROJ-3');
    const outputStart = getCharness().output.length;
    fs.writeFileSync(path.join(getLayout().fakeStateDir, fakeClaudeBackgroundReleaseFileName), '');
    const readReminders = (): FakeClaudePrompt[] => readFakeLog<FakeClaudePrompt>(fakeClaudeLogFileNames.prompts).filter((prompt) => prompt.pid === turn.pid && prompt.text.includes(reminderMarker));
    await waitFor('the standalone reminder in PROJ-3\'s session', answerTimeoutMs, () => readReminders().length > 0);
    assert.equal(readReminders()[0].requestId, null, 'no request was opened for it');
    await waitFor('the bot\'s reminder line', answerTimeoutMs, () => /\[todos\] jira:PROJ:PROJ-3: stale list — reminded the agent/.test(getCharness().output.slice(outputStart)));
    // The reminder's turn answers in plain text ("Nothing to do."): a Jira conversation's plain text never becomes a comment.
    const remindedTurnsOf = (): number => readFakeLog<{ pid: number; requestId: string | null; origin?: string }>(fakeClaudeLogFileNames.turns)
      .filter((candidate) => candidate.pid === turn.pid && candidate.requestId === null && candidate.origin === undefined).length;
    await waitFor('the reminder\'s turn answered', answerTimeoutMs, () => remindedTurnsOf() > 0);
    assert.equal(fakeJira.getIssue('PROJ-3').comments.length, commentsBefore, 'no comment');
    assert.equal(countAssigneeChanges('PROJ-3'), handBacksBefore, 'no hand-back');
    assert.equal(countClosedRequestsOf('PROJ-3'), closedBefore, 'no request opened or closed');
  });

  it('a conversation resumed after its idle stop gets the whole board again: a stop is a fresh context (D20, D56)', async () => {
    await waitFor('PROJ-2\'s process stopped at the idle mark', idleStopTimeoutMs, () => getCharness().output.includes('[compact-on-idle] jira:PROJ:PROJ-2 process stopped; the session sleeps'));
    const prompt = await handOverAndAwaitAnswer('PROJ-2');
    assert.match(prompt, new RegExp(`\\[Project board · ${repositoryName} · 2 other topics\\]`));
    assert.match(prompt, /PROJ-3 «\[fake:background-notify\] Task PROJ-3» — [^\n]*\n {2}▶ Watch the build/);
    assert.match(prompt, /PROJ-1 «\[fake:answer\] Task PROJ-1» — /);
  });

  itHoldsTheInstanceInvariants();
});
