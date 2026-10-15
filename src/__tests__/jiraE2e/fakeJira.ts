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
 * valid ADF document (an empty text node included). Groups ({@link FakeJira.addGroup})
 * are served by `group/bulk` (by exact name) and `group/member` (paged).
 *
 * The search keeps ignoring its JQL — except for the mention branch (`comment ~ currentUser()`): a JQL
 * that carries it is answered as Jira answers it — the issues assigned to the AI account in the listed
 * statuses, and the issues with a comment that holds a mention node of the AI account and changed within
 * the window — so a connector that forgot the branch finds no mention. Every change of an issue moves its
 * `updated` (strictly forward), as in Jira.
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
  /** Set by an edit ({@link FakeJira.editComment}). */
  updated?: string;
  updateAuthor?: JiraAccount;
}

/** A file attached to an issue; `content` is what the download answers with. */
export interface FakeJiraAttachment {
  id: string;
  filename: string;
  mimeType: string;
  content: Buffer;
  /** Who uploaded it; the issue's reporter when absent. */
  author?: JiraAccount;
}

interface FakeJiraGroup {
  groupId: string;
  name: string;
  members: JiraAccount[];
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
  /** Moves forward with every change of the issue: a comment added, edited or deleted, the description, the assignee. */
  updated: string;
  histories: FakeJiraHistory[];
  comments: FakeJiraComment[];
  attachments: FakeJiraAttachment[];
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
  jql?: string;
}

/** A person's comment or edit: who it mentions (each a real ADF mention node, first in the paragraph, as the editor writes them). */
export interface FakeJiraCommentOptions {
  mentions?: JiraAccount[];
}

/** The mention clause of the connector's poll JQL, and the pieces the fake reads out of that JQL. */
const mentionClause = 'comment ~ currentUser()';
const mentionWindowRe = /updated >= -(\d+)m/;
const assignedStatusesRe = /assignee = currentUser\(\) AND status in \(([^)]*)\)/;
const msPerMinute = 60 * 1000;

const jsonContentType = 'application/json';
const restPrefix = '/rest/api/3';
/** The connector's poll, as {@link FakeJira.requestLog} records it. */
export const fakeJiraSearchRequest = `POST ${restPrefix}/search/jql`;

/** A comment body as Jira validates it: an ADF document. */
const commentBodySchema = z.object({ type: z.literal('doc'), version: z.literal(1), content: z.array(adfNodeSchema) });

function createAdfParagraph(text: string, mentions: readonly JiraAccount[] = []): AdfDocument {
  const mentionNodes: AdfNode[] = mentions.flatMap((account) => [
    { type: 'mention', attrs: { id: account.accountId, text: `@${account.displayName ?? account.accountId}` } },
    { type: 'text', text: ' ' },
  ]);
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [...mentionNodes, { type: 'text', text }] }] };
}

/** Does any mention node in `nodes` carry `accountId`? */
function checkHasMentionOf(nodes: readonly AdfNode[], accountId: string): boolean {
  return nodes.some((node) => (node.type === 'mention' && node.attrs?.id === accountId) || checkHasMentionOf(node.content ?? [], accountId));
}

/** ADF refuses an empty text node (`minLength: 1`). */
function checkHasEmptyTextNode(nodes: readonly AdfNode[]): boolean {
  return nodes.some((node) => (node.type === 'text' && !node.text) || checkHasEmptyTextNode(node.content ?? []));
}

export class FakeJira {
  private readonly server: http.Server;
  private readonly issues = new Map<string, FakeJiraIssue>();
  private readonly groups = new Map<string, FakeJiraGroup>();
  private nextHistoryId = 1000;
  private nextCommentId = 5000;
  private nextAttachmentId = 9000;
  /** The last `updated` handed out (epoch ms): the next one is always later, so two changes in one millisecond still differ. */
  private lastUpdatedMs = 0;
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

  /** @description A group of the site with its active members; its id is not its name, as in Jira. */
  addGroup(name: string, members: JiraAccount[]): void {
    this.groups.set(name, { groupId: `group-id-${this.groups.size + 1}`, name, members });
  }

  /** @description A new issue, unassigned, as its reporter created it. */
  createIssue(issue: FakeJiraNewIssue): void {
    const created = new Date().toISOString();
    this.issues.set(issue.key, {
      ...issue,
      id: (this.issues.size + 1).toString(),
      assignee: null,
      created,
      updated: created,
      histories: [],
      comments: [],
      attachments: [],
    });
  }

  /** @description A comment by a person (not the AI account) — what a requester writes on the issue. Resolves its id. */
  addComment(issueKey: string, author: JiraAccount, text: string, options: FakeJiraCommentOptions = {}): string {
    this.nextCommentId += 1;
    const id = this.nextCommentId.toString();
    const issue = this.getIssue(issueKey);
    issue.comments.push({ id, author, created: new Date().toISOString(), body: createAdfParagraph(text, options.mentions) });
    this.touch(issue);
    return id;
  }

  /** @description Edit a comment's text as `editor` does: `updated` and `updateAuthor` move, the author and date stay. */
  editComment(issueKey: string, commentId: string, text: string, editor: JiraAccount, options: FakeJiraCommentOptions = {}): void {
    const issue = this.getIssue(issueKey);
    const comment = issue.comments.find((candidate) => candidate.id === commentId);
    if (!comment) throw new Error(`fake Jira has no comment ${commentId} on ${issueKey}`);
    comment.body = createAdfParagraph(text, options.mentions);
    comment.updated = new Date().toISOString();
    comment.updateAuthor = editor;
    this.touch(issue);
  }

