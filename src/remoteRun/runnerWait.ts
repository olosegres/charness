import { planInterrupt, type InterruptSignal } from './exitCodes';
import { checkHasCapability, checkIsRunnerPaused, formatLastSeen, type RunnerCapability, type RunnerReport } from './probe';
import { RemoteRunError } from './remoteRunError';
import type { RunnerPick } from './runners';
import type { RunnersConfig } from './runnersConfig';

/**
 * @description The wait of `charness remote-run --needs <capability>`: when the only runners that could take the job are PAIRED ones
 * that are offline right now (a laptop that slept, a link that restarts) or have their Mac's lid shut, the command waits for one of them instead of failing — it says
 * so once, looks again every few seconds and gives up after `--runner-wait` (default 15 min, `0` = fail at once). A runner nothing is known
 * to be able to do the job (no runner with the capability at all, or one never seen) is not waited for: that is exit 125 at once, as in
 * phase 1. Hand-made runners (plain ssh) are never waited for either — their offline state is not part of a design.
 */

const msPerSecond = 1000;
const secondsPerMinute = 60;
const secondsPerHour = 3600;

/** @name RunnerWaitPlan @description What a failed pick is worth waiting for. */
export interface RunnerWaitPlan {
  /** The offline paired runners that, when they were last seen, could do the job. */
  runnerNames: string[];
  /** «mac offline since 2026-11-01 14:02 UTC», for the line that says the command is waiting. */
  description: string;
}

/**
 * @description Is there a PAIRED runner worth waiting for — offline right now, or linked with its Mac's lid shut (it takes no new job either, and opening it
 * brings it back)? Only when a capability is needed and no runner is named: a runner is worth it when its last snapshot had the capability and Pueue and nobody
 * paused it (a paused one would be skipped when it came back). `null` = fail now.
 */
export function planRunnerWait(config: RunnersConfig, reports: readonly RunnerReport[], wanted: { runner: string | null; needs: RunnerCapability | null }): RunnerWaitPlan | null {
  const needs = wanted.needs;
  if (needs === null || wanted.runner !== null) return null;
  const candidates = reports.filter((report): report is Extract<RunnerReport, { status: 'offline' | 'lid-closed' }> => {
    // A busy runner is there, not away: nothing to wait for (it is picked from its last snapshot, or the pick says why not).
    if (report.status === 'online' || report.status === 'busy' || report.lastProbe === null) return false;
    const isPaired = config.runners.some((runner) => runner.name === report.name && runner.paired !== undefined);
    return isPaired && !checkIsRunnerPaused(report) && report.lastProbe.pueueVersion !== null && checkHasCapability(report.lastProbe, needs);
  });
  if (candidates.length === 0) return null;
  return {
    runnerNames: candidates.map((report) => report.name),
    description: candidates.map(describeWaitedRunner).join(', '),
  };
}

/** «mac offline since 2026-11-01 14:02 UTC», or «mac has its lid closed». */
function describeWaitedRunner(report: Extract<RunnerReport, { status: 'offline' | 'lid-closed' }>): string {
  if (report.status === 'lid-closed') return `${report.name} has its lid closed`;
  return `${report.name} offline${report.lastSeenAtMs === null ? '' : ` since ${formatLastSeen(report.lastSeenAtMs)}`}`;
}

/** @description `15 min`, `90 s`, `2 h`, `1 h 30 min`: a wait in the words a person would use. */
export function formatWaitDuration(totalSeconds: number): string {
  if (totalSeconds < secondsPerMinute) return `${totalSeconds} s`;
  const hours = Math.floor(totalSeconds / secondsPerHour);
  const minutes = Math.floor((totalSeconds % secondsPerHour) / secondsPerMinute);
  const seconds = totalSeconds % secondsPerMinute;
  const parts = [...(hours > 0 ? [`${hours} h`] : []), ...(minutes > 0 ? [`${minutes} min`] : []), ...(hours === 0 && seconds > 0 ? [`${seconds} s`] : [])];
  return parts.join(' ');
}

/** The poll as a person reads it: «10 s», or «500 ms» for the test window's sub-second polls. */
function formatPoll(pollMs: number): string {
  return pollMs < msPerSecond ? `${pollMs} ms` : formatWaitDuration(Math.round(pollMs / msPerSecond));
}

/** The least an attempt made DURING the wait is worth: a probe through ssh cannot answer in less, so with less left the wait is over. */
export const minWaitAttemptMs = 1000;

/** One try at choosing a runner: the choice, or why there is none and whether it is worth waiting. */
export type RunnerAttempt<TChoice> =
  | { ok: true; choice: TChoice }
  | { ok: false; failure: Extract<RunnerPick, { ok: false }>; wait: RunnerWaitPlan | null };

