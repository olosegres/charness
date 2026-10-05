import * as http from 'http';
import { z } from 'zod';
import { adfNodeSchema, type AdfDocument, type AdfNode } from '../../connectors/jira/adf';
import type { JiraAccount } from '../../connectors/jira/client';

/**
 * @description A Jira Cloud stand-in for the process-level end-to-end test
 * (Jira connector plan J7): a `node:http` server on loopback serving the REST
 * calls the connector makes, over an in-memory model of issues, changelogs and
 * comments. The test plays the requester by changing the model directly
 * ({@link FakeJira.assignIssue}), the way a person would in Jira; the connector
 * sees it only through the API. The search ignores its JQL on purpose and
 * returns EVERY issue, so the connector's own re-check (D13) is what keeps an
 * issue of another project out. Like real Jira it answers 401 to any other
 * credentials than the AI account's, and 400 to a comment body that is not a
 * valid ADF document (an empty text node included).
 */

export interface FakeJiraStatus {
  id: string;
  name: string;
}

export interface FakeJiraComment {
  id: string;
  author: JiraAccount;
  created: string;
  body: AdfDocument;
}

interface FakeJiraChangelogItem {
  field: string;
  fieldId: string;
  from: string | null;
  to: string | null;
}

interface FakeJiraHistory {
  id: string;
  created: string;
  author: JiraAccount;
  items: FakeJiraChangelogItem[];
}

export interface FakeJiraIssue {
  id: string;
  key: string;
  summary: string;
  description: string;
  statusId: string;
  assignee: JiraAccount | null;
  reporter: JiraAccount;
  created: string;
  histories: FakeJiraHistory[];
  comments: FakeJiraComment[];
}

/** What a new issue is made of; the rest is filled in as Jira would. */
export type FakeJiraNewIssue = Pick<FakeJiraIssue, 'key' | 'summary' | 'description' | 'statusId' | 'reporter'>;

export interface FakeJiraOptions {
  aiAccount: JiraAccount;
  /** The only basic-auth credentials accepted — the AI account's email and API token. */
  credentials: { email: string; apiToken: string };
  /** Every project's statuses (one issue type). */
  statuses: FakeJiraStatus[];
}

/** What the connector sends in a request body — only the fields the fake reads. */
interface FakeJiraRequestBody {
  expand?: string;
  body?: AdfDocument;
  accountId?: string;
}

const jsonContentType = 'application/json';
const restPrefix = '/rest/api/3';
/** The connector's poll, as {@link FakeJira.requestLog} records it. */
export const fakeJiraSearchRequest = `POST ${restPrefix}/search/jql`;

/** A comment body as Jira validates it: an ADF document. */
const commentBodySchema = z.object({ type: z.literal('doc'), version: z.literal(1), content: z.array(adfNodeSchema) });

