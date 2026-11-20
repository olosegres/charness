import type { OperatorAlertChannel } from '../../platform/operatorAlert';
import { createCommentBodies, createCommentBodiesWithLeadingNode, createMentionParagraph } from './adf';
import { JiraHttpError, type JiraClient } from './client';

/**
 * @description The OPERATOR ISSUE (`jira.json` `operatorIssue`): on an instance with no Telegram General, the bot's own channel to
 * its operator. Each operator alert (a Claude account signed out, nothing usable — `utils/claudeAccountAlert.ts`) becomes a comment
 * by the AI account there; an alert that asks the operator to act opens with a mention of `operatorAccountIds` (Jira notifies them),
 * a recovery line mentions nobody. The issue is never a request source: the poller never sees it ({@link hideJiraOperatorIssue}),
 * so a hand-over, a comment or a mention on it reaches no agent.
 *
 * A post is made once and never retried: the comment's outcome may be unknown (a timeout), and an alert told twice is worse than one
 * the log names as not posted.
 */
export function createJiraOperatorChannel(deps: {
  client: Pick<JiraClient, 'addComment'>;
  issueKey: string;
  /** Mentioned on an alert that asks the operator to act; empty = no mention. */
  operatorAccountIds: readonly string[];
}): OperatorAlertChannel {
  const { client, issueKey, operatorAccountIds } = deps;
  return {
    label: `jira ${issueKey}`,
    async post(text, options) {
      const bodies = options.isActionRequired && operatorAccountIds.length > 0
        ? createCommentBodiesWithLeadingNode(text, createMentionParagraph(operatorAccountIds.map((accountId) => ({ accountId }))))
        : createCommentBodies(text);
      for (const [index, body] of bodies.entries()) {
        try {
          await client.addComment(issueKey, body);
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          return { ok: false, error: index === 0 ? `the alert comment on ${issueKey} was not posted: ${reason}` : `part ${index + 1} of the alert comment on ${issueKey} was not posted: ${reason}` };
        }
      }
      return { ok: true };
    },
  };
}

/** What a read of the operator issue by the poller answers: Jira's own status for an issue out of reach. */
const jiraHiddenIssueStatus = 404;

/**
 * @description The client the poller works with, which never sees the operator issue (`issueKey`; `null` = none): it is left out of
 * every page of search results, and a read of it by its key — the poller's own re-reads of an issue it kept from an earlier poll (a
 * mention waiting for a slot, a mention held back from its update, an issue that left the handed state; one may date from before
 * `operatorIssue` was set) — answers as Jira does for an issue out of reach, a 404, so the poller drops what it kept for it. Whatever
 * happens on it — assigned to the AI, a comment, a mention — is no request. The first time it is hidden the log says so once. Every
 * other call goes to `client` as it is.
 */
export function hideJiraOperatorIssue<T extends Pick<JiraClient, 'searchIssues' | 'getIssue'>>(client: T, issueKey: string | null): T {
  if (issueKey === null) return client;
  let isLogged = false;
  const noteHidden = (): void => {
    if (isLogged) return;
    isLogged = true;
    console.log(`[jira] poll: ${issueKey} is the operator issue — its comments, mentions and hand-overs are not requests`);
  };
  const searchIssues: JiraClient['searchIssues'] = async (request) => {
    const page = await client.searchIssues(request);
    if (!page.issues.some((issue) => issue.key === issueKey)) return page;
    noteHidden();
    return { ...page, issues: page.issues.filter((issue) => issue.key !== issueKey) };
  };
  const getIssue: JiraClient['getIssue'] = async (requestedKey, fields, expand) => {
    if (requestedKey !== issueKey) return client.getIssue(requestedKey, fields, expand);
    noteHidden();
    throw new JiraHttpError(jiraHiddenIssueStatus, 'GET', `/rest/api/3/issue/${issueKey}`, 'the operator issue is not a request source');
  };
  return new Proxy(client, {
    get: (target, property, receiver): unknown => {
      if (property === 'searchIssues') return searchIssues;
      if (property === 'getIssue') return getIssue;
      return Reflect.get(target, property, receiver);
    },
  });
}
