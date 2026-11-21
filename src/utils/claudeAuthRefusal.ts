/**
 * @description An account profile (`utils/claudeProfiles.ts`) that CANNOT run a conversation — not signed in by its last
 * `claude auth status`, or refused by the CLI on a turn (signed out, its login expired or revoked, its organization turned
 * Claude subscription use in Claude Code off, a bare 401 / 403) — and where the conversation goes instead.
 *
 *   - A refusal is kept on the profile's record (`ClaudeProfileRecord.authRefusal`) with a STAMP of the login that was refused
 *     ({@link readClaudeLoginStamp}: a hash of the stored OAuth refresh token and API key, never the secret itself). It counts as
 *     «not signed in» everywhere the profiles are ranked ({@link getClaudeProfileSignedIn}), so the launch pick, the fallback chain
 *     and every screen leave the account out, until it is signed in again ({@link getClaudeAuthRefusalEnd}): a new login
 *     (the stamp changed). A `rejected` refusal — a bare 401 / 403 the CLI named no reason for — also ends once a status probe
 *     after it finds the account signed in: it may have been the API's moment, not the login. Only once, though: the same login
 *     refused that way again within {@link claudeRejectedRepeatWindowMs} of such an end is held until a new login
 *     (`isHeldUntilNewLogin`), since the CLI reports a revoked login signed in all the same — an account must not swing between
 *     «refused» and «usable» every hour. An end by a status check alone is no sign-in, so nobody is told «signed in again».
 *   - A conversation never starts or resumes on such an account: it goes where `claude_profiles` would send a session leaving
 *     it (`pickClaudeProfileInstead`, `utils/claudeProfileUsageViews.ts`: the accounts the `/limits` list holds, an API-credit
 *     account of it first, then the subscription whose weekly window resets soonest).
 *   - Every change of an account's state is said ONCE in the log ({@link listClaudeProfileUsabilityLines}).
 *
 * Pure apart from {@link readClaudeLoginStamp} (it reads the profile's credential files): the bot passes the records and the clock.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ClaudeProfileRecord } from '../state';
import type { AgentAuthErrorReason } from '../types';
import { checkIsRecord } from './checkIsRecord';
import { readClaudeProfileApiKey, readDefaultClaudeProfileApiKey, resolveHomeClaudeDir } from './claudeProfiles';

/** A turn the CLI failed on the account itself, kept on the profile's record until the account is signed in again. */
export interface ClaudeAuthRefusal {
  /** ISO instant of the refused turn. */
  at: string;
  reason: AgentAuthErrorReason;
  /** {@link readClaudeLoginStamp} of the login that was refused; absent when the folder held none. */
  login?: string;
  /** The CLI's own words of the refusal, one line (`Not logged in · Please run /login`); absent when none were read. */
  detail?: string;
  /** Only a new login ends it — a status check that finds the account signed in does not (see {@link buildClaudeAuthRefusalMark}). */
  isHeldUntilNewLogin?: boolean;
}

/** A bare 401 / 403 refusal a status check ended (`ClaudeProfileRecord.authRefusalEndedByStatusCheck`): when, and the login it was of. */
export interface ClaudeAuthRefusalStatusCheckEnd {
  at: string;
  login?: string;
}

/**
 * How long after a status check ended a bare 401 / 403 refusal a new one of the SAME login is held until a new sign-in, and the
 * account's return by that check stays a quiet one: longer than the hour after which a signed-in account is probed again, so a
 * refusal that keeps coming is caught on its first repeat.
 */
export const claudeRejectedRepeatWindowMs = 6 * 60 * 60_000;

/**
 * @description The refusal to record for a turn the CLI refused now: `login` is {@link readClaudeLoginStamp} of the folder, `detail`
 * the CLI's words (`null` = none). A bare 401 / 403 (`rejected`) of the same login a status check already ended once within
 * {@link claudeRejectedRepeatWindowMs} is held until a new login: the probe that ended it found the login «signed in» and would
 * again, every hour.
 */
export function buildClaudeAuthRefusalMark(input: {
  reason: AgentAuthErrorReason;
  login: string | null;
  detail: string | null;
  nowMs: number;
  endedByStatusCheck: ClaudeAuthRefusalStatusCheckEnd | undefined;
}): ClaudeAuthRefusal {
  const { endedByStatusCheck } = input;
  const isRepeat = input.reason === 'rejected' && endedByStatusCheck !== undefined
    && (endedByStatusCheck.login ?? null) === input.login
    && input.nowMs - Date.parse(endedByStatusCheck.at) < claudeRejectedRepeatWindowMs;
  return {
    at: new Date(input.nowMs).toISOString(),
    reason: input.reason,
    ...(input.login !== null ? { login: input.login } : {}),
    ...(input.detail !== null && input.detail !== '' ? { detail: input.detail } : {}),
    ...(isRepeat ? { isHeldUntilNewLogin: true } : {}),
  };
}

