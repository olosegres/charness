import { JiraHttpError, type JiraAccount, type JiraClient } from './client';
import { checkIsAppAccount } from './trigger';

/**
 * @description The trusted group of the Jira connector: whose text may steer an
 * agent. With `jira.json` `trustedGroup` set, trusted are the active members of
 * that ONE Jira group, the AI account itself, and every app or automation
 * (`accountType` `app`) — what they write reaches the agent and what they hand
 * over starts it; anyone else's text is withheld and anyone else's hand-over is
 * not acted on.
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
  /** Against the list as of the last read; call {@link refreshIfStale} first. A missing account is never trusted. */
  checkIsTrusted(account: JiraAccount | null | undefined): boolean;
}

export type JiraTrustClient = Pick<JiraClient, 'getGroupByName' | 'getGroupMembers'>;

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

/** @description The trust over `snapshot` (the setup check's own read), following the group by its id. */
export function createJiraTrust(options: {
  client: JiraTrustClient;
  snapshot: JiraTrustedGroupSnapshot;
  aiAccountId: string;
  now: () => number;
}): JiraTrust {
  const { client, aiAccountId, now } = options;
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
      return account.accountId === aiAccountId || checkIsAppAccount(account) || memberAccountIds.has(account.accountId);
    },
  };
}
