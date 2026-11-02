/**
 * @description What the admin pairing line needs from a machine that a flow cannot have: root, a second real account, and a service
 * manager. Stand-in programs in one folder that comes FIRST on `PATH` (the line is pasted into an ordinary shell, as an operator would):
 *
 *   sudo      `sudo <command>` makes the command run as "root" (under `fakeroot`: uid 0 for the line's checks and for the service step,
 *             nothing is really changed); `sudo -u <account> -H <command>` runs it as the real user again — with the stand-in account's
 *             HOME, USER and LOGNAME — the way sudo would hand the command to that account
 *   id        answers for the stand-in accounts (uid, groups); everything else is the real `id`
 *   getent    the stand-in accounts' passwd entries; everything else is the real `getent`
 *   loginctl  records the call; `show-user … Linger` says yes
 *   systemctl records the call; `--user is-system-running` says «running»; `daemon-reload` fails while the file `fail-reload` exists
 *
 * Every call of a stand-in is appended to `calls.log` as one line (the long pairing script is cut short), in order.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface StandInAccount {
  name: string;
  uid: number;
  /** What `id -Gn <name>` prints. */
  groups: readonly string[];
  homeDir: string;
}

export interface AdminStandIns {
  binDir: string;
  /** The calls of the stand-ins, one per line, in order. */
  logPath: string;
  /** While this file exists `systemctl --user daemon-reload` fails: the service manager of a machine without a user session. */
  failReloadFlag: string;
}

const logLineWidth = 140;

function findRealTool(name: string): string {
  return execFileSync('which', [name], { encoding: 'utf8' }).trim();
}

function writeScript(binDir: string, name: string, lines: readonly string[]): void {
  fs.writeFileSync(path.join(binDir, name), `${['#!/bin/sh', ...lines].join('\n')}\n`, { mode: 0o755 });
}

/** @description Write the stand-ins for `accounts` into `rootDir/stand-ins`. */
export function installAdminStandIns(rootDir: string, accounts: readonly StandInAccount[]): AdminStandIns {
  const binDir = path.join(rootDir, 'stand-ins');
  fs.mkdirSync(binDir, { recursive: true });
  const logPath = path.join(binDir, 'calls.log');
  const failReloadFlag = path.join(binDir, 'fail-reload');
  // One line per call: the pairing script is many lines long, and only its beginning says which call it is.
  const log = (tool: string): string => `echo "${tool} $*" | head -n 1 | cut -c1-${logLineWidth} >> "${logPath}"`;
  const realId = findRealTool('id');
  const realGetent = findRealTool('getent');

  writeScript(binDir, 'id', [
    'case "$1 $2" in',
    ...accounts.flatMap((account) => [`  "-u ${account.name}") echo ${account.uid}; exit 0;;`, `  "-Gn ${account.name}") echo "${account.groups.join(' ')}"; exit 0;;`]),
    'esac',
    `exec ${realId} "$@"`,
  ]);
  writeScript(binDir, 'getent', [
    'case "$1 $2" in',
    ...accounts.map((account) => `  "passwd ${account.name}") echo "${account.name}:x:${account.uid}:${account.uid}::${account.homeDir}:/bin/sh"; exit 0;;`),
    'esac',
    `exec ${realGetent} "$@"`,
  ]);
  writeScript(binDir, 'sudo', [
    log('sudo'),
    'if [ "$1" = -u ]; then',
    '  user=$2; shift 2',
    '  [ "$1" = -H ] && shift',
    '  case "$user" in',
    ...accounts.map((account) => `    ${account.name}) home="${account.homeDir}";;`),
    '    *) echo "sudo: unknown user $user" >&2; exit 1;;',
    '  esac',
    '  exec env -u LD_PRELOAD -u FAKEROOTKEY -u FAKED_MODE HOME="$home" USER="$user" LOGNAME="$user" "$@"',
    'fi',
    'exec fakeroot -- "$@"',
  ]);
  writeScript(binDir, 'loginctl', [
    log('loginctl'),
    'case "$1" in show-user) echo Linger=yes;; esac',
    'exit 0',
  ]);
  writeScript(binDir, 'systemctl', [
    log('systemctl'),
    `case "$*" in`,
    `  *daemon-reload*) [ -e "${failReloadFlag}" ] && { echo "Failed to connect to bus" >&2; exit 1; };;`,
    '  *is-system-running*) echo running;;',
    '  *"show -p ActiveState"*) echo inactive;;',
    'esac',
    'exit 0',
  ]);
  return { binDir, logPath, failReloadFlag };
}

/** @description The calls recorded so far, in order. */
export function readStandInCalls(standIns: AdminStandIns): string[] {
  try {
    return fs.readFileSync(standIns.logPath, 'utf8').split('\n').filter((line) => line !== '');
  } catch {
    return [];
  }
}
