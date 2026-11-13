/**
 * @description Minimal shape of the bot's per-thread status coalescer that
 * {@link clearStatusCoalescer} needs to drop. Mirrors the load-bearing
 * fields of `bot.ts`'s `StatusCoalesceState`.
 */
export interface ClearableStatusCoalescer {
  /** Latest status frame not yet sent. `null` = nothing pending. */
  pendingText: string | null;
  /**
   * Armed timer that would resume a flush deferred during a 429 cooldown.
   * `null` = none. Optional so older callers that don't track it still type.
   */
  deferRetryTimer?: NodeJS.Timeout | null;
}

/**
 * @description Drop a thread's not-yet-sent status frame when its session stops: a «🔧 tool» or «working…» frame queued before
 * the stop must not appear after it. The frame already being sent (`flushStatusCoalescer` has taken its text) is at the API
 * layer and is left alone. The agent's TEXT is not dropped here: a stop gives it one final attempt
 * (`utils/groupOutputBacklog.ts` `startFinalGroupOutputAttempt`).
 *
 * Idempotent: clearing an already-empty coalescer is a no-op.
 */
export function clearStatusCoalescer(coalescer: ClearableStatusCoalescer | undefined): void {
  if (!coalescer) return;
  // Nulling `pendingText` makes the running flush loop (if any) exit on its
  // next iteration without sending a stale frame. The coalescer can also
  // hold a defer-retry timer armed during a 429 cooldown — cancel it too,
  // otherwise it would fire into a stopped session.
  coalescer.pendingText = null;
  if (coalescer.deferRetryTimer) {
    clearTimeout(coalescer.deferRetryTimer);
    coalescer.deferRetryTimer = null;
  }
}
