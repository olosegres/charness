import type { SessionKey } from '../../sessionKey';
import type { AnswerSink, AnswerDeliveryResult, RequestAnswerDelivery } from '../../platform/answerSink';
import type { RequestAlertReason, RequestOrigin } from '../../requests/types';
import { emptyRequester, getRequestRequester } from '../../requests/requestGroup';
import {
  convertMarkdownToAdf,
  createCommentBodies,
  createCommentBodiesWithLeadingNode,
  createMentionParagraph,
  createPlainTextAdf,
  getAdfText,
  type AdfDocument,
} from './adf';
import { getSingleLineText } from './promptText';
import { JiraHttpError, type JiraAccount, type JiraClient } from './client';
import { getCommentBodyHash, type JiraUnconfirmedPosts } from './unconfirmedPosts';
import { mentionTriggerIdPrefix, checkIsPersonAccount } from './trigger';
import { checkIsCommentTrusted } from './issueBlocks';
import type { JiraContextLedger } from './contextLedger';
import type { JiraTrust } from './trustedGroup';

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

/** @description The park notice (D12): over the run budget, handed back without a new request. Hand-overs and mentions share the budget. */
export function buildJiraParkText(runBudgetPer24h: number): string {
  return `⏸ The AI was asked to work on this issue ${runBudgetPer24h} times in the last 24 hours (hand-overs and mentions together), ` +
    'its limit, so no new request was opened. Assign it to the AI again later, or ask the operator to raise the limit.';
}

/** @description The mention park notice (D10): over the run budget, nothing is handed back — the issue was never handed over. */
export function buildJiraMentionParkText(runBudgetPer24h: number): string {
  return `⏸ The AI was asked about this issue ${runBudgetPer24h} times in the last 24 hours (hand-overs and mentions together), ` +
    'its limit, so this mention was not answered. Mention it again later, or ask the operator to raise the limit.';
}

/**
 * @description The warning that rides an answer's result when some of `replyToCommentIds` were left out: the
 * answer itself was delivered, so the agent is told what to know, never to resend it.
 */
export function buildJiraReplyLeftOutWarning(commentIds: readonly string[]): string {
  return `Delivered, but these comments' authors were not mentioned: ${commentIds.join(', ')}. ` +
    'Only comments you were shown in this conversation, written by a trusted person, can be replied to this way.';
}

/** @description The last paragraph of a hand-over's `question` comment: how the requester lets the agent go on. */
export const jiraQuestionContinueText = 'To let me go on, answer in a comment and assign the issue back to me.';

/**
 * @description The notice of a hand-over the trusted group does not back (T1): nothing was started, and who can
 * hand the AI work. Fixed text — no agent ran. `groupName` is the group as `jira.json` names it.
 */
export function buildJiraUntrustedText(groupName: string): string {
  return `Only members of the AI's trusted group (${groupName}) can hand it work, so nothing was started. Ask a member to hand it over.`;
}

export interface JiraAnswerSinkDeps {
  client: Pick<JiraClient, 'addComment' | 'getRecentComments' | 'getIssue' | 'assignIssue' | 'getComment'>;
  aiAccountId: string;
  /** What each issue's conversation was shown: only a comment it was shown can be replied to. */
  contextLedger: Pick<JiraContextLedger, 'getShownBlock'>;
  /** The trusted group's trust, or `null` without a group (or before it is first read): nobody is judged then. */
  getTrust: () => JiraTrust | null;
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
  return getSingleLineText(getAdfText(body));
}

/** The start of a comment's text, for the agent to find in its own answer. */
function getTextPreview(body: AdfDocument): string {
  const characters = [...getComparableText(body)];
  return characters.length > missingPartPreviewChars ? `${characters.slice(0, missingPartPreviewChars).join('')}…` : characters.join('');
}

/** `body` with {@link jiraQuestionContinueText} as one more paragraph — plain text, never run through Markdown. */
function getBodyWithContinueLine(body: AdfDocument): AdfDocument {
  const [continueParagraph] = createPlainTextAdf(jiraQuestionContinueText).content;
  return { ...body, content: [...body.content, continueParagraph] };
}

