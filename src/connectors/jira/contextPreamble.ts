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
    // C12: restricted and internal comments are given to the agent, marked; what they say stays among those who may read them.
    'A comment marked [restricted to …] or [internal] is not for everyone who can read this issue: ' +
      'never quote or paraphrase it, or what it says, in an answer.',
    // C10: the original of a file the issue lists.
    'The issue\'s files are listed under Attachments and shown where they sit, e.g. "[image: shot.png — attachment 10234]": ' +
      'fetch an original with the jira_get_attachment tool (the attachment id) and read the file at the path it returns.',
  ].join('\n');
}
