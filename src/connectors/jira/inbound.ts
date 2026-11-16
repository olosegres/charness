import type { SessionKey } from '../../sessionKey';
import type { OpenRequestState, RequestOrigin } from '../../requests/types';
import { emptyRequester, getRequestRequester, requestRequesterAttribute } from '../../requests/requestGroup';
import { JiraAuthError, JiraHttpError, jiraChangelogPageSize, type JiraAccount, type JiraChangelogHistory, type JiraClient, type JiraComment, type JiraIssue } from './client';
import { getMentionedAccountIds } from './adf';
import { getJiraIssueProjectKey, makeJiraKey } from './sessionKeyCodec';
import {
  checkIsHandOverTriggerId,
  checkIsPersonAccount,
  commentTriggerIdPrefix,
  compareJiraCommentIds,
  createCommentTrigger,
  createMentionTrigger,
  findNewestTrigger,
  getIssueTrigger,
  getItemField,
  getRequester,
  heldMentionTriggerIdPrefix,
  mentionTriggerIdPrefix,
  updatesPausedTriggerIdPrefix,
  type JiraIssueTrigger,
} from './trigger';
import type { JiraTriggerLog, JiraTriggerRecord } from './triggerLog';
import { buildIssueBlocks, checkIsCommentTrusted, getShownIssueSummary, type JiraBlockTrust, type JiraExtraField } from './issueBlocks';
import { fetchJiraIssueContext, findAccountInContext, type JiraIssueContext } from './issueContext';
import { buildJiraDeltaPrompt, buildJiraRequestPrompt, buildJiraUpdatePrompt, type JiraNewComment, type JiraOpenHandOver, type JiraUpdatePromptBase } from './prompt';
import type { JiraMentionMode } from './config';
import { actingMentionAttribute, checkIsSlotHoldingOrigin } from '../../trackers/taskAgentSlots';
import { getIssueDelta, newBlockNote } from './issueDelta';
import type { JiraContextLedger } from './contextLedger';
import type { SessionPromptText } from '../../postToSession';
import { clearStoredPromptRefresher, setStoredPromptRefresher } from '../../requests/storedPromptRefresh';
import { fitBlocksToPrompt, standInRequestId } from './promptSpill';
import { JiraTrustedGroupGoneError, type JiraTrust } from './trustedGroup';
import type { TaskAgentSlotDecision, TaskAgentSlots } from '../../trackers/taskAgentSlots';

/**
 * @description The Jira connector's inbound side (plan J5, D12/D13/D15/D21): a
 * poll loop, one search per cycle, and per issue the decision chain
 *
 *   allowlist → still matching → no post in flight → trigger (newest changelog pages first) → seen before → self-authored
 *     → hand-over backed by the trusted group (only with `trustedGroup`) → run budget → a free task-agent slot (else the
 *     issue waits in the bot's one list, with a comment saying so) → fetch the issue → bind
 *     → open a request → post (not awaited)
 *     → RECORD the trigger once the post settled
 *
 * The trigger is recorded only once its post SETTLED: a restart while the prompt
 * has not reached the session yet (a session start, a busy turn the post waits
 * out) leaves the trigger unrecorded and its request open, so the next poll opens
 * a fresh request — which supersedes the old one — and posts it, instead of
 * leaving a request the agent never saw. Only a crash in the instant between a
 * finished post and its record can post a trigger twice. While a post is in
 * flight the issue is skipped, so one process never posts two requests of an
 * issue at once. A waiting issue's trigger is NOT recorded: the next poll decides it again, and it starts when it is
 * first in the list and a slot is free (`trackers/taskAgentSlots.ts`; a slot freeing wakes the poll at once, `pollSoon`).
 * A Jira event never cancels an armed usage-limit wait — the ledger's create hook tells the new request about it (core S5).
 *
 * With comment wakes on (a trusted group is set), a trusted person's comment on an issue HANDED to the AI account —
 * assigned to it in a trigger status, its hand-over seen — reaches its agent; a mention there is a comment like any other:
 *
 *   `updated` moved since this process last read it → its newest comments: a person's (not the AI account's, not an app's
 *   or an automation's — those ride the next prompt), newer than every comment a recorded prompt of the issue was built
 *   from (the trigger log's `newestCommentId`: no window, so a comment made while the bot was down is not lost), whose
 *   `comment:<id>` (and `mention:<id>`) is not seen →
 *     author and last editor trusted (else `untrusted`, silent) →
 *       a hand-over request of the conversation open → an ISSUE UPDATE posted for it: no request is opened (a new one
 *         would supersede the hand-over, or hand the issue to the commenter on its first final answer)
 *       none open → run budget → a free task-agent slot → a request of its own (`commented`, the commenter its requester)
 *     → RECORD every comment once its post settled (an update that failed is decided again, after a backoff)
 *
 * With mention wakes on, the same poll also finds a comment that @-mentions the AI account — on an issue that is NOT
 * handed to it (with comment wakes off: on any issue) — and opens a request:
 *
 *   issue returned and its `updated` moved since this process last read it → its newest comments, those
 *   created or edited within the mention window that mention the AI account (the ADF mention node's id) and
 *   whose trigger id `mention:<commentId>` is not seen →
 *     author and last editor trusted → by the requester of an open hand-over request: an issue update for that
 *     request (with comment wakes off: `covered`, nothing posted) → run budget → with `mentionMode: "act"` a free
 *     task-agent slot (an acting mention may start a build) → open a request (no hand-back; the answer sink knows by
 *     the origin kind)
 *
 * One decision per comment, recorded in the same trigger log: an edit of a decided comment wakes nothing. An acting
 * mention that waits for a slot keeps its place across polls and restarts: its comment is decided again outside the
 * window, and its issue is read by its key once the search no longer returns it. So does a mention held back from its
 * issue update (the cap on updates paused it, or its post failed: `held-mention:` in the trigger log) until it is delivered.
 */

export const jiraSearchPageSize = 50;
/** The longest wait between two attempts while Jira keeps failing (R22). */
export const jiraRetryBackoffCapMs = 15 * 60 * 1000;
/** The shortest mention window: a mention this young is found by a poll, whatever the poll interval (D12). */
export const jiraMentionWindowMinMs = 5 * 60 * 1000;
/** How many of an issue's newest comments a mention scan reads — more than a window of activity holds. */
export const jiraMentionScanCommentCount = 100;
const msPerMinute = 60 * 1000;
const msPerDay = 24 * 60 * msPerMinute;
/**
 * The issue updates one issue may get in a rolling 24 h. A person's comment is one; an account that comments as the agent's
 * own tooling would loop (each comment the next poll's update), and the cap ends that: past it, comments wait until the
 * oldest update of the window leaves it, with one log line per pause.
 */
export const jiraIssueUpdatesPer24hMax = 20;
/** Separates an issue key from a trigger id in the key a mention decision has in the poll's result and log line. */
const mentionDecisionKeySeparator = '#';

/**
 * @description R22: the wait before the next attempt after `failureCount`
 * failures in a row — the base interval doubled per failure, up to
 * {@link jiraRetryBackoffCapMs} (never below the base interval).
 */
export function getJiraRetryDelayMs(baseMs: number, failureCount: number): number {
  return Math.min(baseMs * 2 ** failureCount, Math.max(baseMs, jiraRetryBackoffCapMs));
}
/** `updated` tells the mention scan whether an issue changed at all since it last read its comments. */
export const jiraSearchFields = ['status', 'assignee', 'reporter', 'creator', 'updated'];

/**
 * @description D12: the window in which a mention is looked for — `max(5 min, 2 × poll interval)`, so a slow poll
 * never outruns it. The JQL's `updated >= -<n>m` and the comment scan use the same window.
 */
export function getJiraMentionWindowMs(pollIntervalMs: number): number {
  return Math.max(jiraMentionWindowMinMs, 2 * pollIntervalMs);
}

/** @name JiraProjectTrigger @description One allowlisted project as the poller uses it. */
export interface JiraProjectTrigger {
  folder: string;
  triggerStatusIds: ReadonlySet<string>;
  /** The trigger statuses as `jira.json` names them: a mention's note tells the agent which statuses hand work over. */
  triggerStatusNames: readonly string[];
  /** The project's `extraFields` the site knows, named (an unknown id was dropped at boot). */
  extraFields: readonly JiraExtraField[];
}

/**
 * @name JiraIssueDecision
 * @description What the poller did with one returned issue.
 *  - `notAllowed`  — its project is not in the allowlist (dropped).
 *  - `notMatching` — no longer assigned to the AI account, or not in a trigger status.
 *  - `posting`     — the post of its last request has not settled yet (skipped).
 *  - `seen`        — its trigger was decided before.
 *  - `queued`      — no task-agent slot was free: it joined the bot's wait list and was told so (once). `waiting` — it is
 *    still in the list (skipped; nothing is posted again).
 *  - `selfAuthored`, `parked`, `untrusted`, `covered`, `update`, `request` — the recorded outcomes; `untrusted` — the
 *    hand-over was made by someone the trusted group does not back (a notice and the hand-back, no request; for
 *    a mention or a comment: silent, nothing posted); `covered` — with comment wakes off, a mention by the requester of
 *    the issue's open hand-over request (no request, nothing posted); `update` — the comment went to the agent as an
 *    issue update for an open hand-over request (no request).
 *  - `failed`      — an error stopped it; the next poll tries again.
 */
export type JiraIssueDecision =
  | 'notAllowed' | 'notMatching' | 'posting' | 'seen' | 'selfAuthored' | 'parked' | 'untrusted' | 'covered' | 'update' | 'queued' | 'waiting' | 'request' | 'failed';

/** Decisions that change nothing, left out of the poll's log line. */
const quietDecisions: ReadonlySet<JiraIssueDecision> = new Set(['notMatching', 'posting', 'seen', 'waiting']);

/**
 * Decisions that end a hand-over's wait for a slot: its hand-over is gone, was refused or was handled without one. `notAllowed` is not
 * one: that issue never waited, and its key may not even be an issue key (`makeJiraKey` would throw).
 */
const waitEndingDecisions: ReadonlySet<JiraIssueDecision> = new Set(['notMatching', 'seen', 'selfAuthored', 'parked', 'untrusted']);

/** The decisions of a mention or a comment that leave it to the next poll: it is not decided yet. */
const undecidedDecisions: ReadonlySet<JiraIssueDecision> = new Set(['queued', 'waiting', 'failed']);

