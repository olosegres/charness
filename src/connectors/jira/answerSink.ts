import type { SessionKey } from '../../sessionKey';
import type { AnswerSink, AnswerDeliveryResult } from '../../platform/answerSink';
import type { RequestAlertReason, RequestOrigin } from '../../requests/types';
import { convertMarkdownToAdf, createCommentBodies, getAdfText, type AdfDocument } from './adf';
import type { JiraAccount, JiraClient } from './client';

/**
 * @description The Jira connector's answer sink (plan J6, D20, R18): an answer
 * becomes one or more comments by the AI account, in order; a `question` or a
 * `final` answer to an open request hands the issue back to the requester — but
 * ONLY while it is still assigned to the AI account (someone who took it
 * meanwhile keeps it). Comment first, then the hand-back: a hand-back that fails
 * leaves the answer delivered (a warning, never a retry that would post it twice).
 * A comment post whose outcome is unknown (R18) is never re-posted blindly: the
 * issue's newest comments are read once, and a matching comment by the AI
 * account counts as delivered. Bot texts on the issue are English (D20).
 */

/** How many of the issue's newest comments R18's read-back looks through. */
export const jiraReadBackCommentCount = 20;
/** A comment Jira dated this much before the post started still counts as the post (clock skew). */
export const jiraReadBackClockSkewMs = 5 * 60 * 1000;

const alertTexts: Readonly<Record<RequestAlertReason, string>> = {
  silentTurns: 'the agent ended its turns without answering, and the reminders gave up',
  wakeCap: 'the agent was reminded as many times as allowed without answering',
  wakeFailed: "the agent's session could not be reached to remind it",
};

/** @description The alert comment: which request, why, and that a person is needed (D20). */
export function buildJiraAlertText(requestId: string, reason: RequestAlertReason): string {
  return `⚠️ The AI could not finish request ${requestId}: ${alertTexts[reason]}. A person needs to look at this issue.`;
}

/** @description The park notice (D12): over the run budget, handed back without a new request. */
export function buildJiraParkText(runBudgetPer24h: number): string {
  return `⏸ This issue was handed to the AI ${runBudgetPer24h} times in the last 24 hours, its limit, so no new request was opened. ` +
    'Assign it to the AI again later, or ask the operator to raise the limit.';
}

export interface JiraAnswerSinkDeps {
  client: Pick<JiraClient, 'addComment' | 'getRecentComments' | 'getIssue' | 'assignIssue'>;
  aiAccountId: string;
  runBudgetPer24h: number;
  now: () => number;
}

/** What posting an answer's comments did: how many landed, and why the next one did not. */
interface CommentsPosted {
  postedCount: number;
  failure: { kind: 'refused' | 'notPosted' | 'unknown'; detail: string } | null;
}

/** A comment's text as the read-back compares it: its plain text, whitespace collapsed. */
function getComparableText(body: Parameters<typeof getAdfText>[0]): string {
  return getAdfText(body).replace(/\s+/g, ' ').trim();
}

export interface JiraAnswerSink extends AnswerSink {
  /** Over the run budget (D12): the park notice, then the hand-back. Never rejects. */
  parkIssue(issueKey: string, requester: JiraAccount | null): Promise<void>;
}

