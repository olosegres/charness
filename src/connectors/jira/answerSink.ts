import type { SessionKey } from '../../sessionKey';
import type { AnswerSink, AnswerDeliveryResult } from '../../platform/answerSink';
import type { RequestAlertReason } from '../../requests/types';
import { emptyRequester, getRequestRequester } from '../../requests/requestGroup';
import { convertMarkdownToAdf, createCommentBodies, getAdfText, type AdfDocument } from './adf';
import type { JiraAccount, JiraClient } from './client';
import { getCommentBodyHash, type JiraUnconfirmedPosts } from './unconfirmedPosts';

/**
 * @description The Jira connector's answer sink (plan J6, D20, R18): an answer
 * becomes one or more comments by the AI account, in order; a `question` or a
 * `final` answer to an open request hands the issue back to the requester — but
 * ONLY while it is still assigned to the AI account (someone who took it
 * meanwhile keeps it). Comment first, then the hand-back: a hand-back that fails
 * leaves the answer delivered (a warning, never a retry that would post it twice).
 * A comment post whose outcome is unknown (R18) is never re-posted blindly: the
 * issue's newest comments are read once, after a short wait, and a matching
 * comment by the AI account counts as delivered. A post left unconfirmed is
 * remembered on disk (R29): when the same text is sent again for the same
 * request, the issue is read first and a comment that did land is not posted
 * twice. The agent cannot look at the issue itself, so every failure tells it
 * what to send again. Bot texts on the issue are English (D20).
 */

/** How many of the issue's newest comments R18's read-back looks through. */
export const jiraReadBackCommentCount = 20;
/**
 * A comment Jira dated this much before the post started still counts as the post
 * (clock skew) — short (R30), so an earlier identical comment, such as a repeated
 * park notice, is not taken for the new one.
 */
export const jiraReadBackClockSkewMs = 60 * 1000;
/**
 * How long the read-back waits after a post of unknown outcome: a post that timed
 * out or met a 5xx may still be committing on Jira's side, and reading at once
 * would call it "not posted" and invite the agent to post it twice.
 */
export const jiraReadBackDelayMs = 10_000;
/** How much of the first unposted part a partial delivery quotes, so the agent can tell where to resend from. */
const missingPartPreviewChars = 80;

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
  /** Pause before the read-back ({@link jiraReadBackDelayMs}). */
  wait: (ms: number) => Promise<void>;
  unconfirmedPosts: Pick<JiraUnconfirmedPosts, 'getPostedAt' | 'recordUnconfirmed' | 'settle'>;
}

/**
 * Why a comment did not land. `unchecked` — an earlier, unconfirmed post of the
 * same text may have landed and the issue could not be read to check (R29).
 */
interface CommentPostFailure {
  kind: 'refused' | 'notPosted' | 'unknown' | 'unchecked';
  detail: string;
}

/** What posting an answer's comments did: how many landed, and why the next one did not. */
interface CommentsPosted {
  postedCount: number;
  failure: CommentPostFailure | null;
}

/** A comment's text as the read-back compares it: its plain text, whitespace collapsed. */
function getComparableText(body: Parameters<typeof getAdfText>[0]): string {
  return getAdfText(body).replace(/\s+/g, ' ').trim();
}

/** The start of a comment's text, for the agent to find in its own answer. */
function getTextPreview(body: AdfDocument): string {
  const characters = [...getComparableText(body)];
  return characters.length > missingPartPreviewChars ? `${characters.slice(0, missingPartPreviewChars).join('')}…` : characters.join('');
}

export interface JiraAnswerSink extends AnswerSink {
  /** Over the run budget (D12): the park notice, then the hand-back. Never rejects. */
  parkIssue(issueKey: string, requester: JiraAccount | null): Promise<void>;
}

