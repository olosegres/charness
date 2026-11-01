import { planInterrupt, type InterruptSignal } from './exitCodes';
import { addInterruptHandler } from './interrupts';
import { checkHasCapability, checkIsRunnerPaused, formatLastSeen, type RunnerCapability, type RunnerReport } from './probe';
import { RemoteRunError } from './remoteRunError';
import type { RunnerPick } from './runners';
import type { RunnersConfig } from './runnersConfig';

/**
 * @description The wait of `charness remote-run --needs <capability>`: when the only runners that could take the job are PAIRED ones
 * that are offline right now (a laptop that slept, a link that restarts), the command waits for one of them instead of failing — it says
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
 * @description Is there an offline PAIRED runner worth waiting for? Only when a capability is needed and no runner is named: a runner is
 * worth it when its last snapshot had the capability and Pueue and nobody paused it (a paused one would be skipped when it came back).
 * `null` = fail now.
 */
export function planRunnerWait(config: RunnersConfig, reports: readonly RunnerReport[], wanted: { runner: string | null; needs: RunnerCapability | null }): RunnerWaitPlan | null {
  const needs = wanted.needs;
  if (needs === null || wanted.runner !== null) return null;
  const candidates = reports.filter((report): report is Extract<RunnerReport, { status: 'offline' }> => {
    if (report.status !== 'offline' || report.lastProbe === null) return false;
    const isPaired = config.runners.some((runner) => runner.name === report.name && runner.paired !== undefined);
    return isPaired && !checkIsRunnerPaused(report) && report.lastProbe.pueueVersion !== null && checkHasCapability(report.lastProbe, needs);
  });
  if (candidates.length === 0) return null;
  return {
    runnerNames: candidates.map((report) => report.name),
    description: candidates.map((report) => `${report.name} offline${report.lastSeenAtMs === null ? '' : ` since ${formatLastSeen(report.lastSeenAtMs)}`}`).join(', '),
  };
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

/** One try at choosing a runner: the choice, or why there is none and whether it is worth waiting. */
export type RunnerAttempt<TChoice> =
  | { ok: true; choice: TChoice }
  | { ok: false; failure: Extract<RunnerPick, { ok: false }>; wait: RunnerWaitPlan | null };

export interface RunnerWaitLoop<TChoice> {
  /** Probe and pick once. */
  attempt: () => Promise<RunnerAttempt<TChoice>>;
  needs: RunnerCapability | null;
  /** `--runner-wait` in seconds; `0` = never wait. */
  waitSeconds: number;
  pollMs: number;
  now: () => number;
  /** Resolves after `ms`, or earlier with the signal that interrupted it. */
  sleep: (ms: number) => Promise<InterruptSignal | null>;
  say: (line: string) => void;
}

/**
 * @description Choose a runner, waiting for an offline paired one when that is worth it: the choice as soon as an attempt gives one; a
 * {@link RemoteRunError} with the pick's own message (and, after waiting, how long it waited) when nothing can be waited for or the wait
 * ran out; and, if the wait is interrupted, the interrupt's exit code (130 / 143 / 129).
 */
export async function chooseRunnerWithWait<TChoice>(loop: RunnerWaitLoop<TChoice>): Promise<TChoice> {
  const startedAtMs = loop.now();
  const deadlineMs = startedAtMs + loop.waitSeconds * msPerSecond;
  let isAnnounced = false;
  for (;;) {
    const attempt = await loop.attempt();
    if (attempt.ok) return attempt.choice;
    const now = loop.now();
    if (attempt.wait === null || loop.waitSeconds <= 0 || now >= deadlineMs) {
      const waited = isAnnounced ? `\nwaited ${formatWaitDuration(Math.round((now - startedAtMs) / msPerSecond))} for a runner with "${loop.needs}" to come back — none did` : '';
      throw new RemoteRunError(`${attempt.failure.message}${waited}`, attempt.failure.exitCode);
    }
    if (!isAnnounced) {
      isAnnounced = true;
      loop.say(`waiting for a runner with ${loop.needs} (${attempt.wait.description}) — looking again every ${formatPoll(loop.pollMs)}, up to ${formatWaitDuration(loop.waitSeconds)}`);
    }
    const interrupt = await loop.sleep(Math.min(loop.pollMs, deadlineMs - now));
    if (interrupt !== null) throw new RemoteRunError('interrupted while waiting for a runner', planInterrupt(interrupt).exitCode);
  }
}

/** @description `sleep` for {@link chooseRunnerWithWait}: ends early, with the signal, when the user interrupts (Ctrl-C, SIGTERM, SIGHUP). The handler lives only for the sleep: while a probe runs, an interrupt ends the process as it always did (there is no job to stop yet). */
export function sleepUntilInterrupted(ms: number): Promise<InterruptSignal | null> {
  return new Promise((resolve) => {
    let removeHandler: () => void = () => undefined;
    const timer = setTimeout(() => {
      removeHandler();
      resolve(null);
    }, ms);
    removeHandler = addInterruptHandler((signal) => {
      clearTimeout(timer);
      removeHandler();
      resolve(signal);
    });
  });
}
