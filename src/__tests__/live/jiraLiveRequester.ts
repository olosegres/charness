/**
 * @description The requester side of the live Jira run (J8, R33): a person's
 * account driven through ITS OWN BROWSER LOGIN — a headless Chromium opened on a
 * stored Playwright login state of that account. Every action is a Jira REST call
 * the browser page makes with its session cookies, so the requester needs no API
 * token and nothing of it ever reaches charness (D2). The state is never logged
 * in afresh here: an expired one fails the run with a request to refresh it,
 * which is what keeps a run from triggering an emailed login code.
 */

import type { Browser, Page } from 'playwright-core';
import { z } from 'zod';
import { adfNodeSchema, convertMarkdownToAdf, getAdfText } from '../../connectors/jira/adf';

/** What a REST call from the page returned. */
interface PageRestResponse {
  status: number;
  text: string;
}

const myselfSchema = z.object({ accountId: z.string().min(1) });
const createdIssueSchema = z.object({ key: z.string().min(1) });
const issueTypesSchema = z.object({ issueTypes: z.array(z.object({ id: z.string(), subtask: z.boolean() })) });
const transitionsSchema = z.object({
  transitions: z.array(z.object({ id: z.string(), to: z.object({ statusCategory: z.object({ key: z.string() }) }) })),
});
const issueStateSchema = z.object({
  fields: z.object({
    assignee: z.object({ accountId: z.string() }).nullable(),
    status: z.object({ statusCategory: z.object({ key: z.string() }) }),
  }),
});
const commentPageSchema = z.object({
  comments: z.array(z.object({
    id: z.string(),
    author: z.object({ accountId: z.string() }),
    body: adfNodeSchema,
  })),
});

/** @name LiveComment @description A comment as the requester sees it. */
export interface LiveComment {
  id: string;
  authorAccountId: string;
  text: string;
  /** The length of the comment body's serialized ADF, as Jira returns it. */
  adfLength: number;
}

/** @name LiveIssueState @description An issue's assignee, whether it is finished, and its comments, oldest first. */
export interface LiveIssueState {
  assigneeAccountId: string | null;
  isDone: boolean;
  comments: LiveComment[];
}

/** Jira's own page size cap for comments is far above what a run posts on one issue. */
const commentPageSize = 100;
const pageLoadTimeoutMs = 60 * 1000;
/** The status category Jira gives every finished status. */
const doneStatusCategoryKey = 'done';
/** The status category of an issue nobody started on. */
const toDoStatusCategoryKey = 'new';

export class JiraLiveRequester {
  private constructor(
    private readonly browser: Browser,
    private readonly page: Page,
    /** The requester's account, as its own session reports it. */
    readonly accountId: string,
  ) {}