/** Hex digits of a login stamp: enough to tell two logins apart, nothing to recover a secret from. */
const loginStampLength = 16;

/**
 * @description A stamp of the login a profile folder holds (`configDir`; `null` = `~/.claude`, whose Console key lives in the home
 * `.claude.json`): a hash of its OAuth refresh token (else its access token) off `.credentials.json` and of its API key (a pasted
 * one, else a Console login's). A new sign-in writes new secrets, so the stamp changes; `null` when the folder holds none.
 * Only the hash leaves this function — the secrets are never kept, logged or compared as such.
 */
export function readClaudeLoginStamp(configDir: string | null, homeDir: string = os.homedir()): string | null {
  const parts: string[] = [];
  const oauthToken = readOAuthLoginSecret(path.join(configDir ?? resolveHomeClaudeDir(homeDir), '.credentials.json'));
  if (oauthToken !== null) parts.push(`oauth:${oauthToken}`);
  const apiKey = configDir === null ? readDefaultClaudeProfileApiKey(true, homeDir) : readClaudeProfileApiKey(configDir);
  if (apiKey !== null) parts.push(`key:${apiKey}`);
  if (parts.length === 0) return null;
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, loginStampLength);
}

/** The refresh token of a `.credentials.json` (it outlives the access tokens a running CLI renews), else its access token. */
function readOAuthLoginSecret(file: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const oauth = checkIsRecord(parsed) && checkIsRecord(parsed.claudeAiOauth) ? parsed.claudeAiOauth : null;
  if (oauth === null) return null;
  if (typeof oauth.refreshToken === 'string' && oauth.refreshToken !== '') return oauth.refreshToken;
  return typeof oauth.accessToken === 'string' && oauth.accessToken !== '' ? oauth.accessToken : null;
}

/** How a refusal ended: a new login in the folder (a sign-in), or a status check alone (a bare 401 / 403 that may have been the API's moment). */
export type ClaudeAuthRefusalEnd = 'newLogin' | 'statusCheck';

/**
 * @description Whether the refusal is over, and how: `newLogin` — the folder holds a login other than the refused one (a sign-in
 * since; `loginStamp` is {@link readClaudeLoginStamp} now); `statusCheck` — a `rejected` one (a bare 401 / 403) not held until a new
 * login, and a status probe after it found the account signed in; `null` — it stands. A refusal the CLI named (`signedOut`,
 * `orgDisabled`) outlives such a probe: the CLI reports a revoked login and an organization's switch as signed in all the same, and
 * believing it would send the next conversation into the same refusal.
 */
export function getClaudeAuthRefusalEnd(input: {
  refusal: ClaudeAuthRefusal;
  loginStamp: string | null;
  /** The record's last probe. */
  loggedIn: boolean | undefined;
  statusCheckedAt: string | undefined;
}): ClaudeAuthRefusalEnd | null {
  const { refusal, loginStamp } = input;
  if (loginStamp !== null && loginStamp !== (refusal.login ?? null)) return 'newLogin';
  if (refusal.reason !== 'rejected' || refusal.isHeldUntilNewLogin === true) return null;
  if (input.loggedIn !== true || input.statusCheckedAt === undefined) return null;
  return Date.parse(input.statusCheckedAt) > Date.parse(refusal.at) ? 'statusCheck' : null;
}

/**
 * @description Whether the account is usable again only because a status check ended its bare 401 / 403 refusal, lately (within
 * {@link claudeRejectedRepeatWindowMs}): no sign-in happened, so the operator is not told «signed in again» — it is left out of the
 * told accounts quietly — and the log says what did happen.
 */
export function checkIsClaudeProfileBackByStatusCheck(
  record: Pick<ClaudeProfileRecord, 'authRefusal' | 'authRefusalEndedByStatusCheck'> | undefined,
  nowMs: number,
): boolean {
  const ended = record?.authRefusalEndedByStatusCheck;
  if (record?.authRefusal !== undefined || ended === undefined) return false;
  return nowMs - Date.parse(ended.at) < claudeRejectedRepeatWindowMs;
}

