/**
 * @description Pure decision for whether the native "agent is typing" state
 * should keep showing for a topic (S3).
 *
 * The typing indicator persists while a topic has anything still to show OR its
 * agent is still working — and clears only when the topic is truly drained AND
 * idle. Extracted so the rule is unit-testable without the Telegraf / adapter
 * machinery; `bot.ts` supplies the two live readings (output-queue streaming and
 * adapter busy).
 */

export interface TypingActiveInput {
  /** Is real agent output mid-flight (queued / debouncing / sending / drafting)? */
  isOutputStreaming: boolean;
  /** Is the thread's adapter still working (its `checkIsBusy`)? */
  isAdapterBusy: boolean;
  /**
   * Is a BOT-ISSUED compaction in flight for this thread (`/compact`, the idle
   * watchdog, or the agent's `compact_conversation`)?
   *
   * A third input is needed because the other two are BOTH false during a
   * compaction on at least one backend: OpenCode sets no busy flag for its
   * `summarize` turn, and neither backend streams output while summarising. A
   * compaction measured at 43 s (and up to 3+ minutes on a large context) would
   * therefore leave the topic showing nothing at all — the silence this input
   * exists to remove.
   */
  isCompacting: boolean;
}

/**
 * @description Keep the typing indicator alive while output is streaming, the
 * agent is busy, OR a bot-issued compaction is running; stop only when ALL three
 * are false (drained + idle + not compacting).
 */
export function checkShouldKeepTyping(input: TypingActiveInput): boolean {
  return input.isOutputStreaming || input.isAdapterBusy || input.isCompacting;
}
