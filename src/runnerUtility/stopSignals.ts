/**
 * @description Stop on SIGINT / SIGTERM — gracefully, ONCE, and without a second signal ever finding the default action waiting. A runner is stopped by more than
 * one signal: the launcher passes the TERM it got on to the app while a terminal's Ctrl-C or a group kill hands the app its own, a few milliseconds apart. A handler
 * that is `once` is gone after the first: the second signal then takes the default action and kills the process under its own clean-up (no `finally`, no `exit`
 * handlers) — the sleep assertion's state file stayed behind, a login-session agent's heartbeat with it. So the handlers stay, the first signal calls `stop`, and the
 * later ones are ignored (`stop` has its own forced exit for a clean-up that hangs).
 */

/** @description Call `stop` at the first SIGINT or SIGTERM; returns the function that takes the handlers off again. */
export function onStopSignals(stop: () => void): () => void {
  let isStopping = false;
  const handler = (): void => {
    if (isStopping) return;
    isStopping = true;
    stop();
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return () => {
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
  };
}
