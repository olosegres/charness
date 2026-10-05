import { z } from 'zod';
import { sleep } from '../../utils';
import { getRetryAfterHeaderMs } from '../../utils/retryAfterHeader';
import { downloadJiraAttachment, jiraDownloadStallTimeoutMs } from './attachmentDownload';
import { adfNodeSchema, attributeValueSchema, type AdfAttributeValue, type AdfDocument } from './adf';

/**
 * @description The Jira Cloud REST v3 client of the Jira connector (plan J4,
 * D13/D14): Node `fetch`, basic auth (the AI account's email + API token), a
 * 30 s timeout per attempt, every response validated by a schema.
 *
 * Retries:
 *  - 429 — Jira refused the request, so ANY request is retried after its
 *    `Retry-After` (capped at 60 s), at most 3 attempts;
 *  - 5xx / network error / timeout — retried with a jittered backoff, but only
 *    for a request that is safe to repeat. A comment POST is never repeated: when
 *    its request may have reached Jira (a timeout, a connection dropped
 *    mid-response, a 5xx, an unreadable 2xx) `addComment` reports
 *    `deliveryUnknown` instead (R18) — a second POST would post the answer
 *    twice — and only a failure before anything was sent is an error;
 *  - 401 / 403 — never retried: {@link JiraAuthError}, which the poller turns
 *    into one loud line and a stop.
 *
 * Errors carry the method, the path and Jira's own messages — never the token.
 */

export const jiraRequestTimeoutMs = 30_000;
export const jiraMaxAttempts = 3;
export const jiraRetryAfterCapMs = 60_000;
/** Backoff before the 2nd and 3rd attempt of a retryable 5xx / network failure. */
export const jiraBackoffMs = [1_000, 4_000] as const;
/** Up to this share is added at random to a backoff, so clients that failed together do not retry together. */
export const jiraBackoffJitterRatio = 0.5;
/** Jira's own page size for comments; the page actually returned decides where the next one starts. */
export const jiraCommentPageSize = 100;
/**
 * Network error codes that mean the request never left this host — no
 * connection, no address, no TLS session — so nothing reached Jira.
 */
const failedBeforeSendingCodes: ReadonlySet<string> = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** The credentials were refused (401) or lack the permission (403). Never retried. */
export class JiraAuthError extends Error {
  constructor(readonly status: number, readonly method: string, readonly requestPath: string) {
    super(`Jira refused ${method} ${requestPath} with ${status}: check the AI account's token and permissions`);
    this.name = 'JiraAuthError';
  }
}

/**
 * A request that is not safe to repeat may have reached Jira, but its outcome
 * is unknown (R18). Turned into `addComment`'s `deliveryUnknown` result.
 */
class JiraDeliveryUnknownError extends Error {
  constructor(method: string, requestPath: string, detail: string) {
    super(`Jira ${method} ${requestPath}: outcome unknown — ${detail}`);
    this.name = 'JiraDeliveryUnknownError';
  }
}

/** Any other failed request, after its retries. `status` is 0 when no HTTP status applies: a network failure, a timeout, a response that is not the promised JSON. */
export class JiraHttpError extends Error {
  constructor(readonly status: number, readonly method: string, readonly requestPath: string, detail: string) {
    super(`Jira ${method} ${requestPath} failed${status ? ` with ${status}` : ''}: ${detail}`);
    this.name = 'JiraHttpError';
  }
}

const accountSchema = z.object({
  accountId: z.string(),
  /** `atlassian` for a person, `app` for an app or automation, `customer` for a service-desk customer. */
  accountType: z.string().optional(),
  /** Runtime data for the agent's prompt only — never logged or stored. */
  displayName: z.string().optional(),
});

/**
 * Ids only (D11: a status or assignee change is matched by id). The display
 * strings `fromString` / `toString` are left out on purpose: a schema key named
 * `toString` reads the inherited `Object.prototype.toString` when Jira omits it,
 * and the whole response fails validation.
 */
const changelogItemSchema = z.object({
  field: z.string(),
  fieldId: z.string().optional(),
  from: z.string().nullable().optional(),
  to: z.string().nullable().optional(),
});

