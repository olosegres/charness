/**
 * @description The Jira inbound poller (plan J5, D12/D13/D15): one search per
 * poll, and per issue allowlist → still matching → no post in flight → trigger →
 * seen → self-authored → run budget → bind → request → post → record once the
 * post settled. Driven over a fake client; each dependency records its call, so
 * the order is asserted, not assumed.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildJiraTriggerJql, getJiraRetryDelayMs, jiraChangelogPageSize, JiraInbound, jiraRetryBackoffCapMs, type JiraInboundDeps, type JiraProjectTrigger } from '../connectors/jira/inbound';
import { JiraTriggerLog, jiraTriggerLogFileName } from '../connectors/jira/triggerLog';
import { JiraContextLedger } from '../connectors/jira/contextLedger';
import { createTestComment } from './jiraIssueTestData';
import { JiraAuthError, type JiraAccount, type JiraChangelogHistory, type JiraChangelogPage, type JiraComment, type JiraIssue, type JiraRemoteLink, type JiraSearchRequest, type JiraSearchResult } from '../connectors/jira/client';
import { convertMarkdownToAdf } from '../connectors/jira/adf';
import { jiraCommentSpillMinChars, jiraPromptMaxChars } from '../connectors/jira/promptSpill';
import { requestPromptMaxLength } from '../requests/requestLedger';
import { createdTriggerId } from '../connectors/jira/trigger';
import { keyToString } from '../sessionKey';
import type { RequestOrigin } from '../requests/types';
import { buildSupersededRequestsLine } from '../requests/requestHeader';

const aiAccountId = 'ai-account';
const requester: JiraAccount = { accountId: 'requester-account', accountType: 'atlassian', displayName: 'Requester' };
const reporter: JiraAccount = { accountId: 'reporter-account', accountType: 'atlassian' };
const nowMs = Date.parse('2026-10-03T12:00:00Z');
/** Lets a post that was not awaited settle and record its trigger. */
const flushPosts = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
/** The two reads of an issue's context that a poll-loop test has no use for. */
const emptyIssueContext: Pick<JiraInboundDeps['client'], 'getComments' | 'getRemoteLinks'> = {
  getComments: async () => [],
  getRemoteLinks: async () => [],
};
const projects: ReadonlyMap<string, JiraProjectTrigger> = new Map([
  ['PROJ', { folder: 'proj-work', triggerStatusIds: new Set(['10001']), extraFields: [] }],
  ['OPS', { folder: 'ops-work', triggerStatusIds: new Set(['20001']), extraFields: [] }],
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
  /** The `fields` and `expand` of every issue read. */
  issueReads: Array<{ fields: string[]; expand: string | undefined }>;
  origins: RequestOrigin[];
  prompts: string[];
  /** What each request was opened with, to keep for a re-post (R21). */
  storedPrompts: string[];
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
  let contextLedger: JiraContextLedger;
  /** What the session post tells the prompt builder: a session that was just started knows nothing of the issue. */
  let isNextSessionFresh = false;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-inbound-'));
    recorded = { calls: [], searches: [], issueReads: [], origins: [], prompts: [], storedPrompts: [], parked: [] };
    searchPages = [];
    changelogPages = new Map();
    triggerLog = await createLoadedTriggerLog();
    requestCount = 0;
    isPostFailing = false;
    contextLedger = JiraContextLedger.createForDataDir(dataDir);
    isNextSessionFresh = false;
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
        getChangelogPage: async (issueKey, startAt, maxResults = jiraChangelogPageSize): Promise<JiraChangelogPage> => {
          recorded.calls.push(`changelog ${issueKey} ${startAt}+${maxResults}`);
          const all = changelogPages.get(issueKey) ?? [];
          const values = all.slice(startAt, startAt + maxResults);
          return { startAt, maxResults, total: all.length, isLast: startAt + values.length >= all.length, values };
        },
        getIssue: async (issueKey, fields, expand) => {
          recorded.calls.push(`getIssue ${issueKey}`);
          recorded.issueReads.push({ fields, expand });
          return createIssue(issueKey);
        },
        getComments: async (issueKey) => {
          recorded.calls.push(`getComments ${issueKey}`);
          return [];
        },
        getRemoteLinks: async (issueKey) => {
          recorded.calls.push(`getRemoteLinks ${issueKey}`);
          return [];
        },
      },
      aiAccountId,
      siteUrl: 'https://example.atlassian.net/',
      projects,
      runBudgetPer24h: 2,
      pollIntervalMs: 60_000,
      getSpillDir: () => path.join(dataDir, 'spill'),
      triggerLog,
      now: () => nowMs,
      bindConversation: async (key, folder) => {
        recorded.calls.push(`bind ${keyToString(key)} ${folder}`);
      },
      createRequest: async (key, origin, createPrompt) => {
        requestCount += 1;
        recorded.origins.push(origin);
        recorded.calls.push(`create ${keyToString(key)}`);
        // The second request of a conversation replaces the first, as the ledger does for one requester (R34).
        const supersededRequestIds = requestCount === 1 ? [] : [`req_${requestCount - 1}`];
        recorded.storedPrompts.push(createPrompt(`req_${requestCount}`, supersededRequestIds));
        return { id: `req_${requestCount}`, ...(supersededRequestIds.length > 0 ? { supersededRequestIds } : {}) };
      },
      postRequest: async (key, requestId, prompt) => {
        recorded.calls.push(`post ${keyToString(key)} ${requestId} (seen=${triggerLog.checkIsSeen(key.thread, '100')})`);
        // As the session post does: the text is built right before the forward, told whether the session is fresh.
        recorded.prompts.push(prompt.buildText({ isFresh: isNextSessionFresh }));
        if (isPostFailing) throw new Error('session start failed');
      },
      contextLedger,
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
      'getComments PROJ-12',
      'getRemoteLinks PROJ-12',
      'bind jira:PROJ:PROJ-12 proj-work',
      'create jira:PROJ:PROJ-12',
      'post jira:PROJ:PROJ-12 req_1 (seen=false)',
    ]);
    assert.equal(triggerLog.checkIsSeen('PROJ-12', '100'), true, 'recorded after the post');
    assert.deepEqual(recorded.origins, [{ kind: 'trackerEvent', attributes: { issueKey: 'PROJ-12', triggerId: '100', requester: 'requester-account' } }]);
    assert.match(recorded.prompts[0], /^\[Request req_1 · from: PROJ-12 assigned to you by Requester\]/);
    assert.match(recorded.prompts[0], /Link: https:\/\/example\.atlassian\.net\/browse\/PROJ-12/);
    assert.equal(recorded.searches[0].isChangelogExpanded, true);
  });

  it('R21: the request keeps exactly the prompt that is posted, header and all', async () => {
    searchPages = [{ issues: [createIssue('PROJ-12')], isLast: true }];
    await createInbound().pollOnce();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(recorded.storedPrompts.length, 1);
    assert.equal(recorded.storedPrompts[0], recorded.prompts[0]);
    assert.match(recorded.storedPrompts[0], /^\[Request req_1 · from: /);
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
    await flushPosts();
    assert.equal(recorded.origins[1].attributes.triggerId, '110');
    // R34: the request the ledger replaced is named in the posted prompt, exactly as in the stored one.
    assert.ok(recorded.prompts[1].includes(buildSupersededRequestsLine(['req_1'])), 'the second prompt names the replaced request');
    assert.equal(recorded.storedPrompts[1], recorded.prompts[1]);
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
    assert.equal(recorded.origins[0].attributes.requester, 'reporter-account');
  });

  it('an automation\'s change hands the request to the reporter', async () => {
    const byApp = createIssue('PROJ-15', { histories: [createHistory('300', 0, [{ field: 'assignee', to: aiAccountId }], { accountId: 'rule', accountType: 'app' })] });
    searchPages = [{ issues: [byApp] }];
    await createInbound().pollOnce();
    assert.equal(recorded.origins[0].attributes.requester, 'reporter-account');
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

  describe('the whole issue reaches the prompt (C1, C2)', () => {
    const labelledIssue = (issueKey: string, fields: Partial<JiraIssue['fields']> = {}): JiraIssue => {
      const base = createIssue(issueKey);
      return { ...base, fields: { ...base.fields, description: convertMarkdownToAdf('The export fails.'), ...fields } };
    };
    const createComment = (id: string, day: number, markdown: string): JiraComment => ({
      id,
      author: { accountId: `author-${id}`, displayName: `Author ${id}` },
      created: `2026-10-0${day}T10:00:00.000+0000`,
      body: convertMarkdownToAdf(markdown),
    });

    /** A client over one issue: the poll finds it, `getIssue` answers with `issue`, a children search answers with the pages. */
    function createContextClient(options: { issue: JiraIssue; comments?: JiraComment[]; remoteLinks?: JiraRemoteLink[]; childPages?: JiraSearchResult[] }): JiraInboundDeps['client'] {
      let childPageIndex = 0;
      return {
        searchIssues: async (search) => {
          recorded.searches.push(search);
          if (search.jql.startsWith('project in')) return { issues: [createIssue(options.issue.key)], isLast: true };
          return options.childPages?.[childPageIndex++] ?? { issues: [], isLast: true };
        },
        getChangelogPage: async () => ({ startAt: 0, maxResults: 0, total: 0, values: [] }),
        getIssue: async (_issueKey, fields, expand) => {
          recorded.issueReads.push({ fields, expand });
          return options.issue;
        },
        getComments: async () => options.comments ?? [],
        getRemoteLinks: async () => options.remoteLinks ?? [],
      };
    }

    it('EVERY comment, oldest first — not the last three — with the fields, links and remote links', async () => {
      const issue = labelledIssue('PROJ-40', {
        issuetype: { name: 'Bug', hierarchyLevel: 0 },
        priority: { name: 'High' },
        labels: ['backend', 'export'],
        fixVersions: [{ name: '1.2' }],
        components: [{ name: 'Exporter' }],
        issuelinks: [{ type: { inward: 'is blocked by', outward: 'blocks' }, outwardIssue: { key: 'PROJ-41', fields: { summary: 'Release', status: { name: 'To Do' } } } }],
      });
      const comments = [5, 1, 4, 2, 3, 6].map((day) => createComment(`${day}`, day, `comment ${day}`));
      const inbound = createInbound({
        client: createContextClient({ issue, comments, remoteLinks: [{ object: { url: 'https://example.com/spec', title: 'Spec' } }] }),
      });
      await inbound.pollOnce();
      await flushPosts();
      const posted = recorded.prompts[0];
      assert.ok(posted.includes('Comments (6, oldest first):'), posted);
      const positions = [1, 2, 3, 4, 5, 6].map((day) => posted.indexOf(`> comment ${day}`));
      assert.ok(positions.every((position, index) => position > 0 && (index === 0 || position > positions[index - 1])), positions.join(','));
      for (const line of [
        'Type: Bug', 'Priority: High', 'Labels: backend, export', 'Fix versions: 1.2', 'Components: Exporter',
        '- blocks PROJ-41 "Release" (To Do)', '- web link: "Spec" https://example.com/spec', '> The export fails.',
      ]) assert.ok(posted.includes(line), line);
      assert.ok(!posted.includes('Latest comments'));
    });

    it('an epic: its children are searched by `parent`, page after page to the end, and all listed', async () => {
      const epic = labelledIssue('PROJ-42', { issuetype: { name: 'Epic', hierarchyLevel: 1 } });
      const child = (key: string): JiraIssue => ({ id: key, key, fields: { summary: `Child ${key}`, status: { id: '1', name: 'In Progress' } } });
      const inbound = createInbound({
        client: createContextClient({
          issue: epic,
          childPages: [{ issues: [child('PROJ-43'), child('PROJ-44')], nextPageToken: 'more' }, { issues: [child('PROJ-45')], isLast: true }],
        }),
      });
      await inbound.pollOnce();
      await flushPosts();
      const childSearches = recorded.searches.filter((search) => !search.jql.startsWith('project in'));
      assert.deepEqual(childSearches.map((search) => [search.jql, search.nextPageToken]), [
        ['parent = "PROJ-42" ORDER BY created ASC', undefined],
        ['parent = "PROJ-42" ORDER BY created ASC', 'more'],
      ]);
      assert.ok(recorded.prompts[0].includes('Child issues (3):\n- PROJ-43 "Child PROJ-43" (In Progress)\n- PROJ-44 "Child PROJ-44" (In Progress)\n- PROJ-45 "Child PROJ-45" (In Progress)'));
    });

    it('a standard issue lists its sub-tasks and searches for nothing', async () => {
      const issue = labelledIssue('PROJ-46', {
        issuetype: { name: 'Task', hierarchyLevel: 0 },
        subtasks: [{ key: 'PROJ-47', fields: { summary: 'Write it', status: { name: 'Done' } } }],
      });
      await createInbound({ client: createContextClient({ issue }) }).pollOnce();
      await flushPosts();
      assert.deepEqual(recorded.searches.filter((search) => !search.jql.startsWith('project in')), []);
      assert.ok(recorded.prompts[0].includes('Sub-tasks (1):\n- PROJ-47 "Write it" (Done)'));
    });

    it('a comment over the limit reaches the agent as a pointer to a file that holds it whole; the stored prompt is the posted one', async () => {
      const longText = `start ${'w'.repeat(jiraCommentSpillMinChars + 500)} end`;
      const inbound = createInbound({ client: createContextClient({ issue: labelledIssue('PROJ-50'), comments: [createComment('9', 2, longText)] }) });
      await inbound.pollOnce();
      await flushPosts();
      const posted = recorded.prompts[0];
      const [, spillPath, chars] = /written whole to (\S+) \((\d+) chars\) — read it/.exec(posted) ?? [];
      assert.ok(spillPath, posted);
      assert.equal(path.dirname(spillPath), path.join(dataDir, 'spill'));
      assert.equal(fs.readFileSync(spillPath, 'utf8'), longText, 'the file holds the comment whole');
      assert.equal(Number(chars), longText.length);
      assert.ok(posted.includes('Comment 9 by Author 9, 2026-10-02T10:00:00.000+0000:\nwritten whole to '), 'the header stays');
      assert.ok(!posted.includes('w'.repeat(1_000)), 'none of it is in the prompt');
      assert.equal(recorded.storedPrompts[0], posted);
    });

    it('an issue too long for the ledger\'s stored prompt is fitted before the request opens: what is stored is under the cap', async () => {
      const comments = Array.from({ length: 40 }, (_, index) => createComment(`${index + 1}`, 1, `${index} ${'q'.repeat(5_000)}`));
      const inbound = createInbound({ client: createContextClient({ issue: labelledIssue('PROJ-51', { description: convertMarkdownToAdf('d'.repeat(40_000)) }), comments }) });
      await inbound.pollOnce();
      await flushPosts();
      assert.ok(recorded.storedPrompts[0].length <= jiraPromptMaxChars, `${recorded.storedPrompts[0].length} chars`);
      assert.ok(recorded.storedPrompts[0].length < requestPromptMaxLength);
      assert.equal(recorded.storedPrompts[0], recorded.prompts[0]);
      assert.ok(fs.readdirSync(path.join(dataDir, 'spill')).length > 0, 'the text that did not fit is in files');
    });

    it('files that cannot be written stop the request from opening — a prompt never points at a file that is not there', async () => {
      fs.writeFileSync(path.join(dataDir, 'spill'), 'a file where the folder should be');
      const inbound = createInbound({ client: createContextClient({ issue: labelledIssue('PROJ-52'), comments: [createComment('1', 1, 'z'.repeat(jiraCommentSpillMinChars + 1))] }) });
      assert.deepEqual([...await inbound.pollOnce()], [['PROJ-52', 'failed']]);
      assert.equal(requestCount, 0);
      assert.equal(triggerLog.checkIsSeen('PROJ-52', '100'), false);
    });

    it('an issue whose comments cannot be read opens no request: the poll tries it again, and the others go on', async () => {
      const client = createContextClient({ issue: labelledIssue('PROJ-49') });
      let attempts = 0;
      const inbound = createInbound({
        client: {
          ...client,
          getComments: async () => {
            attempts += 1;
            throw new Error('Jira 503');
          },
        },
      });
      assert.deepEqual([...await inbound.pollOnce()], [['PROJ-49', 'failed']]);
      await flushPosts();
      assert.equal(requestCount, 0, 'a request is never opened without its whole prompt');
      assert.equal(triggerLog.checkIsSeen('PROJ-49', '100'), false, 'its trigger stays unseen, so the next poll retries');
      assert.equal(attempts, 1);
    });

    it('the project\'s extra fields are asked for with the standard ones, expanded for the media mapping, and rendered by their site name', async () => {
      const issue = labelledIssue('PROJ-48', { issuetype: { name: 'Task', hierarchyLevel: 0 } });
      issue.rawFields = { customfield_10042: 'The export must finish in 5 s', customfield_10043: null };
      const extraProjects: ReadonlyMap<string, JiraProjectTrigger> = new Map([
        ['PROJ', {
          folder: 'proj-work',
          triggerStatusIds: new Set(['10001']),
          extraFields: [{ id: 'customfield_10042', name: 'Acceptance criteria' }, { id: 'customfield_10043', name: 'Story points' }],
        }],
      ]);
      await createInbound({ projects: extraProjects, client: createContextClient({ issue }) }).pollOnce();
      await flushPosts();
      assert.equal(recorded.issueReads.length, 1);
      assert.ok(recorded.issueReads[0].fields.includes('customfield_10042') && recorded.issueReads[0].fields.includes('description'));
      assert.equal(recorded.issueReads[0].expand, 'renderedFields');
      assert.ok(recorded.prompts[0].includes('Acceptance criteria: The export must finish in 5 s'));
      assert.ok(!recorded.prompts[0].includes('Story points'), 'a field without a value is left out');
    });
  });

  describe('nothing is repeated: the delta (C4, C5, C7)', () => {
    const issueKey = 'PROJ-60';
    let comments: JiraComment[] = [];
    let description = 'The export fails.';
    let triggerHistories: JiraChangelogHistory[] = [];

    /** One issue the poll finds with the current trigger, comments and description. */
    function createDeltaInbound(): JiraInbound {
      return createInbound({
        runBudgetPer24h: 10,
        client: {
          searchIssues: async () => ({ issues: [createIssue(issueKey, { histories: triggerHistories })], isLast: true }),
          getChangelogPage: async () => ({ startAt: 0, maxResults: 0, total: 0, values: [] }),
          getIssue: async () => {
            const base = createIssue(issueKey);
            return { ...base, fields: { ...base.fields, description: convertMarkdownToAdf(description) } };
          },
          getComments: async () => comments,
          getRemoteLinks: async () => [],
        },
      });
    }

    /** A new hand-over of the issue: a newer assignment in its changelog, so the poll opens the next request. */
    async function handOver(minute: number): Promise<void> {
      triggerHistories = [...triggerHistories, createHistory(`${100 + minute}`, minute, [{ field: 'assignee', to: aiAccountId }])];
      await createDeltaInbound().pollOnce();
      await flushPosts();
    }

    beforeEach(() => {
      comments = [createTestComment('1', 0, 'First report.')];
      description = 'The export fails.';
      triggerHistories = [];
    });

    it('after the agent took the first prompt in, the next one carries only what changed; the request still keeps the whole issue', async () => {
      await handOver(1);
      assert.ok(recorded.prompts[0].includes('Comments (1, oldest first):'), 'the first prompt is whole');
      contextLedger.commit(issueKey, 'req_1');
      comments = [...comments, createTestComment('2', 5, 'Still fails on Monday.')];
      description = 'The export fails on Mondays.';
      await handOver(2);
      const delta = recorded.prompts[1];
      assert.ok(delta.includes(`Jira issue ${issueKey} — what changed since your last prompt:`), delta);
      assert.ok(delta.includes('Description (changed since your last prompt):\n> The export fails on Mondays.'));
      assert.ok(delta.includes('Comment 2 by Ann Author, 2026-10-05T10:05:00.000+0000 (new):\n> Still fails on Monday.'));
      assert.ok(!delta.includes('First report.'), 'a comment already taken in is not repeated');
      assert.ok(delta.includes('Unchanged since your last prompt: fields, hierarchy, links, attachments, 1 comment.'));
      assert.match(delta, /^\[Request req_2 · from: PROJ-60 assigned to you by Requester\]/);
      assert.ok(recorded.storedPrompts[1].includes('First report.') && recorded.storedPrompts[1].includes('Comments (2, oldest first):'), 'a re-post sends the whole issue');
    });

    it('a prompt the agent never took in counts for nothing: the next one is whole again', async () => {
      await handOver(1);
      comments = [...comments, createTestComment('2', 5, 'More.')];
      await handOver(2);
      assert.ok(recorded.prompts[1].includes('Comments (2, oldest first):') && recorded.prompts[1].includes('First report.'));
      assert.ok(!recorded.prompts[1].includes('what changed since your last prompt'));
    });

    it('a session that turned out fresh gets the whole issue, whatever was sent before', async () => {
      await handOver(1);
      contextLedger.commit(issueKey, 'req_1');
      isNextSessionFresh = true;
      await handOver(2);
      assert.equal(recorded.prompts[1], recorded.storedPrompts[1]);
      assert.ok(recorded.prompts[1].includes('First report.'));
    });

    it('C6: after a reset — a fresh session started, a compaction completed — the next prompt is whole, even when its own post found the session already running', async () => {
      await handOver(1);
      contextLedger.commit(issueKey, 'req_1');
      contextLedger.reset(issueKey);
      isNextSessionFresh = false;
      await handOver(2);
      assert.equal(recorded.prompts[1], recorded.storedPrompts[1]);
      assert.ok(recorded.prompts[1].includes('First report.'));
    });

    it('C7: the agent\'s own answer comment is not sent back to it', async () => {
      await handOver(1);
      contextLedger.commit(issueKey, 'req_1');
      comments = [...comments, createTestComment('2', 5, 'Fixed it, see the branch.', { author: { accountId: aiAccountId, displayName: 'AI' } }), createTestComment('3', 6, 'Thanks, one more thing.')];
      await handOver(2);
      const delta = recorded.prompts[1];
      assert.ok(!delta.includes('Fixed it, see the branch.'), delta);
      assert.ok(delta.includes('> Thanks, one more thing.'));
      assert.ok(delta.includes('Unchanged since your last prompt: fields, description, hierarchy, links, attachments, 2 comments.'));
    });

    it('a deleted comment is named once, then forgotten', async () => {
      comments = [createTestComment('1', 0, 'First report.'), createTestComment('2', 1, 'Wrong issue, sorry.')];
      await handOver(1);
      contextLedger.commit(issueKey, 'req_1');
      comments = [comments[0]];
      await handOver(2);
      assert.ok(recorded.prompts[1].includes('comment 2 by Ann Author from 2026-10-05T10:01:00.000+0000 was deleted'));
      contextLedger.commit(issueKey, 'req_2');
      await handOver(3);
      assert.ok(!recorded.prompts[2].includes('was deleted'));
      assert.ok(recorded.prompts[2].includes('Nothing in the issue changed since your last prompt.'));
    });
  });

  describe('a changelog the search cut short', () => {
    const entryCount = 250;
    const automation: JiraAccount = { accountId: 'automation', accountType: 'app' };
    /** A long-lived issue's changelog, oldest first (Jira's order): edits by an app, with the given entries in place. */
    function createLongChangelog(overrides: ReadonlyMap<number, Partial<JiraChangelogHistory>>): JiraChangelogHistory[] {
      return Array.from({ length: entryCount }, (_, index) => ({
        id: `${1000 + index}`,
        created: new Date(Date.parse('2026-09-01T00:00:00Z') + index * 60_000).toISOString(),
        author: automation,
        items: [{ field: 'labels' }],
        ...overrides.get(index),
      }));
    }
    const getChangelogCalls = (): string[] => recorded.calls.filter((call) => call.startsWith('changelog'));
    const truncated = (issueKey: string, all: JiraChangelogHistory[]): JiraIssue => createIssue(issueKey, { histories: all.slice(0, 100), total: entryCount });

    it('the newest page holds the trigger: one page is read, and once seen, one page a poll', async () => {
      const all = createLongChangelog(new Map([[240, { author: requester, items: [{ field: 'assignee', to: aiAccountId }] }]]));
      changelogPages.set('PROJ-20', all);
      searchPages = [{ issues: [truncated('PROJ-20', all)] }, { issues: [truncated('PROJ-20', all)] }];
      const inbound = createInbound();
      assert.deepEqual([...await inbound.pollOnce()], [['PROJ-20', 'request']]);
      assert.equal(recorded.origins[0].attributes.triggerId, '1240');
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual([...await inbound.pollOnce()], [['PROJ-20', 'seen']]);
      assert.deepEqual(getChangelogCalls(), ['changelog PROJ-20 150+100', 'changelog PROJ-20 150+100']);
    });

    it('a trigger deep in the history: older pages are read back to it, no entry twice', async () => {
      const all = createLongChangelog(new Map([[10, { author: requester, items: [{ field: 'assignee', to: aiAccountId }] }]]));
      changelogPages.set('PROJ-21', all);
      searchPages = [{ issues: [truncated('PROJ-21', all)] }];
      await createInbound().pollOnce();
      assert.deepEqual(getChangelogCalls(), ['changelog PROJ-21 150+100', 'changelog PROJ-21 50+100', 'changelog PROJ-21 0+50']);
      assert.equal(recorded.origins[0].attributes.triggerId, '1010');
    });

    it('R24: an app\'s trigger reads back to the nearest earlier person — the requester, not the reporter', async () => {
      const earlierPerson: JiraAccount = { accountId: 'earlier-person', accountType: 'atlassian' };
      const all = createLongChangelog(new Map<number, Partial<JiraChangelogHistory>>([
        [40, { author: earlierPerson, items: [{ field: 'summary' }] }],
        [220, { items: [{ field: 'assignee', to: aiAccountId }] }],
      ]));
      changelogPages.set('PROJ-22', all);
      searchPages = [{ issues: [truncated('PROJ-22', all)] }];
      await createInbound().pollOnce();
      assert.equal(recorded.origins[0].attributes.triggerId, '1220');
      assert.equal(recorded.origins[0].attributes.requester, 'earlier-person');
      assert.equal(getChangelogCalls().length, 3, 'read back until the person was found');
    });
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
          ...emptyIssueContext,
        },
      });
      inbound.start();
      await waitMs(120);
      inbound.stop();
      assert.ok(polls >= 2, `${polls} polls`);
      assert.equal(maxRunning, 1);
    });

    it('R22: polls that keep failing back off — the base interval doubled per failure, up to a cap', async () => {
      assert.deepEqual([0, 1, 2, 3].map((failures) => getJiraRetryDelayMs(1_000, failures)), [1_000, 2_000, 4_000, 8_000]);
      assert.equal(getJiraRetryDelayMs(60_000, 10), jiraRetryBackoffCapMs);
      assert.equal(getJiraRetryDelayMs(jiraRetryBackoffCapMs * 2, 3), jiraRetryBackoffCapMs * 2, 'never below the base interval');
      const pollTimes: number[] = [];
      const flaky = createInbound({
        pollIntervalMs: 10,
        client: {
          searchIssues: async () => {
            pollTimes.push(Date.now());
            throw new Error('Jira 503');
          },
          getChangelogPage: async () => ({ startAt: 0, maxResults: 0, total: 0, values: [] }),
          getIssue: async (issueKey) => createIssue(issueKey),
          ...emptyIssueContext,
        },
      });
      flaky.start();
      await waitMs(200);
      flaky.stop();
      // 10, 20, 40, 80 ms waits: at most five polls in 200 ms (a fixed 10 ms interval would make ~20).
      assert.ok(pollTimes.length >= 3 && pollTimes.length <= 5, `${pollTimes.length} polls`);
      const gaps = pollTimes.slice(1).map((time, index) => time - pollTimes[index]);
      assert.ok(gaps.every((gap, index) => index === 0 || gap > gaps[index - 1]), `growing waits: ${gaps.join(', ')}`);
    });

    it('R22: a poll that succeeds again resets the backoff to the base interval', async () => {
      let polls = 0;
      const recovering = createInbound({
        pollIntervalMs: 10,
        client: {
          searchIssues: async () => {
            polls += 1;
            // Three failures (waits 20, 40, 80 ms), then healthy.
            if (polls <= 3) throw new Error('Jira 503');
            return { issues: [] };
          },
          getChangelogPage: async () => ({ startAt: 0, maxResults: 0, total: 0, values: [] }),
          getIssue: async (issueKey) => createIssue(issueKey),
          ...emptyIssueContext,
        },
      });
      recovering.start();
      await waitMs(400);
      recovering.stop();
      // ~140 ms of backoff, then ~10 ms polls: well over a dozen. Without the reset it stays at 80 ms: about five.
      assert.ok(polls >= 12, `${polls} polls`);
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
          ...emptyIssueContext,
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
          ...emptyIssueContext,
        },
      });
      flaky.start();
      await waitMs(60);
      flaky.stop();
      assert.ok(flakyPolls >= 2, `${flakyPolls} polls`);
    });
  });
});