export function createJiraAnswerSink(deps: JiraAnswerSinkDeps): JiraAnswerSink {
  const { client } = deps;

  /** Is the comment on the issue, by the AI account, dated from the post's start on? `null` — the issue could not be read. */
  async function checkIsCommentOnIssue(issueKey: string, comparableText: string, postStartedAt: number): Promise<boolean | null> {
    try {
      const comments = await client.getRecentComments(issueKey, jiraReadBackCommentCount);
      return comments.some((comment) =>
        comment.author?.accountId === deps.aiAccountId
        && Date.parse(comment.created) >= postStartedAt - jiraReadBackClockSkewMs
        && getComparableText(comment.body) === comparableText);
    } catch (error) {
      console.warn(`[jira] ${issueKey}: read-back failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Post one comment. With a `requestId`, a post left unconfirmed is remembered,
   * and a resend of a remembered one reads the issue first (R29).
   */
  async function postComment(issueKey: string, body: AdfDocument, requestId: string | null): Promise<CommentPostFailure | 'posted'> {
    const comparableText = getComparableText(body);
    const bodyHash = getCommentBodyHash(comparableText);
    const earlierPostedAt = requestId === null ? null : deps.unconfirmedPosts.getPostedAt(requestId, bodyHash);
    if (requestId !== null && earlierPostedAt !== null) {
      const isEarlierOnIssue = await checkIsCommentOnIssue(issueKey, comparableText, earlierPostedAt);
      if (isEarlierOnIssue === null) {
        return { kind: 'unchecked', detail: 'the issue could not be read to check whether the earlier attempt landed' };
      }
      deps.unconfirmedPosts.settle(requestId, bodyHash);
      if (isEarlierOnIssue) return 'posted';
    }
    const postStartedAt = deps.now();
    let result: Awaited<ReturnType<JiraClient['addComment']>>;
    try {
      result = await client.addComment(issueKey, body);
    } catch (error) {
      return { kind: 'refused', detail: error instanceof Error ? error.message : String(error) };
    }
    if (result.outcome === 'created') return 'posted';
    // R18: a post that timed out or met a 5xx may still be committing on Jira's side.
    await deps.wait(jiraReadBackDelayMs);
    const isOnIssue = await checkIsCommentOnIssue(issueKey, comparableText, postStartedAt);
    if (isOnIssue === true) return 'posted';
    if (requestId !== null) deps.unconfirmedPosts.recordUnconfirmed(requestId, bodyHash, postStartedAt);
    return isOnIssue === false
      ? { kind: 'notPosted', detail: `${result.reason}; it was not on the issue ${jiraReadBackDelayMs / 1000} s later` }
      : { kind: 'unknown', detail: result.reason };
  }

  async function postComments(issueKey: string, bodies: readonly AdfDocument[], requestId: string | null): Promise<CommentsPosted> {
    let postedCount = 0;
    for (const body of bodies) {
      const outcome = await postComment(issueKey, body, requestId);
      if (outcome !== 'posted') return { postedCount, failure: outcome };
      postedCount += 1;
    }
    return { postedCount, failure: null };
  }

  /** Hand the issue back to the requester while it is still the AI's; a warning when that could not happen. */
  async function handBack(issueKey: string, requesterAccountId: string): Promise<string | null> {
    if (requesterAccountId === emptyRequester) return 'no requester is known, so the issue stays assigned to the AI account';
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

  /**
   * A failure before the first comment landed. The agent has no way to look at the
   * issue itself, so the text says what to do: send again — and, when the issue
   * could not be read, to send the same text unchanged, since only an identical
   * resend is checked against the issue first (R29).
   */
  function getNothingPostedError(failure: CommentPostFailure): string {
    switch (failure.kind) {
      case 'refused':
        return `Jira did not take the comment: ${failure.detail}`;
      case 'notPosted':
        return `Jira did not confirm the comment (${failure.detail}), so it was most likely not posted; send the answer again`;
      case 'unknown':
        return `Jira did not confirm the comment and the issue could not be read to check it (${failure.detail}); it may already be there. ` +
          'Send the answer again, unchanged: before the same text is posted again, the issue is read, so a comment that did land is not posted twice';
      case 'unchecked':
        return `Nothing was posted: ${failure.detail}. Send the answer again in a few minutes`;
    }
  }

  /** A failure after some comments landed: where the unposted rest starts, so only that rest is sent again. */
  function getMissingPartsWarning(bodies: readonly AdfDocument[], posted: CommentsPosted, failure: CommentPostFailure): string {
    const restStart = `"${getTextPreview(bodies[posted.postedCount])}"`;
    const postedPart = `the first ${posted.postedCount} of the answer's ${bodies.length} comments reached the issue`;
    if (failure.kind === 'unknown') {
      return `${postedPart}; the next one, starting at ${restStart}, may or may not have (${failure.detail}; the issue could not be read to check), ` +
        `and nothing after it was posted. Send the rest again, unchanged, starting at ${restStart} — the same text is checked against the issue first, so a comment that did land is not posted twice`;
    }
    if (failure.kind === 'unchecked') {
      return `${postedPart}; nothing after them was posted (${failure.detail}). Send the rest again in a few minutes, starting at ${restStart}`;
    }
    return `${postedPart}, the rest did not (${failure.detail}). Send the rest again, starting at ${restStart} — not the comments already posted`;
  }

  return {
    async deliverAnswer(key: SessionKey, delivery): Promise<AnswerDeliveryResult> {
      const issueKey = key.thread;
      const bodies = createCommentBodies(delivery.body);
      if (bodies.length === 0) return { ok: false, error: 'the answer is empty' };
      const posted = await postComments(issueKey, bodies, delivery.requestId);
      if (posted.postedCount === 0 && posted.failure) return { ok: false, error: getNothingPostedError(posted.failure) };
      const warnings: string[] = [];
      if (posted.failure) warnings.push(getMissingPartsWarning(bodies, posted, posted.failure));
      // An answer to a request that is no longer open (superseded by a newer one) must not take the issue from it.
      if (delivery.isRequestOpen && (delivery.kind === 'question' || delivery.kind === 'final')) {
        const handBackWarning = await handBack(issueKey, getRequestRequester(delivery.origin));
        if (handBackWarning) warnings.push(handBackWarning);
      }
      return warnings.length > 0 ? { ok: true, warning: warnings.join('; ') } : { ok: true };
    },

    async deliverAlert(key, alert) {
      const issueKey = key.thread;
      const posted = await postComments(issueKey, [convertMarkdownToAdf(buildJiraAlertText(alert.requestId, alert.reason))], alert.requestId);
      if (posted.postedCount === 0 && posted.failure) return { ok: false, error: getNothingPostedError(posted.failure) };
      const handBackWarning = await handBack(issueKey, getRequestRequester(alert.origin));
      if (handBackWarning) console.warn(`[jira] ${issueKey}: alert for ${alert.requestId}: ${handBackWarning}`);
      // A comment needs no release: nothing is pinned.
      return { ok: true };
    },

    async releaseAlert() {},

    async parkIssue(issueKey, requester) {
      const posted = await postComments(issueKey, [convertMarkdownToAdf(buildJiraParkText(deps.runBudgetPer24h))], null);
      if (posted.postedCount === 0 && posted.failure) {
        console.warn(`[jira] ${issueKey}: park notice not posted: ${getNothingPostedError(posted.failure)}`);
        return;
      }
      const handBackWarning = await handBack(issueKey, requester?.accountId ?? emptyRequester);
      if (handBackWarning) console.warn(`[jira] ${issueKey}: park: ${handBackWarning}`);
    },
  };
}
