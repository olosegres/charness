/**
 * @description What the commands write and where: the job's output to stdout, remote-run's own lines to stderr prefixed `remote-run: `.
 * The job script writes ITS progress lines (waiting for another job of the project, installing dependencies, a timeout) into the job's
 * log with the same prefix, so the router sends every log line that starts with it to stderr — a command that prints such a line itself
 * only moves it to the other stream.
 */

import * as os from 'os';
import type { EventEmitter } from 'events';
import { raiseStdoutClosed } from './interrupts';

export const ownLinePrefix = 'remote-run: ';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
  homeDir: string;
}

export interface ClosedOutputWatch {
  /** Whether the reader of the stream is gone: what is written to it from now on is dropped. */
  getIsClosed: () => boolean;
}

/**
 * @description Watch an output stream for its reader going away (`remote-run … | head`): the write that hits the closed pipe fails with an
 * EPIPE error, which would otherwise end the process on the spot — its jobs left to the runner's lease to stop, with nobody saying why.
 * `onClosed` is called once, at the first EPIPE; any other stream error is left to end the process as before.
 */
export function watchClosedOutput(stream: EventEmitter, onClosed: () => void): ClosedOutputWatch {
  let isClosed = false;
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error;
    if (isClosed) return;
    isClosed = true;
    onClosed();
  });
  return { getIsClosed: () => isClosed };
}

/**
 * @description The io of the real process. A closed stdout is raised as the SIGPIPE interrupt (`raiseStdoutClosed`), the way the shell's own tools
 * meet it, so every run that owns a job stops it and says why (`followForeground`, `runExec`); a command with nothing to stop (`ls`, `runners`) simply ends.
 * A closed stderr cannot be told about anything: its errors are dropped.
 */
export function createProcessIo(): CliIo {
  const stdoutWatch = watchClosedOutput(process.stdout, raiseStdoutClosed);
  process.stderr.on('error', () => { /* nowhere left to say it */ });
  return {
    stdout: (text) => { if (!stdoutWatch.getIsClosed()) process.stdout.write(text); },
    stderr: (text) => { process.stderr.write(text); },
    cwd: process.cwd(),
    env: process.env,
    homeDir: os.homedir(),
  };
}

/** @description One of remote-run's own lines, to stderr. */
export function sayOwn(io: Pick<CliIo, 'stderr'>, line: string): void {
  io.stderr(`${ownLinePrefix}${line}\n`);
}

export interface JobOutputRouter {
  write: (chunk: string) => void;
  /** The last, unfinished line, if any (a stream that ended without a newline). */
  flush: () => void;
}

export function createJobOutputRouter(io: Pick<CliIo, 'stdout' | 'stderr'>): JobOutputRouter {
  let pending = '';
  const emit = (line: string): void => {
    if (line.startsWith(ownLinePrefix)) io.stderr(line);
    else io.stdout(line);
  };
  return {
    write(chunk) {
      pending += chunk;
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        emit(pending.slice(0, newline + 1));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
    },
    flush() {
      if (pending !== '') emit(pending);
      pending = '';
    },
  };
}

/** The line `runner.sh exec` ends its stderr with: RS (U+001E), the name, the command's exit code, a newline. */
const exitMarkerPattern = /\u001eremote-run-exit:(\d+)\n/g;
/** A marker that has begun but not arrived whole is held back at most this long (the marker is shorter than this). */
const exitMarkerHoldBackLength = 40;

export interface ExitMarkerFilter {
  write: (chunk: string) => void;
  /** Hand on what is still held back (a stream that ended). */
  flush: () => void;
  /** The code of the last marker seen, or `null` when none arrived. */
  getExitCode: () => number | null;
}

/**
 * @description Takes the exit marker `runner.sh exec` prints out of a stderr stream, however the stream is cut into chunks, and hands on
 * everything else at once — a partial marker is held back only until the rest arrives or the stream ends.
 */
export function createExitMarkerFilter(forward: (text: string) => void): ExitMarkerFilter {
  let pending = '';
  let exitCode: number | null = null;
  return {
    write(chunk) {
      let text = pending + chunk;
      pending = '';
      let handedOn = 0;
      for (const match of text.matchAll(exitMarkerPattern)) {
        if (match.index > handedOn) forward(text.slice(handedOn, match.index));
        exitCode = Number(match[1]);
        handedOn = match.index + match[0].length;
      }
      text = text.slice(handedOn);
      const markerStart = text.lastIndexOf('\u001e');
      if (markerStart >= 0 && text.length - markerStart < exitMarkerHoldBackLength && !text.slice(markerStart).includes('\n')) {
        pending = text.slice(markerStart);
        text = text.slice(0, markerStart);
      }
      if (text !== '') forward(text);
    },
    flush() {
      if (pending !== '') forward(pending);
      pending = '';
    },
    getExitCode: () => exitCode,
  };
}