export interface JiraInboundDeps {
  client: Pick<JiraClient, 'searchIssues' | 'getChangelogPage' | 'getIssue' | 'getComments' | 'getRecentComments' | 'getRemoteLinks'>;
  aiAccountId: string;
  /** `https://<site>` (or the test-only loopback base) — issue links are `<siteUrl>/browse/<KEY>`. */
  siteUrl: string;
  projects: ReadonlyMap<string, JiraProjectTrigger>;
  runBudgetPer24h: number;
  pollIntervalMs: number;
  /** Where a conversation's text too long for its prompt is written whole (`promptSpill.ts`). */
  getSpillDir: (key: SessionKey) => string;
  triggerLog: JiraTriggerLog;
  /** The trusted group (`trustedGroup.ts`); `null` without `trustedGroup` in `jira.json`: no filter. */
  trust: JiraTrust | null;
  /** An @-mention of the AI account wakes it (`config.isMentionWakeOn`); never without {@link trust} — nobody could be judged. */
  isMentionWakeOn: boolean;
  /** What a mention asks of the agent (`config.mentionMode`): `act` — an explicit ask is carried out, and the request takes a task-agent slot. */
  mentionMode: JiraMentionMode;
  /** A trusted person's comment on an issue handed to the AI account reaches its agent (`config.isCommentWakeOn`); never without {@link trust}. */
  isCommentWakeOn: boolean;
  /** The open requests of an issue's conversation — the hand-over a comment or a mention belongs to (D9). */
  listOpenRequests: (key: SessionKey) => ReadonlyArray<Pick<OpenRequestState, 'id' | 'origin' | 'isWakeStopped'>>;
  now: () => number;
  /** Bind the issue's conversation to its project's folder. */
  bindConversation: (key: SessionKey, folder: string) => Promise<void>;
  /**
   * Open the request; `createPrompt` builds its prompt — kept by the request for a re-post (R21) — from
   * its id and the ids of the same requester's open requests it replaced, which the header names (R34).
   */
  createRequest: (
    key: SessionKey,
    origin: RequestOrigin,
    createPrompt: (requestId: string, supersededRequestIds: readonly string[]) => string,
  ) => Promise<Pick<OpenRequestState, 'id' | 'supersededRequestIds'>>;
  /**
   * Post the request's prompt to the issue's session (and start watching its turn): `fullText` is the whole
   * issue (the request keeps it for a re-post, a hold keeps it); `buildText` runs right before the forward and
   * makes the delta for a session that already knows the issue (C5).
   */
  postRequest: (key: SessionKey, requestId: string, prompt: SessionPromptText) => Promise<void>;
  /**
   * Post an issue update into the issue's session — no request is opened: it belongs to the open hand-over request its text
   * names. `prompt.buildText` runs right before the forward and settles which request that is; `getTargetRequestId` then
   * answers it (the turn is watched for that request). Rejects when the update did not reach the session.
   */
  postUpdate: (key: SessionKey, prompt: SessionPromptText, getTargetRequestId: () => string) => Promise<void>;
  /** What each issue's conversation was already told (C4), and shown (a comment before its prompt recorded its newest one). */
  contextLedger: Pick<JiraContextLedger, 'getSnapshot' | 'recordBuild' | 'getShownBlock'>;
  /** Over the run budget: the park notice and the hand-back (the answer side, J6). */
  parkIssue: (issueKey: string, requester: JiraAccount | null) => Promise<void>;
  /** The summary a request's prompt shows of its issue — `null` when withheld (D55: the todo boards name the issue by it). */
  noteShownSummary?: (issueKey: string, summary: string | null) => void;
  /** A hand-over the trusted group `groupName` does not back: the fixed notice and the hand-back (the answer side). */
  refuseUntrusted: (issueKey: string, requester: JiraAccount | null, groupName: string) => Promise<void>;
  /** A mention over the run budget: the park notice, no hand-back (the answer side). */
  parkMention: (issueKey: string) => Promise<void>;
  /** The issue reached the cap on updates: one comment saying they are paused until `untilMs` (the answer side). Never rejects. */
  postUpdatesPausedNotice: (issueKey: string, untilMs: number) => Promise<void>;
  /** The bot's one cap on task agents and its wait list; a mention request that answers only bypasses it. */
  slots: Pick<TaskAgentSlots, 'checkIn' | 'noteStarted' | 'noteStartFailed' | 'dropWaiting' | 'listWaiting' | 'pruneWaiting' | 'onSlotFreed'>;
  /** A hand-over that has to wait for a slot: the short comment saying so (the answer side). Never rejects. */
  postQueuedNotice: (issueKey: string, queue: Extract<TaskAgentSlotDecision, { kind: 'queued' }>) => Promise<void>;
}

/**
 * @description The poll's JQL (D13): the allowlist, assigned to the AI account, in a trigger status — and, with
 * `mentionWindowMs`, the issues whose comments mention the AI account and that changed within that window. The
 * mention clause is `comment ~ currentUser()` run as the AI account; it keys on the mention node itself.
 */
export function buildJiraTriggerJql(projects: ReadonlyMap<string, JiraProjectTrigger>, mentionWindowMs: number | null): string {
  const projectKeys = [...projects.keys()].map((projectKey) => `"${projectKey}"`).join(', ');
  const statusIds = [...new Set([...projects.values()].flatMap((project) => [...project.triggerStatusIds]))]
    .map((statusId) => `"${statusId}"`)
    .join(', ');
  const assignedBranch = `assignee = currentUser() AND status in (${statusIds})`;
  if (mentionWindowMs === null) return `project in (${projectKeys}) AND ${assignedBranch} ORDER BY created ASC`;
  const windowMinutes = Math.ceil(mentionWindowMs / msPerMinute);
  return `project in (${projectKeys}) AND ((${assignedBranch}) OR (comment ~ currentUser() AND updated >= -${windowMinutes}m)) ORDER BY created ASC`;
}

/** What {@link getNewestCommentId} says of an issue with no comment yet: below every real id, so any later comment is newer. */
const noCommentId = '0';

/** The open request working on an issue linked to a commented one, and what was read of the commented issue to find it. */
interface JiraLinkedWork {
  /** The linked issue the request is on. */
  issueKey: string;
  requestId: string;
  origin: RequestOrigin;
  /** The COMMENTED issue's context. */
  context: JiraIssueContext;
  project: JiraProjectTrigger;
}

/** A request an issue update can belong to: who asked (as the issue's data names them, and by account id), and whether it is a mention's. */
interface JiraUpdateTarget {
  requestId: string;
  requester: JiraAccount | null;
  requesterAccountId: string;
  isMention: boolean;
}

/** The newest of `comments` by id — a prompt built from them carried every comment up to it — or {@link noCommentId} for none. */
function getNewestCommentId(comments: readonly JiraComment[]): string {
  return comments.reduce((newest, comment) => (compareJiraCommentIds(comment.id, newest) > 0 ? comment.id : newest), noCommentId);
}

/** A changelog item that changed an issue's parent (a sub-task's, a team-managed or an epic's child's). */
function checkIsParentChangeItem(item: JiraChangelogHistory['items'][number]): boolean {
  return ['parent', 'issueparentassociation', 'epic link'].includes(getItemField(item).toLowerCase());
}

/**
 * The issues the AI account itself tied `context`'s issue to, as its whole changelog shows them (read with the context, no
 * further request): the far end of every issue link the AI account made, and its parent when the AI account set it — at
 * the creation (no entry: it created the issue and no one changed the parent since) or by the parent's last change.
 */
function listIssueKeysTiedByAi(context: JiraIssueContext, aiAccountId: string): Set<string> {
  const keys = new Set<string>();
  for (const history of context.changelog) {
    if (history.author?.accountId !== aiAccountId) continue;
    for (const item of history.items) {
      if ((item.field.toLowerCase() === 'link' || item.fieldId === 'issuelinks') && item.to) keys.add(item.to);
    }
  }
  const { parent, creator } = context.issue.fields;
  const lastParentChange = context.changelog.filter((history) => history.items.some(checkIsParentChangeItem)).at(-1);
  const parentSetBy = lastParentChange ? lastParentChange.author : creator;
  if (parent && parentSetBy?.accountId === aiAccountId) keys.add(parent.key);
  return keys;
}

