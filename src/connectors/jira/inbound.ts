import type { SessionKey } from '../../sessionKey';
import type { RequestOrigin } from '../../requests/types';
import { JiraAuthError, type JiraAccount, type JiraChangelogHistory, type JiraClient, type JiraIssue } from './client';
import { makeJiraKey } from './sessionKeyCodec';
import { getIssueTrigger, getRequester, type JiraIssueTrigger } from './trigger';
import type { JiraTriggerLog } from './triggerLog';
import { buildJiraRequestPrompt, jiraPromptIssueFields } from './prompt';

/**
 * @description The Jira connector's inbound side (plan J5, D12/D13/D15/D21): a
 * poll loop, one search per cycle, and per issue the decision chain
 *
 *   allowlist → still matching → trigger → seen before → self-authored → run budget
 *     → fetch the issue → bind → open a request → RECORD the trigger → post (not awaited)
 *
 * The trigger is recorded once the request is open and BEFORE anything reaches
 * the session: a restart can never post the same trigger twice. A crash between
 * opening and recording leaves an open request that was never posted; the next
 * poll opens a fresh one, which supersedes it. A Jira event never cancels an
 * armed usage-limit wait — the ledger's create hook tells the new request about
 * it (core S5).
 */

export const jiraSearchPageSize = 50;
/** Enough of each issue to decide; the prompt's fields are fetched only for a new request. */
export const jiraSearchFields = ['status', 'assignee', 'reporter', 'creator'];

/** @name JiraProjectTrigger @description One allowlisted project as the poller uses it. */
export interface JiraProjectTrigger {
  folder: string;
  triggerStatusIds: ReadonlySet<string>;
}

/**
 * @name JiraIssueDecision
 * @description What the poller did with one returned issue.
 *  - `notAllowed`  — its project is not in the allowlist (dropped).
 *  - `notMatching` — no longer assigned to the AI account, or not in a trigger status.
 *  - `seen`        — its trigger was decided before.
 *  - `selfAuthored`, `parked`, `request` — the recorded outcomes.
 *  - `failed`      — an error stopped it; the next poll tries again.
 */
export type JiraIssueDecision = 'notAllowed' | 'notMatching' | 'seen' | 'selfAuthored' | 'parked' | 'request' | 'failed';

export interface JiraInboundDeps {
  client: Pick<JiraClient, 'searchIssues' | 'getChangelogPage' | 'getIssue'>;
  aiAccountId: string;
  /** `https://<site>` (or the test-only loopback base) — issue links are `<siteUrl>/browse/<KEY>`. */
  siteUrl: string;
  projects: ReadonlyMap<string, JiraProjectTrigger>;
  runBudgetPer24h: number;
  pollIntervalMs: number;
  triggerLog: JiraTriggerLog;
  now: () => number;
  /** Bind the issue's conversation to its project's folder. */
  bindConversation: (key: SessionKey, folder: string) => Promise<void>;
  createRequest: (key: SessionKey, origin: RequestOrigin) => Promise<{ id: string }>;
  /** Close a request that was opened but whose trigger could not be recorded. */
  cancelRequest: (requestId: string) => Promise<void>;
  /** Post the request's prompt to the issue's session (and start watching its turn). */
  postRequest: (key: SessionKey, requestId: string, prompt: string) => Promise<void>;
  /** Over the run budget: the park notice and the hand-back (the answer side, J6). */
  parkIssue: (issueKey: string, requester: JiraAccount | null) => Promise<void>;
}

/** @description The poll's JQL (D13): the allowlist, assigned to the AI account, in a trigger status. */
export function buildJiraTriggerJql(projects: ReadonlyMap<string, JiraProjectTrigger>): string {
  const projectKeys = [...projects.keys()].map((projectKey) => `"${projectKey}"`).join(', ');
  const statusIds = [...new Set([...projects.values()].flatMap((project) => [...project.triggerStatusIds]))]
    .map((statusId) => `"${statusId}"`)
    .join(', ');
  return `project in (${projectKeys}) AND assignee = currentUser() AND status in (${statusIds}) ORDER BY created ASC`;
}

/** The issue's project from its key, or `null` for a key that is not a Jira issue key. */
function getIssueProjectKey(issueKey: string): string | null {
  try {
    return makeJiraKey(issueKey).space;
  } catch {
    return null;
  }
}