/**
 * @description Whether the account is signed in as the rankings must read it: `false` while the CLI's refusal stands, else the last
 * probe's word (`undefined` = never probed). Every view of the profiles reads it ({@link buildClaudeProfileUsageView}).
 */
export function getClaudeProfileSignedIn(record: Pick<ClaudeProfileRecord, 'loggedIn' | 'authRefusal'> | undefined): boolean | undefined {
  return record?.authRefusal !== undefined ? false : record?.loggedIn;
}

/** Whether a conversation must not start or resume on the account: not signed in by its last probe, or refused by the CLI since. */
export function checkIsClaudeProfileKnownUnusable(record: Pick<ClaudeProfileRecord, 'loggedIn' | 'authRefusal'> | undefined): boolean {
  return getClaudeProfileSignedIn(record) === false;
}

/** An account's state as the log says it: usable, not signed in by its last probe, or refused by the CLI (the reason). */
export type ClaudeProfileUsability = 'usable' | 'notSignedIn' | AgentAuthErrorReason;

/** The state of the account behind `record` (a refusal names its reason; never probed counts as usable). */
export function getClaudeProfileUsability(record: Pick<ClaudeProfileRecord, 'loggedIn' | 'authRefusal'> | undefined): ClaudeProfileUsability {
  if (record?.authRefusal !== undefined) return record.authRefusal.reason;
  return record?.loggedIn === false ? 'notSignedIn' : 'usable';
}

/**
 * Whether signing the account in AGAIN can mend this state: a missing, expired or revoked login and a bare 401 / 403 yes (a new login ends
 * the refusal); an organization that turned Claude subscription use off no — the same login is refused again.
 */
export function checkIsClaudeUsabilityMendedBySignIn(usability: Exclude<ClaudeProfileUsability, 'usable'>): boolean {
  return usability !== 'orgDisabled';
}

/** Why the CLI refused an account, in the words of the log and the command line. */
export const claudeAuthRefusalWords: Readonly<Record<AgentAuthErrorReason, string>> = {
  signedOut: 'not signed in (the login is missing, expired or revoked)',
  orgDisabled: 'its organization disabled Claude subscription access in Claude Code',
  rejected: 'the API refused its credentials (401/403)',
};

const usabilityWords: Readonly<Record<Exclude<ClaudeProfileUsability, 'usable'>, string>> = {
  notSignedIn: 'not signed in',
  signedOut: `refused by the CLI: ${claudeAuthRefusalWords.signedOut}`,
  orgDisabled: `refused by the CLI: ${claudeAuthRefusalWords.orgDisabled}`,
  rejected: `refused by the CLI: ${claudeAuthRefusalWords.rejected}`,
};

/** An account's state in the log's words: `usable`, `not signed in`, `refused by the CLI: …`. */
export function describeClaudeProfileUsability(usability: ClaudeProfileUsability): string {
  return usability === 'usable' ? 'usable' : usabilityWords[usability];
}

/**
 * @description The log lines of the accounts whose state changed from `previous` to `current` (each by name), once per change:
 * `[accounts] profile default: not signed in — new sessions go to second` (`getInstead`: where a conversation leaving that account
 * goes now; `null` = nowhere), `[accounts] profile default: signed in again — usable for new sessions` — or, for an account back only
 * because a status check ended its bare 401 / 403 refusal (`backByStatusCheck`), what did happen. An account seen for the first time is
 * said only when it is not usable; one gone from `current` says nothing.
 */
export function listClaudeProfileUsabilityLines(input: {
  previous: ReadonlyMap<string, ClaudeProfileUsability>;
  current: ReadonlyMap<string, ClaudeProfileUsability>;
  getInstead: (name: string) => string | null;
  backByStatusCheck?: ReadonlySet<string>;
}): string[] {
  const lines: string[] = [];
  for (const [name, usability] of input.current) {
    const before = input.previous.get(name);
    if (before === usability || (before === undefined && usability === 'usable')) continue;
    if (usability === 'usable') {
      lines.push(input.backByStatusCheck?.has(name) === true
        ? `[accounts] profile ${name}: usable again — a status check found it signed in after the API refused it (401/403); the same refusal again holds it until a new sign-in`
        : `[accounts] profile ${name}: signed in again — usable for new sessions`);
      continue;
    }
    const instead = input.getInstead(name);
    const target = instead === null ? 'no other account can take new sessions' : `new sessions go to ${instead}`;
    lines.push(`[accounts] profile ${name}: ${usabilityWords[usability]} — ${target}`);
  }
  return lines;
}