const changelogHistorySchema = z.object({
  id: z.string(),
  created: z.string(),
  author: accountSchema.optional(),
  items: z.array(changelogItemSchema),
});

/** Who may read a comment when it is restricted (Jira's `Visibility`); a role's or a group's name. */
const visibilitySchema = z.object({
  type: z.string(),
  value: z.string(),
  identifier: z.string().nullable().optional(),
});

const commentSchema = z.object({
  id: z.string(),
  author: accountSchema.optional(),
  created: z.string(),
  /** Changes on every edit, and on a save that changed nothing. */
  updated: z.string().optional(),
  updateAuthor: accountSchema.optional(),
  /** Only a restricted comment carries it. */
  visibility: visibilitySchema.optional(),
  /** `false` is a Service Management internal note. */
  jsdPublic: z.boolean().optional(),
  body: adfNodeSchema.nullable().optional(),
  /** Only with `expand=renderedBody`: the HTML that names the attachment behind each media node. */
  renderedBody: z.string().optional(),
});

const commentPageSchema = z.object({
  total: z.number().optional(),
  comments: z.array(commentSchema),
});

/** An issue as another issue points at it: its parent, a sub-task, the far end of a link. */
const issueReferenceSchema = z.object({
  key: z.string(),
  fields: z.object({
    summary: z.string().optional(),
    status: z.object({ name: z.string() }).optional(),
  }).optional(),
});

const issueLinkSchema = z.object({
  type: z.object({ inward: z.string(), outward: z.string() }),
  inwardIssue: issueReferenceSchema.optional(),
  outwardIssue: issueReferenceSchema.optional(),
});

const attachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  mimeType: z.string().optional(),
  size: z.number().optional(),
  created: z.string().optional(),
  author: accountSchema.optional(),
});

const namedSchema = z.object({ name: z.string() });

const issueFieldsSchema = z.object({
  summary: z.string().optional(),
  status: z.object({ id: z.string(), name: z.string() }).optional(),
  /** `hierarchyLevel` 0 is a standard issue, 1 and up hold children (an epic), below 0 is a sub-task. */
  issuetype: z.object({ name: z.string(), hierarchyLevel: z.number().optional() }).optional(),
  priority: namedSchema.nullable().optional(),
  parent: issueReferenceSchema.nullable().optional(),
  subtasks: z.array(issueReferenceSchema).optional(),
  issuelinks: z.array(issueLinkSchema).optional(),
  fixVersions: z.array(namedSchema).optional(),
  labels: z.array(z.string()).optional(),
  components: z.array(namedSchema).optional(),
  attachment: z.array(attachmentSchema).optional(),
  assignee: accountSchema.nullable().optional(),
  reporter: accountSchema.nullable().optional(),
  creator: accountSchema.nullable().optional(),
  created: z.string().optional(),
  description: adfNodeSchema.nullable().optional(),
});

const issueSchema = z.object({
  id: z.string(),
  key: z.string(),
  fields: issueFieldsSchema,
  /** Only with `expand=renderedFields`; the description's HTML, read for the attachment behind each media node. */
  renderedFields: z.object({ description: z.string().nullable().optional() }).optional(),
  changelog: z.object({
    startAt: z.number(),
    maxResults: z.number(),
    total: z.number(),
    histories: z.array(changelogHistorySchema),
  }).optional(),
});

const searchResultSchema = z.object({
  issues: z.array(issueSchema),
  /** Jira documents `null` on the last page. */
  nextPageToken: z.string().nullable().optional(),
  isLast: z.boolean().optional(),
});

const changelogPageSchema = z.object({
  startAt: z.number(),
  maxResults: z.number(),
  total: z.number(),
  isLast: z.boolean().optional(),
  values: z.array(changelogHistorySchema),
});

const projectStatusSchema = z.object({ id: z.string(), name: z.string() });
const issueTypeStatusesSchema = z.array(z.object({
  statuses: z.array(projectStatusSchema),
}));

/** The values of an issue's fields by id, whatever their shape: the source of a project's `extraFields`. */
const issueRawFieldsSchema = z.object({ fields: z.record(z.string(), attributeValueSchema) });

