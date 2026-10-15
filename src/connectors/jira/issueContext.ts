import { checkIsLastOffsetPage, jiraChangelogPageSize, type JiraChangelogHistory, type JiraClient, type JiraComment, type JiraIssue, type JiraRemoteLink } from './client';

/**
 * @description Everything one request's prompt says about an issue (plan C1,
 * C2): the issue's own fields, ALL its comments (the issue field holds at most
 * 100), its remote links, and — for an issue that can hold children, such as an
 * epic — ALL its children, read page by page. Fetched before the request opens:
 * a request is never left without its prompt. With a trusted group the issue's
 * WHOLE changelog is read too: it names who wrote what every field says now.
 */

/** The fields every prompt reads; a project's `extraFields` ids are added to them. */
export const jiraPromptIssueFields = [
  'summary', 'status', 'issuetype', 'priority', 'parent', 'subtasks', 'issuelinks', 'fixVersions', 'labels',
  'components', 'attachment', 'description', 'reporter', 'creator',
];
/** Only the description's HTML is asked for: it names the attachment behind an inline file (C9). */
const renderedFieldsExpand = 'renderedFields';
const childIssueFields = ['summary', 'status', 'issuetype'];
export const jiraChildSearchPageSize = 100;
/** An issue type at this level or above holds child issues (an epic); level 0 holds sub-tasks, below 0 is a sub-task. */
export const jiraParentHierarchyLevel = 1;

export type JiraIssueContextClient = Pick<JiraClient, 'getIssue' | 'getComments' | 'getRemoteLinks' | 'searchIssues' | 'getChangelogPage'>;

export interface JiraIssueContext {
  issue: JiraIssue;
  /** Oldest first. */
  comments: JiraComment[];
  remoteLinks: JiraRemoteLink[];
  /** The issue's children when its type can hold them, else empty (its sub-tasks are on the issue itself). */
  children: JiraIssue[];
  /** The whole changelog, oldest first — read only when the caller asked for it (`isChangelogNeeded`), else empty. */
  changelog: JiraChangelogHistory[];
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

/** EVERY entry of the issue's changelog, oldest first, page after page (the page actually returned decides where the next starts). */
async function getWholeChangelog(client: JiraIssueContextClient, issueKey: string): Promise<JiraChangelogHistory[]> {
  const histories: JiraChangelogHistory[] = [];
  for (;;) {
    const page = await client.getChangelogPage(issueKey, histories.length, jiraChangelogPageSize);
    histories.push(...page.values);
    if (checkIsLastOffsetPage({ isLast: page.isLast, total: page.total, pageItemCount: page.values.length, readItemCount: histories.length, pageSize: jiraChangelogPageSize })) {
      return histories;
    }
  }
}

/**
 * @description Read the issue, its comments, its remote links and, when it can have them, its children —
 * and, when `isChangelogNeeded`, its whole changelog.
 */
export async function fetchJiraIssueContext(
  client: JiraIssueContextClient,
  issueKey: string,
  extraFieldIds: readonly string[],
  isChangelogNeeded: boolean,
): Promise<JiraIssueContext> {
  const [issue, comments, remoteLinks, changelog] = await Promise.all([
    client.getIssue(issueKey, [...jiraPromptIssueFields, ...extraFieldIds], renderedFieldsExpand),
    client.getComments(issueKey),
    client.getRemoteLinks(issueKey),
    isChangelogNeeded ? getWholeChangelog(client, issueKey) : [],
  ]);
  const isParent = (issue.fields.issuetype?.hierarchyLevel ?? 0) >= jiraParentHierarchyLevel;
  return { issue, comments, remoteLinks, children: isParent ? await getChildIssues(client, issueKey) : [], changelog };
}
