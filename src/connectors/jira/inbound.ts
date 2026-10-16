import type { SessionKey } from '../../sessionKey';
import type { OpenRequestState, RequestOrigin } from '../../requests/types';
import { emptyRequester, getRequestRequester, requestRequesterAttribute } from '../../requests/requestGroup';
import { JiraAuthError, jiraChangelogPageSize, type JiraAccount, type JiraChangelogHistory, type JiraClient, type JiraComment, type JiraIssue } from './client';
import { getMentionedAccountIds } from './adf';
import { getJiraIssueProjectKey, makeJiraKey } from './sessionKeyCodec';
import { createMentionTrigger, findNewestTrigger, getIssueTrigger, getRequester, mentionTriggerIdPrefix, type JiraIssueTrigger } from './trigger';
import type { JiraTriggerLog, JiraTriggerRecord } from './triggerLog';
import { buildIssueBlocks, checkIsCommentTrusted, type JiraBlockTrust, type JiraExtraField } from './issueBlocks';
import { fetchJiraIssueContext } from './issueContext';
import { buildJiraDeltaPrompt, buildJiraRequestPrompt } from './prompt';
import { getIssueDelta } from './issueDelta';
import type { JiraContextLedger } from './contextLedger';
import type { SessionPromptText } from '../../postToSession';
import { fitBlocksToPrompt, standInRequestId } from './promptSpill';
import { JiraTrustedGroupGoneError, type JiraTrust } from './trustedGroup';

/**
 * @description The Jira connector's inbound side (plan J5, D12/D13/D15/D21): a
 * poll loop, one search per cycle, and per issue the decision chain
 *
 *   allowlist → still matching → no post in flight → trigger (newest changelog pages first) → seen before → self-authored
 *     → hand-over backed by the trusted group (only with `trustedGroup`) → run budget → fetch the issue → bind
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
 * issue at once. A Jira event never cancels an armed usage-limit wait — the
 * ledger's create hook tells the new request about it (core S5).
 *
 * With mention wakes on (a trusted group is set), the same poll also finds a comment that @-mentions the AI
 * account — on an issue that is NOT handed to it — and opens a request that answers only:
 *
 *   issue returned and its `updated` moved since this process last read it → its newest comments, those
 *   created or edited within the mention window that mention the AI account (the ADF mention node's id) and
 *   whose trigger id `mention:<commentId>` is not seen →
 *     author and last editor trusted → not covered by an open hand-over request of the same person
 *     → run budget → open a request (no hand-back; the answer sink knows by the origin kind)
 *
 * One decision per comment, recorded in the same trigger log: an edit of a decided comment wakes nothing.
 */

export const jiraSearchPageSize = 50;
/** The longest wait between two attempts while Jira keeps failing (R22). */
export const jiraRetryBackoffCapMs = 15 * 60 * 1000;
/** The shortest mention window: a mention this young is found by a poll, whatever the poll interval (D12). */
export const jiraMentionWindowMinMs = 5 * 60 * 1000;
/** How many of an issue's newest comments a mention scan reads — more than a window of activity holds. */
export const jiraMentionScanCommentCount = 100;
const msPerMinute = 60 * 1000;
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
 *  - `selfAuthored`, `parked`, `untrusted`, `covered`, `request` — the recorded outcomes; `untrusted` — the
 *    hand-over was made by someone the trusted group does not back (a notice and the hand-back, no request; for
 *    a mention: silent, nothing posted); `covered` — a mention by the requester of the issue's open hand-over
 *    request, which that run already carries (no request).
 *  - `failed`      — an error stopped it; the next poll tries again.
 */
export type JiraIssueDecision =
  | 'notAllowed' | 'notMatching' | 'posting' | 'seen' | 'selfAuthored' | 'parked' | 'untrusted' | 'covered' | 'request' | 'failed';

/** Decisions that change nothing, left out of the poll's log line. */
const quietDecisions: ReadonlySet<JiraIssueDecision> = new Set(['notMatching', 'posting', 'seen']);

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
  /** The open requests of an issue's conversation — a hand-over's requester who mentions the AI is already served (D9). */
  listOpenRequests: (key: SessionKey) => ReadonlyArray<Pick<OpenRequestState, 'origin'>>;
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
  /** What each issue's conversation was already told (C4). */
  contextLedger: Pick<JiraContextLedger, 'getSnapshot' | 'recordBuild'>;
  /** Over the run budget: the park notice and the hand-back (the answer side, J6). */
  parkIssue: (issueKey: string, requester: JiraAccount | null) => Promise<void>;
  /** A hand-over the trusted group `groupName` does not back: the fixed notice and the hand-back (the answer side). */
  refuseUntrusted: (issueKey: string, requester: JiraAccount | null, groupName: string) => Promise<void>;
  /** A mention over the run budget: the park notice, no hand-back (the answer side). */
  parkMention: (issueKey: string) => Promise<void>;
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