const remoteLinkSchema = z.object({
  object: z.object({ url: z.string(), title: z.string().optional() }),
});
const remoteLinksSchema = z.array(remoteLinkSchema);
/** What `GET /issue/{key}/remotelink` answers when issue linking is switched off on the site. */
const remoteLinksDisabledStatus = 403;

const fieldDefinitionsSchema = z.array(z.object({ id: z.string(), name: z.string() }));

const createdCommentSchema = z.object({ id: z.string() });
const myselfSchema = z.object({ accountId: z.string() });

export type JiraAccount = z.infer<typeof accountSchema>;
export type JiraChangelogHistory = z.infer<typeof changelogHistorySchema>;
/** `rawFields` (every returned field's value as Jira sent it, by id) is filled in by `getIssue` only, never by a search. */
export type JiraIssue = z.infer<typeof issueSchema> & { rawFields?: Record<string, AdfAttributeValue> };
export type JiraComment = z.infer<typeof commentSchema>;
export type JiraAttachment = z.infer<typeof attachmentSchema>;
export type JiraIssueReference = z.infer<typeof issueReferenceSchema>;
export type JiraIssueLink = z.infer<typeof issueLinkSchema>;
export type JiraRemoteLink = z.infer<typeof remoteLinkSchema>;
/** A field as `GET /field` lists it: its id and its display name. */
export type JiraFieldDefinition = z.infer<typeof fieldDefinitionsSchema>[number];
export type JiraSearchResult = z.infer<typeof searchResultSchema>;
export type JiraChangelogPage = z.infer<typeof changelogPageSchema>;
/** A status as `GET /project/{key}/statuses` lists it. */
export type JiraProjectStatus = z.infer<typeof projectStatusSchema>;

/** @name JiraSearchRequest @description `POST /rest/api/3/search/jql` (D13). */
export interface JiraSearchRequest {
  jql: string;
  fields: string[];
  isChangelogExpanded: boolean;
  maxResults: number;
  nextPageToken?: string;
}

/**
 * @name JiraCommentPostResult
 * @description `created` — Jira returned the new comment's id; `deliveryUnknown`
 * — the request may have created the comment but the response did not say so
 * (R18). The answer sink reads the issue's comments to decide, never re-posts.
 */
export type JiraCommentPostResult = { outcome: 'created'; id: string } | { outcome: 'deliveryUnknown'; reason: string };

export interface JiraClientOptions {
  /** `https://<site>.atlassian.net`, or a loopback server in tests. */
  baseUrl: string;
  email: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  /** In [0, 1); the backoff jitter's source. */
  randomImpl?: () => number;
  timeoutMs?: number;
  /** How long a download may deliver no data before it is aborted; defaults to {@link jiraDownloadStallTimeoutMs}. */
  downloadStallTimeoutMs?: number;
}

interface JiraRequest {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  body?: object;
  /** Safe to send twice: a read, or a write whose repeat changes nothing. */
  isIdempotent: boolean;
}

/** Jira's error body (`errorMessages` + per-field `errors`), names and texts only. */
const errorBodySchema = z.object({
  errorMessages: z.array(z.string()).optional(),
  errors: z.record(z.string(), z.string()).optional(),
});


function getErrorDetail(text: string): string {
  try {
    const parsed = errorBodySchema.safeParse(JSON.parse(text));
    if (parsed.success) {
      const messages = [...(parsed.data.errorMessages ?? []), ...Object.entries(parsed.data.errors ?? {}).map(([field, message]) => `${field}: ${message}`)];
      if (messages.length > 0) return messages.join('; ');
    }
  } catch {
    // Not JSON: fall through to a short excerpt.
  }
  return text.slice(0, 200) || 'no details';
}

/** The error codes on a failed `fetch`: its cause's, or each of a dual-stack connect's attempts. */
function getFailureCodes(error: Error): string[] {
  const cause = error.cause instanceof Error ? error.cause : null;
  if (!cause) return [];
  const own = 'code' in cause && typeof cause.code === 'string' ? [cause.code] : [];
  const attempts = cause instanceof AggregateError
    ? cause.errors.flatMap((attempt) => (attempt instanceof Error && 'code' in attempt && typeof attempt.code === 'string' ? [attempt.code] : []))
    : [];
  return [...own, ...attempts];
}

