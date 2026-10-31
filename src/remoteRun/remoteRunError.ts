import { remoteRunExitCodes } from './exitCodes';

/**
 * @description A failure remote-run reports as its own (never the command's): the message goes to stderr, the exit code is the
 * given one (125 unless the cause is a usage mistake or a timeout).
 */
export class RemoteRunError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number = remoteRunExitCodes.failed) {
    super(message);
    this.name = 'RemoteRunError';
    this.exitCode = exitCode;
  }
}

/** @description The runner could not be reached (ssh failed before the script ran): `reason` is the short ssh-side cause the `runners` view shows. */
export class RunnerUnreachableError extends RemoteRunError {
  readonly reason: string;

  constructor(runnerName: string, reason: string) {
    super(`runner "${runnerName}" is unreachable — ${reason}`);
    this.name = 'RunnerUnreachableError';
    this.reason = reason;
  }
}
