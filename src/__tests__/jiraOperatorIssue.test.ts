/**
 * @description The Jira OPERATOR ISSUE (`jira.json` `operatorIssue`, `connectors/jira/operatorIssue.ts`): on an instance with no
 * Telegram General, the issue the bot tells its operator on.
 *
 *   • `operatorIssue` is an issue key, `operatorAccountIds` (the operator's Jira accounts) needs it; both optional;
 *   • the boot reads the issue: one the AI account cannot see refuses the start, naming the key's field;
 *   • an alert is a comment there by the AI account — one that asks to act opens with a mention of the operator accounts, a recovery
 *     line mentions nobody; a failed post is a result, never a throw, and is not retried;
 *   • the poller never sees the issue — not in the search, not by its key (a 404, as for an issue out of reach): a hand-over, a
 *     comment or a mention on it opens no request, and what the poller kept for it from before is dropped.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';

import { operatorAccountIdsNeedIssueError, validateJiraConfig } from '../connectors/jira/config';
import { getJiraConfigPath } from '../connectors/jira/configFile';
import { JiraConnectorStartError, jiraOperatorIssueUnseenError, prepareJiraConnector, type JiraConnector } from '../connectors/jira/connector';
import { createJiraOperatorChannel, hideJiraOperatorIssue } from '../connectors/jira/operatorIssue';
import { getAdfText, getMentionedAccountIds, type AdfDocument } from '../connectors/jira/adf';
import { JiraHttpError, type JiraClient, type JiraIssue } from '../connectors/jira/client';
import { createUnlimitedSlots } from './taskAgentSlotsTestKit';

const isolatedOpenCodeUrl = 'http://127.0.0.1:4196';
const aiAccountId = 'ai-account';
const operatorAccountId = 'operator-account';

describe('jira.json operatorIssue and operatorAccountIds', () => {
  let workRoot = '';
  before(() => {
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-operator-config-'));
    fs.mkdirSync(path.join(workRoot, 'proj-work'));
  });
  after(() => fs.rmSync(workRoot, { recursive: true, force: true }));

  const validate = (overrides: object) => validateJiraConfig({
    site: 'example.atlassian.net',
    email: 'ai-account@example.com',
    apiToken: 'placeholder-token',
    accountId: aiAccountId,
    projects: { PROJ: { folder: 'proj-work', triggerStatuses: ['To Do'] } },
    ...overrides,
  }, { workRoot, openCodeUrl: isolatedOpenCodeUrl });

  it('both are optional: none means no operator issue and nobody to mention', () => {
    const result = validate({});
    assert.ok(result.ok);
    assert.equal(result.config.operatorIssueKey, null);
    assert.deepEqual(result.config.operatorAccountIds, []);
  });

  it('an issue key, and the operator accounts once each', () => {
    const result = validate({ operatorIssue: 'OPS-12', operatorAccountIds: [operatorAccountId, operatorAccountId, 'second-operator'] });
    assert.ok(result.ok);
    assert.equal(result.config.operatorIssueKey, 'OPS-12');
    assert.deepEqual(result.config.operatorAccountIds, [operatorAccountId, 'second-operator']);
  });

  it('refused: something that is no issue key (naming the field, not the value), accounts without an issue, an empty or spaced id', () => {
    for (const operatorIssue of ['OPS', 'ops-12', 'OPS-012', 'https://example.atlassian.net/browse/OPS-12']) {
      const result = validate({ operatorIssue });
      assert.ok(!result.ok);
      assert.deepEqual(result.errors, ['jira.json operatorIssue: not a Jira issue key'], operatorIssue);
    }
    const withoutIssue = validate({ operatorAccountIds: [operatorAccountId] });
    assert.ok(!withoutIssue.ok);
    assert.deepEqual(withoutIssue.errors, [operatorAccountIdsNeedIssueError]);
    for (const operatorAccountIds of [[], ['two words']]) {
      const result = validate({ operatorIssue: 'OPS-12', operatorAccountIds });
      assert.ok(!result.ok, JSON.stringify(operatorAccountIds));
      assert.match(result.errors[0], /^jira\.json operatorAccountIds/);
    }
  });
});

describe('the operator channel', () => {
  const createClient = (options: { failAt?: number } = {}) => {
    const posted: Array<{ issueKey: string; body: AdfDocument }> = [];
    const client: Pick<JiraClient, 'addComment'> = {
      addComment: async (issueKey, body) => {
        if (posted.length === options.failAt) throw new Error('Jira answered 503');
        posted.push({ issueKey, body });
        return { id: `${20000 + posted.length}` } as Awaited<ReturnType<JiraClient['addComment']>>;
      },
    };
    return { client, posted };
  };

  it('an alert that asks the operator to act is a comment on the issue that opens with a mention of every operator account', async () => {
    const { client, posted } = createClient();
    const channel = createJiraOperatorChannel({ client, issueKey: 'OPS-12', operatorAccountIds: [operatorAccountId, 'second-operator'] });
    assert.equal(channel.label, 'jira OPS-12');
    assert.deepEqual(await channel.post('⚠️ Action needed: Claude account «default» is signed out.', { isActionRequired: true }), { ok: true });
    assert.equal(posted.length, 1);
    assert.equal(posted[0].issueKey, 'OPS-12');
    assert.deepEqual(getMentionedAccountIds(posted[0].body), [operatorAccountId, 'second-operator']);
    assert.equal(posted[0].body.content[0].type, 'paragraph', 'the mention paragraph comes first');
    assert.match(getAdfText(posted[0].body), /Action needed: Claude account «default» is signed out\.$/);
  });

  it('a recovery line mentions nobody, and neither does any alert without operator accounts', async () => {
    const { client, posted } = createClient();
    await createJiraOperatorChannel({ client, issueKey: 'OPS-12', operatorAccountIds: [operatorAccountId] }).post('✅ back', { isActionRequired: false });
    await createJiraOperatorChannel({ client, issueKey: 'OPS-12', operatorAccountIds: [] }).post('⚠️ Action needed', { isActionRequired: true });
    assert.deepEqual(posted.map(({ body }) => getMentionedAccountIds(body)), [[], []]);
  });

  it('a refused post is a result naming the issue, never a throw, and nothing is posted twice', async () => {
    const { client, posted } = createClient({ failAt: 0 });
    const result = await createJiraOperatorChannel({ client, issueKey: 'OPS-12', operatorAccountIds: [] }).post('⚠️ Action needed', { isActionRequired: true });
    assert.deepEqual(result, { ok: false, error: 'the alert comment on OPS-12 was not posted: Jira answered 503' });
    assert.equal(posted.length, 0);
  });
});

describe('hideJiraOperatorIssue', () => {
  const issueOf = (key: string): JiraIssue => ({ id: key, key, fields: {} }) as unknown as JiraIssue;

  it('the search leaves the operator issue out of every page; a read of it by its key is a 404 that never reaches Jira; every other call is the client\'s own', async () => {
    const reads: string[] = [];
    const client = {
      searchIssues: async () => ({ issues: [issueOf('PROJ-1'), issueOf('OPS-12'), issueOf('PROJ-2')], isLast: true, nextPageToken: null }),
      getIssue: async (issueKey: string) => {
        reads.push(issueKey);
        return issueOf(`${issueKey}-read`);
      },
    } as unknown as Pick<JiraClient, 'searchIssues' | 'getIssue'>;
    const hidden = hideJiraOperatorIssue(client, 'OPS-12');
    const page = await hidden.searchIssues({ jql: 'x', fields: [], isChangelogExpanded: true, maxResults: 50 });
    assert.deepEqual(page.issues.map((issue) => issue.key), ['PROJ-1', 'PROJ-2']);
    assert.equal(page.isLast, true);
    assert.equal((await hidden.getIssue('PROJ-1', [])).key, 'PROJ-1-read');
    await assert.rejects(hidden.getIssue('OPS-12', []), (error: unknown) => error instanceof JiraHttpError && error.status === 404);
    assert.deepEqual(reads, ['PROJ-1'], 'the operator issue is never read for the poller');
  });

  it('without an operator issue the client is handed on as it is', () => {
    const client = { searchIssues: async () => ({ issues: [], isLast: true }), getIssue: async () => issueOf('X-1') } as unknown as Pick<JiraClient, 'searchIssues' | 'getIssue'>;
    assert.equal(hideJiraOperatorIssue(client, null), client);
  });
});

describe('the operator issue of a prepared connector', () => {
  let server: http.Server;
  let baseUrl = '';
  let dataDir = '';
  let workRoot = '';
  let connector: JiraConnector | null = null;
  const requestPaths: string[] = [];
  const postedComments: AdfDocument[] = [];
  const operatorIssue = {
    id: '10009',
    key: 'PROJ-9',
    fields: {
      summary: 'Operator alerts', status: { id: '10001', name: 'To Do' }, assignee: { accountId: aiAccountId, accountType: 'atlassian' },
      reporter: { accountId: operatorAccountId, accountType: 'atlassian' }, creator: { accountId: operatorAccountId, accountType: 'atlassian' },
      created: '2026-11-20T08:00:00.000+0000', updated: '2026-11-20T08:00:00.000+0000', description: null, issuetype: { name: 'Task' }, labels: [],
    },
    changelog: { startAt: 0, maxResults: 100, total: 0, histories: [] },
  };

  before(async () => {
    server = http.createServer((request, response) => {
      const url = request.url ?? '';
      requestPaths.push(`${request.method} ${url.split('?')[0]}`);
      let body = '';
      request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
      request.on('end', () => {
        const sendJson = (value: object, status = 200): void => {
          response.writeHead(status, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify(value));
        };
        if (url === '/rest/api/3/myself') return sendJson({ accountId: aiAccountId });
        if (url === '/rest/api/3/project/PROJ/statuses') return sendJson([{ statuses: [{ id: '10001', name: 'To Do' }] }]);
        // The operator issue matches the poll exactly as a hand-over would: assigned to the AI, in a trigger status.
        if (url === '/rest/api/3/search/jql') return sendJson({ issues: [operatorIssue], isLast: true });
        if (url.startsWith('/rest/api/3/issue/PROJ-9?')) return sendJson(operatorIssue);
        if (request.method === 'POST' && url === '/rest/api/3/issue/PROJ-9/comment') {
          postedComments.push(JSON.parse(body).body);
          return sendJson({ id: '20001' }, 201);
        }
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ errorMessages: ['Issue does not exist or you do not have permission to see it.'] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address: AddressInfo | string | null = server.address();
    assert.ok(address !== null && typeof address === 'object');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-operator-data-'));
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-operator-work-'));
    fs.mkdirSync(path.join(workRoot, 'proj-work'));
    requestPaths.length = 0;
    postedComments.length = 0;
  });
  afterEach(async () => {
    connector?.stop();
    connector = null;
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workRoot, { recursive: true, force: true });
  });

  const prepareWith = (overrides: object): Promise<JiraConnector> => {
    fs.writeFileSync(getJiraConfigPath(dataDir), JSON.stringify({
      site: 'example.atlassian.net',
      baseUrl,
      email: 'ai-account@example.com',
      apiToken: 'placeholder-token',
      accountId: aiAccountId,
      projects: { PROJ: { folder: 'proj-work', triggerStatuses: ['To Do'] } },
      pollIntervalSeconds: 600,
      ...overrides,
    }));
    return prepareJiraConnector({ dataDir, workRoot, openCodeUrl: isolatedOpenCodeUrl });
  };

  it('an operator issue the AI account cannot see refuses the start, naming the field', async () => {
    await assert.rejects(prepareWith({ operatorIssue: 'PROJ-404' }), (error: unknown) => {
      assert.ok(error instanceof JiraConnectorStartError);
      assert.deepEqual(error.reasons, [jiraOperatorIssueUnseenError]);
      return true;
    });
  });

  it('without one there is no channel, and the issue is never read', async () => {
    connector = await prepareWith({});
    assert.equal(connector.operatorChannel, null);
    assert.ok(!requestPaths.some((requestPath) => requestPath.startsWith('GET /rest/api/3/issue/')));
  });

  it('the channel comments on it with the operator mentioned, and the poller makes no request of it however it matches', async () => {
    connector = await prepareWith({ operatorIssue: 'PROJ-9', operatorAccountIds: [operatorAccountId] });
    assert.ok(requestPaths.includes('GET /rest/api/3/issue/PROJ-9'), 'read at boot');
    const created: string[] = [];
    connector.start({
      bindConversation: async () => {},
      createRequest: async (key) => {
        created.push(key.thread);
        return { id: 'req_1', supersededRequestIds: [] };
      },
      listOpenRequests: () => [],
      postUpdate: async () => {},
      postRequest: async () => {},
      slots: createUnlimitedSlots(),
    });
    for (let attempt = 0; attempt < 200 && !requestPaths.includes('POST /rest/api/3/search/jql'); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(requestPaths.includes('POST /rest/api/3/search/jql'), 'the poll ran');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(created, [], 'no request of the operator issue');
    assert.ok(!requestPaths.some((requestPath) => requestPath.includes('/rest/api/3/issue/PROJ-9/changelog')), 'its trigger is not even read');
    assert.deepEqual(postedComments, [], 'no notice posted on it by the poll');

    assert.ok(connector.operatorChannel);
    assert.deepEqual(await connector.operatorChannel.post('⚠️ Action needed: Claude account «default» is signed out.', { isActionRequired: true }), { ok: true });
    assert.equal(postedComments.length, 1);
    assert.deepEqual(getMentionedAccountIds(postedComments[0]), [operatorAccountId]);
  });
});
