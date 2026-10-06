import { convertMarkdownToAdf } from '../connectors/jira/adf';
import type { JiraComment, JiraIssue } from '../connectors/jira/client';
import type { JiraIssueContext } from '../connectors/jira/issueContext';

/**
 * @description Small builders of an issue's context for the Jira prompt tests
 * (not a test file: shared by the block and prompt tests).
 */

export const testCommentAuthor = { accountId: 'ann', displayName: 'Ann Author' };
/** The AI account the test issues are worked by; its comments are the agent's own (C7). */
export const testAiAccountId = 'ai-account';

export function createIssueContext(options: {
  fields?: Partial<JiraIssue['fields']>;
  rawFields?: JiraIssue['rawFields'];
  comments?: JiraComment[];
  remoteLinks?: JiraIssueContext['remoteLinks'];
  children?: JiraIssue[];
} = {}): JiraIssueContext {
  return {
    issue: {
      id: '10100',
      key: 'PROJ-12',
      fields: { summary: 'Fix the export', status: { id: '1', name: 'To Do' }, description: convertMarkdownToAdf('It fails.'), ...options.fields },
      rawFields: options.rawFields,
    },
    comments: options.comments ?? [],
    remoteLinks: options.remoteLinks ?? [],
    children: options.children ?? [],
  };
}

/** A comment made at `2026-10-05T10:<minute>:00.000+0000` by {@link testCommentAuthor}. */
export function createTestComment(id: string, minute: number, markdown: string, overrides: Partial<JiraComment> = {}): JiraComment {
  return {
    id,
    author: testCommentAuthor,
    created: `2026-10-05T10:${String(minute).padStart(2, '0')}:00.000+0000`,
    body: convertMarkdownToAdf(markdown),
    ...overrides,
  };
}
