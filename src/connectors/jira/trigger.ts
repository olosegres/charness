import type { JiraAccount, JiraChangelogHistory } from './client';

/**
 * @description Which change made an issue a request (Jira connector plan J5,
 * D11–D12): the newest changelog entry that set the assignee to the AI account
 * or moved the status into the trigger set. An issue created already matching
 * has no such entry; its trigger is the creation itself. Pure: the poller
 * fetched the whole changelog first.
 */

/** The trigger id of an issue that matched from its creation. */
export const createdTriggerId = 'created';
/** Jira's `accountType` of a person (an app or automation is `app`). */
const personAccountType = 'atlassian';

export type JiraTriggerKind = 'assigned' | 'statusChanged' | 'created';

/** @name JiraIssueTrigger @description `author` is `null` when Jira names no one (an automation without an actor). */
export interface JiraIssueTrigger {
  /** The changelog history id, or {@link createdTriggerId}. */
  triggerId: string;
  kind: JiraTriggerKind;
  author: JiraAccount | null;
}

export interface JiraTriggerMatch {
  aiAccountId: string;
  triggerStatusIds: ReadonlySet<string>;
}

/** A changelog item names its field by `fieldId` (stable) or, on older entries, only by `field`. */
function getItemField(item: JiraChangelogHistory['items'][number]): string {
  return item.fieldId ?? item.field;
}

function getHistoryKind(history: JiraChangelogHistory, match: JiraTriggerMatch): JiraTriggerKind | null {
  for (const item of history.items) {
    const field = getItemField(item);
    if (field === 'assignee' && item.to === match.aiAccountId) return 'assigned';
    if (field === 'status' && item.to !== null && item.to !== undefined && match.triggerStatusIds.has(item.to)) return 'statusChanged';
  }
  return null;
}

/** Newest first: by creation time, then by id (Jira's ids grow). */
function compareHistoriesNewestFirst(left: JiraChangelogHistory, right: JiraChangelogHistory): number {
  const byTime = Date.parse(right.created) - Date.parse(left.created);
  return byTime !== 0 && Number.isFinite(byTime) ? byTime : Number(right.id) - Number(left.id);
}

export function getIssueTrigger(
  histories: readonly JiraChangelogHistory[],
  match: JiraTriggerMatch,
  creator: JiraAccount | null,
): JiraIssueTrigger {
  for (const history of [...histories].sort(compareHistoriesNewestFirst)) {
    const kind = getHistoryKind(history, match);
    if (kind) return { triggerId: history.id, kind, author: history.author ?? null };
  }
  return { triggerId: createdTriggerId, kind: 'created', author: creator };
}

/** A person, as opposed to an app or automation; a missing type is read as a person. */
export function checkIsPersonAccount(account: JiraAccount): boolean {
  return account.accountType === undefined || account.accountType === personAccountType;
}

/**
 * @description The requester ("sender") an answer goes back to: the trigger's
 * author when a person made the change, else the issue's reporter (an app or an
 * automation rule cannot read a comment or take the issue back).
 */
export function getRequester(trigger: JiraIssueTrigger, reporter: JiraAccount | null): JiraAccount | null {
  return trigger.author && checkIsPersonAccount(trigger.author) ? trigger.author : reporter;
}
