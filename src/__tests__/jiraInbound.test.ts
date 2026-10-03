/**
 * @description The Jira inbound poller (plan J5, D12/D13/D15): one search per
 * poll, and per issue allowlist → still matching → no post in flight → trigger →
 * seen → self-authored → run budget → bind → request → post → record once the
 * post settled. Driven over a fake client; each dependency records its call, so
 * the order is asserted, not assumed.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildJiraTriggerJql, JiraInbound, type JiraInboundDeps, type JiraProjectTrigger } from '../connectors/jira/inbound';
import { JiraTriggerLog, jiraTriggerLogFileName } from '../connectors/jira/triggerLog';
import { JiraAuthError, type JiraAccount, type JiraChangelogHistory, type JiraChangelogPage, type JiraIssue, type JiraSearchRequest, type JiraSearchResult } from '../connectors/jira/client';
import { createdTriggerId } from '../connectors/jira/trigger';
import { keyToString } from '../sessionKey';
import type { RequestOrigin } from '../requests/types';

const aiAccountId = 'ai-account';
const requester: JiraAccount = { accountId: 'requester-account', accountType: 'atlassian', displayName: 'Requester' };
const reporter: JiraAccount = { accountId: 'reporter-account', accountType: 'atlassian' };
const nowMs = Date.parse('2026-10-03T12:00:00Z');
/** Lets a post that was not awaited settle and record its trigger. */
const flushPosts = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const projects: ReadonlyMap<string, JiraProjectTrigger> = new Map([
  ['PROJ', { folder: 'proj-work', triggerStatusIds: new Set(['10001']) }],
  ['OPS', { folder: 'ops-work', triggerStatusIds: new Set(['20001']) }],
]);

function createHistory(id: string, minute: number, items: JiraChangelogHistory['items'], author: JiraAccount = requester): JiraChangelogHistory {
  return { id, created: `2026-10-03T09:${String(minute).padStart(2, '0')}:00.000+0000`, author, items };
}

function createIssue(issueKey: string, options: { histories?: JiraChangelogHistory[]; total?: number; statusId?: string; assigneeId?: string } = {}): JiraIssue {
  const histories = options.histories ?? [createHistory('100', 0, [{ field: 'assignee', to: aiAccountId }])];
  return {
    id: `id-${issueKey}`,
    key: issueKey,
    fields: {
      summary: `Summary of ${issueKey}`,
      status: { id: options.statusId ?? '10001', name: 'To Do' },
      assignee: { accountId: options.assigneeId ?? aiAccountId },
      reporter,
      creator: reporter,
    },
    changelog: { startAt: 0, maxResults: 100, total: options.total ?? histories.length, histories },
  };
}

interface Recorded {
  calls: string[];
  searches: JiraSearchRequest[];
  origins: RequestOrigin[];
  prompts: string[];
  parked: Array<{ issueKey: string; requester: JiraAccount | null }>;
}

