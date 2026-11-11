import { tryKeyFromString } from './sessionKey';

/**
 * @description The per-topic talker lists: who, besides the group's admins, may talk to the agent in ONE topic.
 *
 * Pure operations over the `topicTalkers` record that `state.json` persists (`StateStore` wraps them and decides when
 * to flush). Platform-neutral like `accessControl.ts`: a topic is its serialised `SessionKey`, a person is a string
 * id. The list of the General topic is group-wide — {@link getEffectiveTalkerIdsInMap} merges it into every topic's set.
 */

/** How long a username invitation («waits for the person's first message») stays valid. */
export const topicInviteTtlMs = 7 * 24 * 60 * 60 * 1000;

/** The person a talker entry names: what the bot last saw of them. */
export interface TopicTalkerUser {
  userId: string;
  /** Without a leading `@`; absent when the person has none. Shown as typed, matched lowercase. */
  username?: string;
  /** The display name (first + last). */
  name: string;
}

/** The admin who grants an entry. */
export interface TopicGranter {
  userId: string;
  name: string;
}

/** @name TopicTalker @description One person allowed to talk to the agent in a topic, keyed by user id. */
export interface TopicTalker extends TopicTalkerUser {
  addedAt: number;
  /** The granting admin's user id (the audit trail) and the name the list shows. */
  addedBy: string;
  addedByName: string;
}

/** @name TopicInvite @description A grant that waits for its person's first message, matched on the lowercase username. */
export interface TopicInvite {
  /** Lowercase, without `@`. */
  username: string;
  addedAt: number;
  addedBy: string;
  addedByName: string;
}

/**
 * @name TopicTalkersEntry
 * @description The list of one topic. `revision` is bumped on EVERY change and baked into the list's buttons, so a tap on
 * an old keyboard is told apart from a tap on the current one. It never restarts: an emptied list keeps its entry
 * (a tombstone), because a list that began again at revision 1 would let a keyboard drawn at revision 1 long ago act
 * on a different person.
 */
export interface TopicTalkersEntry {
  revision: number;
  talkers: TopicTalker[];
  invites: TopicInvite[];
}

/** The persisted record: the topic's serialised `SessionKey` → its list. */
export type TopicTalkersMap = Record<string, TopicTalkersEntry>;

/** An invitation that turned into a real entry because its person wrote. */
export interface ResolvedTopicInvite {
  /** The topic's serialised `SessionKey`. */
  threadKey: string;
  addedBy: string;
  addedByName: string;
}

/** The outcome of adding a talker: `already` when their id is listed (nothing changes). */
export type AddTalkerResult = 'added' | 'already';

/**
 * The outcome of adding a username invitation: `already` when a live one waits for the name, `listed` when a person of
 * that username is a talker of the topic already — in both nothing changes.
 */
export type AddInviteResult = AddTalkerResult | 'listed';

/** Where a person's right to talk in a topic comes from. */
export type TalkerScope = 'own' | 'general';

/** Lowercase form a username is matched on; a leading `@` is dropped. */
export function normaliseUsername(username: string): string {
  return username.replace(/^@/, '').toLowerCase();
}

function getOrCreateEntry(map: TopicTalkersMap, threadKey: string): TopicTalkersEntry {
  map[threadKey] ??= { revision: 0, talkers: [], invites: [] };
  return map[threadKey];
}

function markChanged(entry: TopicTalkersEntry): void {
  entry.revision += 1;
}

/** @description Add `user` to the topic's list. `already` when their id is listed (nothing changes); a waiting invite of the same username is consumed. */
export function addTalkerToMap(
  map: TopicTalkersMap,
  threadKey: string,
  user: TopicTalkerUser,
  granter: TopicGranter,
  now: number,
): AddTalkerResult {
  if (map[threadKey]?.talkers.some((talker) => talker.userId === user.userId)) return 'already';
  const entry = getOrCreateEntry(map, threadKey);
  const talker: TopicTalker = {
    userId: user.userId,
    name: user.name,
    addedAt: now,
    addedBy: granter.userId,
    addedByName: granter.name,
  };
  if (user.username) talker.username = user.username;
  entry.talkers.push(talker);
  if (user.username) {
    const lowercase = normaliseUsername(user.username);
    entry.invites = entry.invites.filter((invite) => invite.username !== lowercase);
  }
  markChanged(entry);
  return 'added';
}

