import { buildRequestHeader } from '../../requests/requestHeader';
import { getAdfText } from './adf';
import type { JiraAccount, JiraIssue } from './client';
import type { JiraIssueTrigger } from './trigger';

/**
 * @description The prompt a Jira request brings the agent (plan J5, D15): the
 * core request header, then the issue — key, summary, link, status, who handed
 * it over and how, the description and the latest comments as plain text. The
 * answer to a `question` arrives as a comment, so the agent must see the latest
 * ones without a tool call. Agent-facing, so English.
 */

export const jiraPromptDescriptionMaxChars = 8_000;
export const jiraPromptCommentMaxChars = 2_000;
export const jiraPromptCommentCount = 3;
/** The fields the prompt reads, fetched once per request. */
export const jiraPromptIssueFields = ['summary', 'status', 'description', 'comment', 'reporter', 'creator'];
const truncationNote = ' … [cut here — the rest is in Jira]';
const unnamedAccount = 'someone';

function getCappedText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}${truncationNote}` : text;
}

function getAccountName(account: JiraAccount | null | undefined): string {
  return account?.displayName ?? unnamedAccount;
}

/** How the issue reached the agent, in a few words — the header's `from:`. */
export function getJiraOriginDescription(issueKey: string, trigger: JiraIssueTrigger, statusName: string | undefined): string {
  const by = getAccountName(trigger.author);
  switch (trigger.kind) {
    case 'assigned':
      return `${issueKey} assigned to you by ${by}`;
    case 'statusChanged':
      return `${issueKey} moved to "${statusName ?? 'a trigger status'}" by ${by}`;
    case 'created':
      return `${issueKey} created assigned to you by ${by}`;
  }
}

export interface JiraRequestPromptInput {
  requestId: string;
  issue: JiraIssue;
  /** `https://<site>/browse/<KEY>`. */
  issueUrl: string;
  trigger: JiraIssueTrigger;
  requester: JiraAccount | null;
}

export function buildJiraRequestPrompt(input: JiraRequestPromptInput): string {
  const { issue, trigger } = input;
  const statusName = issue.fields.status?.name;
  const header = buildRequestHeader({
    requestId: input.requestId,
    originDescription: getJiraOriginDescription(issue.key, trigger, statusName),
    isPlainTextHidden: true,
  });
  const lines = [
    `Jira issue ${issue.key}: ${issue.fields.summary ?? '(no summary)'}`,
    `Link: ${input.issueUrl}`,
    `Status: ${statusName ?? 'unknown'}`,
    `Requester (your answers go to them): ${getAccountName(input.requester)}`,
    '',
    'Description:',
    getCappedText(getAdfText(issue.fields.description) || '(empty)', jiraPromptDescriptionMaxChars),
  ];
  const comments = [...(issue.fields.comment?.comments ?? [])]
    .sort((left, right) => Date.parse(left.created) - Date.parse(right.created))
    .slice(-jiraPromptCommentCount);
  if (comments.length > 0) {
    lines.push('', `Latest comments (oldest first, ${comments.length} of ${issue.fields.comment?.total ?? comments.length}):`);
    for (const comment of comments) {
      lines.push(`— ${getAccountName(comment.author)}, ${comment.created}:`, getCappedText(getAdfText(comment.body), jiraPromptCommentMaxChars));
    }
  }
  return `${header}${lines.join('\n')}`;
}
