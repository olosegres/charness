/**
 * @description What keeps an agent process "working" (lifecycle plan L-D2), as NAMED signals instead of one boolean: the idle fire
 * logs which of them held a process, and tells the person in plain words why the compaction it would have made was skipped.
 * "Working" is a running turn plus the signals the backend reports apart from it — a pending interactive question excuses the
 * turn alone, never one of these.
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

/** A running turn, or one of the {@link BackgroundWorkSignal}s. */
export type WorkingSignal = { kind: 'turn' } | BackgroundWorkSignal;

/** @description The signal in the words of the bot's log, naming its figure when it has one (`unconsumed input 2`). */
export function describeWorkingSignal(signal: WorkingSignal): string {
  switch (signal.kind) {
    case 'turn': return 'busy turn';
    case 'backgroundTasks': return `background tasks ${signal.count}`;
    case 'scheduledJobs': return `scheduled jobs ${signal.count}`;
    case 'taskTurnOnItsWay': return 'task result turn on its way';
    case 'unconsumedInput': return `unconsumed input ${signal.count}`;
    case 'compaction': return 'compaction in flight';
  }
}

/** @description The signals in the words of the bot's log, comma-separated (`busy turn, unconsumed input 2`). */
export function describeWorkingSignals(signals: readonly WorkingSignal[]): string {
  return signals.map(describeWorkingSignal).join(', ');
}

/** @description The reason the person is told when an idle compaction is skipped because the process was held. */
export type IdleHeldNoticeReason = 'backgroundWork' | 'unconsumedInput' | 'turn';

/**
 * @description Which reason the topic's notice gives for a process held at the idle mark: the agent's own background work first
 * (it is what survives a quiet topic for hours), then a message it has not taken in, then a turn it is still running; `null` when
 * only a compaction is in flight (it is the very thing the idle mark would have done — nothing to explain).
 */
export function getIdleHeldNoticeReason(signals: readonly WorkingSignal[]): IdleHeldNoticeReason | null {
  const kinds = new Set(signals.map((signal) => signal.kind));
  if (kinds.has('backgroundTasks') || kinds.has('scheduledJobs') || kinds.has('taskTurnOnItsWay')) return 'backgroundWork';
  if (kinds.has('unconsumedInput')) return 'unconsumedInput';
  if (kinds.has('turn')) return 'turn';
  return null;
}
