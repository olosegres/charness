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
  type AdfNode,
} from './adf';
import { getSingleLineText } from './promptText';
import { getCommentThreadRootId, JiraAuthError, JiraHttpError, type JiraAccount, type JiraClient, type JiraComment } from './client';
import { getCommentBodyHash, type JiraUnconfirmedPosts } from './unconfirmedPosts';
import { jiraReplyThreadAttribute, mentionTriggerIdPrefix, checkIsPersonAccount } from './trigger';
import { checkIsCommentTrusted } from './issueBlocks';
import type { JiraContextLedger } from './contextLedger';
import type { JiraTrust } from './trustedGroup';
import type { TaskAgentSlotDecision } from '../../trackers/taskAgentSlots';
import type { SendFilesToThreadResult } from '../../utils/fileSendService';
import { appendNodesToBodies, type JiraFilesAttachResult } from './outgoingFiles';
import type { JiraAnswerThreads } from './answerThreads';
import { getJiraNoticeSlot, jiraProgressSlot, type JiraProgressComments } from './progressComments';

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
 *
 * Comment threads: an answer goes into the thread of the first comment it replies to (`replyToCommentIds`), else into
 * the thread the request's latest issue update came from (`answerThreads.ts`: its newest comment was a reply there; the
 * agent's answer delivered uses it up, a notice the bot writes does not), else into the thread its request was opened
 * in (the origin's {@link jiraReplyThreadAttribute}), else it is a top-level comment; the request's alert and the
 * notices about its trigger follow the request's own thread. Jira threads are one level deep, so a reply always names
 * the thread's top-level comment. A thread Jira refuses (400: its comments are gone)
 * gets the comment top-level instead, and the agent is told.
 *
 * Files: an answer's `files` are attached to the issue BEFORE its comment is posted and shown in it, after its text
 * (`outgoingFiles.ts`); a file that cannot be attached fails the answer with nothing posted. `postFiles` is
 * `send_file_to_user` on an issue: the files, and the caption as text, in a comment of their own.
 *
 * One progress comment per request (`progressComments.ts`): the first `progress` answer of a request posts a comment and the sink
 * remembers it (on disk); each next one EDITS it to the newest text, with a line saying when it was last updated, in the thread
 * the first stood in — an edit moves nothing and notifies nobody. A `question` or `final` answer is a new comment as ever, and it
 * closes the progress comments it ends — its request's and those of the requests it replaced, the ones let go earlier (an issue
 * update, a note that was a comment of its own, the alert) included: a line on top says the notes were interim and the answer (or
 * the question) is in a newer comment, so no note still reads as work under way ("pipeline 42 is running now, I'll report when it
 * finishes") once the answer stands below it. The closing comes after the hand-back: it is cosmetic, the hand-back notifies. An edit Jira refuses (the comment is gone, 400, 403), or
 * one of unknown outcome whose read-back shows the old text and whose one repeat does not land, posts the text as a new comment
 * instead (with R18's read-back) and that one is remembered — the text is never lost. An edit of unknown outcome whose comment cannot be read is an error that tells the agent
 * to send it again: nothing is posted, and the resend edits the same comment (a new comment would show the text twice). A progress answer is kept as that one comment only when it is a plain note: it carries no
 * files, replies to no comment (an edit notifies nobody, a reply is meant to) and fits one comment; any other is a comment of its
 * own, like a question, and the progress comment is let go, so the next note starts below it. So is an issue update the request
 * receives (`noteIssueUpdate`, a reply or a top-level comment): what the agent answers to the person is a new comment below theirs
 * — in the thread it asked for — and the notes after it edit that one. The bot's own notice that repeats for a request (`RequestAnswerDelivery.repeatKey`: a
 * usage-limit wait once more) is kept the same way, in a slot of its own — but only for back-to-back repeats: once the agent's own
 * answer is delivered (posted or edited), another bot comment of its own stands below it (an account moved, no account usable, the
 * give-up alert) or an issue update arrives, the notice is let go and the next one is a new comment below; a bot notice without a
 * key is a comment each time.
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
  silentTurns: 'The AI stopped working on this without giving an answer, even after it was reminded.',
  wakeCap: 'The AI was reminded as many times as allowed and still gave no answer here.',
  wakeFailed: "The AI's session could not be reached to remind it, so there is no answer here.",
};

/**
 * @description The alert comment (D20), in words a reader of the issue understands: what happened, and in one line what it means for
 * them — nothing more happens by itself, a person has to look, and how to try again. The request's id stays out of it (the bot's log
 * names it). A turn refused for the AI's Claude account never ends here: the bot says that in words of its own and moves the work, or
 * the work waits for the account (`bot.ts` `handleClaudeAuthRefusal`).
 */
