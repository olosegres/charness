/**
 * @description The trusted group (`trustedGroup.ts`): who counts as trusted — a member, the
 * AI account, an app or automation — and the membership cache: read once, refreshed only when
 * older than its age, never served past it when a refresh fails.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JiraAuthError, JiraHttpError, type JiraAccount } from '../connectors/jira/client';
import {
  createJiraTrust,
  jiraTrustedGroupMaxAgeMs,
  JiraTrustedGroupGoneError,
  readJiraTrustedGroup,
  type JiraTrust,
  type JiraTrustClient,
} from '../connectors/jira/trustedGroup';

const aiAccountId = 'ai-account';
const groupId = 'group-1';

const member: JiraAccount = { accountId: 'member', accountType: 'atlassian' };
const outsider: JiraAccount = { accountId: 'outsider', accountType: 'atlassian' };
const automation: JiraAccount = { accountId: 'rule', accountType: 'app' };
const customer: JiraAccount = { accountId: 'customer', accountType: 'customer' };
const untypedAccount: JiraAccount = { accountId: 'untyped' };

interface FakeGroupSite {
  client: JiraTrustClient;
  /** The members the site answers with; change it between reads. */
  members: string[];
  memberReads: number;
  /** Rejects the next member reads with this error while set. */
  memberReadError: Error | null;
  /** Answer of the group lookup. */
  group: { name: string; groupId: string } | null;
}

function createFakeGroupSite(members: string[]): FakeGroupSite {
  const site: FakeGroupSite = {
    members,
    memberReads: 0,
    memberReadError: null,
    group: { name: 'ai-trusted', groupId },
    client: {
      getGroupByName: async () => site.group,
      getGroupMembers: async () => {
        site.memberReads += 1;
        if (site.memberReadError) throw site.memberReadError;
        return site.members.map((accountId) => ({ accountId }));
      },
    },
  };
  return site;
}

describe('readJiraTrustedGroup', () => {
  it('resolves the group by its name and reads its members, stamped with the time the read started', async () => {
    const site = createFakeGroupSite(['member']);
    const snapshot = await readJiraTrustedGroup(site.client, 'ai-trusted', () => 5_000);
    assert.deepEqual(snapshot && { ...snapshot, memberAccountIds: [...snapshot.memberAccountIds] }, {
      groupName: 'ai-trusted', groupId, memberAccountIds: ['member'], readAtMs: 5_000,
    });
  });

  it('a site without the group → null, and its members are never read', async () => {
    const site = createFakeGroupSite(['member']);
    site.group = null;
    assert.equal(await readJiraTrustedGroup(site.client, 'ai-trusted', () => 0), null);
    assert.equal(site.memberReads, 0);
  });

  it('a group removed between the two calls → null; any other failure is raised as the client raised it', async () => {
    const site = createFakeGroupSite(['member']);
    site.memberReadError = new JiraHttpError(404, 'GET', '/rest/api/3/group/member', 'gone');
    assert.equal(await readJiraTrustedGroup(site.client, 'ai-trusted', () => 0), null);
    site.memberReadError = new JiraAuthError(403, 'GET', '/rest/api/3/group/member');
    await assert.rejects(readJiraTrustedGroup(site.client, 'ai-trusted', () => 0), JiraAuthError);
    site.memberReadError = new JiraHttpError(503, 'GET', '/rest/api/3/group/member', 'down');
    await assert.rejects(readJiraTrustedGroup(site.client, 'ai-trusted', () => 0), (error: Error) => error instanceof JiraHttpError && error.status === 503);
  });
});

