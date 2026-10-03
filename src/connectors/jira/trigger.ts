import type { JiraAccount, JiraChangelogHistory } from './client';

/**
 * @description Which change made an issue a request (Jira connector plan J5,
 * D11–D12): the newest changelog entry that set the assignee to the AI account
 * or moved the status into the trigger set. An issue created already matching
 * has no such entry; its trigger is the creation itself. And who asked (J5b,
 * R24): the person behind that change, or — when an app or automation made it —
 * the nearest person before it, else the reporter. Pure: the poller hands in the
 * changelog entries it read, newest pages first.
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

/**
 * @description The newest entry among `histories` that matches, or `null`. When
 * `histories` are the NEWEST entries of the changelog (any number of its last
 * pages), a match among them is the newest of the whole changelog — what lets
 * the poller stop reading at the first page that holds one.
 */
export function findNewestTrigger(histories: readonly JiraChangelogHistory[], match: JiraTriggerMatch): JiraIssueTrigger | null {
  for (const history of [...histories].sort(compareHistoriesNewestFirst)) {
    const kind = getHistoryKind(history, match);
    if (kind) return { triggerId: history.id, kind, author: history.author ?? null };
  }
  return null;
}

/** The trigger over a WHOLE changelog: its newest matching entry, else the creation. */
export function getIssueTrigger(
  histories: readonly JiraChangelogHistory[],
  match: JiraTriggerMatch,
  creator: JiraAccount | null,
): JiraIssueTrigger {
  return findNewestTrigger(histories, match) ?? { triggerId: createdTriggerId, kind: 'created', author: creator };
}

/** A person, as opposed to an app or automation; a missing type is read as a person. */
export function checkIsPersonAccount(account: JiraAccount): boolean {
  return account.accountType === undefined || account.accountType === personAccountType;
}

/** A person who may be handed an issue back: not an app, not the AI account itself. */
function checkIsRequesterCandidate(account: JiraAccount | null | undefined, aiAccountId: string): account is JiraAccount {
  return account !== null && account !== undefined && checkIsPersonAccount(account) && account.accountId !== aiAccountId;
}

/**
 * @description R24: the nearest person BEFORE the trigger in `histories` — the
 * author of the newest older entry who is a person other than the AI account —
 * or `null` when none of these entries has one (the caller may read older pages).
 * Nothing comes before a creation trigger.
 */
export function findEarlierPerson(
  histories: readonly JiraChangelogHistory[],
  trigger: JiraIssueTrigger,
  aiAccountId: string,
): JiraAccount | null {
  if (trigger.kind === 'created') return null;
  const newestFirst = [...histories].sort(compareHistoriesNewestFirst);
  const triggerIndex = newestFirst.findIndex((history) => history.id === trigger.triggerId);
  if (triggerIndex < 0) return null;
  return newestFirst.slice(triggerIndex + 1).find((history) => checkIsRequesterCandidate(history.author, aiAccountId))?.author ?? null;
}

/**
 * @description The requester ("sender") an answer goes back to: the trigger's
 * author when a person made the change; when an app or automation made it (or
 * Jira names no one), the nearest earlier person in the changelog (R24), else the
 * issue's reporter — an app cannot read a comment or take the issue back.
 */
export function getRequester(
  trigger: JiraIssueTrigger,
  histories: readonly JiraChangelogHistory[],
  reporter: JiraAccount | null,
  aiAccountId: string,
): JiraAccount | null {
  if (checkIsRequesterCandidate(trigger.author, aiAccountId)) return trigger.author;
  return findEarlierPerson(histories, trigger, aiAccountId) ?? reporter;
}
