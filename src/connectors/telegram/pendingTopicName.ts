/**
 * The topic names the bot sets aside while a topic has no binding yet, and what each may be used for. A leaf module (no
 * `bot.ts`, no environment), so a test can reach it.
 */

/**
 * A name seen for an unbound topic. `isFromAdmin`: an authorised user made the topic or renamed it. A name only anyone else
 * gave is kept for ONE use — a fuzzy match against a folder's name, which bounds what it can say — and never written onto a
 * binding, because the binding's topic name goes unescaped into the agent's thread-context preamble.
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
