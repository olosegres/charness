import { z } from 'zod';
import { sleep } from '../../utils';
import { getRetryAfterHeaderMs } from '../../utils/retryAfterHeader';
import { adfNodeSchema, type AdfDocument } from './adf';

/**
 * @description The Jira Cloud REST v3 client of the Jira connector (plan J4,
 * D13/D14): Node `fetch`, basic auth (the AI account's email + API token), a
 * 30 s timeout per attempt, every response validated by a schema.
 *
 * Retries:
 *  - 429 — Jira refused the request, so ANY request is retried after its
 *    `Retry-After` (capped at 60 s), at most 3 attempts;
 *  - 5xx / network error / timeout — retried with backoff, but only for a
 *    request that is safe to repeat: a comment POST that timed out may have
 *    been created, and a second one would post the answer twice;
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

/** The credentials were refused (401) or lack the permission (403). Never retried. */
export class JiraAuthError extends Error {
  constructor(readonly status: number, readonly method: string, readonly requestPath: string) {
    super(`Jira refused ${method} ${requestPath} with ${status}: check the AI account's token and permissions`);
    this.name = 'JiraAuthError';
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
  accountType: z.string().optional(),
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

const issueFieldsSchema = z.object({
  summary: z.string().optional(),
  status: z.object({ id: z.string(), name: z.string() }).optional(),
  assignee: accountSchema.nullable().optional(),
  reporter: accountSchema.nullable().optional(),
  created: z.string().optional(),
  description: adfNodeSchema.nullable().optional(),
  comment: z.object({
    total: z.number().optional(),
    comments: z.array(z.object({
      id: z.string(),
      author: accountSchema.optional(),
      created: z.string(),
      body: adfNodeSchema.nullable().optional(),
    })),
  }).optional(),
});

const issueSchema = z.object({
  id: z.string(),
  key: z.string(),
  fields: issueFieldsSchema,
  changelog: z.object({
    startAt: z.number(),
    maxResults: z.number(),
    total: z.number(),
    histories: z.array(changelogHistorySchema),
  }).optional(),
});

const searchResultSchema = z.object({
  issues: z.array(issueSchema),
  nextPageToken: z.string().optional(),
  isLast: z.boolean().optional(),
});

const changelogPageSchema = z.object({
  startAt: z.number(),
  maxResults: z.number(),
  total: z.number(),
  isLast: z.boolean().optional(),
  values: z.array(changelogHistorySchema),
});

const issueTypeStatusesSchema = z.array(z.object({
  statuses: z.array(z.object({ id: z.string(), name: z.string() })),
}));

const createdCommentSchema = z.object({ id: z.string() });
const myselfSchema = z.object({ accountId: z.string() });

export type JiraAccount = z.infer<typeof accountSchema>;
export type JiraChangelogHistory = z.infer<typeof changelogHistorySchema>;
export type JiraIssue = z.infer<typeof issueSchema>;
export type JiraSearchResult = z.infer<typeof searchResultSchema>;
export type JiraChangelogPage = z.infer<typeof changelogPageSchema>;

/** @name JiraSearchRequest @description `POST /rest/api/3/search/jql` (D13). */
export interface JiraSearchRequest {
  jql: string;
  fields: string[];
  isChangelogExpanded: boolean;
  maxResults: number;
  nextPageToken?: string;
}

export interface JiraClientOptions {
  /** `https://<site>.atlassian.net`, or a loopback server in tests. */
  baseUrl: string;
  email: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  timeoutMs?: number;
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

export interface JiraClient {
  getMyself(): Promise<{ accountId: string }>;
  searchIssues(request: JiraSearchRequest): Promise<JiraSearchResult>;
  getChangelogPage(issueKey: string, startAt: number): Promise<JiraChangelogPage>;
  getIssue(issueKey: string, fields: string[]): Promise<JiraIssue>;
  addComment(issueKey: string, body: AdfDocument): Promise<{ id: string }>;
  assignIssue(issueKey: string, accountId: string): Promise<void>;
  getProjectStatuses(projectKey: string): Promise<Array<{ id: string; name: string }>>;
}

export function createJiraClient(options: JiraClientOptions): JiraClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleepImpl ?? sleep;
  const timeoutMs = options.timeoutMs ?? jiraRequestTimeoutMs;
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
        lastError = new JiraHttpError(0, request.method, request.path, e instanceof Error ? e.message : 'network failure');
        if (!request.isIdempotent || attempt === jiraMaxAttempts) throw lastError;
        await sleepImpl(jiraBackoffMs[attempt - 1]);
        continue;
      }
      if (response.ok) return text;
      if (response.status === 401 || response.status === 403) {
        throw new JiraAuthError(response.status, request.method, request.path);
      }
      lastError = new JiraHttpError(response.status, request.method, request.path, getErrorDetail(text));
      if (attempt === jiraMaxAttempts) break;
      if (response.status === 429) {
        const retryAfterMs = getRetryAfterHeaderMs(response.headers.get('retry-after'), Date.now());
        await sleepImpl(retryAfterMs === null ? jiraBackoffMs[attempt - 1] : Math.min(retryAfterMs, jiraRetryAfterCapMs));
        continue;
      }
      if (response.status >= 500 && request.isIdempotent) {
        await sleepImpl(jiraBackoffMs[attempt - 1]);
        continue;
      }
      break;
    }
    throw lastError ?? new JiraHttpError(0, request.method, request.path, 'no attempt was made');
  }

  async function sendForJson<T>(request: JiraRequest, schema: z.ZodType<T>): Promise<T> {
    const text = await send(request);
    let json: object;
    try {
      json = JSON.parse(text);
    } catch {
      throw new JiraHttpError(0, request.method, request.path, 'the response is not JSON');
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new JiraHttpError(0, request.method, request.path, `unexpected response shape at ${parsed.error.issues[0]?.path.join('.') || '(root)'}`);
    }
    return parsed.data;
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

    getChangelogPage: (issueKey, startAt) =>
      sendForJson(
        { method: 'GET', path: `/rest/api/3/issue/${encode(issueKey)}/changelog?startAt=${startAt}`, isIdempotent: true },
        changelogPageSchema,
      ),

    getIssue: (issueKey, fields) =>
      sendForJson(
        { method: 'GET', path: `/rest/api/3/issue/${encode(issueKey)}?fields=${fields.map(encode).join(',')}`, isIdempotent: true },
        issueSchema,
      ),

    addComment: (issueKey, body) =>
      sendForJson(
        { method: 'POST', path: `/rest/api/3/issue/${encode(issueKey)}/comment`, isIdempotent: false, body: { body } },
        createdCommentSchema,
      ),

    assignIssue: async (issueKey, accountId) => {
      await send({ method: 'PUT', path: `/rest/api/3/issue/${encode(issueKey)}/assignee`, isIdempotent: true, body: { accountId } });
    },

    getProjectStatuses: async (projectKey) => {
      const issueTypes = await sendForJson(
        { method: 'GET', path: `/rest/api/3/project/${encode(projectKey)}/statuses`, isIdempotent: true },
        issueTypeStatusesSchema,
      );
      const byId = new Map<string, { id: string; name: string }>();
      for (const issueType of issueTypes) for (const status of issueType.statuses) byId.set(status.id, status);
      return [...byId.values()];
    },
  };
}
