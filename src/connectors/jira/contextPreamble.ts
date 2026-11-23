import { answerStyleInstruction } from '../../requests/answerStyle';
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
    'You work on this issue for its requesters: the person who handed it to you, or someone who mentioned you in a comment. ' +
      'They see none of your plain output: each answer_request answer becomes a comment on the issue. ' +
      'On a hand-over, a question or a final answer hands the issue back to its requester; on a mention, the issue stays where it is. ' +
      'To reply to someone\'s comment, put its id in answer_request\'s replyToCommentIds: the bot then mentions its author, so they are notified, ' +
      'and posts your answer in that comment\'s thread. A request that a reply in a thread opened is answered in that thread by itself.',
    answerStyleInstruction,
    // Within one request the answer sink keeps the agent's plain progress answers as ONE comment: each replaces the text of the last.
    'Within one request, your plain progress answers are ONE comment: the first posts it, each next one replaces its text (it then shows when it was last updated), ' +
      'so write each progress note as the full current status, never as an addition to the one before. ' +
      'A note that attaches files or replies to a comment is a comment of its own, and so is the first note after a person has written on the issue; so is a question or a final answer.',
    // C12: restricted and internal comments are given to the agent, marked; what they say stays among those who may read them.
    'A comment marked [restricted to …] or [internal] is not for everyone who can read this issue: ' +
      'never quote or paraphrase it, or what it says, in an answer.',
    // C10: the original of a file the issue lists.
    'The issue\'s files are listed under Attachments and shown where they sit, e.g. "[image: shot.png — attachment 10234]": ' +
      'fetch an original with the jira_get_attachment tool (the attachment id) and read the file at the path it returns.',
  ].join('\n');
}
