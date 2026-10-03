/**
 * @description The Jira Cloud REST client (plan J4, D13/D14) against a real
 * loopback HTTP server: basic auth, each method's path and body, schema
 * validation, and the retry policy — 429 honours `Retry-After` for any request,
 * 5xx / network / timeout repeat only a request that is safe to repeat (a
 * comment POST never: it would post the answer twice), 401/403 never repeat.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
import type { AddressInfo } from 'net';
import {
  createJiraClient,
  jiraBackoffJitterRatio,
  jiraBackoffMs,
  jiraMaxAttempts,
  jiraRetryAfterCapMs,
  JiraAuthError,
  JiraHttpError,
  type JiraClient,
} from '../connectors/jira/client';
import { convertMarkdownToAdf } from '../connectors/jira/adf';

const email = 'ai-account@example.com';
const apiToken = 'token-value-never-echoed';

interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: string;
}

interface CannedResponse {
  status: number;
  body?: string;
  headers?: Record<string, string>;
  /** Never answer: the client's timeout must fire. */
  isHanging?: boolean;
  /** Send the headers and part of the body, then drop the connection. */
  isBodyCut?: boolean;
}

let server: http.Server;
let baseUrl = '';
let requests: RecordedRequest[] = [];
let responses: CannedResponse[] = [];
let sleeps: number[] = [];

function respondWith(...canned: CannedResponse[]): void {
  responses = canned;
}

function createClient(overrides: { timeoutMs?: number; fetchImpl?: typeof fetch; randomImpl?: () => number } = {}): JiraClient {
  return createJiraClient({
    baseUrl: `${baseUrl}/`,
    email,
    apiToken,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
    // No jitter unless a test asks for it, so the waits are the backoff itself.
    randomImpl: () => 0,
    ...overrides,
  });
}

const commentBody = convertMarkdownToAdf('x');

/** The refused-connection error `fetch` raises: nothing was sent. */
function createRefusedFetchError(): TypeError {
  const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' });
  return new TypeError('fetch failed', { cause });
}

const json = (value: object): string => JSON.stringify(value);

