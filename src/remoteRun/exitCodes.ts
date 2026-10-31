/**
 * @description The exit codes of `charness remote-run` itself. The command's own code passes through untouched; these are the
 * ones remote-run reports when it is the one that failed or that stopped the job. They follow `timeout(1)` and the shell
 * (128 + signal) so a caller that already knows those reads them right.
 */
export const remoteRunExitCodes = {
  /** A bad command line (`remote-run --nope`): the usage convention of the other subcommands. */
  usage: 2,
  /** The job ran past its `--timeout` and was killed. */
  timedOut: 124,
  /** remote-run failed: no runner, ssh, the file sync, the dependencies step — the message on stderr says which. */
  failed: 125,
  /** The local run was ended by SIGHUP. */
  hangup: 129,
  /** The local run was ended by SIGINT. */
  interrupted: 130,
  /** The job was killed (`remote-run kill`, a lost lease). */
  killed: 137,
  /** The local run was ended by SIGTERM. */
  terminated: 143,
} as const;

export type InterruptSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';

export const interruptSignals: readonly InterruptSignal[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** @description How a local interrupt ends the run: the remote job is killed first (TERM, then KILL after the grace), then this code. */
export interface InterruptPlan {
  exitCode: number;
  /** How long the runner gives the job after SIGTERM before it is killed. */
  killGraceSeconds: number;
}

/** How long the runner gives a job after SIGTERM before it kills it (`kill_grace_sec` in `remoteRun/runner.sh`: the two are one number). */
export const killGraceSeconds = 10;

/** @description What to do when the local remote-run gets `signal`: kill the whole remote job, then exit with the shell's code for it. */
export function planInterrupt(signal: InterruptSignal): InterruptPlan {
  const exitCodeBySignal: Record<InterruptSignal, number> = {
    SIGINT: remoteRunExitCodes.interrupted,
    SIGTERM: remoteRunExitCodes.terminated,
    SIGHUP: remoteRunExitCodes.hangup,
  };
  return { exitCode: exitCodeBySignal[signal], killGraceSeconds };
}