/** Did the request fail before anything was sent? Only then is it certain Jira received nothing. */
function checkIsFailedBeforeSending(error: Error): boolean {
  const codes = getFailureCodes(error);
  return codes.length > 0 && codes.every((code) => failedBeforeSendingCodes.has(code));
}

/** A request that got no response: `fetch` says only "fetch failed", the reason (refused, DNS, TLS) is its cause. */
function getFailureDetail(error: Error): string {
  const cause = error.cause instanceof Error ? error.cause : null;
  if (!cause) return error.message;
  const code = 'code' in cause && typeof cause.code === 'string' ? cause.code : '';
  // A refused dual-stack connect is an AggregateError: a code, an empty message.
  const reason = cause.message.includes(code) ? cause.message : [code, cause.message].filter((part) => part !== '').join(': ');
  return reason ? `${error.message} (${reason})` : error.message;
}

export interface JiraClient {
  getMyself(): Promise<{ accountId: string }>;
  searchIssues(request: JiraSearchRequest): Promise<JiraSearchResult>;
  /** A page of the issue's changelog, oldest first (Jira's order); `maxResults` defaults to Jira's own page size. */
  getChangelogPage(issueKey: string, startAt: number, maxResults?: number): Promise<JiraChangelogPage>;
  /** `expand` is Jira's own (`renderedFields`). The result carries every returned field's raw value (`rawFields`). */
  getIssue(issueKey: string, fields: string[], expand?: string): Promise<JiraIssue>;
  /** EVERY comment of the issue, oldest first, read page by page, each with its rendered HTML. */
  getComments(issueKey: string): Promise<JiraComment[]>;
  getRemoteLinks(issueKey: string): Promise<JiraRemoteLink[]>;
  /** The site's fields (system and custom), to name an `extraFields` id and to tell an unknown one. */
  getFields(): Promise<JiraFieldDefinition[]>;
  /**
   * Stream attachment `attachmentId`'s original into the NEW file `destinationPath` (any size, never held in
   * memory); resolves the byte count. Fails with {@link JiraAuthError} on 401/403 and {@link JiraHttpError}
   * otherwise (a stall included, status 0); the file is removed on failure.
   */
  downloadAttachment(attachmentId: string, destinationPath: string): Promise<number>;
  addComment(issueKey: string, body: AdfDocument): Promise<JiraCommentPostResult>;
  /** The issue's newest comments, newest first — R18's read-back after a post of unknown outcome. */
  getRecentComments(issueKey: string, maxResults: number): Promise<JiraComment[]>;
  assignIssue(issueKey: string, accountId: string): Promise<void>;
  getProjectStatuses(projectKey: string): Promise<JiraProjectStatus[]>;
}

function getParsedResponse<T>(text: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; detail: string } {
  let json: object;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, detail: 'the response is not JSON' };
  }
  const parsed = schema.safeParse(json);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, detail: `unexpected response shape at ${parsed.error.issues[0]?.path.join('.') || '(root)'}` };
}

