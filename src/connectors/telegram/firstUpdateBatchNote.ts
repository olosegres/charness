/**
 * @description Tells whether the updates that waited while the bot was down are handled — the question the topic status marks ask before
 * they write a name (an owner's rename made during the downtime must be learned first). Telegram answers a `getUpdates` at once when
 * updates wait, and holds the long poll open (Telegraf asks for 50 s) when none does. So «the first poll was answered and the dispatcher
 * — which queues what it brought — is empty» means they are handled, and a first poll still open after a short hold means NONE waited:
 * the marks must not stay held back for the whole poll. «No update is in flight» alone says nothing before the first poll returned, and
 * none between two batches.
 */
import type { CallApiHost } from '../../outputTrace';

/**
 * How long the first `getUpdates` may stay unanswered before it counts as «nothing waited»: far more than a round trip to Telegram, far
 * less than the long poll's 50 s — ❓ would otherwise show that much later after every restart.
 */
export const firstPollHoldMs = 3_000;

/** @name FirstUpdateBatchNote @description What {@link installFirstUpdateBatchNote} gives back. */
export interface FirstUpdateBatchNote {
  /**
   * Whether the updates that waited while the bot was down are handled: the first `getUpdates` was answered and `pendingUpdateCount`
   * (what the dispatcher still holds) is 0, or that first poll is still open after {@link firstPollHoldMs} — Telegram had nothing for it.
   */
  checkIsBacklogHandled: (pendingUpdateCount: number) => boolean;
}

/** What the note reads the time from — a test's clock instead of the real one. */
export interface FirstUpdateBatchNoteOptions {
  getNowMs?: () => number;
  holdMs?: number;
}

/** @description Wrap `host.callApi` so the first `getUpdates` is noted — when it was sent and when it was answered; every call and every answer goes through untouched. */
export function installFirstUpdateBatchNote(host: CallApiHost, options: FirstUpdateBatchNoteOptions = {}): FirstUpdateBatchNote {
  const getNowMs = options.getNowMs ?? Date.now;
  const holdMs = options.holdMs ?? firstPollHoldMs;
  let isFirstBatchFetched = false;
  /** When the poll now open was sent; `null` while none is (a poll that failed leaves none: the next one starts its own hold). */
  let openPollSentAtMs: number | null = null;
  const originalCallApi = host.callApi.bind(host);
  host.callApi = async (method, payload, callOptions) => {
    if (method !== 'getUpdates') return originalCallApi(method, payload, callOptions);
    openPollSentAtMs ??= getNowMs();
    try {
      const answer = await originalCallApi(method, payload, callOptions);
      isFirstBatchFetched = true;
      return answer;
    } finally {
      openPollSentAtMs = null;
    }
  };
  return {
    checkIsBacklogHandled: (pendingUpdateCount) => {
      if (isFirstBatchFetched) return pendingUpdateCount === 0;
      return openPollSentAtMs !== null && getNowMs() - openPollSentAtMs >= holdMs;
    },
  };
}
