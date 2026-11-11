/**
 * @description The pure half of `/access` — who may talk to the agent in a topic (`topicTalkers.ts`): the command's text forms,
 * the decision whether a person may be added and why not, the `tlk_*` button codec, and the screens (text + button plan). The
 * command module (`connectors/telegram/commands/topicAccess.ts`) draws them and applies what a tap decides.
 *
 * Everything is ONE message redrawn in place. A button that points into a list bakes the list's REVISION into its data, and a
 * button of the add screen bakes the id of that screen's snapshot: a keyboard left in the history acts on the list or the add screen
 * it was drawn for, or is told it is out of date — never on a different person.
 */

import { getActiveLang, t } from '../i18n';
import type { SeenPerson } from '../topicTalkerMemory';
import { normaliseUsername, topicInviteTtlMs, type TopicTalkersEntry } from '../topicTalkers';
import { formatPersonLabel } from './personLabel';

/** How many people a page of the list holds. */
export const topicAccessPageSize = 8;

/** Longest button caption, in characters: a phone's button holds about this much. */
export const topicAccessLabelMaxChars = 30;

/** Every `/access` button's callback data starts with this; no other module uses the prefix. */
export const topicAccessCallbackPrefix = 'tlk_';

/** The button of the page counter: it does nothing. */
export const topicAccessNoopCallback = 'tlk_n';

/** Whose list a screen shows: one topic's, or General's, which is group-wide. */
export type AccessScope = 'topic' | 'general';

/** One button of a screen: its caption and the data a tap carries. */
export interface AccessButton {
  label: string;
  callbackData: string;
}

/** A screen: the message text and its rows of buttons. */
export interface AccessScreen {
  text: string;
  keyboard: AccessButton[][];
}

// ─── the list's rows ────────────────────────────────────────────────────

/** One line of a list: a person who may talk, or a waiting invitation, in stored order (people first, then invitations). */
export type AccessRow =
  | { kind: 'talker'; index: number; userId: string; username?: string; name: string; addedAt: number; addedByName: string }
  | { kind: 'invite'; index: number; username: string; addedAt: number; addedByName: string };

/** @description The rows of a list: its talkers, then its waiting invitations; `index` is the position a button's data points at. */
export function listAccessRows(entry: TopicTalkersEntry): AccessRow[] {
  const talkers = entry.talkers.map((talker, index): AccessRow => ({
    kind: 'talker',
    index,
    userId: talker.userId,
    ...(talker.username !== undefined ? { username: talker.username } : {}),
    name: talker.name,
    addedAt: talker.addedAt,
    addedByName: talker.addedByName,
  }));
  const invites = entry.invites.map((invite, position): AccessRow => ({
    kind: 'invite',
    index: entry.talkers.length + position,
    username: invite.username,
    addedAt: invite.addedAt,
    addedByName: invite.addedByName,
  }));
  return [...talkers, ...invites];
}

/** @description How many pages `rowCount` rows take: at least one, so an empty list still has its page. */
export function getAccessPageCount(rowCount: number): number {
  return Math.max(1, Math.ceil(rowCount / topicAccessPageSize));
}

