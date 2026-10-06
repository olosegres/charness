import type { JiraClient, JiraComment, JiraIssue, JiraRemoteLink } from './client';

/**
 * @description Everything one request's prompt says about an issue (plan C1,
 * C2): the issue's own fields, ALL its comments (the issue field holds at most
 * 100), its remote links, and — for an issue that can hold children, such as an
 * epic — ALL its children, read page by page. Fetched before the request opens:
 * a request is never left without its prompt.
 */

/** The fields every prompt reads; a project's `extraFields` ids are added to them. */
export const jiraPromptIssueFields = [
  'summary', 'status', 'issuetype', 'priority', 'parent', 'subtasks', 'issuelinks', 'fixVersions', 'labels',
  'components', 'attachment', 'description', 'reporter',
];
/** Only the description's HTML is asked for: it names the attachment behind an inline file (C9). */
const renderedFieldsExpand = 'renderedFields';
const childIssueFields = ['summary', 'status', 'issuetype'];
export const jiraChildSearchPageSize = 100;
/** An issue type at this level or above holds child issues (an epic); level 0 holds sub-tasks, below 0 is a sub-task. */
export const jiraParentHierarchyLevel = 1;

export type JiraIssueContextClient = Pick<JiraClient, 'getIssue' | 'getComments' | 'getRemoteLinks' | 'searchIssues'>;

export interface JiraIssueContext {
  issue: JiraIssue;
  /** Oldest first. */
  comments: JiraComment[];
  remoteLinks: JiraRemoteLink[];
  /** The issue's children when its type can hold them, else empty (its sub-tasks are on the issue itself). */
  children: JiraIssue[];
}

/** A JQL string literal: the key is Jira's own, but a quote or backslash in it must never end the literal. */
function getJqlQuoted(text: string): string {
  return `"${text.replace(/["\\]/g, '\\$&')}"`;
}

async function getChildIssues(client: JiraIssueContextClient, issueKey: string): Promise<JiraIssue[]> {
  const children: JiraIssue[] = [];
  let nextPageToken: string | undefined;
  do {
    const page = await client.searchIssues({
      jql: `parent = ${getJqlQuoted(issueKey)} ORDER BY created ASC`,
      fields: childIssueFields,
      isChangelogExpanded: false,
      maxResults: jiraChildSearchPageSize,
      nextPageToken,
    });
    children.push(...page.issues);
    nextPageToken = page.isLast ? undefined : (page.nextPageToken ?? undefined);
  } while (nextPageToken);
  return children;
}

/** @description Read the issue, its comments, its remote links and, when it can have them, its children. */
export async function fetchJiraIssueContext(
  client: JiraIssueContextClient,
  issueKey: string,
  extraFieldIds: readonly string[],
): Promise<JiraIssueContext> {
  const [issue, comments, remoteLinks] = await Promise.all([
    client.getIssue(issueKey, [...jiraPromptIssueFields, ...extraFieldIds], renderedFieldsExpand),
    client.getComments(issueKey),
    client.getRemoteLinks(issueKey),
  ]);
  const isParent = (issue.fields.issuetype?.hierarchyLevel ?? 0) >= jiraParentHierarchyLevel;
  return { issue, comments, remoteLinks, children: isParent ? await getChildIssues(client, issueKey) : [] };
}