  deleteComment(issueKey: string, commentId: string): void {
    const issue = this.getIssue(issueKey);
    issue.comments = issue.comments.filter((comment) => comment.id !== commentId);
    this.touch(issue);
  }

  setDescription(issueKey: string, description: string): void {
    const issue = this.getIssue(issueKey);
    issue.description = description;
    this.touch(issue);
  }

  /** @description Attach a file to an issue; its id is unique across the site, as Jira's are. */
  addAttachment(issueKey: string, file: Omit<FakeJiraAttachment, 'id'>): string {
    this.nextAttachmentId += 1;
    const id = this.nextAttachmentId.toString();
    this.getIssue(issueKey).attachments.push({ id, ...file });
    return id;
  }

  /** @description Assign the issue, recording the change in its changelog under `author`. */
  assignIssue(issueKey: string, assignee: JiraAccount, author: JiraAccount): void {
    const issue = this.getIssue(issueKey);
    this.addHistory(issue, author, { field: 'assignee', fieldId: 'assignee', from: issue.assignee?.accountId ?? null, to: assignee.accountId });
    issue.assignee = assignee;
    this.touch(issue);
  }

  /** The issue changed: its `updated` moves forward, never to a time it already had. */
  private touch(issue: FakeJiraIssue): void {
    this.lastUpdatedMs = Math.max(Date.now(), this.lastUpdatedMs + 1);
    issue.updated = new Date(this.lastUpdatedMs).toISOString();
  }

  /**
   * What the search returns for `jql`: every issue (the connector's own re-check is under test), or — when the
   * JQL carries the mention branch — what Jira would return for it.
   */
  private getSearchedIssues(jql: string | undefined): FakeJiraIssue[] {
    const issues = [...this.issues.values()];
    if (jql === undefined || !jql.includes(mentionClause)) return issues;
    const windowMinutes = Number(mentionWindowRe.exec(jql)?.[1]);
    if (!Number.isFinite(windowMinutes)) throw new Error(`fake Jira: no "updated >= -<n>m" next to the mention clause in ${jql}`);
    const statusIds = (assignedStatusesRe.exec(jql)?.[1] ?? '').split(',').map((statusId) => statusId.trim().replace(/^"|"$/g, '')).filter(Boolean);
    const windowStartMs = Date.now() - windowMinutes * msPerMinute;
    return issues.filter((issue) => {
      const isAssigned = issue.assignee?.accountId === this.options.aiAccount.accountId && statusIds.includes(issue.statusId);
      const isMentioned = Date.parse(issue.updated) >= windowStartMs
        && issue.comments.some((comment) => checkHasMentionOf(comment.body.content, this.options.aiAccount.accountId));
      return isAssigned || isMentioned;
    });
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
        updated: issue.updated,
        description: createAdfParagraph(issue.description),
        comment: { total: issue.comments.length, comments: issue.comments },
        attachment: issue.attachments.map((attachment) => ({
          id: attachment.id,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          size: attachment.content.length,
          created: issue.created,
          author: attachment.author ?? issue.reporter,
        })),
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
    const attachmentContentMatch = /^\/attachment\/content\/([^/]+)$/.exec(route);

    if (method === 'GET' && route === '/myself') {
      send(200, { accountId: this.options.aiAccount.accountId });
    } else if (method === 'GET' && statusesMatch) {
      send(200, [{ statuses: this.options.statuses }]);
    } else if (method === 'GET' && route === '/group/bulk') {
      // Only the groups of exactly the names asked for, as `groupName=` filters.
      const names = url.searchParams.getAll('groupName');
      const values = [...this.groups.values()].filter((group) => names.includes(group.name)).map(({ name, groupId }) => ({ name, groupId }));
      send(200, { startAt: 0, maxResults: 50, total: values.length, isLast: true, values });
    } else if (method === 'GET' && route === '/group/member') {
      const group = [...this.groups.values()].find((candidate) => candidate.groupId === url.searchParams.get('groupId'));
      if (!group) {
        send(404, { errorMessages: ['The group does not exist.'] });
        return;
      }
      const startAt = Number(url.searchParams.get('startAt') ?? 0);
      const maxResults = Number(url.searchParams.get('maxResults') ?? 50);
      const values = group.members.slice(startAt, startAt + maxResults);
      send(200, { startAt, maxResults, total: group.members.length, isLast: startAt + values.length >= group.members.length, values });
    } else if (method === 'GET' && attachmentContentMatch) {
      // With `redirect=false`, as the connector asks, Jira answers with the file itself.
      const attachment = [...this.issues.values()].flatMap((issue) => issue.attachments).find((candidate) => candidate.id === attachmentContentMatch[1]);
      if (!attachment) {
        send(404, { errorMessages: ['The attachment does not exist.'] });
        return;
      }
      response.writeHead(200, { 'content-type': attachment.mimeType, 'content-length': attachment.content.length });
      response.end(attachment.content);
    } else if (method === 'POST' && route === '/search/jql') {
      const isChangelogExpanded = requestBody.expand === 'changelog';
      send(200, { issues: this.getSearchedIssues(requestBody.jql).map((issue) => this.getIssueJson(issue, isChangelogExpanded)), isLast: true });
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
      this.touch(issue);
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
      this.touch(issue);
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