export function createJiraAnswerSink(deps: JiraAnswerSinkDeps): JiraAnswerSink {
  const { client } = deps;

  /** R18: did the post that left no readable answer land after all? `null` — the read-back failed too. */
  async function checkIsCommentOnIssue(issueKey: string, body: AdfDocument, postStartedAt: number): Promise<boolean | null> {
    try {
      const expected = getComparableText(body);
      const comments = await client.getRecentComments(issueKey, jiraReadBackCommentCount);
      return comments.some((comment) =>
        comment.author?.accountId === deps.aiAccountId
        && Date.parse(comment.created) >= postStartedAt - jiraReadBackClockSkewMs
        && getComparableText(comment.body) === expected);
    } catch (error) {
      console.warn(`[jira] ${issueKey}: read-back failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async function postComments(issueKey: string, bodies: readonly AdfDocument[]): Promise<CommentsPosted> {
    let postedCount = 0;
    for (const body of bodies) {
      const postStartedAt = deps.now();
      let result: Awaited<ReturnType<JiraClient['addComment']>>;
      try {
        result = await client.addComment(issueKey, body);
      } catch (error) {
        return { postedCount, failure: { kind: 'refused', detail: error instanceof Error ? error.message : String(error) } };
      }
      if (result.outcome === 'deliveryUnknown') {
        const isOnIssue = await checkIsCommentOnIssue(issueKey, body, postStartedAt);
        if (isOnIssue === false) return { postedCount, failure: { kind: 'notPosted', detail: result.reason } };
        if (isOnIssue === null) return { postedCount, failure: { kind: 'unknown', detail: result.reason } };
      }
      postedCount += 1;
    }
    return { postedCount, failure: null };
  }

  /** Hand the issue back to the requester while it is still the AI's; a warning when that could not happen. */
  async function handBack(issueKey: string, requesterAccountId: string): Promise<string | null> {
    if (requesterAccountId === '') return 'no requester is known, so the issue stays assigned to the AI account';
    try {
      const issue = await client.getIssue(issueKey, ['assignee']);
      // Someone took it meanwhile: they keep it.
      if (issue.fields.assignee?.accountId !== deps.aiAccountId) return null;
      await client.assignIssue(issueKey, requesterAccountId);
      return null;
    } catch (error) {
      return `the issue could not be handed back to the requester (${error instanceof Error ? error.message : String(error)}); it stays assigned to the AI account`;
    }
  }

  function getRequesterAccountId(origin: RequestOrigin): string {
    return origin.attributes.requesterAccountId ?? '';
  }

  /** A failure before the first comment landed: nothing is on the issue, the agent may send it again — or must look first. */
  function getNothingPostedError(failure: NonNullable<CommentsPosted['failure']>): string {
    switch (failure.kind) {
      case 'refused':
        return `Jira did not take the comment: ${failure.detail}`;
      case 'notPosted':
        return `the comment was not posted (${failure.detail}); sending the answer again is safe`;
      case 'unknown':
        return `Jira did not confirm the comment and it could not be checked (${failure.detail}); it may already be on the issue — check before sending it again`;
    }
  }

  return {
    async deliverAnswer(key: SessionKey, delivery): Promise<AnswerDeliveryResult> {
      const issueKey = key.thread;
      const bodies = createCommentBodies(delivery.body);
      if (bodies.length === 0) return { ok: false, error: 'the answer is empty' };
      const posted = await postComments(issueKey, bodies);
      if (posted.postedCount === 0 && posted.failure) return { ok: false, error: getNothingPostedError(posted.failure) };
      const warnings: string[] = [];
      if (posted.failure) {
        warnings.push(`comment parts ${posted.postedCount + 1}–${bodies.length} of ${bodies.length} were not posted (${posted.failure.detail}); ` +
          'send only the missing part again');
      }
      // An answer to a request that is no longer open (superseded by a newer one) must not take the issue from it.
      if (delivery.isRequestOpen && (delivery.kind === 'question' || delivery.kind === 'final')) {
        const handBackWarning = await handBack(issueKey, getRequesterAccountId(delivery.origin));
        if (handBackWarning) warnings.push(handBackWarning);
      }
      return warnings.length > 0 ? { ok: true, warning: warnings.join('; ') } : { ok: true };
    },

    async deliverAlert(key, alert) {
      const issueKey = key.thread;
      const posted = await postComments(issueKey, [convertMarkdownToAdf(buildJiraAlertText(alert.requestId, alert.reason))]);
      if (posted.postedCount === 0 && posted.failure) return { ok: false, error: getNothingPostedError(posted.failure) };
      const handBackWarning = await handBack(issueKey, getRequesterAccountId(alert.origin));
      if (handBackWarning) console.warn(`[jira] ${issueKey}: alert for ${alert.requestId}: ${handBackWarning}`);
      // A comment needs no release: nothing is pinned.
      return { ok: true };
    },

    async releaseAlert() {},

    async parkIssue(issueKey, requester) {
      const posted = await postComments(issueKey, [convertMarkdownToAdf(buildJiraParkText(deps.runBudgetPer24h))]);
      if (posted.postedCount === 0 && posted.failure) {
        console.warn(`[jira] ${issueKey}: park notice not posted: ${getNothingPostedError(posted.failure)}`);
        return;
      }
      const handBackWarning = await handBack(issueKey, requester?.accountId ?? '');
      if (handBackWarning) console.warn(`[jira] ${issueKey}: park: ${handBackWarning}`);
    },
  };
}