describe('createJiraTrust', () => {
  let nowMs = 1_000_000;
  const now = (): number => nowMs;

  async function createTrust(site: FakeGroupSite): Promise<JiraTrust> {
    nowMs = 1_000_000;
    const snapshot = await readJiraTrustedGroup(site.client, 'ai-trusted', now);
    assert.ok(snapshot);
    return createJiraTrust({ client: site.client, snapshot, aiAccountId, now });
  }

  it('trusts a member, the AI account and every app or automation; nobody else — a customer, a person outside, an account without a type, no account at all', async () => {
    const trust = await createTrust(createFakeGroupSite(['member']));
    assert.equal(trust.groupName, 'ai-trusted');
    assert.equal(trust.checkIsTrusted(member), true);
    assert.equal(trust.checkIsTrusted({ accountId: aiAccountId, accountType: 'atlassian' }), true);
    assert.equal(trust.checkIsTrusted({ accountId: aiAccountId }), true);
    assert.equal(trust.checkIsTrusted(automation), true, 'an app needs no membership');
    assert.equal(trust.checkIsTrusted(outsider), false);
    assert.equal(trust.checkIsTrusted(customer), false);
    assert.equal(trust.checkIsTrusted(untypedAccount), false, 'a missing type is read as a person');
    assert.equal(trust.checkIsTrusted(null), false);
    assert.equal(trust.checkIsTrusted(undefined), false);
  });

  it('a customer or an untyped account that IS a member is trusted — membership is the rule for people', async () => {
    const trust = await createTrust(createFakeGroupSite(['customer', 'untyped']));
    assert.equal(trust.checkIsTrusted(customer), true);
    assert.equal(trust.checkIsTrusted(untypedAccount), true);
  });

  it('refreshes only when the last read is older than its age: the seeded read serves a fresh list, so no member read is made', async () => {
    const site = createFakeGroupSite(['member']);
    const trust = await createTrust(site);
    assert.equal(site.memberReads, 1, 'the setup read');
    nowMs += jiraTrustedGroupMaxAgeMs - 1;
    await trust.refreshIfStale();
    assert.equal(site.memberReads, 1, 'still fresh');
    nowMs += 1;
    await trust.refreshIfStale();
    assert.equal(site.memberReads, 2, 'exactly at its age it is stale');
    await trust.refreshIfStale();
    assert.equal(site.memberReads, 2, 'the refresh restarted the age');
  });

  it('a member removed from the group loses trust at the next refresh, and one added gains it', async () => {
    const site = createFakeGroupSite(['member']);
    const trust = await createTrust(site);
    site.members = ['newcomer'];
    assert.equal(trust.checkIsTrusted(member), true, 'the list is served until it is refreshed');
    nowMs += jiraTrustedGroupMaxAgeMs;
    await trust.refreshIfStale();
    assert.equal(trust.checkIsTrusted(member), false);
    assert.equal(trust.checkIsTrusted({ accountId: 'newcomer', accountType: 'atlassian' }), true);
  });

  it('a failed refresh rejects with the failure and keeps the list stale: the next call reads again, nothing is served past its age silently', async () => {
    const site = createFakeGroupSite(['member']);
    const trust = await createTrust(site);
    nowMs += jiraTrustedGroupMaxAgeMs;
    site.memberReadError = new JiraHttpError(503, 'GET', '/rest/api/3/group/member', 'down');
    await assert.rejects(trust.refreshIfStale(), (error: Error) => error instanceof JiraHttpError && error.status === 503);
    await assert.rejects(trust.refreshIfStale(), JiraHttpError);
    assert.equal(site.memberReads, 3, 'each call tried again');
    site.memberReadError = null;
    site.members = [];
    await trust.refreshIfStale();
    assert.equal(trust.checkIsTrusted(member), false, 'the read that finally worked replaced the list');
  });

  it('a 404 on the refresh is JiraTrustedGroupGoneError, naming the group; a refused call stays a JiraAuthError', async () => {
    const site = createFakeGroupSite(['member']);
    const trust = await createTrust(site);
    nowMs += jiraTrustedGroupMaxAgeMs;
    site.memberReadError = new JiraHttpError(404, 'GET', '/rest/api/3/group/member', 'gone');
    await assert.rejects(trust.refreshIfStale(), (error: Error) =>
      error instanceof JiraTrustedGroupGoneError && error.groupName === 'ai-trusted' && error.message.includes('"ai-trusted"'));
    site.memberReadError = new JiraAuthError(403, 'GET', '/rest/api/3/group/member');
    await assert.rejects(trust.refreshIfStale(), JiraAuthError);
  });

  it('two callers that find the list stale share ONE read', async () => {
    const site = createFakeGroupSite(['member']);
    const trust = await createTrust(site);
    nowMs += jiraTrustedGroupMaxAgeMs;
    await Promise.all([trust.refreshIfStale(), trust.refreshIfStale()]);
    assert.equal(site.memberReads, 2, 'the setup read and one refresh');
  });

  it('follows the group by its id: a refresh reads the id the setup check resolved, never the name again', async () => {
    const site = createFakeGroupSite(['member']);
    const readIds: string[] = [];
    const client: JiraTrustClient = {
      getGroupByName: async () => {
        assert.fail('the name is resolved once, at setup');
      },
      getGroupMembers: async (id) => {
        readIds.push(id);
        return [];
      },
    };
    nowMs = 1_000_000;
    const trust = createJiraTrust({
      client,
      snapshot: { groupName: 'ai-trusted', groupId, memberAccountIds: new Set(site.members), readAtMs: nowMs },
      aiAccountId,
      now,
    });
    nowMs += jiraTrustedGroupMaxAgeMs;
    await trust.refreshIfStale();
    assert.deepEqual(readIds, [groupId]);
  });
});
