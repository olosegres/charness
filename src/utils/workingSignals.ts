/**
 * @description What keeps an agent process "working" (lifecycle plan L-D2), as NAMED signals instead of one boolean: a backend
 * reports the ones that are not a running turn, and a reader can tell which of them holds the process.
 * A pending interactive question excuses the running turn alone, never one of these.
 */

/** The parts of "working" that are not a running turn. */
export type BackgroundWorkSignal =
  /** Background tasks the CLI still runs (a background Bash, a Monitor, a sub-agent), within the pending-work hold. */
  | { kind: 'backgroundTasks'; count: number }
  /** Session-only scheduled jobs the process holds, within the pending-work hold. */
  | { kind: 'scheduledJobs'; count: number }
  /** A finished task's notification announced the turn it starts; the turn has not shown yet (within a short grace). */
  | { kind: 'taskTurnOnItsWay' }
  /** Messages written to the CLI that it has not taken in, within the grace the CLI has to start the turn that does. */
  | { kind: 'unconsumedInput'; count: number }
  /** A bot-issued `/compact` is running, within the longest the bot waits for one. */
  | { kind: 'compaction' };