function createAdfParagraph(text: string): AdfDocument {
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

/** ADF refuses an empty text node (`minLength: 1`). */
function checkHasEmptyTextNode(nodes: readonly AdfNode[]): boolean {
  return nodes.some((node) => (node.type === 'text' && !node.text) || checkHasEmptyTextNode(node.content ?? []));
}

export class FakeJira {
  private readonly server: http.Server;
  private readonly issues = new Map<string, FakeJiraIssue>();
  private nextHistoryId = 1000;
  private nextCommentId = 5000;
  /** `METHOD path` of every request, in order. */
  readonly requestLog: string[] = [];

  constructor(private readonly options: FakeJiraOptions) {
    this.server = http.createServer((request, response) => {
      // A fake that throws must answer, not take the test process down with an unhandled rejection.
      this.handle(request, response).catch((error: Error) => {
        if (!response.headersSent) response.writeHead(500, { 'content-type': jsonContentType });
        response.end(JSON.stringify({ errorMessages: [`fake Jira failed: ${error.message}`] }));
      });
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (address === null || typeof address === 'string') throw new Error('fake Jira is not listening on a TCP port');
    return `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** @description A new issue, unassigned, as its reporter created it. */
  createIssue(issue: FakeJiraNewIssue): void {
    this.issues.set(issue.key, {
      ...issue,
      id: (this.issues.size + 1).toString(),
      assignee: null,
      created: new Date().toISOString(),
      histories: [],
      comments: [],
    });
  }

  /** @description Assign the issue, recording the change in its changelog under `author`. */
  assignIssue(issueKey: string, assignee: JiraAccount, author: JiraAccount): void {
    const issue = this.getIssue(issueKey);
    this.addHistory(issue, author, { field: 'assignee', fieldId: 'assignee', from: issue.assignee?.accountId ?? null, to: assignee.accountId });
    issue.assignee = assignee;
  }

  getIssue(issueKey: string): FakeJiraIssue {
    const issue = this.issues.get(issueKey);
    if (!issue) throw new Error(`fake Jira has no issue ${issueKey}`);
    return issue;
  }

  private addHistory(issue: FakeJiraIssue, author: JiraAccount, changelogItem: FakeJiraChangelogItem): void {
    this.nextHistoryId += 1;
    issue.histories.push({ id: this.nextHistoryId.toString(), created: new Date().toISOString(), author, items: [changelogItem] });
  }

  private getExpectedAuthorization(): string {
    const { email, apiToken } = this.options.credentials;
    return `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;
  }

  private getIssueJson(issue: FakeJiraIssue, isChangelogExpanded: boolean): object {
    return {
      id: issue.id,
      key: issue.key,
      fields: {
        summary: issue.summary,
        status: this.options.statuses.find((status) => status.id === issue.statusId),
        assignee: issue.assignee,
        reporter: issue.reporter,
        creator: issue.reporter,
        created: issue.created,
        description: createAdfParagraph(issue.description),
        comment: { total: issue.comments.length, comments: issue.comments },
      },
      ...(isChangelogExpanded
        ? { changelog: { startAt: 0, maxResults: issue.histories.length, total: issue.histories.length, histories: [...issue.histories].reverse() } }
        : {}),
    };
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const method = request.method ?? 'GET';
    this.requestLog.push(`${method} ${url.pathname}`);
    const send = (status: number, body?: object): void => {
      response.writeHead(status, body === undefined ? {} : { 'content-type': jsonContentType });
      response.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (request.headers.authorization !== this.getExpectedAuthorization()) {
      send(401, { errorMessages: ['Client must be authenticated to access this resource.'] });
      return;
    }
    const requestBody = await this.readBody(request);
    const route = url.pathname.startsWith(restPrefix) ? url.pathname.slice(restPrefix.length) : url.pathname;
    const issueMatch = /^\/issue\/([^/]+)(\/(changelog|comment|assignee|remotelink))?$/.exec(route);
    const statusesMatch = /^\/project\/([^/]+)\/statuses$/.exec(route);

    if (method === 'GET' && route === '/myself') {
      send(200, { accountId: this.options.aiAccount.accountId });
    } else if (method === 'GET' && statusesMatch) {
      send(200, [{ statuses: this.options.statuses }]);
    } else if (method === 'POST' && route === '/search/jql') {
      const isChangelogExpanded = requestBody.expand === 'changelog';
      send(200, { issues: [...this.issues.values()].map((issue) => this.getIssueJson(issue, isChangelogExpanded)), isLast: true });
    } else if (issueMatch) {
      const issue = this.issues.get(decodeURIComponent(issueMatch[1]));
      if (!issue) {
        send(404, { errorMessages: ['Issue does not exist or you do not have permission to see it.'] });
        return;
      }
      this.handleIssueRoute(method, issue, issueMatch[3], url, requestBody, send);
    } else {
      send(404, { errorMessages: [`fake Jira does not serve ${method} ${url.pathname}`] });
    }
  }

  private handleIssueRoute(
    method: string,
    issue: FakeJiraIssue,
    subresource: string | undefined,
    url: URL,
    requestBody: FakeJiraRequestBody,
    send: (status: number, body?: object) => void,
  ): void {
    if (method === 'GET' && subresource === undefined) {
      send(200, this.getIssueJson(issue, false));
    } else if (method === 'GET' && subresource === 'changelog') {
      const startAt = Number(url.searchParams.get('startAt') ?? 0);
      const maxResults = Number(url.searchParams.get('maxResults') ?? issue.histories.length);
      const values = issue.histories.slice(startAt, startAt + maxResults);
      send(200, { startAt, maxResults, total: issue.histories.length, isLast: startAt + values.length >= issue.histories.length, values });
    } else if (method === 'POST' && subresource === 'comment') {
      const parsedBody = commentBodySchema.safeParse(requestBody.body);
      if (!parsedBody.success || checkHasEmptyTextNode(parsedBody.data.content)) {
        send(400, { errorMessages: ['INVALID_INPUT'] });
        return;
      }
      this.nextCommentId += 1;
      const comment: FakeJiraComment = {
        id: this.nextCommentId.toString(),
        author: this.options.aiAccount,
        created: new Date().toISOString(),
        body: parsedBody.data,
      };
      issue.comments.push(comment);
      send(201, { id: comment.id });
    } else if (method === 'GET' && subresource === 'comment') {
      // `orderBy=-created` is newest first (the read-back); `created` (or none) is oldest first, paged like Jira's.
      const ordered = url.searchParams.get('orderBy') === '-created' ? [...issue.comments].reverse() : [...issue.comments];
      const startAt = Number(url.searchParams.get('startAt') ?? 0);
      const maxResults = Number(url.searchParams.get('maxResults') ?? ordered.length);
      send(200, { startAt, maxResults, total: ordered.length, comments: ordered.slice(startAt, startAt + maxResults) });
    } else if (method === 'GET' && subresource === 'remotelink') {
      send(200, []);
    } else if (method === 'PUT' && subresource === 'assignee') {
      const accountId = requestBody.accountId;
      if (typeof accountId !== 'string') {
        send(400, { errorMessages: ['accountId is required'] });
        return;
      }
      this.addHistory(issue, this.options.aiAccount, { field: 'assignee', fieldId: 'assignee', from: issue.assignee?.accountId ?? null, to: accountId });
      issue.assignee = { accountId };
      send(204);
    } else {
      send(404, { errorMessages: [`fake Jira does not serve ${method} on an issue's ${subresource ?? 'fields'}`] });
    }
  }

  private async readBody(request: http.IncomingMessage): Promise<FakeJiraRequestBody> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : {};
  }
}
