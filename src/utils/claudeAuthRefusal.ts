/**
 * @description An account profile (`utils/claudeProfiles.ts`) that CANNOT run a conversation — not signed in by its last
 * `claude auth status`, or refused by the CLI on a turn (signed out, its login expired or revoked, its organization turned
 * Claude subscription use in Claude Code off, a bare 401 / 403) — and where the conversation goes instead.
 *
 *   - A refusal is kept on the profile's record (`ClaudeProfileRecord.authRefusal`) with a STAMP of the login that was refused
 *     ({@link readClaudeLoginStamp}: a hash of the stored OAuth refresh token and API key, never the secret itself). It counts as
 *     «not signed in» everywhere the profiles are ranked ({@link getClaudeProfileSignedIn}), so the launch pick, the fallback chain
 *     and every screen leave the account out, until it is signed in again ({@link checkIsClaudeAuthRefusalOver}): a new login
 *     (the stamp changed). A `rejected` refusal — a bare 401 / 403 the CLI named no reason for — also ends once a status probe
 *     after it finds the account signed in: it may have been the API's moment, not the login.
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

/**
 * @description Whether the refusal is over: the folder holds a login other than the refused one (a sign-in since — `loginStamp` is
 * {@link readClaudeLoginStamp} now), or, for a `rejected` one (a bare 401 / 403), a status probe after it found the account
 * signed in. A refusal the CLI named (`signedOut`, `orgDisabled`) outlives such a probe: the CLI reports a revoked login and an
 * organization's switch as signed in all the same, and believing it would send the next conversation into the same refusal.
 */
export function checkIsClaudeAuthRefusalOver(input: {
  refusal: ClaudeAuthRefusal;
  loginStamp: string | null;
  /** The record's last probe. */
  loggedIn: boolean | undefined;
  statusCheckedAt: string | undefined;
}): boolean {
  const { refusal, loginStamp } = input;
  if (loginStamp !== null && loginStamp !== (refusal.login ?? null)) return true;
  if (refusal.reason !== 'rejected' || input.loggedIn !== true || input.statusCheckedAt === undefined) return false;
  return Date.parse(input.statusCheckedAt) > Date.parse(refusal.at);
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
 * goes now; `null` = nowhere), `[accounts] profile default: signed in again — usable for new sessions`. An account seen for the
 * first time is said only when it is not usable; one gone from `current` says nothing.
 */
export function listClaudeProfileUsabilityLines(input: {
  previous: ReadonlyMap<string, ClaudeProfileUsability>;
  current: ReadonlyMap<string, ClaudeProfileUsability>;
  getInstead: (name: string) => string | null;
}): string[] {
  const lines: string[] = [];
  for (const [name, usability] of input.current) {
    const before = input.previous.get(name);
    if (before === usability || (before === undefined && usability === 'usable')) continue;
    if (usability === 'usable') {
      lines.push(`[accounts] profile ${name}: signed in again — usable for new sessions`);
      continue;
    }
    const instead = input.getInstead(name);
    const target = instead === null ? 'no other account can take new sessions' : `new sessions go to ${instead}`;
    lines.push(`[accounts] profile ${name}: ${usabilityWords[usability]} — ${target}`);
  }
  return lines;
}
