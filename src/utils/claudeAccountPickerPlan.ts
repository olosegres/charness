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
  type ClaudeProfileBilling,
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
/** Ask for the name of a new account billed to a Claude Console organization's API balance. */
export const accountAddApiCallback = 'acct_addapi';
/** A topic drops its own pick and follows the instance default again. */
export const accountFollowDefaultCallback = 'acct_follow';
/** Arm the OpenCode provider-id capture (the next plain message names the provider to connect). */
export const accountAddProviderCallback = 'acct_ocadd';
/**
 * Disconnect an OpenCode provider: the INDEX points into the provider list the screen listed, snapshotted per
 * message (a provider id can be long and the list changes), then the confirmation of the same index.
 */
export const accountDisconnectCallbackRe = /^acct_dc_(\d{1,2})$/;
export const accountDisconnectConfirmCallbackRe = /^acct_dcok_(\d{1,2})$/;
/** Connect an OpenCode provider again (the `/connect <provider>` method picker); same snapshot index. */
export const accountReconnectCallbackRe = /^acct_dcre_(\d{1,2})$/;
/**
 * A provider row in a topic: switch the topic to the provider (its model page opens), by the INDEX of the screen's
 * provider list; then a model on the open page (the index into that provider's models) and a page arrow.
 */
export const accountOpenCodeUseCallbackRe = /^acct_ocuse_(\d{1,2})$/;
export const accountOpenCodeModelCallbackRe = /^acct_ocm_(\d{1,3})$/;
export const accountOpenCodePageCallbackRe = /^acct_ocpg_(\d{1,3})$/;
/** Back to the main picker from a sub-picker. */
export const accountBackCallback = 'acct_back';
/** Flip the auto-switch-on-limit setting (`utils/claudeLimitSwitch.ts`): the topic's override, in General the instance default. */
export const accountAutoSwitchOnCallback = 'acct_autosw_on';
export const accountAutoSwitchOffCallback = 'acct_autosw_off';

export function buildAccountUseCallback(name: string): string {
  return `acct_use_${name}`;
}

export function buildAccountLoginCallback(name: string): string {
  return `acct_login_${name}`;
}

export function buildAccountDisconnectCallback(index: number): string {
  return `acct_dc_${index}`;
}

export function buildAccountOpenCodeUseCallback(index: number): string {
  return `acct_ocuse_${index}`;
}

export function buildAccountOpenCodeModelCallback(index: number): string {
  return `acct_ocm_${index}`;
}

export function buildAccountOpenCodePageCallback(page: number): string {
  return `acct_ocpg_${page}`;
}

export function buildAccountReconnectCallback(index: number): string {
  return `acct_dcre_${index}`;
}

export function buildAccountDisconnectConfirmCallback(index: number): string {
  return `acct_dcok_${index}`;
}

export function buildAccountRemoveCallback(name: string): string {
  return `acct_rm_${name}`;
}

export function buildAccountRemoveConfirmCallback(name: string): string {
  return `acct_rmok_${name}`;
}

/**
 * @description The name a callback's data carries, or `null` when the data is not that button's or names an
 * impossible profile (`default` is a valid target for use / login / removal only where `allowDefault`).
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
  /** How the account pays; `null` when never recorded (a subscription account added before billing was). */
  billing: ClaudeProfileBilling | null;
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
  defaultStatus: { loggedIn: boolean | undefined; email: string | null; subscriptionType: string | null; billing?: ClaudeProfileBilling | null };
  /** The account the ✓ sits on; `null` for none (the topic runs OpenCode). */
  activeName: string | null;
  topicCounts: ReadonlyMap<string, number>;
  /** The operator removed (signed out) `default`: it has no row until it is signed in again. */
  isDefaultRemoved?: boolean;
}): AccountPickerRow[] {
  const rows: AccountPickerRow[] = input.isDefaultRemoved ? [] : [{
    name: defaultClaudeProfileName,
    isActive: input.activeName === defaultClaudeProfileName,
    loggedIn: input.defaultStatus.loggedIn,
    email: input.defaultStatus.email,
    subscriptionType: input.defaultStatus.subscriptionType,
    kind: getClaudeAccountKind(input.defaultStatus.subscriptionType),
    billing: input.defaultStatus.billing ?? null,
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
      billing: record.billing ?? null,
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
