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
/** Jira's `accountType` of a person. */
const personAccountType = 'atlassian';
/** Jira's `accountType` of an app or automation. */
const appAccountType = 'app';

export type JiraTriggerKind = 'assigned' | 'statusChanged' | 'created' | 'mentioned' | 'commented';

/** The trigger id of a comment that mentioned the AI account is this prefix and the comment's id (a changelog id is numeric: no clash). */
export const mentionTriggerIdPrefix = 'mention:';
/** The trigger id of a comment on an issue handed to the AI account (its comment scan) is this prefix and the comment's id. */
export const commentTriggerIdPrefix = 'comment:';
/**
 * Marks a mention held back from its issue update — the cap on updates paused it, or its post failed — and not decided yet:
 * this prefix and the comment's id. The mention scan keeps it, outside the mention window too, until it is delivered.
 */
export const heldMentionTriggerIdPrefix = 'held-mention:';
/** The trigger id of a pause of an issue's updates (the cap): this prefix and the pause's end (epoch ms). */
export const updatesPausedTriggerIdPrefix = 'updates-paused:';
/**
 * The request origin's attribute naming the comment thread its answers go into — the id of the thread's top-level
 * comment — set when the comment that opened the request is a reply in a thread. Absent: the answers are top-level.
 */
export const jiraReplyThreadAttribute = 'threadCommentId';

/**
 * @name JiraIssueTrigger
 * @description `author` is `null` when Jira names no one (an automation without an actor); for a mention or a comment it
 * is the comment's author. `commentId` is set for a `mentioned` and a `commented` trigger only (for a `commented` one, the
 * newest of its `commentIds`, oldest first: one request carries every new comment a poll found). `parentId` is set when
 * that comment is a reply: the id of its thread's top-level comment, where the answers and notices of the trigger go.
 */
export interface JiraIssueTrigger {
  /** The changelog history id, {@link createdTriggerId}, or {@link mentionTriggerIdPrefix} / {@link commentTriggerIdPrefix} and a comment id. */
  triggerId: string;
  kind: JiraTriggerKind;
  author: JiraAccount | null;
  commentId?: string;
  commentIds?: readonly string[];
  parentId?: string;
}

/** @description The trigger of the comment `commentId`, written by `author`, that mentions the AI account; `parentId` when it is a reply. */
export function createMentionTrigger(commentId: string, author: JiraAccount | null, parentId: string | null = null): JiraIssueTrigger {
  return { triggerId: `${mentionTriggerIdPrefix}${commentId}`, kind: 'mentioned', author, commentId, ...(parentId === null ? {} : { parentId }) };
}

/**
 * @description The trigger of the new comments `commentIds` (oldest first) on an issue handed to the AI account while no
 * hand-over request of it is open: the newest one names it, and its author (`author`) is the requester; `parentId` when
 * that newest comment is a reply.
 */
export function createCommentTrigger(commentIds: readonly string[], author: JiraAccount | null, parentId: string | null = null): JiraIssueTrigger {
  const commentId = commentIds[commentIds.length - 1];
  return { triggerId: `${commentTriggerIdPrefix}${commentId}`, kind: 'commented', author, commentId, commentIds, ...(parentId === null ? {} : { parentId }) };
}

/** @description A hand-over's trigger (a changelog entry, a creation) — not a comment's or a mention's. */
export function checkIsHandOverTriggerId(triggerId: string): boolean {
  return !triggerId.startsWith(mentionTriggerIdPrefix) && !triggerId.startsWith(commentTriggerIdPrefix);
}

/**
 * @description Order two Jira comment ids: they are numbers that grow with every comment of the site, so a later comment
 * has the greater id. Compared as digit strings (any length); an id that is not one falls back to a text compare.
 */
export function compareJiraCommentIds(left: string, right: string): number {
  const isNumeric = /^\d+$/.test(left) && /^\d+$/.test(right);
  if (isNumeric && left.length !== right.length) return left.length - right.length;
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface JiraTriggerMatch {
  aiAccountId: string;
  triggerStatusIds: ReadonlySet<string>;
}

/** A changelog item names its field by `fieldId` (stable) or, on older entries, only by `field`. */
export function getItemField(item: JiraChangelogHistory['items'][number]): string {
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

/** An app or automation (a Jira rule, an integration), as opposed to a person or a service-desk customer. */
export function checkIsAppAccount(account: JiraAccount): boolean {
  return account.accountType === appAccountType;
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
