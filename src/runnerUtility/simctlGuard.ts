import * as fs from 'fs';
import * as path from 'path';
import { writeTextFileAtomically } from '../configDirFile';
import { shellSingleQuote } from '../utils/tmuxExec';
import type { RunnerHomePaths } from './runnerHome';

/**
 * @description Jobs of different projects run side by side on one Mac, and each iOS job has a Simulator device of its own (`REMOTE_RUN_IOS_SIMULATOR_UDID`, made by
 * `runner.sh ios-device`). Agents and test tools habitually clear the field with `xcrun simctl shutdown all` (Detox, a freshness gate that refuses two booted devices,
 * a script's cleanup) — which would stop the devices of every other job under way. So `<root>/bin/xcrun`, first on a job's PATH (`execEnv.ts`: the folders of a job
 * and of the login session's agent), is a guard in front of the real `/usr/bin/xcrun`:
 *
 *   `xcrun simctl [--set <path>] shutdown | erase | delete all`   →  the same command on the job's own device, with a line on stderr saying so;
 *                                                                    with no device of its own (the variable is not set) → nothing is run, exit 0, the same line
 *   everything else (`delete unavailable`, `boot <udid>`, `list`, any other tool of `xcrun`)  →  `exec /usr/bin/xcrun "$@"`, the arguments intact
 *
 * It is a guard against a habit, not a wall: `/usr/bin/xcrun`, `killall Simulator` and `killall com.apple.CoreSimulator.CoreSimulatorService` pass it (the agents'
 * instructions say not to). Written at every link start and on `check` (like the `corepack` wrapper of `packageManagerShims.ts`): rewritten when this version's text
 * differs, removed again where it has no use (not a Mac, no `/usr/bin/xcrun`), and a `<root>/bin/xcrun` that is not ours (no marker) is left alone.
 */

export const realXcrunPath = '/usr/bin/xcrun';
const guardName = 'xcrun';
const guardMode = 0o755;
/** The first comment of the guard: what makes a `<root>/bin/xcrun` ours to rewrite or remove. */
export const xcrunGuardMarker = '# Written by charness-runner: xcrun guard.';
/** The variable `runner.sh` sets for a job that has a Simulator device of its own. */
export const simulatorUdidVariable = 'REMOTE_RUN_IOS_SIMULATOR_UDID';
/** The subcommands of `simctl` that take `all`. */
const guardedSubcommands: readonly string[] = ['shutdown', 'erase', 'delete'];

/** What `ensureXcrunGuard` did: made or refreshed, was current already, took our own away, found nothing to do, or found an `xcrun` that is not ours and left it. */
export type GuardOutcome = 'installed' | 'current' | 'removed' | 'not-needed' | 'foreign';

export interface GuardDeps {
  platform: NodeJS.Platform;
  /** The real `xcrun` the guard hands everything else to. */
  realXcrun: string;
  /** Is `candidate` a file this account can run? */
  checkIsExecutable: (candidate: string) => boolean;
}

export function createGuardDeps(): GuardDeps {
  return {
    platform: process.platform,
    realXcrun: realXcrunPath,
    checkIsExecutable: (candidate) => {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    },
  };
}

/** @description The text of the guard (see the head of the file); the real `xcrun` is the one thing in it that varies. POSIX `sh`, no arrays: a rebuilt argument list is rotated through `set --`. */
export function renderXcrunGuard(realXcrun: string): string {
  const udid = `\${${simulatorUdidVariable}:-}`;
  return [
    '#!/bin/sh',
    xcrunGuardMarker,
    '# Jobs run side by side on this machine, each with a Simulator device of its own: `xcrun simctl shutdown|erase|delete all` would reach the devices of the other jobs.',
    '# It is run on this job\'s own device instead (or not at all when the job has none). Everything else goes to the real xcrun unchanged.',
    '# A guard against the habit, not a wall: /usr/bin/xcrun, `killall Simulator` and `killall com.apple.CoreSimulator.CoreSimulatorService` pass it.',
    `REAL=${shellSingleQuote(realXcrun)}`,
    '[ "$1" = simctl ] || exec "$REAL" "$@"',
    'position=0; skip_next=0; subcommand=; target=; target_position=0',
    'for argument in "$@"; do',
    '  position=$((position + 1))',
    '  [ "$position" -eq 1 ] && continue',
    '  if [ "$skip_next" -eq 1 ]; then skip_next=0; continue; fi',
    '  case $argument in',
    '    --set) skip_next=1; continue;;',
    '    --set=*) continue;;',
    '  esac',
    '  if [ -z "$subcommand" ]; then subcommand=$argument; continue; fi',
    '  case $argument in -*) continue;; esac',
    '  if [ "$target_position" -eq 0 ]; then target=$argument; target_position=$position; fi',
    'done',
    `case $subcommand in ${guardedSubcommands.join('|')}) ;; *) exec "$REAL" "$@";; esac`,
    '[ "$target" = all ] || exec "$REAL" "$@"',
    `if [ -z "${udid}" ]; then`,
    '  echo "charness-runner: \\`xcrun simctl $subcommand all\\` was not run: other jobs on this machine use their own simulators, and this job has none of its own (' + simulatorUdidVariable + ' is not set)" >&2',
    '  exit 0',
    'fi',
    `echo "charness-runner: \\\`xcrun simctl $subcommand all\\\` would reach the simulators of other jobs on this machine; it is run on this job's own simulator (${udid}) only" >&2`,
    'count=$#; index=0',
    'while [ "$index" -lt "$count" ]; do',
    '  index=$((index + 1))',
    '  argument=$1; shift',
    `  [ "$index" -eq "$target_position" ] && argument="${udid}"`,
    '  set -- "$@" "$argument"',
    'done',
    'exec "$REAL" "$@"',
    '',
  ].join('\n');
}

function readTextOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/** @description Put the guard in `<root>/bin` on a Mac that has a real `xcrun`; take our own back out anywhere else. Throws only what writing the file throws (the caller says it, the link goes up anyway). */
export function ensureXcrunGuard(paths: RunnerHomePaths, deps: GuardDeps): GuardOutcome {
  const guardPath = path.join(paths.binDir, guardName);
  const current = readTextOrNull(guardPath);
  const isOurs = current !== null && current.includes(xcrunGuardMarker);
  if (deps.platform !== 'darwin' || !deps.checkIsExecutable(deps.realXcrun)) {
    if (!isOurs) return 'not-needed';
    fs.rmSync(guardPath, { force: true });
    return 'removed';
  }
  if (current !== null && !isOurs) return 'foreign';
  const text = renderXcrunGuard(deps.realXcrun);
  if (current === text) return 'current';
  fs.mkdirSync(paths.binDir, { recursive: true, mode: 0o700 });
  writeTextFileAtomically(guardPath, text, guardMode);
  return 'installed';
}

/** @description One line for the link's log: what keeps `simctl shutdown all` away from the other jobs' simulators; nothing where the guard is not in place. */
export function formatGuardLine(outcome: GuardOutcome, paths: RunnerHomePaths): string | null {
  if (outcome === 'installed' || outcome === 'current') return `  simulators: ${path.join(paths.binDir, guardName)} runs \`xcrun simctl shutdown|erase|delete all\` on a job's own simulator only`;
  if (outcome === 'foreign') return `  simulators: ${path.join(paths.binDir, guardName)} is not charness-runner's: jobs can shut down each other's simulators with \`simctl shutdown all\``;
  return null;
}
