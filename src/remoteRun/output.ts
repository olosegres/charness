/**
 * @description What the commands write and where: the job's output to stdout, remote-run's own lines to stderr prefixed `remote-run: `.
 * The job script writes ITS progress lines (waiting for another job of the project, installing dependencies, a timeout) into the job's
 * log with the same prefix, so the router sends every log line that starts with it to stderr — a command that prints such a line itself
 * only moves it to the other stream.
 */

export const ownLinePrefix = 'remote-run: ';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
  homeDir: string;
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