export function createJiraClient(options: JiraClientOptions): JiraClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleepImpl ?? sleep;
  const randomImpl = options.randomImpl ?? Math.random;
  const timeoutMs = options.timeoutMs ?? jiraRequestTimeoutMs;
  const getBackoffMs = (attempt: number): number => {
    const baseMs = jiraBackoffMs[attempt - 1] ?? jiraBackoffMs[jiraBackoffMs.length - 1];
    return Math.round(baseMs * (1 + jiraBackoffJitterRatio * randomImpl()));
  };
  const authorization = `Basic ${Buffer.from(`${options.email}:${options.apiToken}`).toString('base64')}`;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  /** One request with its retries; resolves the response text of a 2xx. */
  async function send(request: JiraRequest): Promise<string> {
    let lastError: JiraHttpError | null = null;
    for (let attempt = 1; attempt <= jiraMaxAttempts; attempt += 1) {
      let response: Response;
      let text: string;
      try {
        response = await fetchImpl(`${baseUrl}${request.path}`, {
          method: request.method,
          headers: {
            Authorization: authorization,
            Accept: 'application/json',
            ...(request.body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: request.body ? JSON.stringify(request.body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
        // Inside the try: the timeout also covers the body, and a connection can drop while it streams.
        text = await response.text();
      } catch (e) {
        const detail = e instanceof Error ? getFailureDetail(e) : 'network failure';
        if (!request.isIdempotent && !(e instanceof Error && checkIsFailedBeforeSending(e))) {
          throw new JiraDeliveryUnknownError(request.method, request.path, detail);
        }
        lastError = new JiraHttpError(0, request.method, request.path, detail);
        if (!request.isIdempotent || attempt === jiraMaxAttempts) throw lastError;
        await sleepImpl(getBackoffMs(attempt));
        continue;
      }
      if (response.ok) return text;
      if (response.status === 401 || response.status === 403) {
        throw new JiraAuthError(response.status, request.method, request.path);
      }
      if (!request.isIdempotent && response.status >= 500) {
        throw new JiraDeliveryUnknownError(request.method, request.path, `${response.status}: ${getErrorDetail(text)}`);
      }
      lastError = new JiraHttpError(response.status, request.method, request.path, getErrorDetail(text));
      if (attempt === jiraMaxAttempts) break;
      // Atlassian: a transient 5xx (such as 503) may also carry a `Retry-After`.
      if (response.status === 429 || (response.status >= 500 && request.isIdempotent)) {
        const retryAfterMs = getRetryAfterHeaderMs(response.headers.get('retry-after'), Date.now());
        await sleepImpl(retryAfterMs === null ? getBackoffMs(attempt) : Math.min(retryAfterMs, jiraRetryAfterCapMs));
        continue;
      }
      break;
    }
    throw lastError ?? new JiraHttpError(0, request.method, request.path, 'no attempt was made');
  }

  async function sendForJson<T>(request: JiraRequest, schema: z.ZodType<T>): Promise<T> {
    const parsed = getParsedResponse(await send(request), schema);
    if (!parsed.ok) throw new JiraHttpError(0, request.method, request.path, parsed.detail);
    return parsed.value;
  }

  const encode = encodeURIComponent;

  return {
    getMyself: () => sendForJson({ method: 'GET', path: '/rest/api/3/myself', isIdempotent: true }, myselfSchema),

    searchIssues: (search) =>
      sendForJson(
        {
          method: 'POST',
          path: '/rest/api/3/search/jql',
          isIdempotent: true,
          body: {
            jql: search.jql,
            fields: search.fields,
            maxResults: search.maxResults,
            ...(search.isChangelogExpanded ? { expand: 'changelog' } : {}),
            ...(search.nextPageToken ? { nextPageToken: search.nextPageToken } : {}),
          },
        },
        searchResultSchema,
      ),

    getChangelogPage: (issueKey, startAt, maxResults) =>
      sendForJson(
        {
          method: 'GET',
          path: `/rest/api/3/issue/${encode(issueKey)}/changelog?startAt=${startAt}${maxResults === undefined ? '' : `&maxResults=${maxResults}`}`,
          isIdempotent: true,
        },
        changelogPageSchema,
      ),

    getIssue: async (issueKey, fields, expand) => {
      const request: JiraRequest = {
        method: 'GET',
        path: `/rest/api/3/issue/${encode(issueKey)}?fields=${fields.map(encode).join(',')}${expand ? `&expand=${encode(expand)}` : ''}`,
        isIdempotent: true,
      };
      const text = await send(request);
      // Parsed twice on purpose: the typed schema drops every key it does not model, and a project's
      // `extraFields` (a site-specific `customfield_*`, or a system field such as `duedate`) are mostly those.
      const issue = getParsedResponse(text, issueSchema);
      const rawFields = getParsedResponse(text, issueRawFieldsSchema);
      if (!issue.ok) throw new JiraHttpError(0, request.method, request.path, issue.detail);
      if (!rawFields.ok) throw new JiraHttpError(0, request.method, request.path, rawFields.detail);
      return { ...issue.value, rawFields: rawFields.value.fields };
    },

    getComments: async (issueKey) => {
      const comments: JiraComment[] = [];
      for (;;) {
        const page = await sendForJson(
          {
            method: 'GET',
            path: `/rest/api/3/issue/${encode(issueKey)}/comment?orderBy=created&expand=renderedBody&startAt=${comments.length}&maxResults=${jiraCommentPageSize}`,
            isIdempotent: true,
          },
          commentPageSchema,
        );
        comments.push(...page.comments);
        // `total` ends the read; without it a page shorter than asked does. An empty page always does.
        const isLastPage = page.comments.length === 0
          || (page.total === undefined ? page.comments.length < jiraCommentPageSize : comments.length >= page.total);
        if (isLastPage) return comments;
      }
    },

    getRemoteLinks: async (issueKey) => {
      try {
        return await sendForJson({ method: 'GET', path: `/rest/api/3/issue/${encode(issueKey)}/remotelink`, isIdempotent: true }, remoteLinksSchema);
      } catch (error) {
        // Atlassian: this endpoint's 403 means issue linking is switched off on the site, so there is no link to
        // read. As a JiraAuthError it would stop polling for good (D14); a missing permission is a 404 here.
        if (error instanceof JiraAuthError && error.status === remoteLinksDisabledStatus) return [];
        throw error;
      }
    },

    downloadAttachment: async (attachmentId, destinationPath) => {
      const requestPath = `/rest/api/3/attachment/content/${encode(attachmentId)}`;
      const result = await downloadJiraAttachment(
        { baseUrl, authorization, fetchImpl, stallTimeoutMs: options.downloadStallTimeoutMs ?? jiraDownloadStallTimeoutMs },
        attachmentId,
        destinationPath,
      );
      if (result.ok) return result.bytes;
      if (result.status === 401 || result.status === 403) throw new JiraAuthError(result.status, 'GET', requestPath);
      throw new JiraHttpError(result.status, 'GET', requestPath, result.detail);
    },

    getFields: () => sendForJson({ method: 'GET', path: '/rest/api/3/field', isIdempotent: true }, fieldDefinitionsSchema),

    addComment: async (issueKey, body) => {
      const request: JiraRequest = { method: 'POST', path: `/rest/api/3/issue/${encode(issueKey)}/comment`, isIdempotent: false, body: { body } };
      let text: string;
      try {
        text = await send(request);
      } catch (e) {
        if (e instanceof JiraDeliveryUnknownError) return { outcome: 'deliveryUnknown', reason: e.message };
        throw e;
      }
      // A 2xx means Jira took the request; a body that does not say which comment it made leaves the outcome open.
      const parsed = getParsedResponse(text, createdCommentSchema);
      return parsed.ok
        ? { outcome: 'created', id: parsed.value.id }
        : { outcome: 'deliveryUnknown', reason: `Jira ${request.method} ${request.path}: ${parsed.detail}` };
    },

    getRecentComments: async (issueKey, maxResults) => {
      const page = await sendForJson(
        { method: 'GET', path: `/rest/api/3/issue/${encode(issueKey)}/comment?orderBy=-created&maxResults=${maxResults}`, isIdempotent: true },
        commentPageSchema,
      );
      return page.comments;
    },

    assignIssue: async (issueKey, accountId) => {
      await send({ method: 'PUT', path: `/rest/api/3/issue/${encode(issueKey)}/assignee`, isIdempotent: true, body: { accountId } });
    },

    getProjectStatuses: async (projectKey) => {
      const issueTypes = await sendForJson(
        { method: 'GET', path: `/rest/api/3/project/${encode(projectKey)}/statuses`, isIdempotent: true },
        issueTypeStatusesSchema,
      );
      const byId = new Map<string, JiraProjectStatus>();
      for (const issueType of issueTypes) for (const status of issueType.statuses) byId.set(status.id, status);
      return [...byId.values()];
    },
  };
}