describe('JiraInbound', () => {
  let dataDir = '';
  let recorded: Recorded;
  let searchPages: JiraSearchResult[];
  let changelogPages: Map<string, JiraChangelogHistory[]>;
  let triggerLog: JiraTriggerLog;
  let requestCount = 0;
  let isPostFailing = false;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-inbound-'));
    recorded = { calls: [], searches: [], origins: [], prompts: [], parked: [] };
    searchPages = [];
    changelogPages = new Map();
    triggerLog = await createLoadedTriggerLog();
    requestCount = 0;
    isPostFailing = false;
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function createLoadedTriggerLog(): Promise<JiraTriggerLog> {
    const log = JiraTriggerLog.createForDataDir(path.join(dataDir, jiraTriggerLogFileName));
    await log.load();
    return log;
  }

  function createInbound(overrides: Partial<JiraInboundDeps> = {}): JiraInbound {
    let pageIndex = 0;
    return new JiraInbound({
      client: {
        searchIssues: async (search) => {
          recorded.searches.push(search);
          recorded.calls.push('search');
          return searchPages[pageIndex++] ?? { issues: [] };
        },
        getChangelogPage: async (issueKey, startAt): Promise<JiraChangelogPage> => {
          recorded.calls.push(`changelog ${issueKey} ${startAt}`);
          const all = changelogPages.get(issueKey) ?? [];
          const values = all.slice(startAt, startAt + 2);
          return { startAt, maxResults: 2, total: all.length, isLast: startAt + values.length >= all.length, values };
        },
        getIssue: async (issueKey) => {
          recorded.calls.push(`getIssue ${issueKey}`);
          return createIssue(issueKey);
        },
      },
      aiAccountId,
      siteUrl: 'https://example.atlassian.net/',
      projects,
      runBudgetPer24h: 2,
      pollIntervalMs: 60_000,
      triggerLog,
      now: () => nowMs,
      bindConversation: async (key, folder) => {
        recorded.calls.push(`bind ${keyToString(key)} ${folder}`);
      },
      createRequest: async (key, origin) => {
        requestCount += 1;
        recorded.origins.push(origin);
        recorded.calls.push(`create ${keyToString(key)}`);
        return { id: `req_${requestCount}` };
      },
      postRequest: async (key, requestId, prompt) => {
        recorded.calls.push(`post ${keyToString(key)} ${requestId} (seen=${triggerLog.checkIsSeen(key.thread, '100')})`);
        recorded.prompts.push(prompt);
        if (isPostFailing) throw new Error('session start failed');
      },
      parkIssue: async (issueKey, parkedRequester) => {
        recorded.calls.push(`park ${issueKey}`);
        recorded.parked.push({ issueKey, requester: parkedRequester });
      },
      ...overrides,
    });
  }

  it('the JQL names only the allowlist, the AI account and the trigger statuses', () => {
    assert.equal(
      buildJiraTriggerJql(projects),
      'project in ("PROJ", "OPS") AND assignee = currentUser() AND status in ("10001", "20001") ORDER BY created ASC',
    );
  });

  it('a new trigger: bind → request → post → recorded once the post settled; the prompt carries the request and the issue', async () => {
    searchPages = [{ issues: [createIssue('PROJ-12')], isLast: true }];
    const decisions = await createInbound().pollOnce();
    assert.deepEqual([...decisions], [['PROJ-12', 'request']]);
    await flushPosts();
    assert.deepEqual(recorded.calls, [
      'search',
      'getIssue PROJ-12',
      'bind jira:PROJ:PROJ-12 proj-work',
      'create jira:PROJ:PROJ-12',
      'post jira:PROJ:PROJ-12 req_1 (seen=false)',
    ]);
    assert.equal(triggerLog.checkIsSeen('PROJ-12', '100'), true, 'recorded after the post');
    assert.deepEqual(recorded.origins, [{ kind: 'trackerEvent', attributes: { issueKey: 'PROJ-12', triggerId: '100', requesterAccountId: 'requester-account' } }]);
    assert.match(recorded.prompts[0], /^\[Request req_1 · from: PROJ-12 assigned to you by Requester\]/);
    assert.match(recorded.prompts[0], /Link: https:\/\/example\.atlassian\.net\/browse\/PROJ-12/);
    assert.equal(recorded.searches[0].isChangelogExpanded, true);
  });

  it('the same trigger is never a second request — in the next poll, and after a restart', async () => {
    searchPages = [{ issues: [createIssue('PROJ-12')] }, { issues: [createIssue('PROJ-12')] }];
    const inbound = createInbound();
    await inbound.pollOnce();
    await flushPosts();
    assert.deepEqual([...await inbound.pollOnce()], [['PROJ-12', 'seen']]);
    triggerLog = await createLoadedTriggerLog();
    searchPages = [{ issues: [createIssue('PROJ-12')] }];
    assert.deepEqual([...await createInbound().pollOnce()], [['PROJ-12', 'seen']]);
    assert.equal(requestCount, 1);
  });

  it('a NEW trigger on the same issue (re-assigned after a question) is a new request', async () => {
    searchPages = [{ issues: [createIssue('PROJ-12')] }];
    await createInbound().pollOnce();
    await flushPosts();
    const reassigned = createIssue('PROJ-12', {
      histories: [
        createHistory('100', 0, [{ field: 'assignee', to: aiAccountId }]),
        createHistory('110', 30, [{ field: 'assignee', to: aiAccountId }]),
      ],
    });
    searchPages = [{ issues: [reassigned] }];
    assert.deepEqual([...await createInbound().pollOnce()], [['PROJ-12', 'request']]);
    assert.equal(recorded.origins[1].attributes.triggerId, '110');
  });

  it('a change made by the AI account itself is recorded and never a request', async () => {
    const selfAssigned = createIssue('PROJ-13', { histories: [createHistory('200', 0, [{ field: 'assignee', to: aiAccountId }], { accountId: aiAccountId })] });
    searchPages = [{ issues: [selfAssigned] }, { issues: [selfAssigned] }];
    const inbound = createInbound();
    assert.deepEqual([...await inbound.pollOnce()], [['PROJ-13', 'selfAuthored']]);
    assert.deepEqual([...await inbound.pollOnce()], [['PROJ-13', 'seen']]);
    assert.equal(requestCount, 0);
  });

  it('an issue created already assigned (no matching changelog entry) triggers by its creation', async () => {
    searchPages = [{ issues: [createIssue('PROJ-14', { histories: [] })] }];
    await createInbound().pollOnce();
    assert.equal(recorded.origins[0].attributes.triggerId, createdTriggerId);
    assert.equal(recorded.origins[0].attributes.requesterAccountId, 'reporter-account');
  });

  it('an automation\'s change hands the request to the reporter', async () => {
    const byApp = createIssue('PROJ-15', { histories: [createHistory('300', 0, [{ field: 'assignee', to: aiAccountId }], { accountId: 'rule', accountType: 'app' })] });
    searchPages = [{ issues: [byApp] }];
    await createInbound().pollOnce();
    assert.equal(recorded.origins[0].attributes.requesterAccountId, 'reporter-account');
  });

  it('an issue outside the allowlist, or no longer matching, is dropped untouched', async () => {
    searchPages = [{
      issues: [
        createIssue('OTHER-1'),
        createIssue('PROJ-16', { assigneeId: 'someone-else' }),
        createIssue('PROJ-17', { statusId: '20001' }),
      ],
    }];
    const decisions = await createInbound().pollOnce();
    assert.deepEqual([...decisions], [['OTHER-1', 'notAllowed'], ['PROJ-16', 'notMatching'], ['PROJ-17', 'notMatching']]);
    assert.deepEqual(recorded.calls, ['search']);
  });

  it('over the run budget (24 h rolling): parked and recorded, no request; an old request does not count', async () => {
    triggerLog.record({ issueKey: 'PROJ-18', triggerId: 'a', outcome: 'request', at: nowMs - 2 * 60 * 60 * 1000 });
    triggerLog.record({ issueKey: 'PROJ-18', triggerId: 'b', outcome: 'request', at: nowMs - 60 * 60 * 1000 });
    triggerLog.record({ issueKey: 'PROJ-19', triggerId: 'a', outcome: 'request', at: nowMs - 25 * 60 * 60 * 1000 });
    searchPages = [{ issues: [createIssue('PROJ-18'), createIssue('PROJ-19')] }];
    const decisions = await createInbound().pollOnce();
    assert.deepEqual([...decisions], [['PROJ-18', 'parked'], ['PROJ-19', 'request']]);
    assert.deepEqual(recorded.parked, [{ issueKey: 'PROJ-18', requester }]);
    assert.equal(triggerLog.checkIsSeen('PROJ-18', '100'), true, 'a parked trigger is not parked again');
  });

  it('a changelog the search cut short is read whole from its own endpoint', async () => {
    const older = createHistory('400', 0, [{ field: 'assignee', to: aiAccountId }]);
    const newest = createHistory('401', 5, [{ field: 'status', to: '10001' }]);
    const unrelated = createHistory('402', 10, [{ field: 'summary' }]);
    changelogPages.set('PROJ-20', [older, newest, unrelated]);
    searchPages = [{ issues: [createIssue('PROJ-20', { histories: [older], total: 3 })] }];
    await createInbound().pollOnce();
    assert.deepEqual(recorded.calls.filter((call) => call.startsWith('changelog')), ['changelog PROJ-20 0', 'changelog PROJ-20 2']);
    assert.equal(recorded.origins[0].attributes.triggerId, '401');
  });

  it('every page of the search is read', async () => {
    searchPages = [{ issues: [createIssue('PROJ-21')], nextPageToken: 'page-2' }, { issues: [createIssue('PROJ-22')], nextPageToken: null }];
    const decisions = await createInbound().pollOnce();
    assert.deepEqual([...decisions.keys()], ['PROJ-21', 'PROJ-22']);
    assert.deepEqual(recorded.searches.map((search) => search.nextPageToken), [undefined, 'page-2']);
  });

  it('a trigger whose record cannot be written after its post is remembered: this process never posts it again', async () => {
    fs.mkdirSync(path.join(dataDir, jiraTriggerLogFileName));
    searchPages = [{ issues: [createIssue('PROJ-23')] }, { issues: [createIssue('PROJ-23')] }];
    const inbound = createInbound();
    assert.deepEqual([...await inbound.pollOnce()], [['PROJ-23', 'request']]);
    await flushPosts();
    assert.deepEqual([...await inbound.pollOnce()], [['PROJ-23', 'seen']]);
    assert.equal(requestCount, 1);
  });

  it('a post that fails leaves the request open and recorded — the wake-up engine takes it from there', async () => {
    isPostFailing = true;
    searchPages = [{ issues: [createIssue('PROJ-24')] }];
    assert.deepEqual([...await createInbound().pollOnce()], [['PROJ-24', 'request']]);
    await flushPosts();
    assert.equal(triggerLog.checkIsSeen('PROJ-24', '100'), true);
  });

  it('a post that waits for a busy session does not hold up the poll; until it settles its issue is skipped and its trigger unrecorded', { timeout: 2_000 }, async () => {
    let releasePost: () => void = () => {};
    searchPages = [{ issues: [createIssue('PROJ-27'), createIssue('PROJ-28')] }, { issues: [createIssue('PROJ-27')] }, { issues: [createIssue('PROJ-27')] }];
    const inbound = createInbound({
      postRequest: async (key) => {
        recorded.calls.push(`post ${key.thread}`);
        if (key.thread === 'PROJ-27') await new Promise<void>((resolve) => { releasePost = resolve; });
      },
    });
    assert.deepEqual([...await inbound.pollOnce()], [['PROJ-27', 'request'], ['PROJ-28', 'request']]);
    assert.ok(recorded.calls.includes('post PROJ-28'), 'the second issue was posted while the first post still waits');
    await flushPosts();
    assert.deepEqual([...await inbound.pollOnce()], [['PROJ-27', 'posting']]);
    assert.equal(triggerLog.checkIsSeen('PROJ-27', '100'), false, 'not recorded while its post waits');
    assert.equal(requestCount, 2, 'no second request of the issue while its post waits');
    releasePost();
    await flushPosts();
    assert.equal(triggerLog.checkIsSeen('PROJ-27', '100'), true);
    assert.deepEqual([...await inbound.pollOnce()], [['PROJ-27', 'seen']]);
  });

  it('a restart before the post settled leaves the trigger unrecorded: the next start opens and posts it again', async () => {
    searchPages = [{ issues: [createIssue('PROJ-29')] }];
    await createInbound({ postRequest: () => new Promise<void>(() => {}) }).pollOnce();
    await flushPosts();
    triggerLog = await createLoadedTriggerLog();
    searchPages = [{ issues: [createIssue('PROJ-29')] }];
    assert.deepEqual([...await createInbound().pollOnce()], [['PROJ-29', 'request']]);
    assert.equal(requestCount, 2);
  });

  it('one issue failing does not stop the others in the same poll', async () => {
    searchPages = [{ issues: [createIssue('PROJ-25'), createIssue('PROJ-26')] }];
    const inbound = createInbound({
      bindConversation: async (key) => {
        if (key.thread === 'PROJ-25') throw new Error('disk full');
      },
    });
    assert.deepEqual([...await inbound.pollOnce()], [['PROJ-25', 'failed'], ['PROJ-26', 'request']]);
  });

  describe('the poll loop', () => {
    const waitMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

    it('polls again only after a poll ENDS — never two at once', async () => {
      let running = 0;
      let maxRunning = 0;
      let polls = 0;
      const inbound = createInbound({
        pollIntervalMs: 5,
        client: {
          searchIssues: async () => {
            polls += 1;
            running += 1;
            maxRunning = Math.max(maxRunning, running);
            await waitMs(30);
            running -= 1;
            return { issues: [] };
          },
          getChangelogPage: async () => ({ startAt: 0, maxResults: 0, total: 0, values: [] }),
          getIssue: async (issueKey) => createIssue(issueKey),
        },
      });
      inbound.start();
      await waitMs(120);
      inbound.stop();
      assert.ok(polls >= 2, `${polls} polls`);
      assert.equal(maxRunning, 1);
    });

    it('a rejected token stops polling for good; any other failure retries at the next interval', async () => {
      let authPolls = 0;
      const refused = createInbound({
        pollIntervalMs: 5,
        client: {
          searchIssues: async () => {
            authPolls += 1;
            throw new JiraAuthError(401, 'POST', '/rest/api/3/search/jql');
          },
          getChangelogPage: async () => ({ startAt: 0, maxResults: 0, total: 0, values: [] }),
          getIssue: async (issueKey) => createIssue(issueKey),
        },
      });
      refused.start();
      await waitMs(60);
      refused.stop();
      assert.equal(authPolls, 1);

      let flakyPolls = 0;
      const flaky = createInbound({
        pollIntervalMs: 5,
        client: {
          searchIssues: async () => {
            flakyPolls += 1;
            throw new Error('Jira 503');
          },
          getChangelogPage: async () => ({ startAt: 0, maxResults: 0, total: 0, values: [] }),
          getIssue: async (issueKey) => createIssue(issueKey),
        },
      });
      flaky.start();
      await waitMs(60);
      flaky.stop();
      assert.ok(flakyPolls >= 2, `${flakyPolls} polls`);
    });
  });
});
