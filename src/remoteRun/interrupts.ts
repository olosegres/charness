import type { ChildProcess } from 'child_process';
import { interruptSignals, killGraceSeconds, type InterruptSignal } from './exitCodes';

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
 * @description Resolves with the exit code when `child` has ended. Normally that is its `close` (the process is gone AND its output
 * has been read to the end). Once `getIsStopped()` says the caller ended it on purpose, its `exit` is enough and the caller's end of
 * its pipes is released: an ssh client that shares a master connection passes its stdio to the master, which keeps those pipes open
 * until the REMOTE command ends — so after a kill the process is dead, `close` never comes, and the command would hang for as long as
 * the remote side runs (hours, for a `wait`).
 */
export function waitForChildEnd(child: ChildProcess, getIsStopped: () => boolean): Promise<number | null> {
  return new Promise((resolve) => {
    child.once('close', (exitCode) => resolve(exitCode));
    child.once('exit', (exitCode) => {
      if (!getIsStopped()) return;
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(exitCode);
    });
  });
}
