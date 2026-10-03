/**
 * @description Jira trigger detection (plan J5, D11/D12): the newest changelog
 * entry that made the issue match is the trigger, the creation when there is
 * none; the requester is the trigger's author when a person made the change,
 * else the reporter. Changelog fixtures use placeholder account ids.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkIsPersonAccount, createdTriggerId, getIssueTrigger, getRequester } from '../connectors/jira/trigger';
import type { JiraAccount, JiraChangelogHistory } from '../connectors/jira/client';

const aiAccountId = 'ai-account';
const requester: JiraAccount = { accountId: 'requester-account', accountType: 'atlassian', displayName: 'Requester' };
const automation: JiraAccount = { accountId: 'automation-account', accountType: 'app' };
const reporter: JiraAccount = { accountId: 'reporter-account', accountType: 'atlassian' };
const match = { aiAccountId, triggerStatusIds: new Set(['10001', '10002']) };

function createHistory(id: string, created: string, items: JiraChangelogHistory['items'], author: JiraAccount | undefined = requester): JiraChangelogHistory {
  return { id, created, author, items };
}

const assignedToAi = createHistory('100', '2026-10-03T09:00:00.000+0000', [{ field: 'assignee', fieldId: 'assignee', from: null, to: aiAccountId }]);
const movedToTrigger = createHistory('101', '2026-10-03T09:05:00.000+0000', [{ field: 'status', fieldId: 'status', from: '3', to: '10002' }]);
const unrelatedEdit = createHistory('102', '2026-10-03T09:10:00.000+0000', [{ field: 'description', fieldId: 'description' }]);

describe('getIssueTrigger', () => {
  it('an assignment to the AI account is the trigger, with its author', () => {
    assert.deepEqual(getIssueTrigger([assignedToAi, unrelatedEdit], match, reporter), { triggerId: '100', kind: 'assigned', author: requester });
  });

  it('the NEWEST matching entry wins, whatever order the changelog came in; unrelated edits never trigger', () => {
    const newest = { triggerId: '101', kind: 'statusChanged', author: requester };
    // Jira lists a changelog oldest first; the order must not matter either way.
    assert.deepEqual(getIssueTrigger([assignedToAi, movedToTrigger, unrelatedEdit], match, reporter), newest);
    assert.deepEqual(getIssueTrigger([unrelatedEdit, movedToTrigger, assignedToAi], match, reporter), newest);
  });

  it('two entries at the same instant: the higher id is the newer one', () => {
    const sameTime = createHistory('099', movedToTrigger.created, [{ field: 'assignee', to: aiAccountId }]);
    assert.equal(getIssueTrigger([sameTime, movedToTrigger], match, reporter).triggerId, '101');
  });

  it('an assignment to someone else and a status outside the set do not trigger: the creation does', () => {
    const toOther = createHistory('200', '2026-10-03T10:00:00.000+0000', [{ field: 'assignee', to: 'other-account' }]);
    const toDone = createHistory('201', '2026-10-03T10:01:00.000+0000', [{ field: 'status', to: '3' }]);
    assert.deepEqual(getIssueTrigger([toOther, toDone], match, reporter), { triggerId: createdTriggerId, kind: 'created', author: reporter });
    assert.deepEqual(getIssueTrigger([], match, null), { triggerId: createdTriggerId, kind: 'created', author: null });
  });

  it('an entry Jira records without an author has a null author', () => {
    const anonymous: JiraChangelogHistory = { id: '300', created: '2026-10-03T11:00:00.000+0000', items: [{ field: 'assignee', to: aiAccountId }] };
    assert.equal(getIssueTrigger([anonymous], match, reporter).author, null);
  });
});

describe('getRequester', () => {
  it('a person who made the change is the requester', () => {
    assert.equal(getRequester(getIssueTrigger([assignedToAi], match, reporter), reporter), requester);
  });

  it('an app or automation, or no author at all: the reporter is the requester', () => {
    const byAutomation = createHistory('400', '2026-10-03T12:00:00.000+0000', [{ field: 'assignee', to: aiAccountId }], automation);
    assert.equal(getRequester(getIssueTrigger([byAutomation], match, reporter), reporter), reporter);
    assert.equal(getRequester({ triggerId: '1', kind: 'assigned', author: null }, reporter), reporter);
  });

  it('a missing account type is read as a person', () => {
    assert.equal(checkIsPersonAccount({ accountId: 'x' }), true);
    assert.equal(checkIsPersonAccount(automation), false);
  });
});