export class JiraInbound {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  /** Polls in a row that failed — the backoff's exponent (R22). */
  private failureCount = 0;
  /** Issues whose last request's post has not settled yet. */
  private readonly postingIssueKeys = new Set<string>();
  /** Per issue, its `updated` as of the last mention scan that decided every comment — in memory only: a restart scans once more. */
  private readonly lastUpdatedByIssue = new Map<string, string>();

  constructor(private readonly deps: JiraInboundDeps) {}

  /** @description Poll now, then every `pollIntervalMs` after each poll ENDS (never two at once). */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.scheduleNext(0);
  }

  stop(): void {
    this.isRunning = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private scheduleNext(delayMs: number): void {
    // Not unref'd on purpose: in a Jira-only instance this timer is what keeps the process alive (D9).
    this.timer = setTimeout(() => {
      void this.runScheduledPoll();
    }, delayMs);
  }

  private async runScheduledPoll(): Promise<void> {
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
    }
    if (this.isRunning) this.scheduleNext(getJiraRetryDelayMs(this.deps.pollIntervalMs, this.failureCount));
  }

  /**
   * @description One poll: every matching issue, each decided once. A {@link JiraAuthError} and a
   * {@link JiraTrustedGroupGoneError} propagate, and so does a failed membership read: nothing is decided on a
   * trusted-group list older than its age.
   */
  async pollOnce(): Promise<Map<string, JiraIssueDecision>> {
    const decisions = new Map<string, JiraIssueDecision>();
    const mentionWindowMs = this.getMentionWindowMs();
    const jql = buildJiraTriggerJql(this.deps.projects, mentionWindowMs);
    const returnedIssueKeys = new Set<string>();
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
        const decision = await this.getDecisionSafely(issue);
        decisions.set(issue.key, decision);
        if (mentionWindowMs !== null && decision !== 'notAllowed') {
          for (const [decisionKey, mentionDecision] of await this.getMentionDecisionsSafely(issue)) decisions.set(decisionKey, mentionDecision);
        }
      }
      nextPageToken = page.isLast ? undefined : (page.nextPageToken ?? undefined);
    } while (nextPageToken);
    // An issue that left the results is read from scratch if it comes back; the seen-log keeps that from waking twice.
    for (const issueKey of this.lastUpdatedByIssue.keys()) {
      if (!returnedIssueKeys.has(issueKey)) this.lastUpdatedByIssue.delete(issueKey);
    }
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

  private getDecisionSafely(issue: JiraIssue): Promise<JiraIssueDecision> {
    return this.runOrWarn(issue.key, '', () => this.getDecision(issue), 'failed');
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
    if (found === 'seen') return 'seen';
    const { trigger, requester } = found;
    const at = deps.now();
    if (trigger.author?.accountId === deps.aiAccountId) {
      this.recordOrWarn({ issueKey: issue.key, triggerId: trigger.triggerId, outcome: 'selfAuthored', at });
      return 'selfAuthored';
    }
    // The HAND-OVER decides: the account that made the change — an app or automation is trusted, so what it hands
    // over starts the agent whoever the requester turns out to be. A change Jira names no one for falls back to the
    // requester, and no account at all is untrusted (fail closed).
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
    return this.openRequest(issue, project, trigger, requester, at);
  }

  private getMentionDecisionsSafely(issue: JiraIssue): Promise<Map<string, JiraIssueDecision>> {
    const failed = new Map<string, JiraIssueDecision>([[`${issue.key}${mentionDecisionKeySeparator}mention`, 'failed']]);
    return this.runOrWarn(issue.key, 'mention scan: ', () => this.getMentionDecisions(issue), failed);
  }

  /**
   * @description The comments of `issue` that mention the AI account and were not decided yet, each decided once
   * (oldest first). Skipped altogether while the issue's `updated` is what the last complete scan saw, and while
   * a request of the issue is being posted (the next poll takes the rest: one request is posted at a time).
   */
  private async getMentionDecisions(issue: JiraIssue): Promise<Map<string, JiraIssueDecision>> {
    const { deps } = this;
    const decisions = new Map<string, JiraIssueDecision>();
    const project = this.getAllowlistedProject(issue);
    const { trust } = deps;
    if (!project || !trust) return decisions;
    const { updated } = issue.fields;
    if (updated !== undefined && this.lastUpdatedByIssue.get(issue.key) === updated) return decisions;
    if (this.postingIssueKeys.has(issue.key)) return decisions;
    const comments = await deps.client.getRecentComments(issue.key, jiraMentionScanCommentCount);
    // The whole window every time, not "since the last scan": a comment that became visible a moment after a scan
    // is still inside it, and the seen-log makes the overlap harmless.
    const windowStartMs = deps.now() - getJiraMentionWindowMs(deps.pollIntervalMs);
    const undecidedMentions = comments
      .filter((comment) => comment.author?.accountId !== deps.aiAccountId
        && Math.max(Date.parse(comment.created), Date.parse(comment.updated ?? comment.created)) >= windowStartMs
        && getMentionedAccountIds(comment.body).includes(deps.aiAccountId)
        && !deps.triggerLog.checkIsSeen(issue.key, `${mentionTriggerIdPrefix}${comment.id}`))
      .sort((left, right) => Date.parse(left.created) - Date.parse(right.created));
    let isEveryMentionDecided = true;
    for (const comment of undecidedMentions) {
      if (this.postingIssueKeys.has(issue.key)) {
        isEveryMentionDecided = false;
        break;
      }
      const decision = await this.getMentionDecisionSafely(issue, project, comment, trust);
      decisions.set(`${issue.key}${mentionDecisionKeySeparator}${mentionTriggerIdPrefix}${comment.id}`, decision);
      if (decision === 'failed') isEveryMentionDecided = false;
    }
    if (isEveryMentionDecided && updated !== undefined) this.lastUpdatedByIssue.set(issue.key, updated);
    return decisions;
  }

  /** One comment failing (the issue could not be read for its prompt, say) leaves the others' decisions standing; the next poll retries it. */
  private getMentionDecisionSafely(issue: JiraIssue, project: JiraProjectTrigger, comment: JiraComment, trust: JiraTrust): Promise<JiraIssueDecision> {
    return this.runOrWarn(issue.key, `mention in comment ${comment.id}: `, () => this.getMentionDecision(issue, project, comment, trust), 'failed');
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
    // D9: the requester of an open hand-over request already has the agent on this issue; their comment reaches that
    // run (a delta, or the news). A request of their own would supersede it and strip its hand-back. A hand-over
    // request with NO requester is superseded by ANY next request of the conversation (`requestLedger.ts`), so while
    // one is open every mention is covered by it.
    const requesterAccountId = comment.author?.accountId;
    const isCovered = deps.listOpenRequests(makeJiraKey(issue.key)).some((request) => {
      const openRequester = getRequestRequester(request.origin);
      return request.origin.kind === 'trackerEvent' && (openRequester === requesterAccountId || openRequester === emptyRequester);
    });
    if (isCovered) return record('covered') ? 'covered' : 'failed';
    if (deps.triggerLog.getRequestCountLastDay(issue.key, at) >= deps.runBudgetPer24h) {
      // D10: the notice is posted at most once per issue per rolling 24 h; later over-budget mentions are recorded silently.
      const isNoticeDue = !deps.triggerLog.checkIsMentionParkNoticePostedLastDay(issue.key, at);
      if (!record('parked', { isNoticePosted: isNoticeDue })) return 'failed';
      if (isNoticeDue) await deps.parkMention(issue.key);
      return 'parked';
    }
    return this.openRequest(issue, project, trigger, comment.author ?? null, at);
  }

  private async openRequest(
    issue: JiraIssue,
    project: JiraProjectTrigger,
    trigger: JiraIssueTrigger,
    requester: JiraAccount | null,
    at: number,
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
    const key = makeJiraKey(issue.key);
    const promptInput = {
      issueKey: issue.key,
      statusName: context.issue.fields.status?.name,
      issueUrl: `${deps.siteUrl.replace(/\/+$/, '')}/browse/${issue.key}`,
      trigger,
      requester,
      assignee: context.issue.fields.assignee ?? null,
      isTextFiltered: trust !== null,
    };
    // Rendered and written BEFORE the request opens: the ledger builds the prompt inside its own synchronous update.
    const fitted = await fitBlocksToPrompt({
      blocks,
      textDir: deps.getSpillDir(key),
      measure: (candidate) => buildJiraRequestPrompt({ ...promptInput, requestId: standInRequestId, ...candidate }).length,
    });
    await deps.bindConversation(key, project.folder);
    const createPrompt = (requestId: string, supersededRequestIds: readonly string[]): string => buildJiraRequestPrompt({
      ...promptInput,
      requestId,
      ...fitted,
      supersededRequestIds,
    });
    // R34: the requester is part of the request's group key — a second person's trigger on the same
    // issue opens a request of its own instead of superseding the first (`requests/requestGroup.ts`).
    const request = await deps.createRequest(key, {
      // A mention hands nothing over, so its answer never hands anything back: the origin kind is what the sink reads.
      kind: trigger.kind === 'mentioned' ? 'trackerMention' : 'trackerEvent',
      attributes: { issueKey: issue.key, triggerId: trigger.triggerId, [requestRequesterAttribute]: requester?.accountId ?? emptyRequester },
    }, createPrompt);
    const supersededRequestIds = request.supersededRequestIds ?? [];
    const fullText = createPrompt(request.id, supersededRequestIds);
    const prompt: SessionPromptText = {
      fullText,
      // C5: built only once the post knows whether the session is fresh — right before the forward.
      buildText: ({ isFresh }) => {
        const snapshot = deps.contextLedger.getSnapshot(issue.key);
        const isWhole = isFresh || Object.keys(snapshot.sent).length === 0;
        const delta = getIssueDelta(fitted.blocks, isWhole ? {} : snapshot.sent);
        // Counted as sent only once the agent takes it in (C4): the connector commits it then.
        deps.contextLedger.recordBuild(issue.key, request.id, snapshot.generation, delta.sent);
        return isWhole ? fullText : buildJiraDeltaPrompt({ ...promptInput, requestId: request.id, supersededRequestIds, delta });
      },
    };
    // Not awaited: a busy session may take minutes to take the prompt, and the rest of
    // the poll must not wait for it; until the post settles, the issue is skipped.
    this.postingIssueKeys.add(issue.key);
    void this.postAndRecord(key, request.id, prompt, { issueKey: issue.key, triggerId: trigger.triggerId, outcome: 'request', at, requestId: request.id });
    return 'request';
  }

  /**
   * @description Post the request, then record its trigger — also when the post
   * failed: the request stays open and the wake-up engine takes it from there
   * (its backstop resumes the session, or alerts when nothing can be resumed).
   * A record that cannot be written is still remembered for this process, so the
   * posted request is never posted again before a restart. Never rejects.
   */
  private async postAndRecord(key: SessionKey, requestId: string, prompt: SessionPromptText, record: JiraTriggerRecord): Promise<void> {
    try {
      await this.deps.postRequest(key, requestId, prompt);
    } catch (error) {
      console.warn(`[jira] ${record.issueKey}: request ${requestId} not posted: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!this.recordOrWarn(record)) this.deps.triggerLog.remember(record);
    this.postingIssueKeys.delete(record.issueKey);
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
  private async findTrigger(issue: JiraIssue, project: JiraProjectTrigger): Promise<'seen' | { trigger: JiraIssueTrigger; requester: JiraAccount | null }> {
    const { deps } = this;
    const match = { aiAccountId: deps.aiAccountId, triggerStatusIds: project.triggerStatusIds };
    const reporter = issue.fields.reporter ?? null;
    const histories: JiraChangelogHistory[] = [];
    for await (const page of this.getChangelogNewestPagesFirst(issue)) {
      histories.push(...page);
      const trigger = findNewestTrigger(histories, match);
      if (!trigger) continue;
      if (deps.triggerLog.checkIsSeen(issue.key, trigger.triggerId)) return 'seen';
      const isRequesterKnown = trigger.author?.accountId === deps.aiAccountId
        || getRequester(trigger, histories, null, deps.aiAccountId) !== null;
      if (isRequesterKnown) return { trigger, requester: getRequester(trigger, histories, reporter, deps.aiAccountId) };
    }
    const trigger = getIssueTrigger(histories, match, issue.fields.creator ?? reporter);
    if (deps.triggerLog.checkIsSeen(issue.key, trigger.triggerId)) return 'seen';
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
