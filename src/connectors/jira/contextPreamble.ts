import type { SessionKey } from '../../sessionKey';

/**
 * @description The Jira issue's context preamble (Jira connector plan J5, R5):
 * what `[Telegram thread context]` is for a topic — where the agent works and
 * for whom — glued ahead of a prompt by the bot's one choke point, re-sent only
 * when it changes. Agent-facing, so English. Kept free of the connector's
 * heavier modules: `bot.ts` imports it statically (R20).
 */

export const jiraContextPreambleHeader = '[Jira issue context]';

export interface JiraContextPreambleInput {
  /** A Jira conversation key: `space` is the project, `thread` the issue key. */
  key: SessionKey;
  /** The project's working folder under `WORK_ROOT`. */
  subdir: string;
  timezone?: string;
}

export function buildJiraContextPreamble(input: JiraContextPreambleInput): string {
  const placeParts = [`issue: ${input.key.thread}`, `project: ${input.key.space}`, `folder: ${input.subdir}`];
  if (input.timezone) placeParts.push(`timezone: ${input.timezone}`);
  return [
    jiraContextPreambleHeader,
    placeParts.join(' | '),
    'You work on this issue for its requester — the person who assigned it to you. ' +
      'They see none of your plain output: each answer_request answer becomes a comment on the issue, ' +
      'and a question or a final answer hands the issue back to them.',
  ].join('\n');
}
