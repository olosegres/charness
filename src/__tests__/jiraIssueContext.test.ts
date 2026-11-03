/**
 * @description `findAccountInContext`: the display name of a request's requester, taken from the issue's own data (a
 * request's ledger record holds an account id only) — never invented, and never an account without a name.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findAccountInContext } from '../connectors/jira/issueContext';
import { createIssueContext, createTestComment } from './jiraIssueTestData';

const named = (accountId: string, displayName: string) => ({ accountId, accountType: 'atlassian', displayName });

describe('findAccountInContext', () => {
  it('finds an account by id among the reporter, creator, assignee, comment authors and editors, and changelog authors', () => {
    const context = createIssueContext({
      fields: { reporter: named('reporter-id', 'Reporter'), creator: named('creator-id', 'Creator'), assignee: named('assignee-id', 'Assignee') },
      comments: [createTestComment('1', 1, 'hello', { author: named('author-id', 'Author'), updateAuthor: named('editor-id', 'Editor') })],
      changelog: [{ id: '5', created: '2026-10-05T10:00:00.000+0000', author: named('changer-id', 'Changer'), items: [] }],
    });
    for (const [accountId, name] of [['reporter-id', 'Reporter'], ['creator-id', 'Creator'], ['assignee-id', 'Assignee'], ['author-id', 'Author'], ['editor-id', 'Editor'], ['changer-id', 'Changer']]) {
      assert.equal(findAccountInContext(context, accountId)?.displayName, name, accountId);
    }
  });

  it('is null for an id nothing names, an empty id (a request without a requester), and an account that carries no display name', () => {
    const context = createIssueContext({ fields: { reporter: { accountId: 'nameless-id' }, creator: named('creator-id', 'Creator') } });
    assert.equal(findAccountInContext(context, 'stranger-id'), null);
    assert.equal(findAccountInContext(context, ''), null);
    assert.equal(findAccountInContext(context, 'nameless-id'), null);
  });

  it('takes the entry that has a name when the same account appears without one first', () => {
    const context = createIssueContext({
      fields: { reporter: { accountId: 'same-id' } },
      comments: [createTestComment('1', 1, 'hello', { author: named('same-id', 'Same Person') })],
    });
    assert.equal(findAccountInContext(context, 'same-id')?.displayName, 'Same Person');
  });
});
