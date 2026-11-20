import type { OperatorAlertChannel } from '../../platform/operatorAlert';
import { createCommentBodies, createCommentBodiesWithLeadingNode, createMentionParagraph } from './adf';
import type { JiraClient } from './client';

/**
 * @description The OPERATOR ISSUE (`jira.json` `operatorIssue`): on an instance with no Telegram General, the bot's own channel to
 * its operator. Each operator alert (a Claude account signed out, nothing usable — `utils/claudeAccountAlert.ts`) becomes a comment
 * by the AI account there; an alert that asks the operator to act opens with a mention of `operatorAccountIds` (Jira notifies them),
 * a recovery line mentions nobody. The issue is never a request source: the poller's search never returns it
 * ({@link hideJiraOperatorIssue}), so a hand-over, a comment or a mention on it reaches no agent.
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

/**
 * @description The client the poller searches with, the operator issue (`issueKey`; `null` = none) left out of every page of
 * results: whatever happens on it — assigned to the AI, a comment, a mention — is no request. The first time it is left out the log
 * says so once. Every other call goes to `client` as it is.
 */
export function hideJiraOperatorIssue<T extends Pick<JiraClient, 'searchIssues'>>(client: T, issueKey: string | null): T {
  if (issueKey === null) return client;
  let isLogged = false;
  const searchIssues: JiraClient['searchIssues'] = async (request) => {
    const page = await client.searchIssues(request);
    if (!page.issues.some((issue) => issue.key === issueKey)) return page;
    if (!isLogged) {
      isLogged = true;
      console.log(`[jira] poll: ${issueKey} is the operator issue — its comments, mentions and hand-overs are not requests`);
    }
    return { ...page, issues: page.issues.filter((issue) => issue.key !== issueKey) };
  };
  return new Proxy(client, {
    get: (target, property, receiver): unknown => (property === 'searchIssues' ? searchIssues : Reflect.get(target, property, receiver)),
  });
}