/** @description The page that holds row `index`. */
export function getAccessPageOfRow(index: number): number {
  return Math.floor(index / topicAccessPageSize);
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const labelEllipsis = '…';

/** @description `text` cut to `maxChars` characters on a grapheme boundary, ending in an ellipsis when it was cut. */
export function cutAccessLabel(text: string, maxChars: number = topicAccessLabelMaxChars): string {
  const graphemes = [...graphemeSegmenter.segment(text)].map((segment) => segment.segment);
  if (graphemes.length <= maxChars) return text;
  return `${graphemes.slice(0, maxChars - 1).join('')}${labelEllipsis}`;
}

/** @description A row's button caption: the @username, or the name when there is none; a waiting invitation leads with ⏳. */
export function getAccessRowLabel(row: AccessRow): string {
  if (row.kind === 'invite') return cutAccessLabel(`⏳ @${row.username}`);
  return cutAccessLabel(row.username ? `@${row.username}` : row.name);
}

/** English reads day first here («11 Nov», not «Nov 11»), as every other language of the bot does. */
const intlLocaleByLanguage: Readonly<Record<string, string>> = { en: 'en-GB' };

/** @description The day an entry was made, or an invitation expires, as «11 Nov» in the active language. */
export function formatAccessDate(epochMs: number, options: { locale?: string; timeZone?: string } = {}): string {
  const language = options.locale ?? getActiveLang();
  return new Intl.DateTimeFormat(intlLocaleByLanguage[language] ?? language, { day: 'numeric', month: 'short', ...(options.timeZone ? { timeZone: options.timeZone } : {}) }).format(epochMs);
}

// ─── the buttons ────────────────────────────────────────────────────────

/** A decoded `tlk_*` tap. */
export type AccessCallback =
  | { kind: 'page'; revision: number; page: number }
  | { kind: 'open'; revision: number; index: number }
  | { kind: 'revoke'; revision: number; index: number }
  | { kind: 'add'; revision: number }
  | { kind: 'writer'; snapshotId: number; index: number }
  | { kind: 'confirm'; snapshotId: number }
  | { kind: 'dismiss'; snapshotId: number }
  | { kind: 'noop' };

/** Every `tlk_*` data the module registers: one pattern, decoded by {@link parseAccessCallback}. */
export const accessCallbackRe = /^tlk_(?:n|[pur]_\d+_\d+|a_\d+|w_\d+_\d+|[yx]_\d+)$/;

export const buildAccessPageCallback = (revision: number, page: number): string => `tlk_p_${revision}_${page}`;
export const buildAccessOpenCallback = (revision: number, index: number): string => `tlk_u_${revision}_${index}`;
export const buildAccessRevokeCallback = (revision: number, index: number): string => `tlk_r_${revision}_${index}`;
export const buildAccessAddCallback = (revision: number): string => `tlk_a_${revision}`;
export const buildAccessWriterCallback = (snapshotId: number, index: number): string => `tlk_w_${snapshotId}_${index}`;
export const buildAccessConfirmCallback = (snapshotId: number): string => `tlk_y_${snapshotId}`;
export const buildAccessDismissCallback = (snapshotId: number): string => `tlk_x_${snapshotId}`;

/** @description Decode a button's data; `null` for anything that is not one of ours. */
export function parseAccessCallback(callbackData: string): AccessCallback | null {
  if (!accessCallbackRe.test(callbackData)) return null;
  if (callbackData === topicAccessNoopCallback) return { kind: 'noop' };
  const [, token, first, second] = /^tlk_([a-z])_(\d+)(?:_(\d+))?$/.exec(callbackData) ?? [];
  const firstNumber = Number(first);
  const secondNumber = Number(second);
  switch (token) {
    case 'p': return { kind: 'page', revision: firstNumber, page: secondNumber };
    case 'u': return { kind: 'open', revision: firstNumber, index: secondNumber };
    case 'r': return { kind: 'revoke', revision: firstNumber, index: secondNumber };
    case 'a': return { kind: 'add', revision: firstNumber };
    case 'w': return { kind: 'writer', snapshotId: firstNumber, index: secondNumber };
    case 'y': return { kind: 'confirm', snapshotId: firstNumber };
    case 'x': return { kind: 'dismiss', snapshotId: firstNumber };
    default: return null;
  }
}

// ─── the typed forms ────────────────────────────────────────────────────

/** What `/access …` says: open the list, add or remove (the person is the replied-to message's, or the @username), or nothing we know. */
export type AccessCommand =
  | { kind: 'open' }
  | { kind: 'add'; usernameArgument: string | null }
  | { kind: 'remove'; usernameArgument: string | null }
  | { kind: 'unknown' };

/** @description Read the words after `/access`: none, or `add` / `remove` with at most one more word. */
export function parseAccessCommand(args: readonly string[]): AccessCommand {
  if (args.length === 0) return { kind: 'open' };
  const [word, ...rest] = args;
  const action = word.toLowerCase();
  if ((action !== 'add' && action !== 'remove') || rest.length > 1) return { kind: 'unknown' };
  return { kind: action, usernameArgument: rest[0] ?? null };
}

/** A Telegram username: 5–32 letters, digits and underscores, starting with a letter and not ending with an underscore. */
const usernamePattern = /^[A-Za-z][A-Za-z0-9_]{3,30}[A-Za-z0-9]$/;

/** @description The username a typed word names (`@alice` or `alice`), without the `@`; `null` when it is not well formed. */
export function parseAccessUsername(word: string): string | null {
  const bare = word.replace(/^@/, '');
  return usernamePattern.test(bare) ? bare : null;
}

// ─── who may be added ───────────────────────────────────────────────────

/** What an add names, reduced from the replied-to message, a mention or a typed @username. */
export type AccessTarget =
  | { kind: 'person'; userId: string; username?: string; name: string; isBot: boolean }
  | { kind: 'chatIdentity' }
  | { kind: 'username'; username: string };

/** What the decision needs to know about the conversation. */
export interface AccessAddContext {
  /** This bot's own user id, so it is refused with its own line. */
  botUserId: string | undefined;
  /** This bot's own @username: a typed one names it before any message of the bot's could be seen. */
  botUsername: string | undefined;
  adminIds: ReadonlySet<string>;
  /** The admins' lowercase @usernames: a typed one names an admin the bot has not seen write, whose id it does not know. */
  adminUsernames: ReadonlySet<string>;
  /** The list being edited. */
  ownEntry: TopicTalkersEntry;
  /** General's list, for a topic's screen: someone on it already talks here. `undefined` on General's own screen. */
  generalEntry: TopicTalkersEntry | undefined;
  /** The clock, for an invitation that has expired but nobody pruned. */
  now: number;
}

/** The outcome of an add: a person to grant, a waiting invitation to make, or a refusal with its line. */
export type AccessAddDecision =
  | { kind: 'person'; person: { userId: string; username?: string; name: string } }
  | { kind: 'invite'; username: string }
  | { kind: 'refused'; refusalKey: string; person?: string };

const hasUsername = (entry: TopicTalkersEntry | undefined, lowercase: string): boolean =>
  entry?.talkers.some((talker) => talker.username !== undefined && normaliseUsername(talker.username) === lowercase) ?? false;

/**
 * @description Whether the add may go ahead and in what form. Refused, each with its own short line: a bot, this bot itself, a post
 * made as the group or a channel (no person), an admin (they talk everywhere already), somebody on the list already — or on
 * General's, for a topic — and an invitation that waits for the name already. An @username is checked against the bot's own name
 * and the admins' names too: no id is known for it, but the same people are refused.
 */
export function decideAccessAdd(target: AccessTarget, context: AccessAddContext): AccessAddDecision {
  if (target.kind === 'chatIdentity') return { kind: 'refused', refusalKey: 'access.refuseChatIdentity' };
  if (target.kind === 'person') {
    const label = formatPersonLabel(target);
    if (target.userId === context.botUserId) return { kind: 'refused', refusalKey: 'access.refuseSelf' };
    if (target.isBot) return { kind: 'refused', refusalKey: 'access.refuseBot' };
    if (context.adminIds.has(target.userId)) return { kind: 'refused', refusalKey: 'access.refuseAdmin', person: label };
    if (context.ownEntry.talkers.some((talker) => talker.userId === target.userId)) return { kind: 'refused', refusalKey: 'access.refuseListed', person: label };
    if (context.generalEntry?.talkers.some((talker) => talker.userId === target.userId)) return { kind: 'refused', refusalKey: 'access.refuseListedInGeneral', person: label };
    return { kind: 'person', person: { userId: target.userId, ...(target.username !== undefined ? { username: target.username } : {}), name: target.name } };
  }
  const lowercase = normaliseUsername(target.username);
  const label = `@${target.username}`;
  // An admin or this bot named by @username would wait for a message that never turns the invitation into a person (the
  // sender tracking ignores admins and bots), a dead entry for a week.
  if (context.botUsername !== undefined && normaliseUsername(context.botUsername) === lowercase) return { kind: 'refused', refusalKey: 'access.refuseSelf' };
  if (context.adminUsernames.has(lowercase)) return { kind: 'refused', refusalKey: 'access.refuseAdmin', person: label };
  if (hasUsername(context.ownEntry, lowercase)) return { kind: 'refused', refusalKey: 'access.refuseListed', person: label };
  if (hasUsername(context.generalEntry, lowercase)) return { kind: 'refused', refusalKey: 'access.refuseListedInGeneral', person: label };
  const waiting = context.ownEntry.invites.find((invite) => invite.username === lowercase);
  if (waiting && context.now - waiting.addedAt < topicInviteTtlMs) return { kind: 'refused', refusalKey: 'access.refuseInviteWaiting', person: label };
  return { kind: 'invite', username: target.username };
}

/** @description The line of a refusal, in words that fit the scope it was made in («here» on a topic's screen, «in every topic» on General's). */
export function formatAccessRefusal(refusal: Extract<AccessAddDecision, { kind: 'refused' }>, scope: AccessScope): string {
  return t(refusal.refusalKey, { person: refusal.person ?? '', scope: getScopeWords(scope) });
}

// ─── the screens ────────────────────────────────────────────────────────

/** @description The words of a scope inside a sentence: «here» for a topic, «in every topic» for General. */
export function getScopeWords(scope: AccessScope): string {
  return scope === 'general' ? t('access.scopeEveryTopic') : t('access.scopeHere');
}

/** @description The mandatory warning: a talker can make the agent run any command in the folder — adding one is trusting them with the machine. */
export function getAccessShellWarning(scope: AccessScope): string {
  return scope === 'general' ? t('access.warningGeneral') : t('access.warningTopic');
}

/** What the list screen needs besides the list. */
export interface AccessListInput {
  scope: AccessScope;
  entry: TopicTalkersEntry;
  page: number;
  /** A topic's screen: how many people General's list holds (read-only line); 0 for none. */
  generalTalkerCount: number;
  /** General's screen: the topics that have talkers of their own, with their names, for the summary line. */
  topicsWithTalkers: readonly { name: string; talkerCount: number }[];
  /** One line under the list (after a revoke: the person still reads the group). */
  footerNote?: string;
}

/** @description The list: its title and notes, one button per person on the page, the page row when there is more than one page, and «Add». */
export function buildAccessListScreen(input: AccessListInput): AccessScreen {
  const { scope, entry, generalTalkerCount, topicsWithTalkers, footerNote } = input;
  const rows = listAccessRows(entry);
  const pageCount = getAccessPageCount(rows.length);
  const page = Math.min(Math.max(input.page, 0), pageCount - 1);
  const title = `${scope === 'general' ? t('access.listTitleGeneral') : t('access.listTitleTopic')}\n${t('access.adminsNote')}`;
  const sections = [title, scope === 'general' ? t('access.readNoteGeneral') : t('access.readNoteTopic')];
  if (rows.length === 0) sections.push(scope === 'general' ? t('access.emptyListGeneral') : t('access.emptyListTopic'));
  if (scope === 'topic' && generalTalkerCount > 0) sections.push(t('access.alsoGeneralLine', { count: generalTalkerCount }));
  if (scope === 'general' && topicsWithTalkers.length > 0) {
    sections.push(t('access.alsoTopicsLine', { topics: topicsWithTalkers.map((topic) => `«${cutAccessLabel(topic.name)}» ${topic.talkerCount}`).join(', ') }));
  }
  if (footerNote) sections.push(footerNote);

  const keyboard: AccessButton[][] = rows
    .slice(page * topicAccessPageSize, (page + 1) * topicAccessPageSize)
    .map((row) => [{ label: getAccessRowLabel(row), callbackData: buildAccessOpenCallback(entry.revision, row.index) }]);
  if (pageCount > 1) {
    const navigation: AccessButton[] = [];
    if (page > 0) navigation.push({ label: t('access.previousButton'), callbackData: buildAccessPageCallback(entry.revision, page - 1) });
    navigation.push({ label: `${page + 1} / ${pageCount}`, callbackData: topicAccessNoopCallback });
    if (page < pageCount - 1) navigation.push({ label: t('access.nextButton'), callbackData: buildAccessPageCallback(entry.revision, page + 1) });
    keyboard.push(navigation);
  }
  keyboard.push([{ label: t('access.addButton'), callbackData: buildAccessAddCallback(entry.revision) }]);
  return { text: sections.join('\n\n'), keyboard };
}

/** @description One person's (or invitation's) menu: who they are, since when and by whom, «Revoke access» / «Cancel invitation», «Back». */
export function buildAccessEntryScreen(input: { scope: AccessScope; entry: TopicTalkersEntry; row: AccessRow; options?: { locale?: string; timeZone?: string } }): AccessScreen {
  const { scope, entry, row } = input;
  const date = (epochMs: number): string => formatAccessDate(epochMs, input.options);
  const backButton: AccessButton = { label: t('access.backButton'), callbackData: buildAccessPageCallback(entry.revision, getAccessPageOfRow(row.index)) };
  if (row.kind === 'invite') {
    return {
      text: t('access.entryInvite', { username: row.username, date: date(row.addedAt + topicInviteTtlMs) }),
      keyboard: [[{ label: t('access.cancelInviteButton'), callbackData: buildAccessRevokeCallback(entry.revision, row.index) }], [backButton]],
    };
  }
  return {
    text: `${formatPersonLabel(row)}\n${t('access.entryTalker', { scope: getScopeWords(scope), date: date(row.addedAt), admin: row.addedByName })}`,
    keyboard: [[{ label: t('access.revokeButton'), callbackData: buildAccessRevokeCallback(entry.revision, row.index) }], [backButton]],
  };
}

/** @description The add screen: the three ways to add, the warning, a button for each person who wrote here recently and was ignored, «Back». */
export function buildAccessAddScreen(input: { scope: AccessScope; revision: number; snapshotId: number; writers: readonly SeenPerson[] }): AccessScreen {
  const { scope, revision, snapshotId, writers } = input;
  const text = [t('access.addTitle', { scope: getScopeWords(scope) }), t('access.addHowTo'), getAccessShellWarning(scope)].join('\n\n');
  const writerButtons = writers.map((writer, index): AccessButton => ({ label: cutAccessLabel(formatPersonLabel(writer)), callbackData: buildAccessWriterCallback(snapshotId, index) }));
  const keyboard: AccessButton[][] = [];
  for (let start = 0; start < writerButtons.length; start += 2) keyboard.push(writerButtons.slice(start, start + 2));
  keyboard.push([{ label: t('access.backButton'), callbackData: buildAccessPageCallback(revision, 0) }]);
  return { text, keyboard };
}

/** What the confirmation asks to add: a person, or a waiting invitation for a username not seen yet. */
export type AccessPendingAdd = { kind: 'person'; person: { userId: string; username?: string; name: string } } | { kind: 'invite'; username: string };

/**
 * @description The confirmation of a typed add — the step the grant waits for, so the warning is read BEFORE it takes effect:
 * who, what they will be able to do, «Add» and «Cancel».
 */
export function buildAccessConfirmScreen(input: { scope: AccessScope; snapshotId: number; pending: AccessPendingAdd }): AccessScreen {
  const { scope, snapshotId, pending } = input;
  const title = pending.kind === 'person'
    ? t('access.confirmTitle', { person: formatPersonLabel(pending.person) })
    : t('access.confirmInviteTitle', { username: pending.username });
  return {
    text: [title, getAccessShellWarning(scope)].join('\n\n'),
    keyboard: [[
      { label: t('access.confirmAddButton'), callbackData: buildAccessConfirmCallback(snapshotId) },
      { label: t('access.confirmCancelButton'), callbackData: buildAccessDismissCallback(snapshotId) },
    ]],
  };
}

/** @description The silent line posted when somebody was added: who may now talk and, plainly, what they can make the agent do. */
export function buildAccessGrantedNotice(input: { scope: AccessScope; person: { username?: string; name: string }; folder: string | null }): string {
  const person = formatPersonLabel(input.person);
  if (input.scope === 'general') return t('access.grantedNoticeGeneral', { person });
  return input.folder === null ? t('access.grantedNoticeTopicUnbound', { person }) : t('access.grantedNoticeTopic', { person, folder: input.folder });
}

/** @description The silent line posted when an invitation was made: it takes effect at the person's first message, within a week. */
export function buildAccessInvitedNotice(input: { scope: AccessScope; username: string; expiresAt: number; options?: { locale?: string; timeZone?: string } }): string {
  return t('access.invitedNotice', { username: input.username, scope: getScopeWords(input.scope), date: formatAccessDate(input.expiresAt, input.options) });
}
