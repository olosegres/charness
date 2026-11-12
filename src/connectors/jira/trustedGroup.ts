import { JiraHttpError, type JiraAccount, type JiraClient } from './client';
import { checkIsAppAccount } from './trigger';

/**
 * @description The trusted group of the Jira connector: whose text may steer an
 * agent. With `jira.json` `trustedGroup` set, trusted are the active members of
 * that ONE Jira group and the AI account itself — what they write reaches the
 * agent and what they hand over starts it; anyone else's text is withheld and
 * anyone else's hand-over is not acted on. An app or automation (`accountType`
 * `app`) is judged by `trustedApps` alone: absent, every app is trusted; set
 * (even empty), only an app whose account id is listed is — group membership
 * does not make an app trusted, since the product-access group of a site holds
 * its integrations' app users, which can relay text written by outsiders. Any
 * other app is an outsider like a person outside the group, and is logged once
 * (name and id) so an operator can find the id to list.
 *
 * The config names the group, the site is asked once for its id (a rename keeps
 * working), and its members are read at boot and again whenever the last read is
 * older than {@link jiraTrustedGroupMaxAgeMs}. A read that fails leaves the old
 * list in place but never serves it past its age: the caller's
 * {@link JiraTrust.refreshIfStale} rejects, so nothing is decided on a stale
 * list (fail closed).
 */

/** A member removed from the group loses trust within this plus one poll. */
export const jiraTrustedGroupMaxAgeMs = 5 * 60 * 1000;
/** What a `group/member` read answers for a group that no longer exists. */
const groupNotFoundStatus = 404;

/** The group is gone from the site: a setup fault that does not fix itself, so polling stops. */
export class JiraTrustedGroupGoneError extends Error {
  constructor(readonly groupName: string) {
    super(`the trusted group "${groupName}" no longer exists on the site`);
    this.name = 'JiraTrustedGroupGoneError';
  }
}

/** The group as one read of the site saw it. */
export interface JiraTrustedGroupSnapshot {
  /** The name `jira.json` gives; what the notice to a requester says. */
  groupName: string;
  groupId: string;
  memberAccountIds: ReadonlySet<string>;
  /** Epoch ms the read started at. */
  readAtMs: number;
}

export interface JiraTrust {
  readonly groupName: string;
  /** Reads the members again when the last read is older than {@link jiraTrustedGroupMaxAgeMs}; rejects when it cannot (the list stays stale). */
  refreshIfStale(): Promise<void>;
  /**
   * Against the list as of the last read; call {@link refreshIfStale} first. A missing account is never trusted. An app
   * not in `trustedApps` is not either, and its first judgement logs one line.
   */
  checkIsTrusted(account: JiraAccount | null | undefined): boolean;
}

export type JiraTrustClient = Pick<JiraClient, 'getGroupByName' | 'getGroupMembers'>;

/** The longest app name a log line carries. */
const loggedAppNameMaxLength = 80;
/** Control and line-separator characters: a name or id with one would split or forge a log line. */
const logUnsafeCharsRe = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
/** Zero-width and bidi-control characters (U+200B–U+200F, U+202A–U+202E, U+2066–U+2069): invisible, and a terminal may reorder the line around them. */
const logInvisibleCharsRe = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

/** One value of an untrusted app (its name, its id) as a single quoted, capped word of a log line. */
function quoteForLog(value: string): string {
  const flat = value.replace(logInvisibleCharsRe, '').replace(logUnsafeCharsRe, ' ').trim();
  return JSON.stringify(flat.length > loggedAppNameMaxLength ? `${flat.slice(0, loggedAppNameMaxLength)}…` : flat);
}

/** @description The line logged once per untrusted app: its name and id, and what lists it. */
export function buildJiraUntrustedAppLogLine(app: JiraAccount): string {
  const name = app.displayName === undefined ? '(no name)' : quoteForLog(app.displayName);
  return `[jira] app ${name} (account id ${quoteForLog(app.accountId)}) is not in trustedApps: its text is withheld and its hand-over starts nothing; add its account id to jira.json trustedApps to trust it`;
}

/** The account ids of the group's members; a 404 is {@link JiraTrustedGroupGoneError}. */
async function readMemberAccountIds(client: JiraTrustClient, groupId: string, groupName: string): Promise<Set<string>> {
  try {
    return new Set((await client.getGroupMembers(groupId)).map((member) => member.accountId));
  } catch (error) {
    if (error instanceof JiraHttpError && error.status === groupNotFoundStatus) throw new JiraTrustedGroupGoneError(groupName);
    throw error;
  }
}

/**
 * @description Resolve the group named `groupName` and read its members, for
 * the setup check. `null` — the site has no such group. A failed call
 * (unreachable, refused) rejects as the client raised it.
 */
export async function readJiraTrustedGroup(client: JiraTrustClient, groupName: string, now: () => number): Promise<JiraTrustedGroupSnapshot | null> {
  const readAtMs = now();
  const group = await client.getGroupByName(groupName);
  if (!group) return null;
  try {
    return { groupName, groupId: group.groupId, memberAccountIds: await readMemberAccountIds(client, group.groupId, groupName), readAtMs };
  } catch (error) {
    // Removed between the two calls.
    if (error instanceof JiraTrustedGroupGoneError) return null;
    throw error;
  }
}

/**
 * @description The trust over `snapshot` (the setup check's own read), following the group by its id. `trustedAppAccountIds`
 * is `jira.json` `trustedApps` (`null`: absent, every app is trusted); `log` takes the one line per untrusted app.
 */
export function createJiraTrust(options: {
  client: JiraTrustClient;
  snapshot: JiraTrustedGroupSnapshot;
  aiAccountId: string;
  trustedAppAccountIds?: ReadonlySet<string> | null;
  now: () => number;
  log?: (line: string) => void;
}): JiraTrust {
  const { client, aiAccountId, now } = options;
  const trustedAppAccountIds = options.trustedAppAccountIds ?? null;
  const log = options.log ?? ((line: string): void => console.log(line));
  /** The apps already logged: every site that judges an account asks, so one app would otherwise fill the log. */
  const loggedUntrustedAppIds = new Set<string>();
  const { groupName, groupId } = options.snapshot;
  let memberAccountIds = options.snapshot.memberAccountIds;
  let readAtMs = options.snapshot.readAtMs;
  /** One read at a time: the poll and the attachment tool may both find the list stale. */
  let refreshInFlight: Promise<void> | null = null;

  async function refresh(): Promise<void> {
    const startedAtMs = now();
    memberAccountIds = await readMemberAccountIds(client, groupId, groupName);
    readAtMs = startedAtMs;
  }

  return {
    groupName,
    refreshIfStale: async () => {
      if (now() - readAtMs < jiraTrustedGroupMaxAgeMs) return;
      refreshInFlight ??= refresh().finally(() => {
        refreshInFlight = null;
      });
      await refreshInFlight;
    },
    checkIsTrusted: (account) => {
      if (!account) return false;
      if (account.accountId === aiAccountId) return true;
      if (!checkIsAppAccount(account)) return memberAccountIds.has(account.accountId);
      // An app: the list alone decides, never the group — and a listed id makes no PERSON trusted (the branch above).
      if (trustedAppAccountIds === null || trustedAppAccountIds.has(account.accountId)) return true;
      if (!loggedUntrustedAppIds.has(account.accountId)) {
        loggedUntrustedAppIds.add(account.accountId);
        log(buildJiraUntrustedAppLogLine(account));
      }
      return false;
    },
  };
}