export class JiraInbound {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

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
    } catch (error) {
      if (error instanceof JiraAuthError) {
        // D14: wrong or revoked credentials do not fix themselves; one loud line, then stop.
        console.error(`[jira] polling STOPPED: ${error.message}`);
        this.stop();
        return;
      }
      console.warn(`[jira] poll failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (this.isRunning) this.scheduleNext(this.deps.pollIntervalMs);
  }

  /** @description One poll: every matching issue, each decided once. A {@link JiraAuthError} propagates. */
  async pollOnce(): Promise<Map<string, JiraIssueDecision>> {
    const decisions = new Map<string, JiraIssueDecision>();
    const jql = buildJiraTriggerJql(this.deps.projects);
    let nextPageToken: string | undefined;
    do {
      const page = await this.deps.client.searchIssues({
        jql,
        fields: jiraSearchFields,
        isChangelogExpanded: true,
        maxResults: jiraSearchPageSize,
        nextPageToken,
      });
      for (const issue of page.issues) decisions.set(issue.key, await this.getDecisionSafely(issue));
      nextPageToken = page.isLast ? undefined : (page.nextPageToken ?? undefined);
    } while (nextPageToken);
    const acted = [...decisions].filter(([, decision]) => decision !== 'seen' && decision !== 'notMatching');
    if (acted.length > 0) console.log(`[jira] poll: ${acted.map(([issueKey, decision]) => `${issueKey} ${decision}`).join(', ')}`);
    return decisions;
  }

  private async getDecisionSafely(issue: JiraIssue): Promise<JiraIssueDecision> {
    try {
      return await this.getDecision(issue);
    } catch (error) {
      if (error instanceof JiraAuthError) throw error;
      console.warn(`[jira] ${issue.key}: ${error instanceof Error ? error.message : String(error)}`);
      return 'failed';
    }
  }

  private async getDecision(issue: JiraIssue): Promise<JiraIssueDecision> {
    const { deps } = this;
    const projectKey = getIssueProjectKey(issue.key);
    const project = projectKey === null ? undefined : deps.projects.get(projectKey);
    // D13: the JQL names only the allowlist, but every returned issue is checked again.
    if (!project) return 'notAllowed';
    const statusId = issue.fields.status?.id;
    if (issue.fields.assignee?.accountId !== deps.aiAccountId || statusId === undefined || !project.triggerStatusIds.has(statusId)) {
      return 'notMatching';
    }
    const trigger = getIssueTrigger(
      await this.getFullChangelog(issue),
      { aiAccountId: deps.aiAccountId, triggerStatusIds: project.triggerStatusIds },
      issue.fields.creator ?? issue.fields.reporter ?? null,
    );
    if (deps.triggerLog.checkIsSeen(issue.key, trigger.triggerId)) return 'seen';
    const at = deps.now();
    if (trigger.author?.accountId === deps.aiAccountId) {
      this.recordOrWarn({ issueKey: issue.key, triggerId: trigger.triggerId, outcome: 'selfAuthored', at });
      return 'selfAuthored';
    }
    const requester = getRequester(trigger, issue.fields.reporter ?? null);
    if (deps.triggerLog.getRequestCountLastDay(issue.key, at) >= deps.runBudgetPer24h) {
      // Recorded first: a failed notice is not repeated on every poll (at most one per trigger).
      if (!this.recordOrWarn({ issueKey: issue.key, triggerId: trigger.triggerId, outcome: 'parked', at })) return 'failed';
      await deps.parkIssue(issue.key, requester);
      return 'parked';
    }
    return this.openRequest(issue, project, trigger, requester, at);
  }

  private async openRequest(
    issue: JiraIssue,
    project: JiraProjectTrigger,
    trigger: JiraIssueTrigger,
    requester: JiraAccount | null,
    at: number,
  ): Promise<JiraIssueDecision> {
    const { deps } = this;
    // Fetched before the request opens: a request is never left without its prompt.
    const details = await deps.client.getIssue(issue.key, jiraPromptIssueFields);
    const key = makeJiraKey(issue.key);
    await deps.bindConversation(key, project.folder);
    const request = await deps.createRequest(key, {
      kind: 'trackerEvent',
      attributes: { issueKey: issue.key, triggerId: trigger.triggerId, requesterAccountId: requester?.accountId ?? '' },
    });
    if (!this.recordOrWarn({ issueKey: issue.key, triggerId: trigger.triggerId, outcome: 'request', at, requestId: request.id })) {
      // Unrecorded, it would be posted again after a restart: withdraw it, the next poll retries.
      await deps.cancelRequest(request.id);
      return 'failed';
    }
    const prompt = buildJiraRequestPrompt({
      requestId: request.id,
      issue: details,
      issueUrl: `${deps.siteUrl.replace(/\/+$/, '')}/browse/${issue.key}`,
      trigger,
      requester,
    });
    // Not awaited: a busy session may take minutes to take the prompt, and the rest of
    // the poll must not wait for it — the recorded trigger already keeps it from repeating.
    deps.postRequest(key, request.id, prompt).catch((error: unknown) => {
      // The request stays open: the wake-up engine's backstop resumes the session and reminds it.
      console.warn(`[jira] ${issue.key}: request ${request.id} not posted: ${error instanceof Error ? error.message : String(error)}`);
    });
    return 'request';
  }

  private recordOrWarn(record: Parameters<JiraTriggerLog['record']>[0]): boolean {
    const isRecorded = this.deps.triggerLog.record(record);
    if (!isRecorded) console.warn(`[jira] ${record.issueKey}: trigger ${record.triggerId} (${record.outcome}) could not be recorded`);
    return isRecorded;
  }

  /** D13: a changelog the search cut short (or left out) is read whole from its own endpoint. */
  private async getFullChangelog(issue: JiraIssue): Promise<JiraChangelogHistory[]> {
    const { changelog } = issue;
    if (changelog && changelog.total <= changelog.histories.length) return changelog.histories;
    const histories: JiraChangelogHistory[] = [];
    for (;;) {
      const page = await this.deps.client.getChangelogPage(issue.key, histories.length);
      histories.push(...page.values);
      if (page.isLast || page.values.length === 0 || histories.length >= page.total) return histories;
    }
  }
}