export interface RunnerWaitLoop<TChoice> {
  /**
   * Probe and pick once. `budgetMs` is what is left of the wait once it has begun (the probe must end within it), `null` for the first attempt.
   * `stop` aborts when the user interrupts: the attempt ends what it started (its ssh calls) at once, and whatever it returns after that is not used.
   */
  attempt: (budgetMs: number | null, stop: AbortSignal) => Promise<RunnerAttempt<TChoice>>;
  needs: RunnerCapability | null;
  /** `--runner-wait` in seconds; `0` = never wait. */
  waitSeconds: number;
  pollMs: number;
  now: () => number;
  /** Resolves after `ms`, or at once when `stop` aborts. */
  sleep: (ms: number, stop: AbortSignal) => Promise<void>;
  /** Calls `onInterrupt` with the signal when the user interrupts (Ctrl-C, SIGTERM, SIGHUP), until the returned function is called. */
  watchInterrupts: (onInterrupt: (signal: InterruptSignal) => void) => () => void;
  say: (line: string) => void;
}

/**
 * @description Choose a runner, waiting for an offline paired one when that is worth it: the choice as soon as an attempt gives one IN TIME;
 * a {@link RemoteRunError} with the pick's own message (and, after waiting, how long it waited) when nothing can be waited for or the wait
 * ran out; and, if the user interrupts, the interrupt's exit code (130 / 143 / 129).
 *
 * An interrupt is heard from the first attempt to the last, in a sleep AND in a probe: it aborts what is in flight, and after every await the
 * loop looks at it first — a runner an attempt picked after the interrupt is not taken, and no other attempt starts.
 *
 * `--runner-wait` is a promise about when the command stops waiting, so once the wait has begun no attempt starts with less than
 * {@link minWaitAttemptMs} left, every attempt is told the time it has (its probe is cut at it), and an answer that comes after the
 * deadline is refused — the job is not started late. The last sleep is cut so that one more look still fits before the deadline.
 */
export async function chooseRunnerWithWait<TChoice>(loop: RunnerWaitLoop<TChoice>): Promise<TChoice> {
  type FailedAttempt = Extract<RunnerAttempt<TChoice>, { ok: false }>;
  const startedAtMs = loop.now();
  const deadlineMs = startedAtMs + loop.waitSeconds * msPerSecond;
  /** Set once the wait has begun (announced): the attempt that made it worth waiting, then the latest failed one. */
  let waiting: { lastFailure: FailedAttempt } | null = null;
  const stop = new AbortController();
  const interrupted: { signal: InterruptSignal | null } = { signal: null };
  const stopWatching = loop.watchInterrupts((signal) => {
    interrupted.signal ??= signal;
    stop.abort();
  });
  const throwIfInterrupted = (): void => {
    if (interrupted.signal === null) return;
    throw new RemoteRunError(waiting === null ? 'interrupted while looking for a runner' : 'interrupted while waiting for a runner', planInterrupt(interrupted.signal).exitCode);
  };
  const giveUp = (failure: FailedAttempt, endNote: string): never => {
    const waited = waiting === null ? '' : `\nwaited ${formatWaitDuration(Math.round((loop.now() - startedAtMs) / msPerSecond))} for a runner with "${loop.needs}" ${endNote}`;
    throw new RemoteRunError(`${failure.failure.message}${waited}`, failure.failure.exitCode);
  };
  try {
    for (;;) {
      if (waiting !== null && deadlineMs - loop.now() < minWaitAttemptMs) giveUp(waiting.lastFailure, 'to come back — none did');
      const attempt = await loop.attempt(waiting === null ? null : deadlineMs - loop.now(), stop.signal);
      throwIfInterrupted();
      if (attempt.ok) {
        if (waiting === null || loop.now() <= deadlineMs) return attempt.choice;
        return giveUp(waiting.lastFailure, 'to come back — one answered only after the wait had ended, so the job was not started');
      }
      // The last sleep ends minWaitAttemptMs before the deadline, so the wait ends with one more look instead of with a sleep nobody answers; with
      // less than that left there is nothing to wait for.
      const sleepMs = Math.min(loop.pollMs, deadlineMs - loop.now() - minWaitAttemptMs);
      if (attempt.wait === null || loop.waitSeconds <= 0 || sleepMs <= 0) return giveUp(attempt, 'to come back — none did');
      if (waiting === null) {
        loop.say(`waiting for a runner with ${loop.needs} (${attempt.wait.description}) — looking again every ${formatPoll(loop.pollMs)}, up to ${formatWaitDuration(loop.waitSeconds)}`);
      }
      waiting = { lastFailure: attempt };
      await loop.sleep(sleepMs, stop.signal);
      throwIfInterrupted();
    }
  } finally {
    stopWatching();
  }
}

/** @description `sleep` for {@link chooseRunnerWithWait}: ends after `ms`, or at once when `stop` aborts; its timer never outlives the call. */
export function sleepUntilStopped(ms: number, stop: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (stop.aborted) {
      resolve();
      return;
    }
    const onStop = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      stop.removeEventListener('abort', onStop);
      resolve();
    }, ms);
    stop.addEventListener('abort', onStop, { once: true });
  });
}
