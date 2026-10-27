/**
 * The topic names the bot sets aside while a topic has no binding yet, and what each may be used for. A leaf module (no
 * `bot.ts`, no environment), so a test can reach it.
 */

/**
 * A name seen for an unbound topic. `isFromAdmin`: an authorised user made the topic or renamed it. A name only anyone else
 * gave is kept for ONE use — a fuzzy match against a folder's name — and never written onto a binding, because the
 * binding's topic name goes unescaped into the agent's thread-context preamble: the topic that name matched is bound under
 * the folder's own name instead ({@link getAutoBindTopicName}).
 */
export interface PendingTopicName {
  name: string;
  ts: number;
  isFromAdmin: boolean;
}

/** @description The entry, unless it is missing or older than `ttlMs`. */
export function getFreshPendingTopicName(entry: PendingTopicName | undefined, nowMs: number, ttlMs: number): PendingTopicName | undefined {
  return entry !== undefined && nowMs - entry.ts < ttlMs ? entry : undefined;
}

/** @description The name a binding may carry: a fresh one an authorised user gave, else `undefined`. */
export function getTrustedPendingTopicName(entry: PendingTopicName | undefined, nowMs: number, ttlMs: number): string | undefined {
  const fresh = getFreshPendingTopicName(entry, nowMs, ttlMs);
  return fresh?.isFromAdmin ? fresh.name : undefined;
}

/**
 * @description The topic name an auto-bind writes onto the binding: the name itself when an authorised user gave it, else
 * the name of the folder it matched — a stranger's spelling (`BIND_Deferred` for `bind-deferred`) is text the bot never
 * vetted, and the folder's own name says the same.
 */
export function getAutoBindTopicName(entry: PendingTopicName, folderName: string): string {
  return entry.isFromAdmin ? entry.name : folderName;
}
