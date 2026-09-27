/**
 * @description Pure idle-watchdog decision for the `claude-json-stream` adapter's
 * `isBusy` flag — the flag that (via `checkIsBusy` → `checkShouldKeepTyping`)
 * keeps the native Telegram "agent is typing…" indicator alive.
 *
 * ROOT-CAUSE CONTEXT. In `claudeJsonStreamAdapter` `isBusy` has exactly ONE
 * clear-point: a processed terminal `result` line (`handleTurnEnd`). Every other
 * event only ever SETS it (`sendInput`, a text/thinking delta, a `tool_use`, a
 * surfaced question). So if that single `result` is ever missed — an `interrupt`
 * the CLI aborts without a final `result`, a process that goes quiet after the
 * answer, a `result` shape a newer CLI stops emitting — `isBusy` sticks `true`
 * forever and the typing indicator hangs. Observed live: an otherwise-idle topic
 * firing `sendChatAction('typing')` every 4s for an hour+ after the agent was
 * already done. The typing loop self-stops only when `checkShouldKeepTyping`
 * (`isBusy || isOutputStreaming`) goes false and has NO absolute bound, so a
 * single stuck flag is unbounded.
 *
 * This is the bounded safety net: when the session is flagged busy but stdout has
 * been SILENT for {@link busyIdleWatchdogMs} AND nothing is genuinely in flight
 * (no outstanding tool, no active sub-agent, no pending user question, no
 * un-emitted answer batch), the turn has really ended — clear `isBusy`.
 *
 * SILENCE — not wall-clock since the turn started — is the signal, so a
 * legitimately long turn is NEVER cut short: a working agent is always doing one
 * of (a) streaming text/thinking deltas → stdout activity, (b) waiting on a tool
 * → `outstandingToolCount > 0`, (c) waiting on a sub-agent → `subagentActive`,
 * (d) waiting on the user → `hasPendingQuestion`. Each of those VETOES the clear.
 * The watchdog can therefore only fire once the work is provably done but the
 * terminal `result` never arrived.
 */

/**
 * @description How long stdout may be silent, with nothing in flight, before a
 * busy session is force-declared idle. Comfortably longer than the only silent
 * gap a working-yet-nothing-in-flight turn has (pre-first-token latency), far
 * shorter than the reported hour+ hang.
 */
export const busyIdleWatchdogMs = 120_000;

export interface BusyIdleWatchdogInput {
  /** Is the session currently flagged busy (drives the typing indicator)? */
  isBusy: boolean;
  /** ms since the last stdout byte was consumed for this session. */
  msSinceStdoutActivity: number;
  /** The silence threshold (injected so tests need no fake clock). */
  idleTimeoutMs: number;
  /** Tool calls started but whose `tool_result` hasn't returned (Bash/Read/Task/…). */
  outstandingToolCount: number;
  /** A sub-agent delegation is mid-flight. */
  subagentActive: boolean;
  /** A user question is awaiting an answer. */
  hasPendingQuestion: boolean;
  /** Answer text still sits un-emitted in the coalesce batch. */
  hasUnflushedAnswer: boolean;
}

/**
 * @description True iff a busy session should be force-cleared to idle: it is
 * busy, stdout has been silent past the threshold, and every "in flight" signal
 * is absent. Any single in-flight signal (tool / sub-agent / question / batched
 * answer) VETOES the clear so a legitimately mid-turn agent is never truncated.
 */
export function checkShouldClearBusyOnIdle(input: BusyIdleWatchdogInput): boolean {
  if (!input.isBusy) return false;
  if (input.msSinceStdoutActivity < input.idleTimeoutMs) return false;
  if (input.outstandingToolCount > 0) return false;
  if (input.subagentActive) return false;
  if (input.hasPendingQuestion) return false;
  if (input.hasUnflushedAnswer) return false;
  return true;
}

