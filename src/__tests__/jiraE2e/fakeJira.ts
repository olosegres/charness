import * as http from 'http';
import type { AdfDocument } from '../../connectors/jira/adf';
import type { JiraAccount } from '../../connectors/jira/client';

/**
 * @description A Jira Cloud stand-in for the process-level end-to-end test
 * (Jira connector plan J7): a `node:http` server on loopback serving the REST
 * calls the connector makes, over an in-memory model of issues, changelogs and
 * comments. The test plays the requester by changing the model directly
 * ({@link FakeJira.assignIssue}), the way a person would in Jira; the connector
 * sees it only through the API. The search ignores its JQL on purpose and
 * returns EVERY issue, so the connector's own re-check (D13) is what keeps an
 * issue of another project out.
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

interface FakeJiraHistory {
  id: string;
  created: string;
  author: JiraAccount;
  items: Array<{ field: string; fieldId: string; from: string | null; to: string | null }>;
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

export interface FakeJiraOptions {
  aiAccount: JiraAccount;
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

function createAdfParagraph(text: string): AdfDocument {
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
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
  createIssue(issue: { key: string; summary: string; description: string; statusId: string; reporter: JiraAccount }): void {
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
    const issue = this.getIssueOrThrow(issueKey);
    this.addHistory(issue, author, { field: 'assignee', fieldId: 'assignee', from: issue.assignee?.accountId ?? null, to: assignee.accountId });
    issue.assignee = assignee;
  }

  getIssue(issueKey: string): FakeJiraIssue {
    return this.getIssueOrThrow(issueKey);
  }

  private getIssueOrThrow(issueKey: string): FakeJiraIssue {
    const issue = this.issues.get(issueKey);
    if (!issue) throw new Error(`fake Jira has no issue ${issueKey}`);
    return issue;
  }

  private addHistory(issue: FakeJiraIssue, author: JiraAccount, item: FakeJiraHistory['items'][number]): void {
    this.nextHistoryId += 1;
    issue.histories.push({ id: this.nextHistoryId.toString(), created: new Date().toISOString(), author, items: [item] });
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
    if (!request.headers.authorization?.startsWith('Basic ')) {
      send(401, { errorMessages: ['missing credentials'] });
      return;
    }
    const requestBody = await this.readBody(request);
    const route = url.pathname.startsWith(restPrefix) ? url.pathname.slice(restPrefix.length) : url.pathname;
    const issueMatch = /^\/issue\/([^/]+)(\/(changelog|comment|assignee))?$/.exec(route);
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
      if (requestBody.body === undefined) {
        send(400, { errorMessages: ['body is required'] });
        return;
      }
      this.nextCommentId += 1;
      const comment: FakeJiraComment = {
        id: this.nextCommentId.toString(),
        author: this.options.aiAccount,
        created: new Date().toISOString(),
        body: requestBody.body,
      };
      issue.comments.push(comment);
      send(201, { id: comment.id });
    } else if (method === 'GET' && subresource === 'comment') {
      send(200, { total: issue.comments.length, comments: [...issue.comments].reverse() });
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
