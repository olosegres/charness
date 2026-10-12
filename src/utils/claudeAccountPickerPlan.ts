/**
 * @description Pure plan of the `/account` picker (`connectors/telegram/commands/claudeAccounts.ts`): the
 * `callback_data` codecs and the per-profile row model. Profile names are slugs of at most 32 characters
 * (`utils/claudeProfiles.ts`), so a button BAKES THE NAME into its data (`acct_use_<name>` is at most 41
 * bytes, under Telegram's 64-byte cap) and an old keyboard can never act on a profile other than the one it
 * named — a removed name simply resolves to "unknown profile".
 */

import type { ClaudeProfileRecord } from '../state';
import {
  checkIsValidClaudeProfileName,
  defaultClaudeProfileName,
  getClaudeAccountKind,
  type ClaudeAccountKind,
} from './claudeProfiles';

const nameGroup = '([a-z0-9][a-z0-9_-]{0,31})';

/** Switch the topic (General: the instance default) to the named profile. */
export const accountUseCallbackRe = new RegExp(`^acct_use_${nameGroup}$`);
/** Open the sub-picker that chooses a profile to sign in again / to remove. */
export const accountLoginMenuCallback = 'acct_login_menu';
export const accountRemoveMenuCallback = 'acct_rm_menu';
/** Start the sign-in of the named profile. */
export const accountLoginCallbackRe = new RegExp(`^acct_login_${nameGroup}$`);
/** Ask to confirm the removal of the named profile, then remove it. */
export const accountRemoveCallbackRe = new RegExp(`^acct_rm_${nameGroup}$`);
export const accountRemoveConfirmCallbackRe = new RegExp(`^acct_rmok_${nameGroup}$`);
/** Ask for a new profile's name. */
export const accountAddCallback = 'acct_add';
/** A topic drops its own pick and follows the instance default again. */
export const accountFollowDefaultCallback = 'acct_follow';
/** Back to the main picker from a sub-picker. */
export const accountBackCallback = 'acct_back';

export function buildAccountUseCallback(name: string): string {
  return `acct_use_${name}`;
}

export function buildAccountLoginCallback(name: string): string {
  return `acct_login_${name}`;
}

export function buildAccountRemoveCallback(name: string): string {
  return `acct_rm_${name}`;
}

export function buildAccountRemoveConfirmCallback(name: string): string {
  return `acct_rmok_${name}`;
}

/**
 * @description The name a callback's data carries, or `null` when the data is not that button's or names an
 * impossible profile (`default` is a valid target for use / login, never for a removal).
 */
export function parseAccountCallbackName(data: string, re: RegExp, options: { allowDefault: boolean }): string | null {
  const match = data.match(re);
  if (!match) return null;
  const name = match[1];
  if (name === defaultClaudeProfileName) return options.allowDefault ? name : null;
  return checkIsValidClaudeProfileName(name) ? name : null;
}

/** One line / one button of the picker. */
export interface AccountPickerRow {
  name: string;
  /** The profile the topic (General: the instance) effectively uses. */
  isActive: boolean;
  /** The CLI's last answer; `undefined` when never read. */
  loggedIn: boolean | undefined;
  email: string | null;
  subscriptionType: string | null;
  kind: ClaudeAccountKind;
  /** How many bound topics resolve to this profile. */
  topicCount: number;
}

/**
 * @description The picker's rows: `default` first, then the added profiles in creation order. `topicCounts`
 * is the resolved use per profile (explicit picks AND topics that follow the instance default), so the count
 * answers "which topics would a removal or re-login touch".
 */
export function buildAccountPickerRows(input: {
  records: Readonly<Record<string, ClaudeProfileRecord>>;
  defaultStatus: { loggedIn: boolean | undefined; email: string | null; subscriptionType: string | null };
  activeName: string;
  topicCounts: ReadonlyMap<string, number>;
}): AccountPickerRow[] {
  const rows: AccountPickerRow[] = [{
    name: defaultClaudeProfileName,
    isActive: input.activeName === defaultClaudeProfileName,
    loggedIn: input.defaultStatus.loggedIn,
    email: input.defaultStatus.email,
    subscriptionType: input.defaultStatus.subscriptionType,
    kind: getClaudeAccountKind(input.defaultStatus.subscriptionType),
    topicCount: input.topicCounts.get(defaultClaudeProfileName) ?? 0,
  }];
  const added = Object.entries(input.records)
    .sort(([, a], [, b]) => a.createdAt.localeCompare(b.createdAt));
  for (const [name, record] of added) {
    rows.push({
      name,
      isActive: input.activeName === name,
      loggedIn: record.loggedIn,
      email: record.email ?? null,
      subscriptionType: record.subscriptionType ?? null,
      kind: getClaudeAccountKind(record.subscriptionType ?? null),
      topicCount: input.topicCounts.get(name) ?? 0,
    });
  }
  return rows;
}

/** The profile each bound topic resolves to, counted per profile name. */
export function countTopicsPerProfile(resolvedNames: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of resolvedNames) counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
}