/** @description Take `userId` off the topic's list. `false` when they were not on it. */
export function removeTalkerFromMap(map: TopicTalkersMap, threadKey: string, userId: string): boolean {
  const entry = map[threadKey];
  if (!entry) return false;
  const remaining = entry.talkers.filter((talker) => talker.userId !== userId);
  if (remaining.length === entry.talkers.length) return false;
  entry.talkers = remaining;
  markChanged(entry);
  return true;
}

/**
 * @description Add a username invitation. An invitation past {@link topicInviteTtlMs} counts as missing even when nobody
 * read the list since — it is replaced by a fresh one (new clock, new granter), never reported as «already».
 */
export function addInviteToMap(
  map: TopicTalkersMap,
  threadKey: string,
  username: string,
  granter: TopicGranter,
  now: number,
): AddInviteResult {
  const lowercase = normaliseUsername(username);
  const existing = map[threadKey];
  if (existing?.talkers.some((talker) => talker.username !== undefined && normaliseUsername(talker.username) === lowercase)) {
    return 'listed';
  }
  const waiting = existing?.invites.find((invite) => invite.username === lowercase);
  if (waiting && now - waiting.addedAt < topicInviteTtlMs) return 'already';
  const entry = getOrCreateEntry(map, threadKey);
  entry.invites = entry.invites.filter((invite) => invite !== waiting);
  entry.invites.push({ username: lowercase, addedAt: now, addedBy: granter.userId, addedByName: granter.name });
  markChanged(entry);
  return 'added';
}

/** @description Cancel a waiting invitation. `false` when none waits for the name. */
export function removeInviteFromMap(map: TopicTalkersMap, threadKey: string, username: string): boolean {
  const entry = map[threadKey];
  if (!entry) return false;
  const lowercase = normaliseUsername(username);
  const remaining = entry.invites.filter((invite) => invite.username !== lowercase);
  if (remaining.length === entry.invites.length) return false;
  entry.invites = remaining;
  markChanged(entry);
  return true;
}

/** @description Drop the invitations older than {@link topicInviteTtlMs} everywhere. `true` when any list changed. */
export function pruneExpiredInvitesInMap(map: TopicTalkersMap, now: number): boolean {
  let isChanged = false;
  for (const entry of Object.values(map)) {
    const alive = entry.invites.filter((invite) => now - invite.addedAt < topicInviteTtlMs);
    if (alive.length === entry.invites.length) continue;
    entry.invites = alive;
    markChanged(entry);
    isChanged = true;
  }
  return isChanged;
}

/**
 * @description The person with `user.username` wrote: every topic that waits for that name turns the invitation into an
 * entry by their id (a topic that lists them already just drops the invitation). Expired invitations are not honoured.
 * `resolved` are the topics that now list them newly; `isChanged` is true when any invitation was consumed, even one that
 * only expired.
 */
export function resolveInvitesInMap(
  map: TopicTalkersMap,
  user: TopicTalkerUser,
  now: number,
): { resolved: ResolvedTopicInvite[]; isChanged: boolean } {
  const resolved: ResolvedTopicInvite[] = [];
  let isChanged = false;
  if (!user.username) return { resolved, isChanged };
  const lowercase = normaliseUsername(user.username);
  for (const [threadKey, entry] of Object.entries(map)) {
    const invite = entry.invites.find((candidate) => candidate.username === lowercase);
    if (!invite) continue;
    const isExpired = now - invite.addedAt >= topicInviteTtlMs;
    const isAlreadyListed = entry.talkers.some((talker) => talker.userId === user.userId);
    entry.invites = entry.invites.filter((candidate) => candidate !== invite);
    markChanged(entry);
    isChanged = true;
    if (isExpired || isAlreadyListed) continue;
    entry.talkers.push({
      userId: user.userId,
      username: user.username,
      name: user.name,
      addedAt: now,
      addedBy: invite.addedBy,
      addedByName: invite.addedByName,
    });
    resolved.push({ threadKey, addedBy: invite.addedBy, addedByName: invite.addedByName });
  }
  return { resolved, isChanged };
}