export interface JiraAnswerSink extends AnswerSink {
  /** Over the run budget (D12): the park notice, then the hand-back. Never rejects. */
  parkIssue(issueKey: string, requester: JiraAccount | null): Promise<void>;
  /** A mention over the run budget (D10): the park notice, no hand-back (nothing was handed over). Never rejects. */
  parkMention(issueKey: string): Promise<void>;
  /** A hand-over the trusted group `groupName` does not back: the fixed notice, then the hand-back. Never rejects. */
  refuseUntrusted(issueKey: string, requester: JiraAccount | null, groupName: string): Promise<void>;
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

  /**
   * The person a mention request is about: its comment's author, when it is the request's requester and a person
   * (an app cannot be notified). `null` — nobody to mention; the answer goes without.
   */
  async function getMentionRequester(issueKey: string, origin: RequestOrigin): Promise<JiraAccount | null> {
    const requesterAccountId = getRequestRequester(origin);
    const triggerId = origin.attributes.triggerId ?? '';
    if (requesterAccountId === emptyRequester || !triggerId.startsWith(mentionTriggerIdPrefix)) return null;
    try {
      const comment = await client.getComment(issueKey, triggerId.slice(mentionTriggerIdPrefix.length));
      const { author } = comment;
      return author && author.accountId === requesterAccountId && checkIsPersonAccount(author) ? author : null;
    } catch (error) {
      // The comment was deleted, or Jira did not answer: the answer is worth more than its mention.
      console.warn(`[jira] ${issueKey}: the requester of ${triggerId} could not be read, so it is not mentioned: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * The author of comment `commentId` when the agent may reply to it that way: the conversation was shown it and
   * its text was readable then, its author is a person other than the AI account, and — with a trusted group —
   * the comment is trusted now (author and last editor). `null` otherwise.
   */
  async function getReplyTarget(issueKey: string, commentId: string): Promise<JiraAccount | null> {
    const shown = deps.contextLedger.getShownBlock(issueKey, `comment:${commentId}`);
    if (!shown || shown.isWithheld) return null;
    try {
      const comment = await client.getComment(issueKey, commentId);
      const { author } = comment;
      if (!author || author.accountId === deps.aiAccountId || !checkIsPersonAccount(author)) return null;
      const trust = deps.getTrust();
      return trust && !checkIsCommentTrusted(comment, trust) ? null : author;
    } catch (error) {
      // An id Jira does not know is the agent's slip, told to it in the result; anything else is the operator's to see.
      const isUnknownComment = error instanceof JiraHttpError && error.status === 404;
      if (!isUnknownComment) console.warn(`[jira] ${issueKey}: comment ${commentId} could not be read, so its author is not mentioned: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Whom an answer notifies, requester first, each once: the requester of a mention request, and the authors of the
   * comments the answer replies to. `leftOutCommentIds` are the replies that did not qualify.
   */
  async function resolveMentionTargets(issueKey: string, delivery: RequestAnswerDelivery): Promise<{ targets: JiraAccount[]; leftOutCommentIds: string[] }> {
    const targets = new Map<string, JiraAccount>();
    if (delivery.origin.kind === 'trackerMention') {
      const requester = await getMentionRequester(issueKey, delivery.origin);
      if (requester) targets.set(requester.accountId, requester);
    }
    const leftOutCommentIds: string[] = [];
    for (const commentId of new Set(delivery.replyToCommentIds ?? [])) {
      const author = await getReplyTarget(issueKey, commentId);
      if (author) targets.set(author.accountId, author);
      else leftOutCommentIds.push(commentId);
    }
    return { targets: [...targets.values()], leftOutCommentIds };
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
   * A notice the bot writes itself (no agent ran), then the hand-back to the requester. A notice that did not land
   * is a warning and no hand-back: the issue stays the AI's, and the trigger is recorded already, so it is not repeated.
   */
  async function postNoticeAndHandBack(issueKey: string, requester: JiraAccount | null, notice: AdfDocument, noticeKind: 'park' | 'untrusted'): Promise<void> {
    if (!await postNotice(issueKey, notice, noticeKind)) return;
    const handBackWarning = await handBack(issueKey, requester?.accountId ?? emptyRequester);
    if (handBackWarning) console.warn(`[jira] ${issueKey}: ${noticeKind}: ${handBackWarning}`);
  }

  /** A notice the bot writes itself; `false` (and a warning) when it did not land. */
  async function postNotice(issueKey: string, notice: AdfDocument, noticeKind: 'park' | 'untrusted' | 'mention park'): Promise<boolean> {
    const posted = await postComments(issueKey, [notice], null);
    if (posted.postedCount === 0 && posted.failure) {
      console.warn(`[jira] ${issueKey}: ${noticeKind} notice not posted: ${getNothingPostedError(posted.failure)}`);
      return false;
    }
    return true;
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
      const { targets, leftOutCommentIds } = await resolveMentionTargets(issueKey, delivery);
      const bodies = targets.length > 0
        ? createCommentBodiesWithLeadingNode(delivery.body, createMentionParagraph(targets))
        : createCommentBodies(delivery.body);
      if (bodies.length === 0) return { ok: false, error: 'the answer is empty' };
      // Only a hand-over's question asks the requester to take the issue back, so only it carries the line saying how.
      const isHandOver = delivery.origin.kind === 'trackerEvent';
      if (isHandOver && delivery.kind === 'question') bodies[bodies.length - 1] = getBodyWithContinueLine(bodies[bodies.length - 1]);
      const posted = await postComments(issueKey, bodies, delivery.requestId);
      if (posted.postedCount === 0 && posted.failure) return { ok: false, error: getNothingPostedError(posted.failure) };
      const warnings: string[] = [];
      if (leftOutCommentIds.length > 0) warnings.push(buildJiraReplyLeftOutWarning(leftOutCommentIds));
      if (posted.failure) warnings.push(getMissingPartsWarning(bodies, posted, posted.failure));
      // An answer to a request that is no longer open (superseded by a newer one) must not take the issue from it.
      // A mention request never had the issue handed over: its answer is a comment, and the issue stays where it is.
      if (isHandOver && delivery.isRequestOpen && (delivery.kind === 'question' || delivery.kind === 'final')) {
        const handBackWarning = await handBack(issueKey, getRequestRequester(delivery.origin));
        if (handBackWarning) warnings.push(handBackWarning);
      }
      return warnings.length > 0 ? { ok: true, warning: warnings.join('; ') } : { ok: true };
    },

    async deliverAlert(key, alert) {
      const issueKey = key.thread;
      const posted = await postComments(issueKey, [convertMarkdownToAdf(buildJiraAlertText(alert.requestId, alert.reason))], alert.requestId);
      if (posted.postedCount === 0 && posted.failure) return { ok: false, error: getNothingPostedError(posted.failure) };
      if (alert.origin.kind === 'trackerEvent') {
        const handBackWarning = await handBack(issueKey, getRequestRequester(alert.origin));
        if (handBackWarning) console.warn(`[jira] ${issueKey}: alert for ${alert.requestId}: ${handBackWarning}`);
      }
      // A comment needs no release: nothing is pinned.
      return { ok: true };
    },

    async releaseAlert() {},

    parkIssue: (issueKey, requester) =>
      postNoticeAndHandBack(issueKey, requester, convertMarkdownToAdf(buildJiraParkText(deps.runBudgetPer24h)), 'park'),

    parkMention: async (issueKey) => {
      await postNotice(issueKey, convertMarkdownToAdf(buildJiraMentionParkText(deps.runBudgetPer24h)), 'mention park');
    },

    refuseUntrusted: (issueKey, requester, groupName) =>
      postNoticeAndHandBack(issueKey, requester, createPlainTextAdf(buildJiraUntrustedText(groupName)), 'untrusted'),
  };
}
