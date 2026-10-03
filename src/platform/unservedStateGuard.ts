import type { PlatformId, SessionKey } from '../sessionKey';
import { tryKeyFromString } from '../sessionKey';
import type { StateStore } from '../state';
import { checkIsServedConversation } from './connectorSet';

/**
 * @description R13 (Jira connector plan J4b): an instance never boots on another
 * platform's state. Every boot scan already skips a conversation it does not
 * serve, but the state is shared: a Telegram instance's save, unbind or sweep
 * rewrites the file another platform's conversations live in, and two instances
 * on one `DATA_DIR` would fight over it. So a `DATA_DIR` that holds bindings,
 * open requests, schedules or armed retries of a platform outside `CONNECTORS`
 * stops the start instead.
 */

/** What a conversation left in the state, named for the start-up message. */
export type PersistedConversationKind = 'bindings' | 'open requests' | 'schedules' | 'armed retries';

export interface PersistedConversation {
  kind: PersistedConversationKind;
  key: SessionKey;
}

/** The part of the store the guard reads. */
export type PersistedConversationSource = Pick<StateStore, 'listBindings' | 'getOpenRequests' | 'getSchedules' | 'getApiRetries'>;

/** Keys that do not parse are skipped, as every boot scan skips them. */
function getParsedKeys(kind: PersistedConversationKind, keyStrings: readonly string[]): PersistedConversation[] {
  return keyStrings.flatMap((keyString) => {
    const key = tryKeyFromString(keyString);
    return key ? [{ kind, key }] : [];
  });
}

export function getPersistedConversations(source: PersistedConversationSource): PersistedConversation[] {
  return [
    ...source.listBindings().map(({ key }): PersistedConversation => ({ kind: 'bindings', key })),
    ...getParsedKeys('open requests', Object.keys(source.getOpenRequests())),
    ...getParsedKeys('schedules', Object.values(source.getSchedules()).map((schedule) => schedule.threadKey)),
    ...getParsedKeys('armed retries', Object.keys(source.getApiRetries())),
  ];
}

/**
 * @description The start-up error for conversations outside `platforms`, counted
 * per platform and kind (no keys: they name chats and issues); `null` when
 * every conversation is served.
 */
export function getUnservedStateError(
  conversations: readonly PersistedConversation[],
  platforms: ReadonlySet<PlatformId>,
): string | null {
  const countsByPlatform = new Map<PlatformId, Map<PersistedConversationKind, number>>();
  for (const { kind, key } of conversations) {
    if (checkIsServedConversation(key, platforms)) continue;
    const counts = countsByPlatform.get(key.platform) ?? new Map<PersistedConversationKind, number>();
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    countsByPlatform.set(key.platform, counts);
  }
  if (countsByPlatform.size === 0) return null;
  const details = [...countsByPlatform].map(([platform, counts]) =>
    `${platform} (${[...counts].map(([kind, count]) => `${kind}: ${count}`).join(', ')})`);
  return `DATA_DIR holds conversations of a platform this instance does not serve — ${details.join('; ')}. ` +
    'Start the instance that serves them on this DATA_DIR, or give this one a DATA_DIR of its own.';
}