describe('createJiraClient', () => {
  before(async () => {
    server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        requests.push({
          method: request.method ?? '',
          url: request.url ?? '',
          authorization: request.headers.authorization,
          contentType: request.headers['content-type'],
          body: Buffer.concat(chunks).toString('utf8'),
        });
        const canned = responses.shift() ?? { status: 500, body: 'no canned response left' };
        if (canned.isHanging) return;
        if (canned.isBodyCut) {
          response.writeHead(canned.status, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
          response.write('{"accountId":');
          setImmediate(() => response.destroy());
          return;
        }
        response.writeHead(canned.status, { 'Content-Type': 'application/json', ...canned.headers });
        response.end(canned.body ?? '');
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
    requests = [];
    responses = [];
    sleeps = [];
  });

  describe('requests', () => {
    it('getMyself: basic auth of email + token, the trailing slash of baseUrl dropped', async () => {
      respondWith({ status: 200, body: json({ accountId: 'placeholder-account', displayName: 'ignored' }) });
      assert.deepEqual(await createClient().getMyself(), { accountId: 'placeholder-account' });
      assert.equal(requests.length, 1);
      assert.equal(requests[0].method, 'GET');
      assert.equal(requests[0].url, '/rest/api/3/myself');
      assert.equal(requests[0].authorization, `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`);
      assert.equal(requests[0].body, '');
    });

    it('searchIssues: POST /search/jql with fields, changelog expansion and the page token', async () => {
      const issue = {
        id: '10100',
        key: 'PROJ-7',
        fields: {
          summary: 'Do it',
          status: { id: '10001', name: 'AI To Do' },
          assignee: { accountId: 'placeholder-account' },
          description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }] },
        },
        changelog: { startAt: 0, maxResults: 100, total: 1, histories: [
          { id: '1', created: '2026-10-02T10:00:00.000+0000', items: [{ field: 'status', from: '1', to: '10001' }] },
          { id: '2', created: '2026-10-02T10:01:00.000+0000', items: [{ field: 'assignee', from: null, fromString: null, to: 'placeholder-account', toString: 'AI' }] },
        ] },
      };
      respondWith({ status: 200, body: json({ issues: [issue], nextPageToken: 'page-2', isLast: false }) });
      const result = await createClient().searchIssues({
        jql: 'project = PROJ',
        fields: ['summary', 'status'],
        isChangelogExpanded: true,
        maxResults: 50,
        nextPageToken: 'page-1',
      });
      assert.equal(result.issues[0].key, 'PROJ-7');
      // An item without `toString` (the first) must not fail on the inherited Object.prototype.toString.
      assert.deepEqual(result.issues[0].changelog?.histories.map((history) => history.items[0]), [
        { field: 'status', from: '1', to: '10001' },
        { field: 'assignee', from: null, to: 'placeholder-account' },
      ]);
      assert.equal(result.nextPageToken, 'page-2');
      assert.equal(requests[0].method, 'POST');
      assert.equal(requests[0].url, '/rest/api/3/search/jql');
      assert.equal(requests[0].contentType, 'application/json');
      assert.deepEqual(JSON.parse(requests[0].body), {
        jql: 'project = PROJ', fields: ['summary', 'status'], maxResults: 50, expand: 'changelog', nextPageToken: 'page-1',
      });
    });

    it('searchIssues without expansion or page token sends neither key', async () => {
      respondWith({ status: 200, body: json({ issues: [] }) });
      await createClient().searchIssues({ jql: 'x', fields: [], isChangelogExpanded: false, maxResults: 1 });
      assert.deepEqual(JSON.parse(requests[0].body), { jql: 'x', fields: [], maxResults: 1 });
    });

    it('searchIssues accepts the last page\'s null token — Jira documents null there, not an absent key', async () => {
      respondWith({ status: 200, body: json({ issues: [], nextPageToken: null, isLast: true }) });
      const result = await createClient().searchIssues({ jql: 'x', fields: [], isChangelogExpanded: false, maxResults: 1 });
      assert.equal(result.nextPageToken, null);
      assert.equal(result.isLast, true);
    });

    it('getChangelogPage, getIssue: paths with the key encoded and the fields joined', async () => {
      respondWith(
        { status: 200, body: json({ startAt: 100, maxResults: 100, total: 101, isLast: true, values: [] }) },
        { status: 200, body: json({ id: '10100', key: 'PROJ-7', fields: { summary: 'Do it' } }) },
      );
      const client = createClient();
      assert.equal((await client.getChangelogPage('PROJ-7', 100)).total, 101);
      assert.equal((await client.getIssue('PROJ-7', ['summary', 'comment'])).fields.summary, 'Do it');
      assert.deepEqual(requests.map((request) => `${request.method} ${request.url}`), [
        'GET /rest/api/3/issue/PROJ-7/changelog?startAt=100',
        'GET /rest/api/3/issue/PROJ-7?fields=summary,comment',
      ]);
    });

    it('addComment posts {body: ADF}; assignIssue PUTs the account and accepts an empty 204', async () => {
      const adf = convertMarkdownToAdf('Done.');
      respondWith({ status: 201, body: json({ id: '20001', self: 'ignored' }) }, { status: 204 });
      const client = createClient();
      assert.deepEqual(await client.addComment('PROJ-7', adf), { outcome: 'created', id: '20001' });
      await client.assignIssue('PROJ-7', 'placeholder-requester');
      assert.deepEqual(requests.map((request) => `${request.method} ${request.url}`), [
        'POST /rest/api/3/issue/PROJ-7/comment',
        'PUT /rest/api/3/issue/PROJ-7/assignee',
      ]);
      assert.deepEqual(JSON.parse(requests[0].body), { body: adf });
      assert.deepEqual(JSON.parse(requests[1].body), { accountId: 'placeholder-requester' });
    });

    it('getProjectStatuses flattens every issue type\'s statuses, deduplicated by id', async () => {
      respondWith({
        status: 200,
        body: json([
          { name: 'Task', statuses: [{ id: '1', name: 'To Do' }, { id: '10001', name: 'AI To Do' }] },
          { name: 'Bug', statuses: [{ id: '10001', name: 'AI To Do' }, { id: '3', name: 'Done' }] },
        ]),
      });
      assert.deepEqual(await createClient().getProjectStatuses('PROJ'), [
        { id: '1', name: 'To Do' }, { id: '10001', name: 'AI To Do' }, { id: '3', name: 'Done' },
      ]);
      assert.equal(requests[0].url, '/rest/api/3/project/PROJ/statuses');
    });
  });

  describe('responses that are not what Jira promised', () => {
    it('a body of the wrong shape is an error naming the field, not a half-typed object', async () => {
      respondWith({ status: 200, body: json({ displayName: 'no account id' }) });
      await assert.rejects(createClient().getMyself(), (error: Error) =>
        error instanceof JiraHttpError && error.message === 'Jira GET /rest/api/3/myself failed: unexpected response shape at accountId');
    });

    it('a 2xx that is not JSON is an error', async () => {
      respondWith({ status: 200, body: '<html>maintenance</html>' });
      await assert.rejects(createClient().getMyself(), /the response is not JSON/);
    });
  });

  describe('retries', () => {
    it('429 waits Retry-After seconds, then succeeds', async () => {
      respondWith({ status: 429, headers: { 'Retry-After': '2' } }, { status: 200, body: json({ accountId: 'a' }) });
      await createClient().getMyself();
      assert.equal(requests.length, 2);
      assert.deepEqual(sleeps, [2_000]);
    });

    it('429 retries even a comment POST — Jira refused it, nothing was created', async () => {
      respondWith({ status: 429, headers: { 'Retry-After': '1' } }, { status: 201, body: json({ id: '20001' }) });
      assert.deepEqual(await createClient().addComment('PROJ-7', convertMarkdownToAdf('x')), { outcome: 'created', id: '20001' });
      assert.equal(requests.length, 2);
    });

    it(`429 Retry-After is capped at ${jiraRetryAfterCapMs} ms; after ${jiraMaxAttempts} attempts the 429 is thrown`, async () => {
      respondWith(
        { status: 429, headers: { 'Retry-After': '3600' } },
        { status: 429 },
        { status: 429, body: json({ errorMessages: ['Rate limit exceeded'] }) },
      );
      await assert.rejects(createClient().getMyself(), (error: Error) =>
        error instanceof JiraHttpError && error.status === 429 && /Rate limit exceeded/.test(error.message));
      assert.equal(requests.length, jiraMaxAttempts);
      assert.deepEqual(sleeps, [jiraRetryAfterCapMs, jiraBackoffMs[1]], 'no Retry-After → the backoff');
    });

    it('5xx on a read is retried with the backoff', async () => {
      respondWith({ status: 503 }, { status: 502 }, { status: 200, body: json({ accountId: 'a' }) });
      await createClient().getMyself();
      assert.equal(requests.length, 3);
      assert.deepEqual(sleeps, [...jiraBackoffMs]);
    });

    it('a 5xx on a read with its own Retry-After waits that long (capped alike), not the backoff', async () => {
      respondWith(
        { status: 503, headers: { 'Retry-After': '7' } },
        { status: 503, headers: { 'Retry-After': '3600' } },
        { status: 200, body: json({ accountId: 'a' }) },
      );
      await createClient().getMyself();
      assert.equal(requests.length, 3);
      assert.deepEqual(sleeps, [7_000, jiraRetryAfterCapMs]);
    });

    it('5xx on a read, every attempt: the last status and Jira\'s messages are thrown', async () => {
      respondWith({ status: 503 }, { status: 503 }, { status: 503, body: json({ errorMessages: ['Down'], errors: { jql: 'bad' } }) });
      await assert.rejects(createClient().getMyself(), (error: Error) =>
        error instanceof JiraHttpError && error.message === 'Jira GET /rest/api/3/myself failed with 503: Down; jql: bad');
      assert.equal(requests.length, jiraMaxAttempts);
    });

    it('R18: 5xx on a comment POST is deliveryUnknown, never retried — the comment may exist already', async () => {
      respondWith({ status: 502, body: json({ errorMessages: ['Bad gateway'] }) }, { status: 201, body: json({ id: 'second-comment' }) });
      const result = await createClient().addComment('PROJ-7', commentBody);
      assert.equal(result.outcome, 'deliveryUnknown');
      assert.match(result.outcome === 'deliveryUnknown' ? result.reason : '', /outcome unknown — 502: Bad gateway/);
      assert.equal(requests.length, 1);
      assert.deepEqual(sleeps, []);
    });

    it('R18: a 2xx whose body does not name the comment is deliveryUnknown', async () => {
      respondWith({ status: 201, body: '<html>proxy</html>' });
      assert.deepEqual(await createClient().addComment('PROJ-7', commentBody), {
        outcome: 'deliveryUnknown',
        reason: 'Jira POST /rest/api/3/issue/PROJ-7/comment: the response is not JSON',
      });
    });

    it('R18: a comment POST that failed before anything was sent is an error, not unknown, and not retried', async () => {
      let calls = 0;
      const fetchImpl: typeof fetch = async () => {
        calls += 1;
        throw createRefusedFetchError();
      };
      await assert.rejects(createClient({ fetchImpl }).addComment('PROJ-7', commentBody), (error: Error) =>
        error instanceof JiraHttpError && error.status === 0 && /ECONNREFUSED/.test(error.message));
      assert.equal(calls, 1);
    });

    it('R18: a 4xx on a comment POST is an error — Jira refused it', async () => {
      respondWith({ status: 400, body: json({ errors: { comment: 'Comment body is too long' } }) });
      await assert.rejects(createClient().addComment('PROJ-7', commentBody), (error: Error) =>
        error instanceof JiraHttpError && error.status === 400 && /too long/.test(error.message));
    });

    it('a timeout on a read is retried; on a comment POST it is deliveryUnknown at once (R18)', async () => {
      respondWith({ status: 200, isHanging: true }, { status: 200, body: json({ accountId: 'a' }) });
      await createClient({ timeoutMs: 100 }).getMyself();
      assert.equal(requests.length, 2);
      assert.deepEqual(sleeps, [jiraBackoffMs[0]]);

      requests = [];
      respondWith({ status: 201, isHanging: true }, { status: 201, body: json({ id: 'second-comment' }) });
      assert.equal((await createClient({ timeoutMs: 100 }).addComment('PROJ-7', commentBody)).outcome, 'deliveryUnknown');
      assert.equal(requests.length, 1);
    });

    it('a connection dropped while the body streams: a read retries, a comment POST is deliveryUnknown (R18)', async () => {
      respondWith({ status: 200, isBodyCut: true }, { status: 200, body: json({ accountId: 'a' }) });
      assert.deepEqual(await createClient().getMyself(), { accountId: 'a' });
      assert.equal(requests.length, 2);

      requests = [];
      respondWith({ status: 201, isBodyCut: true }, { status: 201, body: json({ id: 'second-comment' }) });
      assert.equal((await createClient().addComment('PROJ-7', commentBody)).outcome, 'deliveryUnknown');
      assert.equal(requests.length, 1);
    });

    it('the backoff carries jitter: up to half again, from the random source', async () => {
      respondWith({ status: 503 }, { status: 503 }, { status: 200, body: json({ accountId: 'a' }) });
      await createClient({ randomImpl: () => 0.5 }).getMyself();
      assert.deepEqual(sleeps, jiraBackoffMs.map((ms) => ms * (1 + jiraBackoffJitterRatio * 0.5)));
    });

    it('a network failure on a read is retried', async () => {
      let calls = 0;
      const fetchImpl: typeof fetch = async (input, init) => {
        calls += 1;
        if (calls === 1) throw new TypeError('fetch failed');
        return fetch(input, init);
      };
      respondWith({ status: 200, body: json({ accountId: 'a' }) });
      await createClient({ fetchImpl }).getMyself();
      assert.equal(calls, 2);
    });

    it('a refused connection names its cause, not only "fetch failed"', async () => {
      const closedServer = http.createServer();
      await new Promise<void>((resolve) => closedServer.listen(0, '127.0.0.1', resolve));
      const address: AddressInfo | string | null = closedServer.address();
      assert.ok(address !== null && typeof address === 'object');
      await new Promise<void>((resolve) => closedServer.close(() => resolve()));
      const client = createJiraClient({ baseUrl: `http://127.0.0.1:${address.port}`, email, apiToken, sleepImpl: async () => {} });
      await assert.rejects(client.getMyself(), (error: Error) =>
        error instanceof JiraHttpError && error.status === 0 && /^Jira GET \/rest\/api\/3\/myself failed: fetch failed \(.*ECONNREFUSED/.test(error.message)
        && !error.message.includes(apiToken));
    });

    for (const status of [401, 403]) {
      it(`${status} is a JiraAuthError, never retried, never carrying the token`, async () => {
        respondWith({ status }, { status: 200, body: json({ accountId: 'a' }) });
        await assert.rejects(createClient().getMyself(), (error: Error) =>
          error instanceof JiraAuthError && error.status === status && !error.message.includes(apiToken));
        assert.equal(requests.length, 1);
      });
    }

    it('another 4xx is thrown at once with Jira\'s messages', async () => {
      respondWith({ status: 400, body: json({ errorMessages: ['The value \'X\' does not exist for the field \'project\'.'] }) });
      await assert.rejects(createClient().searchIssues({ jql: 'project = X', fields: [], isChangelogExpanded: false, maxResults: 1 }), (error: Error) =>
        error instanceof JiraHttpError && error.status === 400 && /does not exist/.test(error.message));
      assert.equal(requests.length, 1);
    });
  });
});