/**
 * @description The person left the group (or was banned): drop their entries in every topic AND the waiting invitations for
 * their username, so coming back needs a new grant — an invitation left behind would turn into one on their first
 * message after rejoining. The username is the one the update carries plus the ones the lists stored for the id (the update
 * may carry none). Returns the topics where anything was dropped.
 */
export function removeUserFromMap(map: TopicTalkersMap, user: TopicTalkerUser): string[] {
  const usernames = new Set<string>();
  if (user.username) usernames.add(normaliseUsername(user.username));
  for (const entry of Object.values(map)) {
    for (const talker of entry.talkers) {
      if (talker.userId === user.userId && talker.username) usernames.add(normaliseUsername(talker.username));
    }
  }
  const topics: string[] = [];
  for (const [threadKey, entry] of Object.entries(map)) {
    const isTalkerRemoved = removeTalkerFromMap(map, threadKey, user.userId);
    const remainingInvites = entry.invites.filter((invite) => !usernames.has(invite.username));
    const isInviteRemoved = remainingInvites.length !== entry.invites.length;
    if (isInviteRemoved) {
      entry.invites = remainingInvites;
      markChanged(entry);
    }
    if (isTalkerRemoved || isInviteRemoved) topics.push(threadKey);
  }
  return topics;
}

/**
 * @description Refresh what the lists show of `user` (renamed, new or dropped @username). The revision is NOT bumped: the
 * order of a list never changes with a name, so an old keyboard still points at the same person. `true` when anything
 * was written.
 */
export function refreshIdentityInMap(map: TopicTalkersMap, user: TopicTalkerUser): boolean {
  let isChanged = false;
  for (const entry of Object.values(map)) {
    for (const talker of entry.talkers) {
      if (talker.userId !== user.userId) continue;
      if (talker.name !== user.name) {
        talker.name = user.name;
        isChanged = true;
      }
      if (talker.username !== user.username) {
        if (user.username) talker.username = user.username;
        else delete talker.username;
        isChanged = true;
      }
    }
  }
  return isChanged;
}

/**
 * @description The served group changed (a re-pair): the lists of every other space are emptied, so nobody keeps a grant in a
 * chat the bot no longer serves. The emptied entries stay — their revisions must never restart, or pairing back to that
 * group would let an old keyboard match a new list. A key no codec reads can never match a topic and is deleted. Returns the
 * topics that were emptied or deleted.
 */
export function dropOtherSpacesFromMap(map: TopicTalkersMap, spaceId: string): string[] {
  const dropped: string[] = [];
  for (const [threadKey, entry] of Object.entries(map)) {
    const key = tryKeyFromString(threadKey);
    if (key?.space === spaceId) continue;
    if (!key) {
      delete map[threadKey];
      dropped.push(threadKey);
      continue;
    }
    if (entry.talkers.length === 0 && entry.invites.length === 0) continue;
    entry.talkers = [];
    entry.invites = [];
    markChanged(entry);
    dropped.push(threadKey);
  }
  return dropped;
}

/** @description Ids allowed to talk in `threadKey`: its own list plus the group-wide list of the General topic. */
export function getEffectiveTalkerIdsInMap(map: TopicTalkersMap, threadKey: string, generalKey: string): Set<string> {
  const ids = new Set<string>();
  for (const talker of map[threadKey]?.talkers ?? []) ids.add(talker.userId);
  for (const talker of map[generalKey]?.talkers ?? []) ids.add(talker.userId);
  return ids;
}

/** @description How `userId` may talk in `threadKey`: from its own list (also General's, in General itself), from General's, or not at all. */
export function getTalkerScopeInMap(map: TopicTalkersMap, threadKey: string, generalKey: string, userId: string): TalkerScope | null {
  if (map[threadKey]?.talkers.some((talker) => talker.userId === userId)) return 'own';
  if (threadKey !== generalKey && map[generalKey]?.talkers.some((talker) => talker.userId === userId)) return 'general';
  return null;
}
