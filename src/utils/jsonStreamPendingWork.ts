/**
 * @description The json-stream "working" judgement for the agent's OWN pending work between turns: a background task
 * (background Bash / Monitor / sub-agent), the turn a finished task is about to start, a session-only `CronCreate` job.
 * A stop kills every one of them with the process, so each counts as working (lifecycle plan L-D2) — but only for a
 * bounded time, so a forgotten task cannot pin a process forever.
 *
 * Measured on the real CLI (2.1.310): a background task's end writes `task_notification`, then empties the
 * background list, then starts the task's own turn, whose first output comes only after the API round-trip (1.3 s on
 * a small context, 3–5 s on a large one). The gap read as idle once, and the idle check stopped the process right as
 * the agent was being woken to read its task's result.
 */

/**
 * How long a background task's notification holds the process for the turn it starts. The CLI starts that turn ~0.1 s
 * after the notification; the grace only bounds a notification whose turn never shows (one folded into a running
 * turn, a task stopped from inside a turn).
 */
export const notificationTurnGraceMs = 30_000;

/**
 * How long pending work (background tasks, scheduled jobs) holds the process after the conversation's LAST turn
 * ended. Every turn resets it — a watchdog that re-arms itself keeps its process for as long as it keeps looping — so
 * only a task nobody heard from in that time (a forgotten dev server, a `sleep infinity`) is let go.
 */
export const pendingWorkHoldDefaultMs = 6 * 60 * 60 * 1000;
// A test instance shortens it through `CHARNESS_TEST_TIMINGS` `backgroundHoldMaxMs` (`createAdapter.registerPendingWorkHoldMs`).

/** @name PendingWorkInput @description The session state the pending-work judgement reads, with its clock. */
export interface PendingWorkInput {
  now: number;
  backgroundTaskCount: number;
  scheduledJobCount: number;
  /** When the conversation's last turn ended (the process start before its first turn). */
  lastTurnEndedAt: number;
  holdMs: number;
  /** When a background task's notification announced its turn; `null` when none is pending. */
  notificationTurnPendingSince: number | null;
}

/**
 * @description The hold left for the pending background tasks / scheduled jobs: `null` when there are none, `0` once
 * the hold is spent.
 */
export function getPendingWorkHoldRemainingMs(input: PendingWorkInput): number | null {
  if (input.backgroundTaskCount === 0 && input.scheduledJobCount === 0) return null;
  return Math.max(0, input.holdMs - (input.now - input.lastTurnEndedAt));
}

/** @description Whether a background task's notification still announces a turn that has not shown yet (within the grace). */
export function checkIsNotificationTurnPending(input: Pick<PendingWorkInput, 'now' | 'notificationTurnPendingSince'>): boolean {
  return input.notificationTurnPendingSince !== null && input.now - input.notificationTurnPendingSince < notificationTurnGraceMs;
}

/** @description Whether the agent's own pending work must keep its process: tasks or jobs within the hold, or a task's turn on its way. */
export function checkHasPendingWork(input: PendingWorkInput): boolean {
  const holdRemainingMs = getPendingWorkHoldRemainingMs(input);
  return (holdRemainingMs !== null && holdRemainingMs > 0) || checkIsNotificationTurnPending(input);
}
