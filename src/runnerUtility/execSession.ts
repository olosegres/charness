import { spawn } from 'child_process';
import type { ServerChannel } from 'ssh2';

/**
 * @description One `exec` request of a session: the command runs under `bash -c` in a clean environment, its stdin is the channel's
 * (the client's EOF is the command's EOF — phase 1's lease relies on it), its stdout and stderr go back on the channel's two streams,
 * and its end is reported as an exit status or a signal.
 *
 * Sshd's semantics for a channel that is CLOSED by the client: the pipes close, the command is NOT killed. Here: stdout and stderr are
 * destroyed (the command's next write fails, as with a closed pipe), its stdin is closed, and the process runs on. Only the real end
 * of the process closes the books on it ({@link ExecTracker.ended}), which is what «the runner is busy» means.
 */

const commandNotFoundStatus = 127;
const signalPrefix = /^SIG/;

export interface ExecTracker {
  started: () => void;
  ended: () => void;
}

export interface ExecOptions {
  env: NodeJS.ProcessEnv;
  cwd: string;
  tracker: ExecTracker;
}

function sendExitStatus(channel: ServerChannel, exitCode: number | null, signal: NodeJS.Signals | null): void {
  try {
    if (signal !== null) channel.exit(signal.replace(signalPrefix, ''), false, '');
    else channel.exit(exitCode ?? commandNotFoundStatus);
    channel.end();
  } catch {
    // The client closed the channel first: nobody is waiting for the status.
  }
}

/** @description Run `command` for `channel`. */
export function serveExec(channel: ServerChannel, command: string, options: ExecOptions): void {
  options.tracker.started();
  const child = spawn('bash', ['-c', command], { env: options.env, cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => undefined);
  channel.on('error', () => undefined);
  channel.stderr.on('error', () => undefined);
  channel.pipe(child.stdin);
  child.stdout.pipe(channel, { end: false });
  child.stderr.pipe(channel.stderr, { end: false });
  channel.once('close', () => {
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  });
  child.once('error', (error) => {
    channel.stderr.write(`charness-runner: cannot start the command (${error.message})\n`);
    sendExitStatus(channel, commandNotFoundStatus, null);
    options.tracker.ended();
  });
  child.once('close', (exitCode, signal) => {
    sendExitStatus(channel, exitCode, signal);
    options.tracker.ended();
  });
}
