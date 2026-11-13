import * as fs from 'fs';
import { writeTextFileAtomically } from '../configDirFile';
import { shellSingleQuote } from '../utils/tmuxExec';
import { nodeMovedExitCode, restartExitCode } from './appInstall';
import type { RunnerHomePaths } from './runnerHome';

/**
 * @description `~/.charness-runner/bin/charness-runner`: a two-line `sh` loop that starts the app `current` points at and starts it
 * AGAIN when it exits with {@link restartExitCode} (an update installed a newer copy). The app runs in the background of the
 * script so that the script can pass TERM / INT / HUP on to it: under systemd's `KillMode=process` only the script is signalled, and
 * without the forwarding the app would be left running unsupervised. Terminal runs, the systemd unit and the launchd
 * job all start this one file, so an update needs no service reinstall. `node` is the one that made the file (the runner's own Node.js,
 * `managedNode.ts`); if it has moved, the `node` on PATH is tried. Exit code {@link nodeMovedExitCode} means the file itself was rewritten (the link
 * moved to its own Node): the script starts the new file in its place.
 *
 * A trapped signal ends the script's `wait` early, with a status above 128 that is not the app's: after one, the script waits for the app
 * again, which returns the app's own status — also when the app has ended and the shell has reaped it in between (dash and bash both keep the
 * status of a background job until it is waited for). Looking whether the app still runs was not enough: a shell slowed down after it passed
 * the signal on (a loaded host) found the app gone and ended with the signal's 143 instead of the app's code.
 */

const launcherMode = 0o755;
/** What a shell's `wait` returns when a trapped signal ends it early, and a process ended by a signal reports: 128 + the signal's number. */
const signalExitCodeBase = 128;

export function renderLauncher(paths: Pick<RunnerHomePaths, 'currentApp'>, nodePath: string): string {
  const cli = `${paths.currentApp}/dist/runnerUtility/runnerCli.js`;
  return [
    '#!/bin/sh',
    '# Written by charness-runner. Exit code 75 asks for a restart onto an updated copy, 76 for a start of this file again; TERM / INT / HUP go to the app.',
    `NODE=${shellSingleQuote(nodePath)}`,
    '[ -x "$NODE" ] || NODE=node',
    'child=',
    'trap \'signalled=1; [ -n "$child" ] && kill -TERM "$child" 2>/dev/null\' TERM INT HUP',
    'while :; do',
    '  signalled=',
    `  "$NODE" ${shellSingleQuote(cli)} "$@" &`,
    '  child=$!',
    '  wait "$child"; code=$?',
    `  while [ -n "$signalled" ] && [ "$code" -gt ${signalExitCodeBase} ]; do signalled=; wait "$child"; code=$?; done`,
    `  [ "$code" = ${restartExitCode} ] && continue`,
    `  [ "$code" = ${nodeMovedExitCode} ] && [ -x "$0" ] && exec "$0" "$@"`,
    '  exit "$code"',
    'done',
    '',
  ].join('\n');
}

/** `NODE='…'` as {@link renderLauncher} writes it: a single-quoted word, in which a quote is `'\\''`. */
const launcherNodePattern = /^NODE='((?:[^']|'\\'')*)'$/m;

/** @description The Node the launcher on disk starts, or `null` when there is no launcher or it names none. */
export function readLauncherNodePath(paths: Pick<RunnerHomePaths, 'launcher'>): string | null {
  try {
    const match = launcherNodePattern.exec(fs.readFileSync(paths.launcher, 'utf8'));
    return match === null ? null : match[1].replace(/'\\''/g, "'");
  } catch {
    return null;
  }
}

/** @description Is the launcher on disk exactly the one that starts `nodePath`? */
export function checkLauncherIsFor(paths: RunnerHomePaths, nodePath: string): boolean {
  try {
    return fs.readFileSync(paths.launcher, 'utf8') === renderLauncher(paths, nodePath);
  } catch {
    return false;
  }
}

/** @description Write the launcher (when it differs) and return its path. */
export function ensureLauncher(paths: RunnerHomePaths, nodePath: string): string {
  fs.mkdirSync(paths.binDir, { recursive: true, mode: 0o700 });
  if (!checkLauncherIsFor(paths, nodePath)) writeTextFileAtomically(paths.launcher, renderLauncher(paths, nodePath), launcherMode);
  return paths.launcher;
}
