import { keyToString, tryKeyFromString, type SessionKey } from '../sessionKey';
import type { RequestOrigin } from './types';

/**
 * @description The MERGE rule of the request ledger, in one place: a new request
 * supersedes an earlier open one ONLY when both have the same group key — the
 * conversation (the surface and the topic / thread / issue the message belongs
 * to, i.e. the `SessionKey`) AND the requester. Two people writing in a row in
 * one topic therefore keep two open requests, each owed its own answer; two
 * messages in a row from one person merge into the newer request.
 *
 * The requester is a connector-owned fact in the origin's attributes (a Telegram
 * user id, a tracker account id, the scheduler's marker); an origin without one
 * reads as the empty requester, so every such request in a conversation shares
 * one group — the behaviour the ledger had before requesters existed.
 */

/** The origin attribute that names who raised the request (the part of the group key the conversation does not carry). */
export const requestRequesterAttribute = 'requester';

/**
 * Separates the conversation key from the requester in the persisted group key:
 * the ASCII unit separator, which no `SessionKey` codec produces (keys are
 * printable); the requester is URI-encoded so it can never contain it either.
 */
const requestGroupSeparator = '\u001f';

/**
 * @name RequestGroupKey
 * @description What an open request is filed under: its conversation and its requester.
 */
export interface RequestGroupKey {
  conversation: SessionKey;
  requester: string;
}

/** @description The requester an origin names, or the empty requester when it names none. */
export function getRequestRequester(origin: RequestOrigin): string {
  return origin.attributes[requestRequesterAttribute] ?? '';
}

/** @description The group a request of `origin` in `conversation` belongs to. */
export function getRequestGroupKey(conversation: SessionKey, origin: RequestOrigin): RequestGroupKey {
  return { conversation, requester: getRequestRequester(origin) };
}

/**
 * @description The persisted form (`state.json` `openRequests` field name). An
 * empty requester yields the bare conversation key, so entries written before
 * requesters existed read back unchanged.
 */
export function requestGroupKeyToString(group: RequestGroupKey): string {
  const conversationKey = keyToString(group.conversation);
  return group.requester === '' ? conversationKey : `${conversationKey}${requestGroupSeparator}${encodeURIComponent(group.requester)}`;
}

/** @description Non-throwing decoder of {@link requestGroupKeyToString}; `null` for a field of an unknown platform. */
export function tryRequestGroupKeyFromString(serialized: string): RequestGroupKey | null {
  const separatorIndex = serialized.indexOf(requestGroupSeparator);
  const conversationKey = separatorIndex === -1 ? serialized : serialized.slice(0, separatorIndex);
  const conversation = tryKeyFromString(conversationKey);
  if (!conversation) return null;
  const requester = separatorIndex === -1 ? '' : decodeURIComponent(serialized.slice(separatorIndex + 1));
  return { conversation, requester };
}