  /**
   * @description Open the requester's browser on `https://<siteHost>` with its stored
   * login. Throws when the page leaves the site (a login page) or the session is not
   * a logged-in one — never logs in itself.
   */
  static async open(siteHost: string, storageStatePath: string): Promise<JiraLiveRequester> {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ storageState: storageStatePath });
      const page = await context.newPage();
      await page.goto(`https://${siteHost}/jira`, { timeout: pageLoadTimeoutMs });
      if (new URL(page.url()).host !== siteHost) {
        throw new Error('the requester\'s stored login no longer opens the site (redirected away): refresh the stored login state');
      }
      const response = await callRestFromPage(page, 'GET', '/rest/api/3/myself');
      if (response.status !== 200) {
        throw new Error(`the requester's stored login is not a session on the site (GET /myself → ${response.status}): refresh the stored login state`);
      }
      return new JiraLiveRequester(browser, page, myselfSchema.parse(JSON.parse(response.text)).accountId);
    } catch (error) {
      await browser.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.browser.close();
  }

  /** A REST call that must succeed; its JSON body parsed by `schema`, or `null` for an empty body. */
  private async callJson<T>(method: 'GET' | 'POST' | 'PUT', path: string, schema: z.ZodType<T> | null, body?: object): Promise<T | null> {
    const response = await callRestFromPage(this.page, method, path, body);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`requester ${method} ${path} → ${response.status}: ${response.text.slice(0, 500)}`);
    }
    return schema === null || response.text === '' ? null : schema.parse(JSON.parse(response.text));
  }

  /** @description Create an unassigned issue of the project's first standard issue type; resolves its key. */
  async createIssue(projectKey: string, summary: string, descriptionMarkdown: string): Promise<string> {
    const issueTypes = await this.callJson('GET', `/rest/api/3/issue/createmeta/${projectKey}/issuetypes`, issueTypesSchema);
    const issueType = issueTypes?.issueTypes.find((type) => !type.subtask);
    if (!issueType) throw new Error(`project ${projectKey} offers no standard issue type`);
    const created = await this.callJson('POST', '/rest/api/3/issue', createdIssueSchema, {
      fields: {
        project: { key: projectKey },
        issuetype: { id: issueType.id },
        summary,
        description: convertMarkdownToAdf(descriptionMarkdown),
      },
    });
    if (!created) throw new Error('Jira returned no key for the created issue');
    return created.key;
  }

  async assignIssue(issueKey: string, accountId: string): Promise<void> {
    await this.callJson('PUT', `/rest/api/3/issue/${issueKey}/assignee`, null, { accountId });
  }

  async addComment(issueKey: string, markdown: string): Promise<void> {
    await this.callJson('POST', `/rest/api/3/issue/${issueKey}/comment`, null, { body: convertMarkdownToAdf(markdown) });
  }

  /** @description Move the issue to a finished status (the first transition into the `done` category). */
  async moveToDone(issueKey: string): Promise<void> {
    const transitions = await this.callJson('GET', `/rest/api/3/issue/${issueKey}/transitions`, transitionsSchema);
    const done = transitions?.transitions.find((transition) => transition.to.statusCategory.key === doneStatusCategoryKey);
    if (!done) throw new Error(`${issueKey} has no transition into a finished status`);
    await this.callJson('POST', `/rest/api/3/issue/${issueKey}/transitions`, null, { transition: { id: done.id } });
  }

  /** @description Move a finished issue back to a status of the "to do" category, so that it can be handed over again. */
  async reopenIssue(issueKey: string): Promise<void> {
    const transitions = await this.callJson('GET', `/rest/api/3/issue/${issueKey}/transitions`, transitionsSchema);
    const reopen = transitions?.transitions.find((transition) => transition.to.statusCategory.key === toDoStatusCategoryKey);
    if (!reopen) throw new Error(`${issueKey} has no transition into a to-do status`);
    await this.callJson('POST', `/rest/api/3/issue/${issueKey}/transitions`, null, { transition: { id: reopen.id } });
  }

  async getIssueState(issueKey: string): Promise<LiveIssueState> {
    const issue = await this.callJson('GET', `/rest/api/3/issue/${issueKey}?fields=assignee,status`, issueStateSchema);
    const page = await this.callJson('GET', `/rest/api/3/issue/${issueKey}/comment?orderBy=created&maxResults=${commentPageSize}`, commentPageSchema);
    if (!issue || !page) throw new Error(`${issueKey}: an empty response`);
    return {
      assigneeAccountId: issue.fields.assignee?.accountId ?? null,
      isDone: issue.fields.status.statusCategory.key === doneStatusCategoryKey,
      comments: page.comments.map((comment) => ({
        id: comment.id,
        authorAccountId: comment.author.accountId,
        text: getAdfText(comment.body),
        adfLength: JSON.stringify(comment.body).length,
      })),
    };
  }
}

/** A same-origin REST call made by the page itself, with the browser's session cookies. */
function callRestFromPage(page: Page, method: string, path: string, body?: object): Promise<PageRestResponse> {
  return page.evaluate(async (request) => {
    const response = await fetch(request.path, {
      method: request.method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        // Jira's XSRF check refuses a cookie-authenticated write without it.
        'X-Atlassian-Token': 'no-check',
      },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
    });
    return { status: response.status, text: await response.text() };
  }, { method, path, body });
}