export function buildJiraAlertText(reason: RequestAlertReason): string {
  return `⚠️ ${alertTexts[reason]} It will not go on by itself: a person needs to look at this issue. To try again, hand it to the AI again or mention it in a comment.`;
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
 * @description The notice of an issue whose updates reached the cap (`jiraIssueUpdatesPer24hMax` in a rolling 24 h): new comments
 * wait until `untilMs` and reach the AI then. Posted by the AI account, so it is never an update itself — and at most once per
 * issue per rolling 24 h, so it says that a pause soon after is not told again.
 */
export function buildJiraUpdatesPausedText(maxUpdates: number, untilMs: number): string {
  const until = new Date(untilMs).toISOString().slice(0, 16).replace('T', ' ');
  return `⏸ The AI got ${maxUpdates} updates from comments on this issue in the last 24 hours, its limit, so new comments reach it from ${until} UTC on — ` +
    'nothing is lost. If the limit is reached again within a day, comments wait the same way without another note. ' +
    'If you did not write that many, check that the AI posts only as its own account.';
}

/**
 * @description The queued notice (D10): every task-agent slot of the bot is busy, so this hand-over waits and starts by itself.
 * Posted once, when the issue joins the list; `aheadCount` is how many issues were in front of it then.
 */
export function buildJiraQueuedText(maxConcurrent: number, aheadCount: number): string {
  const place = aheadCount === 0 ? 'it is next in line' : `${aheadCount} ${aheadCount === 1 ? 'issue is' : 'issues are'} ahead of it`;
  return `⏳ The AI is working on ${maxConcurrent} ${maxConcurrent === 1 ? 'task' : 'tasks'} at once, its limit, so this issue is queued (${place}). ` +
    'It starts by itself when a slot frees up; nothing is needed from you.';
}

/**
 * @description The warning that rides an answer's result when some of `replyToCommentIds` were left out: the
 * answer itself was delivered, so the agent is told what to know, never to resend it.
 */
export function buildJiraReplyLeftOutWarning(commentIds: readonly string[]): string {
  return `Delivered, but these comments' authors were not mentioned: ${commentIds.join(', ')}. ` +
    'Only comments you were shown in this conversation, written by a trusted person, can be replied to this way.';
}

/**
 * @description The warning of an answer that replied to comments in several threads: one answer is one place, so it
 * went into the thread of the first comment it replied to; the others' authors were only mentioned.
 */
export function buildJiraOtherThreadsWarning(threadRootId: string, commentIds: readonly string[]): string {
  return `Delivered in the thread of comment ${threadRootId}, but ${commentIds.length === 1 ? 'comment' : 'comments'} ${commentIds.join(', ')} ` +
    `${commentIds.length === 1 ? 'is' : 'are'} in another thread: ${commentIds.length === 1 ? 'its author was' : 'their authors were'} mentioned, ` +
    'and the answer is not there. To answer in that thread too, send a separate answer that replies to it.';
}

/** @description The warning of an answer whose thread Jira refused (its comments are gone): it was posted as a new top-level comment. */
export function buildJiraThreadRefusedWarning(threadRootId: string): string {
  return `The thread of comment ${threadRootId} no longer takes replies (Jira refused it), so the answer was posted as a new comment instead.`;
}

/** A moment as the notices tell time: UTC, to the minute. */
function formatUtcMinute(atMs: number): string {
  return `${new Date(atMs).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** @description The line an edited progress comment ends with: when it was last updated. */
export function buildJiraProgressUpdatedText(atMs: number): string {
  return `Last updated ${formatUtcMinute(atMs)}`;
}

const progressDoneMark = '✅ Done';
const progressPausedMark = '⏸ Paused';

/**
 * @description The line a progress comment gets on top once its request has its answer (`final`) or asks the requester (`question`):
 * the notes below it were interim, and where to read on.
 */
export function buildJiraProgressClosedText(kind: 'final' | 'question', atMs: number): string {
  return kind === 'final'
    ? `${progressDoneMark} ${formatUtcMinute(atMs)}: these were interim notes, the answer is in a newer comment.`
    : `${progressPausedMark} ${formatUtcMinute(atMs)} for a question: these were interim notes, the question is in a newer comment.`;
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
  client: Pick<JiraClient, 'addComment' | 'editComment' | 'getRecentComments' | 'getIssue' | 'assignIssue' | 'getComment'>;
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
  /** The thread an issue update put a request's next answer in; consumed by the answer delivered. */
  answerThreads: Pick<JiraAnswerThreads, 'get' | 'note' | 'consume'>;
  /** The comments kept up to date instead of posting another: a request's progress note, a repeating bot notice. */
  progressComments: Pick<JiraProgressComments, 'get' | 'remember' | 'forgetAll' | 'listToClose' | 'settle'>;
  /**
   * Attach files of the issue's project folder to the issue and say how a comment shows them (`outgoingFiles.ts`);
   * absent where files cannot be sent — an answer that carries some is then refused, nothing posted.
   */
  attachFiles?: (issueKey: string, paths: readonly string[], options: { isShownInline: boolean }) => Promise<JiraFilesAttachResult>;
}

/** The refusal of files where the sink has no way to attach them. */
export const jiraFilesUnavailableError = 'files cannot be attached to a Jira issue on this instance; nothing was posted';

/**
 * Why a comment did not land. `unchecked` — an earlier, unconfirmed post of the
 * same text may have landed and the issue could not be read to check (R29).
 */
interface CommentPostFailure {
  kind: 'refused' | 'notPosted' | 'unknown' | 'unchecked';
  detail: string;
  /** A refusal's HTTP status; 0 when none applies. */
  status?: number;
}

/** A comment that landed, with its id (the progress comment is edited by it). */
interface CommentPosted {
  kind: 'posted';
  commentId: string;
}

/**
 * What posting an answer's comments did: how many landed (and their ids, in order), why the next one did not, and the thread
 * Jira refused when the comments went top-level instead (`null` when they went where they were meant to).
 */
interface CommentsPosted {
  postedCount: number;
  commentIds: string[];
  failure: CommentPostFailure | null;
  refusedThreadRootId: string | null;
}

/** Jira's answer to a reply whose thread it does not have: the request is refused, nothing was posted. */
const threadRefusedStatus = 400;

/**
 * The slot an answer is kept in as ONE comment edited by the next such answer, or `null` when it is a comment of its own: only a
 * plain `progress` note — no files, no reply to a comment — and, of the bot's notices, one that carries a repeat key.
 */
function getEditableSlot(delivery: RequestAnswerDelivery): string | null {
  const isPlain = delivery.kind === 'progress' && (delivery.files?.length ?? 0) === 0 && (delivery.replyToCommentIds?.length ?? 0) === 0;
  if (!isPlain) return null;
  if (!delivery.isBotNotice) return jiraProgressSlot;
  return delivery.repeatKey === undefined ? null : getJiraNoticeSlot(delivery.repeatKey);
}

/** `body` with the line saying when it was last updated as one more paragraph, in italics. */
function getBodyWithUpdatedLine(body: AdfDocument, atMs: number): AdfDocument {
  const updatedParagraph: AdfNode = { type: 'paragraph', content: [{ type: 'text', text: buildJiraProgressUpdatedText(atMs), marks: [{ type: 'em' }] }] };
  return { ...body, content: [...body.content, updatedParagraph] };
}

/** The thread a request's answers go into by default: the origin's {@link jiraReplyThreadAttribute}, when it is a comment id. */
export function getOriginThreadRootId(origin: RequestOrigin): string | null {
  const threadRootId = origin.attributes[jiraReplyThreadAttribute];
  return threadRootId !== undefined && /^\d+$/.test(threadRootId) ? threadRootId : null;
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

/**
 * The notices that answer a trigger — a park, a queued hand-over — go where an answer to it would: `threadRootId` is
 * the thread of the comment that triggered it when that comment is a reply, `null` (or absent) for a top-level one.
 */
export interface JiraAnswerSink extends AnswerSink {
  /**
   * An issue update reached request `requestId`'s session (`inbound.ts`): its next answer goes into the thread of `threadRootId` — the
   * update's newest comment is a reply there — or, `null`, where the request's answers go by default; and every comment the request
   * keeps up to date is let go, so what the agent answers to the person is a new comment below theirs, never a silent edit above it.
   * Never throws.
   */
  noteIssueUpdate(requestId: string, threadRootId: string | null): void;
  /**
   * An issue update of ANOTHER issue — a comment on an issue linked to the request's own — reached request `requestId`'s session: the
   * comments the request keeps up to date are let go, as by {@link noteIssueUpdate}, but no thread is noted (the update's thread
   * belongs to the other issue; noting none would also clear a thread this issue's own update is still owed). Never throws.
   */
  noteLinkedIssueUpdate(requestId: string): void;
  /** Over the run budget (D12): the park notice, then the hand-back. Never rejects. */
  parkIssue(issueKey: string, requester: JiraAccount | null, threadRootId?: string | null): Promise<void>;
  /** A mention over the run budget (D10): the park notice, no hand-back (nothing was handed over). Never rejects. */
  parkMention(issueKey: string, threadRootId?: string | null): Promise<void>;
  /** The issue's comments wait past the cap on updates: the notice saying until when (`untilMs`). Never rejects. */
  postUpdatesPausedNotice(issueKey: string, maxUpdates: number, untilMs: number): Promise<void>;
  /** A hand-over that waits for a task-agent slot (D10): the notice saying so, no hand-back — the issue stays the AI's. Never rejects. */
  postQueuedNotice(issueKey: string, queue: Extract<TaskAgentSlotDecision, { kind: 'queued' }>, threadRootId?: string | null): Promise<void>;
  /** A hand-over the trusted group `groupName` does not back: the fixed notice, then the hand-back. Never rejects. */
  refuseUntrusted(issueKey: string, requester: JiraAccount | null, groupName: string): Promise<void>;
  /**
   * `send_file_to_user` on an issue: the files attached and ONE comment showing them, the caption (Markdown) as its text,
   * in the thread of `threadRootId` or top-level. `isAsLinks` lists every file as a link (`as_file`). Never rejects.
   */
  postFiles(issueKey: string, request: { paths: readonly string[]; caption?: string; isAsLinks: boolean }, threadRootId: string | null): Promise<SendFilesToThreadResult>;
}

export function createJiraAnswerSink(deps: JiraAnswerSinkDeps): JiraAnswerSink {
  const { client } = deps;

  /** The comment on the issue, by the AI account, dated from the post's start on, with this text: its id; `false` — none; `null` — the issue could not be read. */
  async function findCommentOnIssue(issueKey: string, comparableText: string, postStartedAt: number): Promise<string | false | null> {
    try {
      const comments = await client.getRecentComments(issueKey, jiraReadBackCommentCount);
      const found = comments.find((comment) =>
        comment.author?.accountId === deps.aiAccountId
        && Date.parse(comment.created) >= postStartedAt - jiraReadBackClockSkewMs
        && getComparableText(comment.body) === comparableText);
      return found ? found.id : false;
    } catch (error) {
      console.warn(`[jira] ${issueKey}: read-back failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Post one comment, in the thread of `parentId` (a top-level comment's id) or top-level (`null`). With a
   * `requestId`, a post left unconfirmed is remembered, and a resend of a remembered one reads the issue first (R29).
   */
  async function postComment(issueKey: string, body: AdfDocument, requestId: string | null, parentId: string | null): Promise<CommentPostFailure | CommentPosted> {
    const comparableText = getComparableText(body);
    const bodyHash = getCommentBodyHash(comparableText);
    const earlierPostedAt = requestId === null ? null : deps.unconfirmedPosts.getPostedAt(requestId, bodyHash);
    if (requestId !== null && earlierPostedAt !== null) {
      const earlierCommentId = await findCommentOnIssue(issueKey, comparableText, earlierPostedAt);
      if (earlierCommentId === null) {
        return { kind: 'unchecked', detail: 'the issue could not be read to check whether the earlier attempt landed' };
      }
      deps.unconfirmedPosts.settle(requestId, bodyHash);
      if (earlierCommentId !== false) return { kind: 'posted', commentId: earlierCommentId };
    }
    const postStartedAt = deps.now();
    let result: Awaited<ReturnType<JiraClient['addComment']>>;
    try {
      result = await client.addComment(issueKey, body, parentId);
    } catch (error) {
      return { kind: 'refused', detail: error instanceof Error ? error.message : String(error), status: error instanceof JiraHttpError ? error.status : 0 };
    }
    if (result.outcome === 'created') return { kind: 'posted', commentId: result.id };
    // R18: a post that timed out or met a 5xx may still be committing on Jira's side.
    await deps.wait(jiraReadBackDelayMs);
    const landedCommentId = await findCommentOnIssue(issueKey, comparableText, postStartedAt);
    if (landedCommentId !== false && landedCommentId !== null) return { kind: 'posted', commentId: landedCommentId };
    if (requestId !== null) deps.unconfirmedPosts.recordUnconfirmed(requestId, bodyHash, postStartedAt);
    return landedCommentId === false
      ? { kind: 'notPosted', detail: `${result.reason}; it was not on the issue ${jiraReadBackDelayMs / 1000} s later` }
      : { kind: 'unknown', detail: result.reason };
  }

  /**
   * Post `bodies` in order, in the thread of `threadRootId` or top-level (`null`). A reply Jira refuses with 400 — the
   * thread's comments are gone — is posted top-level instead, and so is the rest of the answer: a refusal posted nothing.
   */
  async function postComments(issueKey: string, bodies: readonly AdfDocument[], requestId: string | null, threadRootId: string | null): Promise<CommentsPosted> {
    const commentIds: string[] = [];
    let parentId = threadRootId;
    let refusedThreadRootId: string | null = null;
    for (const body of bodies) {
      let outcome = await postComment(issueKey, body, requestId, parentId);
      if (outcome.kind === 'refused' && outcome.status === threadRefusedStatus && parentId !== null) {
        console.warn(`[jira] ${issueKey}: the thread of comment ${parentId} was refused (${outcome.detail}); posting top-level`);
        refusedThreadRootId = parentId;
        parentId = null;
        outcome = await postComment(issueKey, body, requestId, null);
      }
      if (outcome.kind !== 'posted') return { postedCount: commentIds.length, commentIds, failure: outcome, refusedThreadRootId };
      commentIds.push(outcome.commentId);
    }
    return { postedCount: commentIds.length, commentIds, failure: null, refusedThreadRootId };
  }

  /** One try at the edit: `edited`, a refusal that changed nothing (404, 400, 403, a rate limit), or an outcome Jira did not confirm. */
  async function sendEdit(issueKey: string, commentId: string, body: AdfDocument): Promise<'edited' | { kind: 'refused' | 'unconfirmed'; detail: string }> {
    try {
      await client.editComment(issueKey, commentId, body);
      return 'edited';
    } catch (error) {
      const status = error instanceof JiraHttpError || error instanceof JiraAuthError ? error.status : 0;
      const isRefused = error instanceof JiraAuthError || (status >= 400 && status < 500);
      return { kind: isRefused ? 'refused' : 'unconfirmed', detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Replace the text of comment `commentId` with `body`. `edited` — it is there now. `notEdited` — it is not (the comment is gone, Jira
   * refuses the edit): the caller posts the text as a new comment. `unknown` — Jira did not confirm the edit and the comment could not
   * be read to check: nothing may be posted (the edit may have landed — the text would stand twice), and the agent is told to send it
   * again, which edits the same comment again. An edit repeats harmlessly, so after an outcome Jira did not confirm (a timeout, a 5xx
   * after the client's retries) the comment is read after the read-back's wait: the new text on it counts as edited, the OLD text
   * gets ONE more edit (the first may still be committing, or was lost) before the text goes into a new comment.
   */
  async function editCommentText(issueKey: string, commentId: string, body: AdfDocument): Promise<'edited' | { kind: 'notEdited' | 'unknown'; detail: string }> {
    const first = await sendEdit(issueKey, commentId, body);
    if (first === 'edited') return first;
    if (first.kind === 'refused') return { kind: 'notEdited', detail: first.detail };
    await deps.wait(jiraReadBackDelayMs);
    let shown: JiraComment;
    try {
      shown = await client.getComment(issueKey, commentId);
    } catch (readError) {
      // A comment that is gone cannot have been edited; one that cannot be read leaves the outcome open.
      if (readError instanceof JiraHttpError && readError.status === 404) return { kind: 'notEdited', detail: `${first.detail}; the comment is gone` };
      console.warn(`[jira] ${issueKey}: read-back of comment ${commentId} after an edit of unknown outcome failed: ${readError instanceof Error ? readError.message : String(readError)}`);
      return { kind: 'unknown', detail: first.detail };
    }
    if (getComparableText(shown.body) === getComparableText(body)) return 'edited';
    const second = await sendEdit(issueKey, commentId, body);
    return second === 'edited' ? second : { kind: 'notEdited', detail: second.detail };
  }

  /**
   * Put the closing line on top of each progress comment an answer of `kind` ends. Cosmetic: the answer has landed, so a comment that
   * cannot be read or edited stays as it is, with a warning; one that already carries a closing line is left alone.
   */
  async function closeProgressComments(issueKey: string, commentIds: readonly string[], kind: 'final' | 'question'): Promise<void> {
    const [closedParagraph] = createPlainTextAdf(buildJiraProgressClosedText(kind, deps.now())).content;
    for (const commentId of commentIds) {
      try {
        const shown = await client.getComment(issueKey, commentId);
        const content = shown.body?.content ?? [];
        const firstLine = getAdfText(content[0] ?? null);
        if (firstLine.startsWith(progressDoneMark) || firstLine.startsWith(progressPausedMark)) continue;
        await client.editComment(issueKey, commentId, { version: 1, type: 'doc', content: [closedParagraph, ...content] });
      } catch (error) {
        console.warn(`[jira] ${issueKey}: progress comment ${commentId} could not be marked ${kind === 'final' ? 'done' : 'paused'}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
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
   * Comment `commentId` when the agent may reply to it — its author to mention, the thread the answer goes into:
   * the conversation was shown it and its text was readable then, its author is a person other than the AI account,
   * and — with a trusted group — the comment is trusted now (author and last editor). `null` otherwise.
   */
  async function getReplyTarget(issueKey: string, commentId: string): Promise<{ author: JiraAccount; threadRootId: string } | null> {
    const shown = deps.contextLedger.getShownBlock(issueKey, `comment:${commentId}`);
    if (!shown || shown.isWithheld) return null;
    try {
      const comment = await client.getComment(issueKey, commentId);
      const { author } = comment;
      if (!author || author.accountId === deps.aiAccountId || !checkIsPersonAccount(author)) return null;
      const trust = deps.getTrust();
      return trust && !checkIsCommentTrusted(comment, trust) ? null : { author, threadRootId: getCommentThreadRootId(comment) };
    } catch (error) {
      // An id Jira does not know is the agent's slip, told to it in the result; anything else is the operator's to see.
      const isUnknownComment = error instanceof JiraHttpError && error.status === 404;
      if (!isUnknownComment) console.warn(`[jira] ${issueKey}: comment ${commentId} could not be read, so its author is not mentioned: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Whom an answer notifies, requester first, each once: the requester of a mention request, and the authors of the
   * comments the answer replies to. `leftOutCommentIds` are the replies that did not qualify; `threadRootId` is the
   * thread of the first that did (`null`: none did), and `otherThreadCommentIds` those that qualified in another thread.
   */
  async function resolveReplyTargets(issueKey: string, delivery: RequestAnswerDelivery): Promise<{
    targets: JiraAccount[];
    leftOutCommentIds: string[];
    threadRootId: string | null;
    otherThreadCommentIds: string[];
  }> {
    const targets = new Map<string, JiraAccount>();
    if (delivery.origin.kind === 'trackerMention') {
      const requester = await getMentionRequester(issueKey, delivery.origin);
      if (requester) targets.set(requester.accountId, requester);
    }
    const leftOutCommentIds: string[] = [];
    const otherThreadCommentIds: string[] = [];
    let threadRootId: string | null = null;
    for (const commentId of new Set(delivery.replyToCommentIds ?? [])) {
      const target = await getReplyTarget(issueKey, commentId);
      if (!target) {
        leftOutCommentIds.push(commentId);
        continue;
      }
      targets.set(target.author.accountId, target.author);
      if (threadRootId === null) threadRootId = target.threadRootId;
      else if (target.threadRootId !== threadRootId) otherThreadCommentIds.push(commentId);
    }
    return { targets: [...targets.values()], leftOutCommentIds, threadRootId, otherThreadCommentIds };
  }

  /** The answer's files attached (`null`: it carries none), or why they could not be. */
  async function attachAnswerFiles(issueKey: string, paths: readonly string[] | undefined): Promise<JiraFilesAttachResult | null> {
    if (!paths || paths.length === 0) return null;
    if (!deps.attachFiles) return { ok: false, error: jiraFilesUnavailableError };
    try {
      return await deps.attachFiles(issueKey, paths, { isShownInline: true });
    } catch (error) {
      return { ok: false, error: `the files could not be attached (${error instanceof Error ? error.message : String(error)}); nothing was posted` };
    }
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
  async function postNoticeAndHandBack(
    issueKey: string,
    requester: JiraAccount | null,
    notice: AdfDocument,
    noticeKind: 'park' | 'untrusted',
    threadRootId: string | null,
  ): Promise<void> {
    if (!await postNotice(issueKey, notice, noticeKind, threadRootId)) return;
    const handBackWarning = await handBack(issueKey, requester?.accountId ?? emptyRequester);
    if (handBackWarning) console.warn(`[jira] ${issueKey}: ${noticeKind}: ${handBackWarning}`);
  }

  /** A notice the bot writes itself, in the thread of `threadRootId` or top-level; `false` (and a warning) when it did not land. */
  async function postNotice(
    issueKey: string,
    notice: AdfDocument,
    noticeKind: 'park' | 'untrusted' | 'mention park' | 'queued' | 'updates paused',
    threadRootId: string | null,
  ): Promise<boolean> {
    const posted = await postComments(issueKey, [notice], null, threadRootId);
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

  /** The edit of the progress comment was not confirmed and the comment could not be read: nothing was posted, the resend edits it again. */
  function getEditUnknownError(detail: string): string {
    return `Jira did not confirm the edit of your progress comment and the comment could not be read to check it (${detail}); it may be edited already. ` +
      'Nothing was posted. Send the progress again, unchanged: the same comment is edited again, which is safe to repeat';
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
    noteIssueUpdate(requestId, threadRootId) {
      deps.answerThreads.note(requestId, threadRootId);
      deps.progressComments.forgetAll(requestId);
    },

    noteLinkedIssueUpdate(requestId) {
      deps.progressComments.forgetAll(requestId);
    },

    async deliverAnswer(key: SessionKey, delivery): Promise<AnswerDeliveryResult> {
      const issueKey = key.thread;
      const replies = await resolveReplyTargets(issueKey, delivery);
      const { targets, leftOutCommentIds } = replies;
      // The comment the agent replies to decides the thread; else the thread an update of the request came from; else the
      // thread the request was opened in; else top-level.
      let threadRootId = replies.threadRootId ?? deps.answerThreads.get(delivery.requestId) ?? getOriginThreadRootId(delivery.origin);
      const textBodies = targets.length > 0
        ? createCommentBodiesWithLeadingNode(delivery.body, createMentionParagraph(targets))
        : createCommentBodies(delivery.body);
      if (textBodies.length === 0) return { ok: false, error: 'the answer is empty' };
      // Attached before anything is posted: a file that cannot be attached leaves the answer undelivered, safe to send again.
      const files = await attachAnswerFiles(issueKey, delivery.files);
      if (files && !files.ok) return { ok: false, error: files.error };
      const bodies = files ? appendNodesToBodies(textBodies, files.nodes) : textBodies;
      // Only a hand-over's question hands the issue back, so only it carries the line saying how to give it back —
      // and only while its request is open: a superseded request's question hands nothing back.
      const isHandOver = delivery.origin.kind === 'trackerEvent';
      if (isHandOver && delivery.isRequestOpen && delivery.kind === 'question') bodies[bodies.length - 1] = getBodyWithContinueLine(bodies[bodies.length - 1]);
      // A plain note that fits one comment is kept as that comment, edited by the next one.
      const slot = bodies.length === 1 ? getEditableSlot(delivery) : null;
      const kept = slot === null ? null : deps.progressComments.get(delivery.requestId, slot);
      if (slot !== null && kept !== null) {
        const edited = await editCommentText(issueKey, kept.commentId, getBodyWithUpdatedLine(bodies[0], deps.now()));
        if (edited === 'edited') {
          // The agent has spoken since the bot's notices: the next one of them is a new comment below, not an edit above.
          if (!delivery.isBotNotice) deps.progressComments.forgetAll(delivery.requestId, [slot]);
          return { ok: true };
        }
        // An edit that may have landed: nothing is posted, the comment stays the kept one and the resend edits it again.
        if (edited.kind === 'unknown') return { ok: false, error: getEditUnknownError(edited.detail) };
        // The text goes into a new comment in the thread the old one stood in, which stays the progress comment's.
        console.warn(`[jira] ${issueKey}: comment ${kept.commentId} could not be edited (${edited.detail}); posting the progress as a new comment`);
        threadRootId = kept.threadRootId;
      }
      // The progress comments this answer ends: its request's and those of the requests it replaced, kept or released.
      const isEndingAnswer = !delivery.isBotNotice && (delivery.kind === 'final' || delivery.kind === 'question');
      const endedRequestIds = isEndingAnswer ? [delivery.requestId, ...(delivery.supersededRequestIds ?? [])] : [];
      const endedProgressCommentIds = [...new Set(endedRequestIds.flatMap((requestId) => deps.progressComments.listToClose(requestId)))];
      const posted = await postComments(issueKey, bodies, delivery.requestId, threadRootId);
      if (posted.postedCount === 0 && posted.failure) return { ok: false, error: getNothingPostedError(posted.failure) };
      // The agent's answer is there: the thread an update put it in is used up, the next answer goes where they go by default.
      // A notice the bot wrote (a usage limit, a refused sign-in) goes into that thread too but uses nothing up: the agent's
      // answer to the reply is still owed, and comes after the resume.
      if (!delivery.isBotNotice) deps.answerThreads.consume(delivery.requestId);
      if (slot !== null) deps.progressComments.remember(delivery.requestId, slot, posted.commentIds[0], posted.refusedThreadRootId === null ? threadRootId : null);
      // A comment was added: every chain of edits that stands above it ends, so the next of each is a new comment below — a notice
      // of the bot's own is one chain, the agent's progress note another. The agent's answer ends the bot's notices (a question, a
      // final answer or a note that is a comment of its own ends its progress comment too); a bot comment that stands on its own
      // (an account moved, no account usable) ends the notices and leaves the agent's note, which it has nothing to do with.
      deps.progressComments.forgetAll(delivery.requestId, [...(slot === null ? [] : [slot]), ...(delivery.isBotNotice ? [jiraProgressSlot] : [])]);
      for (const requestId of endedRequestIds) deps.progressComments.settle(requestId);
      const warnings: string[] = [...(files?.notes ?? [])];
      if (leftOutCommentIds.length > 0) warnings.push(buildJiraReplyLeftOutWarning(leftOutCommentIds));
      if (replies.threadRootId !== null && replies.otherThreadCommentIds.length > 0) {
        warnings.push(buildJiraOtherThreadsWarning(replies.threadRootId, replies.otherThreadCommentIds));
      }
      if (posted.refusedThreadRootId !== null) warnings.push(buildJiraThreadRefusedWarning(posted.refusedThreadRootId));
      if (posted.failure) warnings.push(getMissingPartsWarning(bodies, posted, posted.failure));
      // An answer to a request that is no longer open (superseded by a newer one) must not take the issue from it.
      // A mention request never had the issue handed over: its answer is a comment, and the issue stays where it is.
      if (isHandOver && delivery.isRequestOpen && (delivery.kind === 'question' || delivery.kind === 'final')) {
        const handBackWarning = await handBack(issueKey, getRequestRequester(delivery.origin));
        if (handBackWarning) warnings.push(handBackWarning);
      }
      // Cosmetic, so after what notifies the requester: a slow Jira delays the closing lines, never the hand-back.
      if (isEndingAnswer) {
        await closeProgressComments(issueKey, endedProgressCommentIds.filter((commentId) => !posted.commentIds.includes(commentId)), delivery.kind === 'final' ? 'final' : 'question');
      }
      return warnings.length > 0 ? { ok: true, warning: warnings.join('; ') } : { ok: true };
    },

    async deliverAlert(key, alert) {
      const issueKey = key.thread;
      const posted = await postComments(issueKey, [convertMarkdownToAdf(buildJiraAlertText(alert.reason))], alert.requestId, getOriginThreadRootId(alert.origin));
      if (posted.postedCount === 0 && posted.failure) return { ok: false, error: getNothingPostedError(posted.failure) };
      // The comment names no request: the log does. Everything kept up to date above it stays as it is: later notes start below.
      console.log(`[jira] ${issueKey}: request ${alert.requestId} given up (${alert.reason}); the alert comment is posted`);
      deps.progressComments.forgetAll(alert.requestId);
      if (alert.origin.kind === 'trackerEvent') {
        const handBackWarning = await handBack(issueKey, getRequestRequester(alert.origin));
        if (handBackWarning) console.warn(`[jira] ${issueKey}: alert for ${alert.requestId}: ${handBackWarning}`);
      }
      // A comment needs no release: nothing is pinned.
      return { ok: true };
    },

    async releaseAlert() {},

    parkIssue: (issueKey, requester, threadRootId = null) =>
      postNoticeAndHandBack(issueKey, requester, convertMarkdownToAdf(buildJiraParkText(deps.runBudgetPer24h)), 'park', threadRootId),

    parkMention: async (issueKey, threadRootId = null) => {
      await postNotice(issueKey, convertMarkdownToAdf(buildJiraMentionParkText(deps.runBudgetPer24h)), 'mention park', threadRootId);
    },

    // The issue's, not a trigger's: top-level.
    postUpdatesPausedNotice: async (issueKey, maxUpdates, untilMs) => {
      await postNotice(issueKey, createPlainTextAdf(buildJiraUpdatesPausedText(maxUpdates, untilMs)), 'updates paused', null);
    },

    postQueuedNotice: async (issueKey, queue, threadRootId = null) => {
      await postNotice(issueKey, convertMarkdownToAdf(buildJiraQueuedText(queue.maxConcurrent, queue.aheadCount)), 'queued', threadRootId);
    },

    // A hand-over's: it has no comment, so top-level.
    refuseUntrusted: (issueKey, requester, groupName) =>
      postNoticeAndHandBack(issueKey, requester, createPlainTextAdf(buildJiraUntrustedText(groupName)), 'untrusted', null),

    postFiles: async (issueKey, request, threadRootId) => {
      if (!deps.attachFiles) return { ok: false, error: jiraFilesUnavailableError };
      let files: JiraFilesAttachResult;
      try {
        files = await deps.attachFiles(issueKey, request.paths, { isShownInline: !request.isAsLinks });
      } catch (error) {
        return { ok: false, error: `the files could not be attached (${error instanceof Error ? error.message : String(error)}); nothing was posted` };
      }
      if (!files.ok) return { ok: false, error: files.error };
      const caption = request.caption?.trim() ?? '';
      const bodies = appendNodesToBodies(caption === '' ? [] : createCommentBodies(caption), files.nodes);
      const posted = await postComments(issueKey, bodies, null, threadRootId);
      if (posted.postedCount === 0 && posted.failure) {
        const error = `the files are attached to ${issueKey} — ${files.summary} — but the comment that shows them was not posted (${posted.failure.detail}); ` +
          'sending them again reuses the attachments';
        return posted.failure.kind === 'unknown' ? { ok: false, kind: 'deliveryUnknown', error } : { ok: false, error };
      }
      const notes = [
        ...files.notes,
        ...(posted.refusedThreadRootId === null ? [] : [buildJiraThreadRefusedWarning(posted.refusedThreadRootId)]),
        ...(posted.failure ? [`only the first ${posted.postedCount} of the comment's ${bodies.length} parts were posted (${posted.failure.detail})`] : []),
      ];
      const place = threadRootId === null || posted.refusedThreadRootId !== null ? 'a comment' : `a comment in the thread of comment ${threadRootId}`;
      return {
        ok: true,
        summary: `Posted in ${place} on ${issueKey}: ${files.summary}.${notes.length > 0 ? ` Note: ${notes.join('; ')}.` : ''}`,
        sentKinds: files.sentKinds,
      };
    },
  };
}