/** The first line of a stored request prompt names its request: `[Request req_… · from: …]`. */
const storedPromptRequestIdPattern = /^\[Request (req_[A-Za-z0-9_-]+) · /;
/** How many mention prompts can be rebuilt at delivery at once (each keeps its issue in memory). */
const promptRebuildersMax = 32;

export class JiraInbound {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  /** A poll is under way (the timer's own, not a direct {@link pollOnce}). */
  private isPolling = false;
  /** A slot freed while a poll was under way: the next poll follows at once. */
  private isRepollRequested = false;
  private stopListeningForSlots: (() => void) | null = null;
  /** Polls in a row that failed — the backoff's exponent (R22). */
  private failureCount = 0;
  /** Issues whose last request's post has not settled yet. */
  private readonly postingIssueKeys = new Set<string>();
  /** Per issue, its `updated` as of the last comment or mention scan that decided every comment — in memory only: a restart scans once more. */
  private readonly lastUpdatedByIssue = new Map<string, string>();
  /** Per issue, the issue updates in a row that did not reach the session, and when the next may be tried — in memory only. */
  private readonly updateRetries = new Map<string, { failureCount: number; retryAt: number }>();
  /** Issues whose seen hand-over the AI account made itself (it took the issue up) — in memory, refreshed by every poll. */
  private readonly selfAssignedIssueKeys = new Set<string>();
  /**
   * The issues handed to the AI account (their hand-over seen) at the last poll, each with the request its last update went
   * to or would have gone to — in memory only. One that leaves the handed state gets one last comment scan.
   */
  private readonly handedIssues = new Map<string, Omit<JiraUpdateTarget, 'requester'> | null>();
  /** The issues the poll under way found handed to the AI account (whatever their decision). */
  private readonly handedThisPoll = new Set<string>();
  /**
   * The mention requests whose stored prompt can be rebuilt with the hand-over requests that are open NOW, by request id —
   * in memory only (a restart leaves the stored text, whose wording holds on its own) and bounded: an entry of a request
   * that is no longer open is dropped whenever another is added.
   */
  private readonly promptRebuilders = new Map<string, { key: SessionKey; rebuild: () => string }>();

  constructor(private readonly deps: JiraInboundDeps) {}

  /** @description Poll now, then every `pollIntervalMs` after each poll ENDS (never two at once). */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    setStoredPromptRefresher(this.refreshPromptText);
    this.stopListeningForSlots = this.deps.slots.onSlotFreed(() => this.pollSoon());
    this.scheduleNext(0);
  }

  stop(): void {
    this.isRunning = false;
    clearStoredPromptRefresher(this.refreshPromptText);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stopListeningForSlots?.();
    this.stopListeningForSlots = null;
  }

  /**
   * @description Poll at once, without waiting out the interval: a task-agent slot freed, and an issue waits for it. A poll that
   * is under way is not interrupted — the next one follows it immediately. Polls still never overlap.
   */
  pollSoon(): void {
    if (!this.isRunning) return;
    if (this.isPolling) {
      this.isRepollRequested = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.scheduleNext(0);
  }

  private scheduleNext(delayMs: number): void {
    // Not unref'd on purpose: in a Jira-only instance this timer is what keeps the process alive (D9).
    this.timer = setTimeout(() => {
      void this.runScheduledPoll();
    }, delayMs);
  }

  private async runScheduledPoll(): Promise<void> {
    this.isPolling = true;
    try {
      await this.pollOnce();
      this.failureCount = 0;
    } catch (error) {
      if (error instanceof JiraAuthError || error instanceof JiraTrustedGroupGoneError) {
        // D14: wrong or revoked credentials, or a trusted group deleted from the site, do not fix themselves;
        // one loud line, then stop.
        console.error(`[jira] polling STOPPED: ${error.message}`);
        this.stop();
        return;
      }
      // R22: a Jira outage never stops polling — the next attempt just waits longer.
      this.failureCount += 1;
      console.warn(`[jira] poll failed (${this.failureCount} in a row): ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.isPolling = false;
    }
    // A failing Jira is never hammered: the backoff stands, whatever freed meanwhile.
    const isRepollDue = this.isRepollRequested && this.failureCount === 0;
    this.isRepollRequested = false;
    if (this.isRunning) this.scheduleNext(isRepollDue ? 0 : getJiraRetryDelayMs(this.deps.pollIntervalMs, this.failureCount));
  }

  /**
   * @description One poll: every matching issue, each decided once. A {@link JiraAuthError} and a
   * {@link JiraTrustedGroupGoneError} propagate, and so does a failed membership read: nothing is decided on a
   * trusted-group list older than its age.
   */
  async pollOnce(): Promise<Map<string, JiraIssueDecision>> {
    const decisions = new Map<string, JiraIssueDecision>();
    this.handedThisPoll.clear();
    const mentionWindowMs = this.getMentionWindowMs();
    const jql = buildJiraTriggerJql(this.deps.projects, mentionWindowMs);
    const returnedIssueKeys = new Set<string>();
    const returnedIssues = new Map<string, JiraIssue>();
    let nextPageToken: string | undefined;
    do {
      // Before every page, not only the first: deciding a long page takes time, and the list must not age out under it.
      await this.deps.trust?.refreshIfStale();
      const page = await this.deps.client.searchIssues({
        jql,
        fields: jiraSearchFields,
        isChangelogExpanded: true,
        maxResults: jiraSearchPageSize,
        nextPageToken,
      });
      for (const issue of page.issues) {
        returnedIssueKeys.add(issue.key);
        returnedIssues.set(issue.key, issue);
        for (const [decisionKey, decision] of await this.decideIssue(issue, mentionWindowMs)) decisions.set(decisionKey, decision);
      }
      nextPageToken = page.isLast ? undefined : (page.nextPageToken ?? undefined);
    } while (nextPageToken);
    for (const [decisionKey, decision] of await this.scanIssuesThatLeftHanded(returnedIssues)) decisions.set(decisionKey, decision);
    // An acting mention that waits for a slot may be older than the search's window by now: its issue is read by its key.
    for (const { issueKey } of this.listWaitingMentions()) {
      if (returnedIssueKeys.has(issueKey)) continue;
      // Kept in the list even when the read fails: a Jira hiccup must not cost the place.
      returnedIssueKeys.add(issueKey);
      const issue = await this.readWaitingIssue(issueKey);
      if (issue) for (const [decisionKey, decision] of await this.decideIssue(issue, mentionWindowMs)) decisions.set(decisionKey, decision);
    }
    // So may a mention held back from its issue update (the cap on updates, a post that failed) by the time it may go.
    for (const issueKey of mentionWindowMs === null ? [] : this.deps.triggerLog.listHeldMentionIssueKeys(this.deps.now())) {
      if (returnedIssueKeys.has(issueKey)) continue;
      returnedIssueKeys.add(issueKey);
      // Not read while its pause or its post's backoff lasts: the scan would skip it anyway.
      if (this.checkIsUpdateRetryPending(issueKey)) continue;
      const issue = await this.readHeldMentionIssue(issueKey);
      if (issue) for (const [decisionKey, decision] of await this.decideIssue(issue, mentionWindowMs)) decisions.set(decisionKey, decision);
    }
    // An issue that left the results is read from scratch if it comes back; the seen-log keeps that from waking twice.
    for (const issueKey of this.lastUpdatedByIssue.keys()) {
      if (!returnedIssueKeys.has(issueKey)) this.lastUpdatedByIssue.delete(issueKey);
    }
    // Only after a complete poll: an issue that is no longer handed to the AI does not wait for a slot (and holds nobody up).
    this.deps.slots.pruneWaiting('jira', (key) => returnedIssueKeys.has(key.thread));
    const acted = [...decisions].filter(([, decision]) => !quietDecisions.has(decision));
    if (acted.length > 0) console.log(`[jira] poll: ${acted.map(([issueKey, decision]) => `${issueKey} ${decision}`).join(', ')}`);
    return decisions;
  }

  /** The issue's project as the allowlist has it, or `undefined` when the issue is outside it. */
  private getAllowlistedProject(issue: JiraIssue): JiraProjectTrigger | undefined {
    const projectKey = getJiraIssueProjectKey(issue.key);
    return projectKey === null ? undefined : this.deps.projects.get(projectKey);
  }

  /** The mention window, or `null` when mention wakes are off (or cannot judge anyone: no trusted group read yet). */
  private getMentionWindowMs(): number | null {
    return this.deps.isMentionWakeOn && this.deps.trust !== null ? getJiraMentionWindowMs(this.deps.pollIntervalMs) : null;
  }

  /** Comment wakes are on and can judge someone (a trusted group read). */
  private checkIsCommentWakeOn(): boolean {
    return this.deps.isCommentWakeOn && this.deps.trust !== null;
  }

  /** Handed to the AI account: assigned to it, in one of its project's trigger statuses. */
  private checkIsHanded(issue: JiraIssue, project: JiraProjectTrigger): boolean {
    const statusId = issue.fields.status?.id;
    return issue.fields.assignee?.accountId === this.deps.aiAccountId && statusId !== undefined && project.triggerStatusIds.has(statusId);
  }

  /**
   * Every decision one returned issue gets in a poll: the hand-over's, then — with comment wakes on and the issue handed
   * to the AI, once its hand-over is seen — its new comments', else — with mention wakes on — its mentions'.
   */
  private async decideIssue(issue: JiraIssue, mentionWindowMs: number | null): Promise<Map<string, JiraIssueDecision>> {
    const decisions = new Map<string, JiraIssueDecision>();
    const decision = await this.getDecisionSafely(issue);
    decisions.set(issue.key, decision);
    const project = this.getAllowlistedProject(issue);
    if (decision === 'notAllowed' || !project) return decisions;
    const key = makeJiraKey(issue.key);
    if (this.checkIsCommentWakeOn() && this.checkIsHanded(issue, project)) {
      this.handedThisPoll.add(issue.key);
      // A mention on a handed issue is a comment like any other: a mention still waiting for a slot gives its place up.
      this.deps.slots.dropWaiting(key, (triggerId) => triggerId.startsWith(mentionTriggerIdPrefix));
      if (decision === 'seen') {
        for (const [decisionKey, commentDecision] of await this.getCommentDecisionsSafely(issue, project)) decisions.set(decisionKey, commentDecision);
        this.noteHanded(key);
      }
      return decisions;
    }
    if (mentionWindowMs !== null) {
      for (const [decisionKey, mentionDecision] of await this.getMentionDecisionsSafely(issue)) decisions.set(decisionKey, mentionDecision);
    } else {
      // Mention wakes went off (a restart with another jira.json): a mention that waited for a slot can never start.
      this.deps.slots.dropWaiting(key, (triggerId) => triggerId.startsWith(mentionTriggerIdPrefix));
    }
    return decisions;
  }

  /** A handed issue whose hand-over is seen: remembered with the request an update would go to now (kept when none is open). */
  private noteHanded(key: SessionKey): void {
    const targets = this.listUpdateTargetRequests(key);
    const newest = targets[targets.length - 1];
    const target = newest
      ? { requestId: newest.id, requesterAccountId: getRequestRequester(newest.origin), isMention: newest.origin.kind === 'trackerMention' }
      : (this.handedIssues.get(key.thread) ?? null);
    this.handedIssues.set(key.thread, target);
  }

  /**
   * @description One last comment scan of each issue that was handed to the AI account at an earlier poll and is not now
   * (handed back, unassigned, moved on): a comment written while it was handed — before the change that ended that —
   * which the agent never got (its final answer came first) is delivered as the "finished" update of the request it was
   * working on, or to a request still open — on an issue the AI account took up in another issue's run, to that run's
   * request when no request of its own is known. An issue the search no longer returns is read by its key. Kept for the next
   * poll while a post of it is in flight, its read fails, or an update of it is still to land.
   */
  private async scanIssuesThatLeftHanded(returnedIssues: ReadonlyMap<string, JiraIssue>): Promise<Map<string, JiraIssueDecision>> {
    const decisions = new Map<string, JiraIssueDecision>();
    if (!this.checkIsCommentWakeOn()) {
      this.handedIssues.clear();
      return decisions;
    }
    for (const [issueKey, lastTarget] of [...this.handedIssues]) {
      if (this.handedThisPoll.has(issueKey) || this.postingIssueKeys.has(issueKey) || this.checkIsUpdateRetryPending(issueKey)) continue;
      const issue = returnedIssues.get(issueKey) ?? await this.readIssueThatLeft(issueKey);
      if (issue === null) continue;
      const project = issue === 'gone' ? undefined : this.getAllowlistedProject(issue);
      if (issue === 'gone' || !project) {
        this.handedIssues.delete(issueKey);
        continue;
      }
      if (this.checkIsHanded(issue, project)) continue;
      const scanned = await this.runOrWarn(issueKey, 'last comment scan: ', () => this.getLastCommentDecisions(issue, project, lastTarget), null);
      if (scanned === null) continue;
      for (const [decisionKey, decision] of scanned.decisions) decisions.set(decisionKey, decision);
      if (!scanned.isPosting) this.handedIssues.delete(issueKey);
    }
    return decisions;
  }

  /** An issue that left the handed state, read by its key; `'gone'` when Jira no longer has it, `null` when the read failed. */
  private async readIssueThatLeft(issueKey: string): Promise<JiraIssue | 'gone' | null> {
    try {
      return await this.deps.client.getIssue(issueKey, jiraSearchFields);
    } catch (error) {
      if (error instanceof JiraAuthError) throw error;
      if (error instanceof JiraHttpError && error.status === 404) return 'gone';
      console.warn(`[jira] ${issueKey}: the issue that left the AI account could not be read for its last comment scan: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** When the issue stopped being handed: the newest changelog entry that assigned it away from the AI account or moved it out of a trigger status; `null` when none is found. */
  private async findLeftHandedAt(issue: JiraIssue, project: JiraProjectTrigger): Promise<number | null> {
    const { aiAccountId } = this.deps;
    for await (const page of this.getChangelogNewestPagesFirst(issue)) {
      const newestFirst = [...page].sort((left, right) => Date.parse(right.created) - Date.parse(left.created));
      const left = newestFirst.find((history) => history.items.some((item) => {
        const field = getItemField(item);
        return (field === 'assignee' && item.to !== aiAccountId) || (field === 'status' && (item.to === null || item.to === undefined || !project.triggerStatusIds.has(item.to)));
      }));
      if (left) return Date.parse(left.created);
    }
    return null;
  }

  /** The last comment scan of an issue that left the handed state (see {@link scanIssuesThatLeftHanded}). */
  private async getLastCommentDecisions(
    issue: JiraIssue,
    project: JiraProjectTrigger,
    lastTarget: Omit<JiraUpdateTarget, 'requester'> | null,
  ): Promise<{ decisions: Map<string, JiraIssueDecision>; isPosting: boolean }> {
    const { deps } = this;
    const decisions = new Map<string, JiraIssueDecision>();
    const { trust } = deps;
    if (!trust) return { decisions, isPosting: false };
    const leftAt = (await this.findLeftHandedAt(issue, project)) ?? deps.now();
    const comments = await deps.client.getRecentComments(issue.key, jiraMentionScanCommentCount);
    const at = deps.now();
    const written = this.listNewComments(issue.key, comments).filter((comment) => Date.parse(comment.created) <= leftAt);
    const { counted } = this.partitionTrustedComments(issue.key, written, trust, at, decisions);
    if (counted.length === 0) return { decisions, isPosting: false };
    const key = makeJiraKey(issue.key);
    const newest = counted[counted.length - 1];
    let decision: JiraIssueDecision;
    if (this.listUpdateTargetRequests(key).length > 0 || lastTarget) {
      decision = await this.postIssueUpdate(issue, project, counted, commentTriggerIdPrefix, at, lastTarget);
    } else {
      // An issue the AI account took up in another issue's run: its comments go to that run, as at every poll before.
      const linked = this.selfAssignedIssueKeys.has(issue.key) ? await this.findLinkedWorkingRequest(issue, project) : null;
      if (!linked) {
        console.log(`[jira] ${issue.key}: comments ${counted.map((comment) => comment.id).join(', ')} came while it was handed to the AI, but no request of it is known any more to bring them to`);
        return { decisions, isPosting: false };
      }
      decision = await this.postLinkedIssueUpdate(issue, counted, at, linked);
    }
    decisions.set(`${issue.key}${mentionDecisionKeySeparator}${commentTriggerIdPrefix}${newest.id}`, decision);
    // Posted (it may still fail and be retried), or waiting out the cap on updates: either way the issue is scanned again.
    return { decisions, isPosting: decision === 'update' || decision === 'waiting' };
  }

  /** The acting mentions that wait for a task-agent slot, oldest first: each issue's key and its `mention:<id>` trigger. */
  private listWaitingMentions(): Array<{ issueKey: string; triggerId: string }> {
    return this.deps.slots.listWaiting('jira')
      .filter((entry) => entry.triggerId.startsWith(mentionTriggerIdPrefix))
      .map((entry) => ({ issueKey: entry.key.thread, triggerId: entry.triggerId }));
  }

  /** The trigger `key`'s conversation waits for a slot with, when it starts with `prefix`; else `null`. */
  private getWaitingTriggerId(key: SessionKey, prefix: string): string | null {
    return this.deps.slots.listWaiting('jira').find((entry) => entry.key.thread === key.thread && entry.triggerId.startsWith(prefix))?.triggerId ?? null;
  }

  /**
   * The issue of a waiting acting mention, read by its key with the search's fields; `null` when it could not be read. An
   * issue Jira no longer has (deleted, or moved out of reach) gives its place up.
   */
  private async readWaitingIssue(issueKey: string): Promise<JiraIssue | null> {
    try {
      return await this.deps.client.getIssue(issueKey, jiraSearchFields);
    } catch (error) {
      if (error instanceof JiraAuthError) throw error;
      if (error instanceof JiraHttpError && error.status === 404) {
        console.log(`[jira] ${issueKey}: the issue of a mention waiting for a slot is gone; its place is dropped`);
        this.deps.slots.dropWaiting(makeJiraKey(issueKey), (triggerId) => triggerId.startsWith(mentionTriggerIdPrefix));
        return null;
      }
      console.warn(`[jira] ${issueKey}: the issue of a mention waiting for a slot could not be read: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * The issue of a mention held back from its issue update, read by its key with the search's fields; `null` when it could
   * not be read. An issue Jira no longer has (deleted, or moved out of reach) is no longer kept for its held mentions.
   */
  private async readHeldMentionIssue(issueKey: string): Promise<JiraIssue | null> {
    const { deps } = this;
    try {
      return await deps.client.getIssue(issueKey, jiraSearchFields);
    } catch (error) {
      if (error instanceof JiraAuthError) throw error;
      if (error instanceof JiraHttpError && error.status === 404) {
        console.log(`[jira] ${issueKey}: the issue of a mention held back from its update is gone; it is not kept any more`);
        for (const commentId of deps.triggerLog.listHeldMentionIds(issueKey, deps.now())) deps.triggerLog.forgetHeldMention(issueKey, commentId);
        return null;
      }
      console.warn(`[jira] ${issueKey}: the issue of a mention held back from its update could not be read: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Runs `run`: a refused token propagates (it stops polling); any other failure is one warning naming the issue and
   * `what` failed, and the answer is `fallback` — the next poll tries again.
   */
  private async runOrWarn<T>(issueKey: string, what: string, run: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof JiraAuthError) throw error;
      console.warn(`[jira] ${issueKey}: ${what}${error instanceof Error ? error.message : String(error)}`);
      return fallback;
    }
  }

  private async getDecisionSafely(issue: JiraIssue): Promise<JiraIssueDecision> {
    const decision = await this.runOrWarn(issue.key, '', () => this.getDecision(issue), 'failed');
    // A hand-over's place: its own decision ends it. A comment's request waits only while the issue is handed; a mention's
    // place is its own scan's to end.
    if (waitEndingDecisions.has(decision)) {
      this.deps.slots.dropWaiting(makeJiraKey(issue.key), (triggerId) =>
        checkIsHandOverTriggerId(triggerId) || (decision === 'notMatching' && triggerId.startsWith(commentTriggerIdPrefix)));
    }
    return decision;
  }

  private async getDecision(issue: JiraIssue): Promise<JiraIssueDecision> {
    const { deps } = this;
    const project = this.getAllowlistedProject(issue);
    // D13: the JQL names only the allowlist, but every returned issue is checked again.
    if (!project) return 'notAllowed';
    const statusId = issue.fields.status?.id;
    if (issue.fields.assignee?.accountId !== deps.aiAccountId || statusId === undefined || !project.triggerStatusIds.has(statusId)) {
      return 'notMatching';
    }
    if (this.postingIssueKeys.has(issue.key)) return 'posting';
    const found = await this.findTrigger(issue, project);
    if ('seen' in found) {
      // The AI account handed the issue to itself (an acting mention's "take up the work"): its comments go to the open
      // request that did so, never into a request of their own.
      if (found.seen.author?.accountId === deps.aiAccountId) this.selfAssignedIssueKeys.add(issue.key);
      else this.selfAssignedIssueKeys.delete(issue.key);
      return 'seen';
    }
    const { trigger, requester } = found;
    const at = deps.now();
    if (trigger.author?.accountId === deps.aiAccountId) {
      this.recordOrWarn({ issueKey: issue.key, triggerId: trigger.triggerId, outcome: 'selfAuthored', at });
      return 'selfAuthored';
    }
    // The HAND-OVER decides: the account that made the change — a trusted app or automation (`trustedApps`: every app
    // while the key is absent, else the listed ones) starts the agent whoever the requester turns out to be, an app that is
    // not listed is refused like an outsider. A change Jira names no one for falls back to the requester, and no account
    // at all is untrusted (fail closed).
    if (deps.trust && !deps.trust.checkIsTrusted(trigger.author ?? requester)) {
      // Recorded first, as a park: the notice is posted at most once per trigger, never again by a failed or repeated poll.
      if (!this.recordOrWarn({ issueKey: issue.key, triggerId: trigger.triggerId, outcome: 'untrusted', at })) return 'failed';
      await deps.refuseUntrusted(issue.key, requester, deps.trust.groupName);
      return 'untrusted';
    }
    if (deps.triggerLog.getRequestCountLastDay(issue.key, at) >= deps.runBudgetPer24h) {
      // Recorded first: a failed notice is not repeated on every poll (at most one per trigger).
      if (!this.recordOrWarn({ issueKey: issue.key, triggerId: trigger.triggerId, outcome: 'parked', at })) return 'failed';
      await deps.parkIssue(issue.key, requester);
      return 'parked';
    }
    // D10: one cap on the task agents of the whole bot. Past it the issue waits — its trigger stays unrecorded, so every poll
    // decides it again and it starts when it is first in the list and a slot is free.
    const key = makeJiraKey(issue.key);
    const slot = await deps.slots.checkIn(key, trigger.triggerId);
    if (slot.kind === 'queued') {
      if (!slot.isNewlyQueued) return 'waiting';
      await deps.postQueuedNotice(issue.key, slot);
      return 'queued';
    }
    try {
      const decision = await this.openRequest(issue, project, trigger, requester, at);
      deps.slots.noteStarted(key);
      return decision;
    } catch (error) {
      deps.slots.noteStartFailed(key);
      throw error;
    }
  }

  private getMentionDecisionsSafely(issue: JiraIssue): Promise<Map<string, JiraIssueDecision>> {
    const failed = new Map<string, JiraIssueDecision>([[`${issue.key}${mentionDecisionKeySeparator}mention`, 'failed']]);
    return this.runOrWarn(issue.key, 'mention scan: ', () => this.getMentionDecisions(issue), failed);
  }

  /**
   * @description The comments of `issue` that mention the AI account and were not decided yet, each decided once
   * (oldest first). Skipped altogether while the issue's `updated` is what the last complete scan saw, and while
   * a request of the issue is being posted (the next poll takes the rest: one request is posted at a time). A mention
   * waiting for a task-agent slot is scanned at every poll and stays in, outside the window too, until it is decided; so
   * does a mention held back from its issue update (the cap on updates, a post that failed), once the wait is over.
   */
  private async getMentionDecisions(issue: JiraIssue): Promise<Map<string, JiraIssueDecision>> {
    const { deps } = this;
    const decisions = new Map<string, JiraIssueDecision>();
    const project = this.getAllowlistedProject(issue);
    const { trust } = deps;
    if (!project || !trust) return decisions;
    const key = makeJiraKey(issue.key);
    const waitingTriggerId = this.getWaitingTriggerId(key, mentionTriggerIdPrefix);
    const heldCommentIds = new Set(deps.triggerLog.listHeldMentionIds(issue.key, deps.now()));
    const { updated } = issue.fields;
    const isRescanDue = waitingTriggerId !== null || heldCommentIds.size > 0 || this.updateRetries.has(issue.key);
    if (!isRescanDue && updated !== undefined && this.lastUpdatedByIssue.get(issue.key) === updated) return decisions;
    if (this.postingIssueKeys.has(issue.key)) return decisions;
    if (this.checkIsUpdateRetryPending(issue.key)) return decisions;
    const comments = await deps.client.getRecentComments(issue.key, jiraMentionScanCommentCount);
    // The whole window every time, not "since the last scan": a comment that became visible a moment after a scan
    // is still inside it, and the seen-log makes the overlap harmless.
    const windowStartMs = deps.now() - getJiraMentionWindowMs(deps.pollIntervalMs);
    const checkIsDecided = (comment: JiraComment): boolean => deps.triggerLog.checkIsSeen(issue.key, `${mentionTriggerIdPrefix}${comment.id}`)
      || deps.triggerLog.checkIsSeen(issue.key, `${commentTriggerIdPrefix}${comment.id}`);
    // A waiting mention whose comment is gone, or was decided meanwhile, waits no more.
    if (waitingTriggerId !== null && !comments.some((comment) => `${mentionTriggerIdPrefix}${comment.id}` === waitingTriggerId && !checkIsDecided(comment))) {
      deps.slots.dropWaiting(key, (triggerId) => triggerId === waitingTriggerId);
    }
    // A held mention is kept no more once its comment is gone (or no longer among the newest) — it can never be delivered —
    // or a prompt of the issue built since carried it (the watermark passed it: an update of the issue once it was handed).
    const shownUpToId = deps.triggerLog.getNewestShownCommentId(issue.key);
    for (const commentId of heldCommentIds) {
      const isShown = shownUpToId !== null && compareJiraCommentIds(commentId, shownUpToId) <= 0;
      if (!isShown && comments.some((comment) => comment.id === commentId)) continue;
      deps.triggerLog.forgetHeldMention(issue.key, commentId);
      heldCommentIds.delete(commentId);
    }
    const undecidedMentions = comments
      .filter((comment) => comment.author?.accountId !== deps.aiAccountId
        && (Math.max(Date.parse(comment.created), Date.parse(comment.updated ?? comment.created)) >= windowStartMs
          || `${mentionTriggerIdPrefix}${comment.id}` === waitingTriggerId
          || heldCommentIds.has(comment.id))
        && getMentionedAccountIds(comment.body).includes(deps.aiAccountId)
        && !checkIsDecided(comment))
      .sort((left, right) => Date.parse(left.created) - Date.parse(right.created));
    let isEveryMentionDecided = true;
    for (const comment of undecidedMentions) {
      if (this.postingIssueKeys.has(issue.key)) {
        isEveryMentionDecided = false;
        break;
      }
      const decision = await this.getMentionDecisionSafely(issue, project, comment, trust);
      decisions.set(`${issue.key}${mentionDecisionKeySeparator}${mentionTriggerIdPrefix}${comment.id}`, decision);
      if (undecidedDecisions.has(decision)) isEveryMentionDecided = false;
    }
    if (isEveryMentionDecided && updated !== undefined) this.lastUpdatedByIssue.set(issue.key, updated);
    return decisions;
  }

  /**
   * One comment failing (the issue could not be read for its prompt, say) leaves the others' decisions standing; the next poll
   * retries it. A mention that waited for a slot and is decided now — started, or refused, parked or turned into an update —
   * gives its place up.
   */
  private async getMentionDecisionSafely(issue: JiraIssue, project: JiraProjectTrigger, comment: JiraComment, trust: JiraTrust): Promise<JiraIssueDecision> {
    const decision = await this.runOrWarn(issue.key, `mention in comment ${comment.id}: `, () => this.getMentionDecision(issue, project, comment, trust), 'failed');
    if (!undecidedDecisions.has(decision)) this.deps.slots.dropWaiting(makeJiraKey(issue.key), (triggerId) => triggerId === `${mentionTriggerIdPrefix}${comment.id}`);
    return decision;
  }

  private async getMentionDecision(
    issue: JiraIssue,
    project: JiraProjectTrigger,
    comment: JiraComment,
    trust: JiraTrust,
  ): Promise<JiraIssueDecision> {
    const { deps } = this;
    const at = deps.now();
    const trigger = createMentionTrigger(comment.id, comment.author ?? null);
    const record = (outcome: 'untrusted' | 'covered' | 'parked', extra: { isNoticePosted?: boolean } = {}): boolean =>
      this.recordOrWarn({ issueKey: issue.key, triggerId: trigger.triggerId, outcome, at, ...extra });
    // The same rule as for the comment's text: its author AND its last editor. A comment that fails it is recorded,
    // so the line below is logged once; nothing is posted — an outsider gets no answer and no notice.
    if (!checkIsCommentTrusted(comment, trust)) {
      if (!record('untrusted')) return 'failed';
      console.log(`[jira] ${issue.key}: the mention in comment ${comment.id} is ignored: its author or last editor is outside the trusted group`);
      return 'untrusted';
    }
    // D9: the requester of an open hand-over request already has the agent on this issue; a request of their own would
    // supersede it and strip its hand-back. A hand-over request with NO requester is superseded by ANY next request of
    // the conversation (`requestLedger.ts`), so while one is open every mention belongs to it. With comment wakes on the
    // comment reaches that run as an issue update; with them off it is `covered`: recorded, nothing posted.
    // With comment wakes on, the same holds for an open mention that acts: a follow-up mention by its requester (on an issue
    // not handed to the AI, where a plain comment never arrives) goes into that work, not into a second mention request.
    const requesterAccountId = comment.author?.accountId;
    const isCommentWakeOn = this.checkIsCommentWakeOn();
    const isCovered = deps.listOpenRequests(makeJiraKey(issue.key)).some((request) => {
      const openRequester = getRequestRequester(request.origin);
      const isCoveringKind = isCommentWakeOn ? checkIsSlotHoldingOrigin(request.origin) : request.origin.kind === 'trackerEvent';
      return isCoveringKind && !request.isWakeStopped && (openRequester === requesterAccountId || openRequester === emptyRequester);
    });
    if (isCovered && !isCommentWakeOn) return record('covered') ? 'covered' : 'failed';
    if (isCovered) return this.postIssueUpdate(issue, project, [comment], mentionTriggerIdPrefix, at);
    if (deps.triggerLog.getRequestCountLastDay(issue.key, at) >= deps.runBudgetPer24h) {
      // D10: the notice is posted at most once per issue per rolling 24 h; later over-budget mentions are recorded silently.
      const isNoticeDue = !deps.triggerLog.checkIsMentionParkNoticePostedLastDay(issue.key, at);
      if (!record('parked', { isNoticePosted: isNoticeDue })) return 'failed';
      if (isNoticeDue) await deps.parkMention(issue.key);
      return 'parked';
    }
    // An acting mention may start a build: it takes a task-agent slot like a hand-over (and waits for one past the cap).
    if (deps.mentionMode === 'act') return this.openRequestInSlot(issue, project, trigger, comment.author ?? null, at);
    return this.openRequest(issue, project, trigger, comment.author ?? null, at);
  }

  /**
   * Open the request of `trigger` in a free task-agent slot; past the cap the conversation joins the bot's wait list — told
   * once with the queued notice, its trigger unrecorded, decided again by every poll until it is first in the list.
   */
  private async openRequestInSlot(
    issue: JiraIssue,
    project: JiraProjectTrigger,
    trigger: JiraIssueTrigger,
    requester: JiraAccount | null,
    at: number,
    extraRecords: readonly JiraTriggerRecord[] = [],
  ): Promise<JiraIssueDecision> {
    const { deps } = this;
    const key = makeJiraKey(issue.key);
    const slot = await deps.slots.checkIn(key, trigger.triggerId);
    if (slot.kind === 'queued') {
      if (!slot.isNewlyQueued) return 'waiting';
      await deps.postQueuedNotice(issue.key, slot);
      return 'queued';
    }
    try {
      const decision = await this.openRequest(issue, project, trigger, requester, at, extraRecords);
      deps.slots.noteStarted(key);
      return decision;
    } catch (error) {
      deps.slots.noteStartFailed(key);
      throw error;
    }
  }

  private getCommentDecisionsSafely(issue: JiraIssue, project: JiraProjectTrigger): Promise<Map<string, JiraIssueDecision>> {
    const failed = new Map<string, JiraIssueDecision>([[`${issue.key}${mentionDecisionKeySeparator}comment`, 'failed']]);
    return this.runOrWarn(issue.key, 'comment scan: ', () => this.getCommentDecisions(issue, project), failed);
  }

  /**
   * @description The new comments of an issue HANDED to the AI account (its hand-over seen), decided in one go: the trusted
   * people's reach its agent — as ONE issue update of the open hand-over request, else as ONE request of their own —
   * the others are recorded `untrusted` (silent), and an app's or an automation's ride the next prompt. Skipped while the
   * issue's `updated` is what the last complete scan saw (unless a comment's request waits for a slot: then every poll
   * decides it again), while a post of the issue is in flight, and while a failed update waits for its retry.
   */
  private async getCommentDecisions(issue: JiraIssue, project: JiraProjectTrigger): Promise<Map<string, JiraIssueDecision>> {
    const { deps } = this;
    const decisions = new Map<string, JiraIssueDecision>();
    const { trust } = deps;
    if (!trust) return decisions;
    const key = makeJiraKey(issue.key);
    // Read again whatever `updated` says while a comment's request waits for a slot, or a failed update waits for its retry.
    const isRescanDue = this.getWaitingTriggerId(key, commentTriggerIdPrefix) !== null || this.updateRetries.has(issue.key);
    const { updated } = issue.fields;
    if (!isRescanDue && updated !== undefined && this.lastUpdatedByIssue.get(issue.key) === updated) return decisions;
    if (this.postingIssueKeys.has(issue.key) || this.checkIsUpdateRetryPending(issue.key)) return decisions;
    const comments = await deps.client.getRecentComments(issue.key, jiraMentionScanCommentCount);
    const at = deps.now();
    const partition = this.partitionTrustedComments(issue.key, this.listNewComments(issue.key, comments), trust, at, decisions);
    const { counted } = partition;
    let { isEveryCommentDecided } = partition;
    if (counted.length > 0) {
      const newest = counted[counted.length - 1];
      const decision = await this.runOrWarn(issue.key, `comments ${counted.map((comment) => comment.id).join(', ')}: `, () => this.deliverComments(issue, project, counted, at), 'failed');
      decisions.set(`${issue.key}${mentionDecisionKeySeparator}${commentTriggerIdPrefix}${newest.id}`, decision);
      if (undecidedDecisions.has(decision)) isEveryCommentDecided = false;
    }
    if (isEveryCommentDecided && updated !== undefined) this.lastUpdatedByIssue.set(issue.key, updated);
    return decisions;
  }

  /** The comments of `comments` new to the issue's conversation and not decided yet (none the AI account wrote), oldest first. */
  private listNewComments(issueKey: string, comments: readonly JiraComment[]): JiraComment[] {
    const { deps } = this;
    return comments
      .filter((comment) => comment.author?.accountId !== deps.aiAccountId
        && this.checkIsCommentNewToConversation(issueKey, comment)
        && !deps.triggerLog.checkIsSeen(issueKey, `${commentTriggerIdPrefix}${comment.id}`)
        && !deps.triggerLog.checkIsSeen(issueKey, `${mentionTriggerIdPrefix}${comment.id}`))
      .sort((left, right) => compareJiraCommentIds(left.id, right.id));
  }

  /**
   * The people's comments of `comments` that may reach the agent (`counted`): an app's or an automation's (a pipeline notice,
   * a rule) wakes nothing — it rides the next prompt — and one whose author or last editor is not trusted is recorded
   * `untrusted` (one log line, nothing posted; its decision goes into `decisions`).
   */
  private partitionTrustedComments(
    issueKey: string,
    comments: readonly JiraComment[],
    trust: JiraTrust,
    at: number,
    decisions: Map<string, JiraIssueDecision>,
  ): { counted: JiraComment[]; isEveryCommentDecided: boolean } {
    const counted: JiraComment[] = [];
    let isEveryCommentDecided = true;
    for (const comment of comments) {
      if (!comment.author || !checkIsPersonAccount(comment.author)) continue;
      const decisionKey = `${issueKey}${mentionDecisionKeySeparator}${commentTriggerIdPrefix}${comment.id}`;
      // The same rule as for the comment's text: its author AND its last editor.
      if (!checkIsCommentTrusted(comment, trust)) {
        const isRecorded = this.recordOrWarn({ issueKey, triggerId: `${commentTriggerIdPrefix}${comment.id}`, outcome: 'untrusted', at });
        if (isRecorded) console.log(`[jira] ${issueKey}: comment ${comment.id} does not wake the AI: its author or last editor is outside the trusted group`);
        else isEveryCommentDecided = false;
        decisions.set(decisionKey, isRecorded ? 'untrusted' : 'failed');
        continue;
      }
      counted.push(comment);
    }
    return { counted, isEveryCommentDecided };
  }

  /**
   * Is `comment` new to the issue's conversation? Newer than every comment a recorded prompt of the issue was built from
   * (the trigger log's watermark — it survives a restart, a compaction and a fresh session) or the conversation was shown.
   * With neither (decisions recorded before the watermark was): not shown, and written after the issue's last decision.
   */
  private checkIsCommentNewToConversation(issueKey: string, comment: JiraComment): boolean {
    const { deps } = this;
    const recordedId = deps.triggerLog.getNewestShownCommentId(issueKey);
    if (recordedId !== null) return compareJiraCommentIds(comment.id, recordedId) > 0;
    if (deps.contextLedger.getShownBlock(issueKey, `${commentTriggerIdPrefix}${comment.id}`)) return false;
    const lastDecidedAt = deps.triggerLog.getLastDecidedAt(issueKey);
    return lastDecidedAt !== null && Date.parse(comment.created) > lastDecidedAt;
  }

  /**
   * The requests of the conversation an update can belong to, open and not given up: its hand-overs and its mentions that
   * may act (the work it is doing on the issue) — and, on an issue the AI account handed to itself, any open request: the
   * one that made it take the issue up is still working on it.
   */
  private listUpdateTargetRequests(key: SessionKey): Array<Pick<OpenRequestState, 'id' | 'origin'>> {
    const open = this.deps.listOpenRequests(key).filter((request) => !request.isWakeStopped);
    const working = open.filter((request) => checkIsSlotHoldingOrigin(request.origin));
    if (working.length > 0 || !this.selfAssignedIssueKeys.has(key.thread)) return working;
    return open.filter((request) => request.origin.kind === 'trackerMention');
  }

  /**
   * The trusted comments `counted` (oldest first) of a handed issue: an issue update when a hand-over request is open, else
   * a request of their own — the newest comment's trigger, its author the requester — through the run budget and a slot.
   */
  private async deliverComments(issue: JiraIssue, project: JiraProjectTrigger, counted: readonly JiraComment[], at: number): Promise<JiraIssueDecision> {
    const { deps } = this;
    const key = makeJiraKey(issue.key);
    if (this.listUpdateTargetRequests(key).length > 0) {
      // A comment's request that waited for a slot is no longer needed: the hand-over that opened since carries it.
      deps.slots.dropWaiting(key, (triggerId) => triggerId.startsWith(commentTriggerIdPrefix));
      return this.postIssueUpdate(issue, project, counted, commentTriggerIdPrefix, at);
    }
    // An issue the AI account handed to itself while ANOTHER issue's request works on it (it created the issue, or took it up,
    // in that run): the comment goes to that request — a request of its own would be a second agent on the same work.
    if (this.selfAssignedIssueKeys.has(issue.key)) {
      const linked = await this.findLinkedWorkingRequest(issue, project);
      if (linked) return this.postLinkedIssueUpdate(issue, counted, at, linked);
    }
    const newest = counted[counted.length - 1];
    const trigger = createCommentTrigger(counted.map((comment) => comment.id), newest.author ?? null);
    const requester = newest.author ?? null;
    const olderRecords = counted.slice(0, -1).map((comment): JiraTriggerRecord => ({ issueKey: issue.key, triggerId: `${commentTriggerIdPrefix}${comment.id}`, outcome: 'update', at }));
    if (deps.triggerLog.getRequestCountLastDay(issue.key, at) >= deps.runBudgetPer24h) {
      // Recorded first, as a hand-over's park: the notice and the hand-back go out at most once.
      const records = [...olderRecords.map((record) => ({ ...record, outcome: 'parked' as const })), { issueKey: issue.key, triggerId: trigger.triggerId, outcome: 'parked' as const, at }];
      if (!records.every((record) => this.recordOrWarn(record))) return 'failed';
      await deps.parkIssue(issue.key, requester);
      return 'parked';
    }
    return this.openRequestInSlot(issue, project, trigger, requester, at, olderRecords);
  }

  /**
   * The open request that works on an issue linked to `issue` — its parent, a sub-task or child, either end of an issue link,
   * in an allowlisted project — and holds a task-agent slot (a hand-over, or a mention that may act); `null` when none does.
   * When several do, the one on an issue the AI account tied `issue` to (it linked them, or set the parent: the run that
   * created or took it up), else the first. Read with the issue's context, which the update then quotes.
   */
  private async findLinkedWorkingRequest(issue: JiraIssue, project: JiraProjectTrigger): Promise<JiraLinkedWork | null> {
    const { deps } = this;
    const context = await fetchJiraIssueContext(deps.client, issue.key, project.extraFields.map((extraField) => extraField.id), deps.trust !== null);
    const { fields } = context.issue;
    const linkedKeys = [
      fields.parent?.key,
      ...(fields.issuelinks ?? []).flatMap((link) => [link.outwardIssue?.key, link.inwardIssue?.key]),
      ...(fields.subtasks ?? []).map((subtask) => subtask.key),
      ...context.children.map((child) => child.key),
    ].filter((linkedKey): linkedKey is string => linkedKey !== undefined && linkedKey !== issue.key && getJiraIssueProjectKey(linkedKey) !== null && deps.projects.has(getJiraIssueProjectKey(linkedKey) ?? ''));
    const working = [...new Set(linkedKeys)].flatMap((linkedKey) => {
      const request = deps.listOpenRequests(makeJiraKey(linkedKey)).find((open) => checkIsSlotHoldingOrigin(open.origin) && !open.isWakeStopped);
      return request ? [{ linkedKey, request }] : [];
    });
    if (working.length === 0) return null;
    const tiedKeys = working.length > 1 ? listIssueKeysTiedByAi(context, deps.aiAccountId) : new Set<string>();
    const picked = working.find(({ linkedKey }) => tiedKeys.has(linkedKey)) ?? working[0];
    if (working.length > 1) {
      const why = tiedKeys.has(picked.linkedKey) ? 'the AI account tied the issue to it' : 'the first: the changelog shows no tie the AI account made';
      console.log(`[jira] ${issue.key}: linked issues ${working.map(({ linkedKey }) => linkedKey).join(', ')} each have a request at work; its comments go to ${picked.linkedKey}'s (${why})`);
    }
    return { issueKey: picked.linkedKey, requestId: picked.request.id, origin: picked.request.origin, context, project };
  }

  /**
   * @description Post the comments of a self-handed issue into the conversation of the linked issue whose request works on it:
   * an issue update of THAT request whose header names the issue the comments are on, carrying only the new comments (that
   * conversation's context ledger is its own issue's). Recorded on the commented issue once posted, like any update.
   */
  private async postLinkedIssueUpdate(issue: JiraIssue, comments: readonly JiraComment[], at: number, linked: JiraLinkedWork): Promise<JiraIssueDecision> {
    const { deps } = this;
    const { trust } = deps;
    if (deps.triggerLog.getUpdateCountLastDay(issue.key, at) >= jiraIssueUpdatesPer24hMax) return this.pauseUpdates(issue.key, comments, commentTriggerIdPrefix);
    const blockTrust: JiraBlockTrust | null = trust && {
      checkIsTrusted: (account) => trust.checkIsTrusted(account),
      allowlistedProjectKeys: new Set(deps.projects.keys()),
    };
    const commentKeys = new Set(comments.map((comment) => `${commentTriggerIdPrefix}${comment.id}`));
    const commentBlocks = buildIssueBlocks(linked.context, linked.project.extraFields, deps.aiAccountId, blockTrust).filter((block) => commentKeys.has(block.key));
    const requesterAccountId = getRequestRequester(linked.origin);
    const targetKey = makeJiraKey(linked.issueKey);
    const buildText = (): string => buildJiraUpdatePrompt({
      issueKey: issue.key,
      issueUrl: `${deps.siteUrl.replace(/\/+$/, '')}/browse/${issue.key}`,
      requestIssueKey: linked.issueKey,
      target: {
        requestId: linked.requestId,
        requester: findAccountInContext(linked.context, requesterAccountId),
        isMention: linked.origin.kind === 'trackerMention',
        isOpen: deps.listOpenRequests(targetKey).some((open) => open.id === linked.requestId),
      },
      openHandOvers: [],
      comments: comments.map((comment) => ({ commentId: comment.id, author: comment.author ?? null })),
      isTextFiltered: trust !== null,
      delta: { entries: commentBlocks.map((block) => ({ block, stateNote: newBlockNote })), unchangedKinds: [], unchangedCommentCount: 0, deletedCommentLabels: [], sent: {} },
    });
    const prompt: SessionPromptText = { fullText: buildText(), buildText };
    // Only the delivered comments were shown (not the rest of the issue, read after the scan): one written in between stays new.
    const newestCommentId = getNewestCommentId(comments);
    this.postingIssueKeys.add(issue.key);
    void this.postUpdateAndRecord(targetKey, issue.key, prompt, () => linked.requestId, (requestId) => comments.map((comment) => ({
      issueKey: issue.key,
      triggerId: `${commentTriggerIdPrefix}${comment.id}`,
      outcome: 'update',
      at,
      requestId,
      newestCommentId,
    })));
    return 'update';
  }

  /**
   * Past the cap on issue updates: the comments stay undecided and are delivered once the oldest update of the last 24 h
   * leaves that window (the scan waits until then; a mention, found only inside the mention window, is held back so the
   * scan keeps it). One log line per pause says until when; the issue gets ONE comment by the AI account saying so at most
   * once per rolling 24 h — a steady stream of comments pauses it again at every window end — and the AI account's own
   * comments are never delivered, so the notice starts no loop.
   */
  private async pauseUpdates(issueKey: string, comments: readonly JiraComment[], prefix: string): Promise<JiraIssueDecision> {
    const { deps } = this;
    const at = deps.now();
    const until = deps.triggerLog.getUpdateWindowEnd(issueKey, at) ?? at + msPerDay;
    this.updateRetries.set(issueKey, { failureCount: 0, retryAt: until });
    if (prefix === mentionTriggerIdPrefix) this.holdMentionsBack(issueKey, comments, at);
    const pauseTriggerId = `${updatesPausedTriggerIdPrefix}${until}`;
    if (deps.triggerLog.checkIsSeen(issueKey, pauseTriggerId)) return 'waiting';
    // Recorded first, like a mention's park notice: never logged or posted again after a failed post or a restart.
    const isNoticeDue = !deps.triggerLog.checkIsUpdatesPausedNoticePostedLastDay(issueKey, at);
    if (!this.recordOrWarn({ issueKey, triggerId: pauseTriggerId, outcome: 'parked', at, isNoticePosted: isNoticeDue })) return 'failed';
    const noticeText = isNoticeDue ? 'the issue says so in one comment' : 'the issue got its one comment about a pause in the last 24 h, so it gets none now';
    console.warn(`[jira] ${issueKey}: ${jiraIssueUpdatesPer24hMax} issue updates in 24 h, the cap: comments ${comments.map((comment) => comment.id).join(', ')} and later ones wait until ${new Date(until).toISOString()} and are delivered then; ${noticeText}. Does the agent comment under a person's account instead of the AI account?`);
    if (isNoticeDue) await deps.postUpdatesPausedNotice(issueKey, until);
    return 'waiting';
  }

  /**
   * Mark the mentions `comments` held back from their issue update (`held-mention:`): the mention scan keeps them, outside
   * the mention window too, until they are delivered. Kept for this process when the line could not be written.
   */
  private holdMentionsBack(issueKey: string, comments: readonly JiraComment[], at: number): void {
    for (const comment of comments) {
      const triggerId = `${heldMentionTriggerIdPrefix}${comment.id}`;
      if (this.deps.triggerLog.checkIsSeen(issueKey, triggerId)) continue;
      const record: JiraTriggerRecord = { issueKey, triggerId, outcome: 'parked', at };
      if (!this.recordOrWarn(record)) this.deps.triggerLog.remember(record);
    }
  }

  /** A failed issue update of the issue waits for its retry. */
  private checkIsUpdateRetryPending(issueKey: string): boolean {
    const retry = this.updateRetries.get(issueKey);
    return retry !== undefined && this.deps.now() < retry.retryAt;
  }

  /**
   * @description Post an ISSUE UPDATE: the comments `comments` (trigger ids `prefix` + id: a comment's, or a mention's)
   * reach the agent inside an open hand-over request of the conversation — no request is opened. Which request is
   * settled right before the forward (the post may have waited behind a running turn): the commenter's own open one,
   * else one with no requester, else the newest; when every hand-over finished meanwhile, the one the update was meant
   * for, named as finished — the comment still reaches the agent, and its answer becomes a comment. The text is the
   * issue's delta (or the whole issue for a session that does not know it). Recorded once the post settled; a post that
   * failed is decided again after a backoff. Not awaited: the issue is skipped until the post settles.
   */
  private async postIssueUpdate(
    issue: JiraIssue,
    project: JiraProjectTrigger,
    comments: readonly JiraComment[],
    prefix: string,
    at: number,
    finishedTarget: Omit<JiraUpdateTarget, 'requester'> | null = null,
  ): Promise<JiraIssueDecision> {
    const { deps } = this;
    const { trust } = deps;
    // A trusted account that is not the AI account may write as the agent's own tooling (an operator token in its MCP
    // config): every comment it writes would be the next poll's update, one turn per poll for ever. Updates are capped.
    if (deps.triggerLog.getUpdateCountLastDay(issue.key, at) >= jiraIssueUpdatesPer24hMax) return this.pauseUpdates(issue.key, comments, prefix);
    const context = await fetchJiraIssueContext(deps.client, issue.key, project.extraFields.map((extraField) => extraField.id), trust !== null);
    const blockTrust: JiraBlockTrust | null = trust && {
      checkIsTrusted: (account) => trust.checkIsTrusted(account),
      allowlistedProjectKeys: new Set(deps.projects.keys()),
    };
    const blocks = buildIssueBlocks(context, project.extraFields, deps.aiAccountId, blockTrust);
    deps.noteShownSummary?.(issue.key, getShownIssueSummary(context, blockTrust));
    const key = makeJiraKey(issue.key);
    const commenterAccountId = comments[comments.length - 1].author?.accountId;
    const newComments: JiraNewComment[] = comments.map((comment) => ({ commentId: comment.id, author: comment.author ?? null }));
    /** The requests the update can belong to now, named from the issue's data (a mention's marked as one). */
    const getTargets = (): JiraUpdateTarget[] => this.listUpdateTargetRequests(key).map((request) => ({
      requestId: request.id,
      requester: findAccountInContext(context, getRequestRequester(request.origin)),
      requesterAccountId: getRequestRequester(request.origin),
      isMention: request.origin.kind === 'trackerMention',
    }));
    const pickTarget = (): JiraUpdateTarget | null => {
      const targets = getTargets();
      return targets.find((target) => target.requesterAccountId === commenterAccountId)
        ?? targets.find((target) => target.requesterAccountId === emptyRequester)
        ?? targets[targets.length - 1]
        ?? null;
    };
    const firstTarget = pickTarget() ?? (finishedTarget ? { ...finishedTarget, requester: findAccountInContext(context, finishedTarget.requesterAccountId) } : null);
    if (!firstTarget) throw new Error('no request is open for the update');
    let target = firstTarget;
    const getBase = (): JiraUpdatePromptBase => {
      const now = pickTarget();
      if (now) target = now;
      return {
        issueKey: issue.key,
        issueUrl: `${deps.siteUrl.replace(/\/+$/, '')}/browse/${issue.key}`,
        target: { requestId: target.requestId, requester: target.requester, isMention: target.isMention, isOpen: now !== null },
        openHandOvers: getTargets().map((open) => ({ requestId: open.requestId, requester: open.requester })),
        comments: newComments,
        isTextFiltered: trust !== null,
      };
    };
    const fitted = await fitBlocksToPrompt({
      blocks,
      textDir: deps.getSpillDir(key),
      measure: (candidate) => buildJiraUpdatePrompt({ ...getBase(), ...candidate }).length,
    });
    const newestCommentId = getNewestCommentId(context.comments);
    const prompt: SessionPromptText = {
      fullText: buildJiraUpdatePrompt({ ...getBase(), ...fitted }),
      buildText: ({ isFresh }) => {
        const base = getBase();
        const snapshot = deps.contextLedger.getSnapshot(issue.key);
        const isWhole = isFresh || Object.keys(snapshot.sent).length === 0;
        const delta = getIssueDelta(fitted.blocks, isWhole ? {} : snapshot.sent);
        // Counted as sent once the request it belongs to takes it in, or is closed by its answer (C4).
        deps.contextLedger.recordBuild(issue.key, base.target.requestId, snapshot.generation, delta.sent);
        return isWhole ? buildJiraUpdatePrompt({ ...base, ...fitted }) : buildJiraUpdatePrompt({ ...base, delta });
      },
    };
    this.postingIssueKeys.add(issue.key);
    // A mention whose update failed is retried after a backoff that may outlast the mention window: it is held back.
    const onFailed = prefix === mentionTriggerIdPrefix ? () => this.holdMentionsBack(issue.key, comments, at) : undefined;
    void this.postUpdateAndRecord(key, issue.key, prompt, () => target.requestId, (requestId) => comments.map((comment) => ({
      issueKey: issue.key,
      triggerId: `${prefix}${comment.id}`,
      outcome: 'update',
      at,
      requestId,
      newestCommentId,
    })), onFailed);
    return 'update';
  }

  /**
   * Post the update, then record its comments — only when it reached the session (or a usage-limit wait holds it): an
   * update that failed is decided again by a later poll, after a backoff (the session could not be started, say, and a
   * start per poll would hammer it). Never rejects.
   */
  private async postUpdateAndRecord(
    key: SessionKey,
    issueKey: string,
    prompt: SessionPromptText,
    getTargetRequestId: () => string,
    createRecords: (requestId: string) => JiraTriggerRecord[],
    onFailed?: () => void,
  ): Promise<void> {
    try {
      await this.deps.postUpdate(key, prompt, getTargetRequestId);
    } catch (error) {
      const failureCount = (this.updateRetries.get(issueKey)?.failureCount ?? 0) + 1;
      const delayMs = getJiraRetryDelayMs(this.deps.pollIntervalMs, failureCount);
      // Kept until an update of the issue reaches the session: while it is, the issue is scanned again once the wait is over.
      this.updateRetries.set(issueKey, { failureCount, retryAt: this.deps.now() + delayMs });
      onFailed?.();
      this.postingIssueKeys.delete(issueKey);
      console.warn(`[jira] ${issueKey}: an issue update for request ${getTargetRequestId()} was not posted (${error instanceof Error ? error.message : String(error)}); tried again in ${Math.round(delayMs / 1000)} s`);
      return;
    }
    this.updateRetries.delete(issueKey);
    for (const record of createRecords(getTargetRequestId())) {
      if (!this.recordOrWarn(record)) this.deps.triggerLog.remember(record);
    }
    this.postingIssueKeys.delete(issueKey);
  }

  /**
   * The hand-over requests (`trackerEvent`) the conversation has open, each with its requester named as the issue's own
   * data names them — what a mention note says goes on. A mention request itself is not one: it hands nothing over.
   */
  private getOpenHandOvers(key: SessionKey, context: JiraIssueContext): JiraOpenHandOver[] {
    return this.deps.listOpenRequests(key)
      .filter((request) => request.origin.kind === 'trackerEvent')
      .map((request) => ({ requestId: request.id, requester: findAccountInContext(context, getRequestRequester(request.origin)) }));
  }

  /**
   * `handOvers` — the ones the note named when the prompt was built — without those that have finished since. Never more:
   * the rest of the note (who holds the issue, in which status) is as of that moment, and a hand-over that opened later
   * would be «open when this comment came in» next to an issue state it does not fit.
   */
  private getStillOpenHandOvers(key: SessionKey, handOvers: readonly JiraOpenHandOver[]): JiraOpenHandOver[] {
    const openIds = new Set(this.deps.listOpenRequests(key).map((request) => request.id));
    return handOvers.filter((handOver) => openIds.has(handOver.requestId));
  }

  private rememberPromptRebuilder(key: SessionKey, requestId: string, rebuild: () => string): void {
    for (const [id, entry] of this.promptRebuilders) {
      if (!this.deps.listOpenRequests(entry.key).some((request) => request.id === id)) this.promptRebuilders.delete(id);
    }
    this.promptRebuilders.set(requestId, { key, rebuild });
    for (const id of this.promptRebuilders.keys()) {
      if (this.promptRebuilders.size <= promptRebuildersMax) break;
      this.promptRebuilders.delete(id);
    }
  }

  /**
   * @description The `StoredPromptRefresher` of this poller: a stored mention prompt (a wake-up's resend, the resume of a
   * usage-limit wait) without the hand-over requests that have finished since it was built. Any other text — or a prompt
   * of a request that is no longer open, or one built before a restart — comes back as it is.
   */
  readonly refreshPromptText = (promptText: string): string => {
    const requestId = storedPromptRequestIdPattern.exec(promptText)?.[1];
    const entry = requestId === undefined ? undefined : this.promptRebuilders.get(requestId);
    if (requestId === undefined || !entry) return promptText;
    if (!this.deps.listOpenRequests(entry.key).some((request) => request.id === requestId)) {
      this.promptRebuilders.delete(requestId);
      return promptText;
    }
    return entry.rebuild();
  };

  /**
   * Open the request of `trigger` and post it (not awaited); `extraRecords` are recorded with its trigger once the post
   * settled (the older comments a comment's request carries). Every record names the newest comment the prompt was built from.
   */
  private async openRequest(
    issue: JiraIssue,
    project: JiraProjectTrigger,
    trigger: JiraIssueTrigger,
    requester: JiraAccount | null,
    at: number,
    extraRecords: readonly JiraTriggerRecord[] = [],
  ): Promise<JiraIssueDecision> {
    const { deps } = this;
    const { trust } = deps;
    // Fetched before the request opens: a request is never left without its prompt. The whole changelog is read
    // only with a trusted group — it says who wrote each field — and once per request, never per poll.
    const context = await fetchJiraIssueContext(deps.client, issue.key, project.extraFields.map((extraField) => extraField.id), trust !== null);
    const blockTrust: JiraBlockTrust | null = trust && {
      checkIsTrusted: (account) => trust.checkIsTrusted(account),
      allowlistedProjectKeys: new Set(deps.projects.keys()),
    };
    const blocks = buildIssueBlocks(context, project.extraFields, deps.aiAccountId, blockTrust);
    deps.noteShownSummary?.(issue.key, getShownIssueSummary(context, blockTrust));
    const key = makeJiraKey(issue.key);
    const statusId = context.issue.fields.status?.id;
    const isMention = trigger.kind === 'mentioned';
    const isActingMention = isMention && deps.mentionMode === 'act';
    const newComments: JiraNewComment[] = (trigger.commentIds ?? []).map((commentId) => ({
      commentId,
      author: context.comments.find((comment) => comment.id === commentId)?.author ?? null,
    }));
    const promptInput = {
      issueKey: issue.key,
      statusName: context.issue.fields.status?.name,
      issueUrl: `${deps.siteUrl.replace(/\/+$/, '')}/browse/${issue.key}`,
      trigger,
      requester,
      assignee: context.issue.fields.assignee ?? null,
      isAssignedToYou: context.issue.fields.assignee?.accountId === deps.aiAccountId,
      isInWorkStatus: statusId !== undefined && project.triggerStatusIds.has(statusId),
      // As of building the prompt only: the text is rebuilt right before it is forwarded (`buildText`) and when a stored copy
      // is read for a resend (`refreshPromptText`), and the note's wording holds where neither happens (a restart in between).
      openHandOvers: isMention ? this.getOpenHandOvers(key, context) : [],
      triggerStatusNames: project.triggerStatusNames,
      isTextFiltered: trust !== null,
      mentionMode: deps.mentionMode,
      newComments,
    };
    // Rendered and written BEFORE the request opens: the ledger builds the prompt inside its own synchronous update.
    const fitted = await fitBlocksToPrompt({
      blocks,
      textDir: deps.getSpillDir(key),
      measure: (candidate) => buildJiraRequestPrompt({ ...promptInput, requestId: standInRequestId, ...candidate }).length,
    });
    await deps.bindConversation(key, project.folder);
    const createPrompt = (requestId: string, supersededRequestIds: readonly string[], openHandOvers = promptInput.openHandOvers): string => buildJiraRequestPrompt({
      ...promptInput,
      openHandOvers,
      requestId,
      ...fitted,
      supersededRequestIds,
    });
    // R34: the requester is part of the request's group key — a second person's trigger on the same
    // issue opens a request of its own instead of superseding the first (`requests/requestGroup.ts`).
    const request = await deps.createRequest(key, {
      // A mention hands nothing over, so its answer never hands anything back: the origin kind is what the sink reads. An
      // acting mention says so in its origin: it holds a task-agent slot like a hand-over.
      kind: isMention ? 'trackerMention' : 'trackerEvent',
      attributes: {
        issueKey: issue.key,
        triggerId: trigger.triggerId,
        [requestRequesterAttribute]: requester?.accountId ?? emptyRequester,
        ...(isActingMention ? { [actingMentionAttribute]: 'true' } : {}),
      },
    }, createPrompt);
    const supersededRequestIds = request.supersededRequestIds ?? [];
    const fullText = createPrompt(request.id, supersededRequestIds);
    if (isMention) this.rememberPromptRebuilder(key, request.id, () => createPrompt(request.id, supersededRequestIds, this.getStillOpenHandOvers(key, promptInput.openHandOvers)));
    const prompt: SessionPromptText = {
      fullText,
      // C5: built only once the post knows whether the session is fresh — right before the forward.
      buildText: ({ isFresh }) => {
        const snapshot = deps.contextLedger.getSnapshot(issue.key);
        const isWhole = isFresh || Object.keys(snapshot.sent).length === 0;
        const delta = getIssueDelta(fitted.blocks, isWhole ? {} : snapshot.sent);
        // Counted as sent only once the agent takes it in (C4): the connector commits it then.
        deps.contextLedger.recordBuild(issue.key, request.id, snapshot.generation, delta.sent);
        // The hand-over requests the mention note names are checked again here: the post may have waited behind a running turn.
        const openHandOvers = this.getStillOpenHandOvers(key, promptInput.openHandOvers);
        return isWhole
          ? createPrompt(request.id, supersededRequestIds, openHandOvers)
          : buildJiraDeltaPrompt({ ...promptInput, openHandOvers, requestId: request.id, supersededRequestIds, delta });
      },
    };
    // Not awaited: a busy session may take minutes to take the prompt, and the rest of
    // the poll must not wait for it; until the post settles, the issue is skipped.
    this.postingIssueKeys.add(issue.key);
    const newestCommentId = getNewestCommentId(context.comments);
    void this.postAndRecord(key, request.id, prompt, [
      { issueKey: issue.key, triggerId: trigger.triggerId, outcome: 'request', at, requestId: request.id, newestCommentId },
      ...extraRecords.map((record) => ({ ...record, requestId: request.id, newestCommentId })),
    ]);
    return 'request';
  }

  /**
   * @description Post the request, then record its trigger — also when the post
   * failed: the request stays open and the wake-up engine takes it from there
   * (its backstop resumes the session, or alerts when nothing can be resumed).
   * A record that cannot be written is still remembered for this process, so the
   * posted request is never posted again before a restart. Never rejects.
   */
  private async postAndRecord(key: SessionKey, requestId: string, prompt: SessionPromptText, records: readonly JiraTriggerRecord[]): Promise<void> {
    const { issueKey } = records[0];
    try {
      await this.deps.postRequest(key, requestId, prompt);
    } catch (error) {
      console.warn(`[jira] ${issueKey}: request ${requestId} not posted: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const record of records) {
      if (!this.recordOrWarn(record)) this.deps.triggerLog.remember(record);
    }
    this.postingIssueKeys.delete(issueKey);
  }

  private recordOrWarn(record: JiraTriggerRecord): boolean {
    const isRecorded = this.deps.triggerLog.record(record);
    if (!isRecorded) console.warn(`[jira] ${record.issueKey}: trigger ${record.triggerId} (${record.outcome}) could not be recorded`);
    return isRecorded;
  }

  /**
   * @description The issue's trigger and its requester, reading the changelog
   * newest pages first and only as far as needed (D13, J5b): the first page with
   * a matching entry holds the newest one — already seen, the read stops there,
   * so a long-lived issue costs one page a poll — and older pages are read only
   * while an app's trigger still needs the nearest earlier person (R24).
   */
  private async findTrigger(issue: JiraIssue, project: JiraProjectTrigger): Promise<{ seen: JiraIssueTrigger } | { trigger: JiraIssueTrigger; requester: JiraAccount | null }> {
    const { deps } = this;
    const match = { aiAccountId: deps.aiAccountId, triggerStatusIds: project.triggerStatusIds };
    const reporter = issue.fields.reporter ?? null;
    const histories: JiraChangelogHistory[] = [];
    for await (const page of this.getChangelogNewestPagesFirst(issue)) {
      histories.push(...page);
      const trigger = findNewestTrigger(histories, match);
      if (!trigger) continue;
      if (deps.triggerLog.checkIsSeen(issue.key, trigger.triggerId)) return { seen: trigger };
      const isRequesterKnown = trigger.author?.accountId === deps.aiAccountId
        || getRequester(trigger, histories, null, deps.aiAccountId) !== null;
      if (isRequesterKnown) return { trigger, requester: getRequester(trigger, histories, reporter, deps.aiAccountId) };
    }
    const trigger = getIssueTrigger(histories, match, issue.fields.creator ?? reporter);
    if (deps.triggerLog.checkIsSeen(issue.key, trigger.triggerId)) return { seen: trigger };
    return { trigger, requester: getRequester(trigger, histories, reporter, deps.aiAccountId) };
  }

  /**
   * The changelog in pages, NEWEST first: the search's own copy when complete,
   * else read backwards from its end through its endpoint (which lists oldest
   * first), never fetching an entry twice.
   */
  private async *getChangelogNewestPagesFirst(issue: JiraIssue): AsyncGenerator<JiraChangelogHistory[]> {
    const { changelog } = issue;
    if (changelog && changelog.total <= changelog.histories.length) {
      yield changelog.histories;
      return;
    }
    let total = changelog?.total;
    if (total === undefined) {
      const first = await this.deps.client.getChangelogPage(issue.key, 0, jiraChangelogPageSize);
      if (first.total <= first.values.length) {
        yield first.values;
        return;
      }
      total = first.total;
    }
    for (let end = total; end > 0;) {
      const startAt = Math.max(0, end - jiraChangelogPageSize);
      const page = await this.deps.client.getChangelogPage(issue.key, startAt, end - startAt);
      if (page.values.length === 0) return;
      yield page.values;
      end = startAt;
    }
  }
}