/**
 * @description How long stdout may be silent before a compaction the CLI never
 * confirmed is declared dead. Same signal, same reasoning as
 * {@link busyIdleWatchdogMs}: while it compacts, the CLI heartbeats
 * `system/status status:"compacting"` every few seconds, so real silence this long
 * means the process is gone — not that it is thinking.
 */
export const compactionSilenceTimeoutMs = 120_000;

/**
 * @description Absolute backstop on one compaction wait. Only reachable by a CLI
 * that keeps talking forever without ever finishing (a retry loop), which silence
 * alone cannot catch; without it the caller's promise — and with it the
 * "a compaction is running" guard — would never settle.
 */
export const compactionAbsoluteTimeoutMs = 30 * 60 * 1000;

/** How often the compaction wait re-evaluates its verdict. */
export const compactionWaitPollMs = 15_000;

export type CompactionWaitVerdict = 'keepWaiting' | 'timedOutSilent' | 'timedOutTotal';

/** How a timed-out wait is REPORTED (decided by {@link getCompactionTimeoutOutcome}). */
export type CompactionTimeoutOutcome =
  /** It demonstrably worked; only the frame carrying the token counts is missing. */
  | { kind: 'succeededWithoutTokenCounts' }
  | { kind: 'failed'; reason: 'silent' | 'total' };

/**
 * @description What a timed-out compaction wait should report.
 *
 * `sawSuccess` means the CLI already sent `compact_status success` and only the
 * boundary frame (which carries the pre/post token counts) never followed. The
 * context IS compacted at that point, so reporting failure would suppress the
 * notice over an already-compacted session and leave the operator with the same
 * silence this whole fix exists to remove. Token counts are a diagnostic; the
 * compaction is the outcome.
 */
export function getCompactionTimeoutOutcome(input: {
  verdict: Exclude<CompactionWaitVerdict, 'keepWaiting'>;
  sawSuccess: boolean;
}): CompactionTimeoutOutcome {
  if (input.sawSuccess) return { kind: 'succeededWithoutTokenCounts' };
  return { kind: 'failed', reason: input.verdict === 'timedOutSilent' ? 'silent' : 'total' };
}

/**
 * @description Decide whether to keep waiting for a compaction to confirm.
 *
 * ROOT-CAUSE CONTEXT. This wait used to be a flat 3-minute cap on TOTAL elapsed
 * time, and it produced the operator's report that idle compaction "runs but never
 * says so": the compaction fired, the CLI compacted successfully, and the bot had
 * already given up and posted nothing. Measured on the real session that exposed
 * it — `compact_metadata.duration_ms: 195649`, i.e. 3 min 15.6 s against a 180 s
 * cap, missing by 15 seconds. Elapsed time is the wrong bound: how long a summary
 * takes scales with the context being summarised, so ANY fixed cap is a guess that
 * a big enough session beats, and compact-on-idle exists precisely FOR big
 * sessions — the bound was guaranteed to fail exactly where the feature matters.
 *
 * So silence decides instead, and the absolute cap survives only as a backstop
 * against a CLI that never finishes at all. Silence is checked FIRST: for a dead
 * process both bounds can be past, and "still talking, never finished" would be
 * the wrong report.
 */
export function getCompactionWaitVerdict(input: {
  /** ms since the last stdout byte was consumed for this session. */
  msSinceStdoutActivity: number;
  /** ms since the `/compact` turn was written to stdin. */
  msSinceCompactionStarted: number;
  /** Silence threshold (injected so tests need no fake clock). */
  silenceTimeoutMs: number;
  /** Absolute backstop (injected for the same reason). */
  absoluteTimeoutMs: number;
}): CompactionWaitVerdict {
  if (input.msSinceStdoutActivity >= input.silenceTimeoutMs) return 'timedOutSilent';
  if (input.msSinceCompactionStarted >= input.absoluteTimeoutMs) return 'timedOutTotal';
  return 'keepWaiting';
}
