import type { ChildProcess } from 'child_process';
import { interruptSignals, killGraceSeconds, planInterrupt, type InterruptSignal } from './exitCodes';

/** A `kill` call waits for the runner's grace time, then its own SIGKILL and the call itself. */
const killCallMarginSeconds = 30;
export const killCallTimeoutMs = (killGraceSeconds + killCallMarginSeconds) * 1000;

/**
 * @description Run `handler` for SIGINT, SIGTERM and SIGHUP — a listener also keeps Node from ending the process by itself, so the
 * command decides how it ends (kill the remote job first). Returns the function that removes the listeners.
 */
export function addInterruptHandler(handler: (signal: InterruptSignal) => void): () => void {
  const listeners = interruptSignals.map((signal) => {
    const listener = (): void => handler(signal);
    process.on(signal, listener);
    return { signal, listener };
  });
  return () => listeners.forEach(({ signal, listener }) => process.off(signal, listener));
}

/**
 * @description The handler of an interrupt that is given time to clean up: the FIRST interrupt goes to `onInterrupt`; a SECOND one — the user does
 * not want to wait for the clean-up — ends the process at once with the code of the first, so a call that does not stop can never swallow Ctrl-C.
 */
export function createHardStopHandler(onInterrupt: (signal: InterruptSignal) => void, exit: (exitCode: number) => void): (signal: InterruptSignal) => void {
  let firstExitCode: number | null = null;
  return (signal) => {
    if (firstExitCode !== null) {
      exit(firstExitCode);
      return;
    }
    firstExitCode = planInterrupt(signal).exitCode;
    onInterrupt(signal);
  };
}

/** @description {@link addInterruptHandler} with {@link createHardStopHandler}: a second interrupt ends the process (`process.exit`) at once. */
export function addInterruptHandlerWithHardStop(onInterrupt: (signal: InterruptSignal) => void): () => void {
  return addInterruptHandler(createHardStopHandler(onInterrupt, (exitCode) => process.exit(exitCode)));
}

/** How often a child that has exited by itself is asked whether it has been stopped since (`waitForChildEnd`). */
const stopAfterExitPollMs = 50;

/**
 * @description Resolves with the exit code when `child` has ended. Normally that is its `close` (the process is gone AND its output
 * has been read to the end). Once `getIsStopped()` says the caller ended it on purpose, its `exit` is enough and the caller's end of
 * its pipes is released: an ssh client that shares a master connection passes its stdio to the master, which keeps those pipes open
 * until the REMOTE command ends — so after a kill the process is dead, `close` never comes, and the command would hang for as long as
 * the remote side runs (hours, for a `wait`).
 *
 * The stop may come AFTER the process exited by itself (the client was done, the master still held the pipes, then the deadline passed or the
 * user interrupted): between its `exit` and its `close` the stop is asked about every {@link stopAfterExitPollMs}, and then the pipes are let go the same way.
 */
export function waitForChildEnd(child: ChildProcess, getIsStopped: () => boolean): Promise<number | null> {
  return new Promise((resolve) => {
    let pollTimer: NodeJS.Timeout | null = null;
    const settle = (exitCode: number | null): void => {
      if (pollTimer !== null) clearInterval(pollTimer);
      resolve(exitCode);
    };
    child.once('close', (exitCode) => settle(exitCode));
    child.once('exit', (exitCode) => {
      const settleIfStopped = (): boolean => {
        if (!getIsStopped()) return false;
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(exitCode);
        return true;
      };
      if (!settleIfStopped()) pollTimer = setInterval(settleIfStopped, stopAfterExitPollMs);
    });
  });
}
