import * as fs from 'fs';
import { writeTextFileAtomically } from '../configDirFile';
import { shellSingleQuote } from '../utils/tmuxExec';
import { restartExitCode } from './appInstall';
import type { RunnerHomePaths } from './runnerHome';

/**
 * @description `~/.charness-runner/bin/charness-runner`: a two-line `sh` loop that starts the app `current` points at and starts it
 * AGAIN when it exits with {@link restartExitCode} (an update installed a newer copy). The app runs in the background of the
 * script so that the script can pass TERM / INT / HUP on to it: under systemd's `KillMode=process` only the script is signalled, and
 * without the forwarding the app would be left running unsupervised. Terminal runs, the systemd unit and the launchd
 * job all start this one file, so an update needs no service reinstall. `node` is the one that made the file; if it has moved, the
 * `node` on PATH is tried.
 */

const launcherMode = 0o755;

export function renderLauncher(paths: Pick<RunnerHomePaths, 'currentApp'>, nodePath: string): string {
  const cli = `${paths.currentApp}/dist/runnerUtility/runnerCli.js`;
  return [
    '#!/bin/sh',
    '# Written by charness-runner. Exit code 75 asks for a restart onto an updated copy; TERM / INT / HUP go to the app.',
    `NODE=${shellSingleQuote(nodePath)}`,
    '[ -x "$NODE" ] || NODE=node',
    'child=',
    'trap \'[ -n "$child" ] && kill -TERM "$child" 2>/dev/null\' TERM INT HUP',
    'while :; do',
    `  "$NODE" ${shellSingleQuote(cli)} "$@" &`,
    '  child=$!',
    '  code=0',
    '  while kill -0 "$child" 2>/dev/null; do wait "$child"; code=$?; done',
    `  [ "$code" = ${restartExitCode} ] || exit "$code"`,
    'done',
    '',
  ].join('\n');
}

/** @description Write the launcher (when it differs) and return its path. */
export function ensureLauncher(paths: RunnerHomePaths, nodePath: string): string {
  fs.mkdirSync(paths.binDir, { recursive: true, mode: 0o700 });
  const text = renderLauncher(paths, nodePath);
  let current: string | null = null;
  try {
    current = fs.readFileSync(paths.launcher, 'utf8');
  } catch {
    current = null;
  }
  if (current !== text) writeTextFileAtomically(paths.launcher, text, launcherMode);
  return paths.launcher;
}
