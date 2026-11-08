/**
 * @description What the admin pairing line needs from a machine that a flow cannot have: root, a second real account, and a service
 * manager. Stand-in programs in one folder that comes FIRST on `PATH` (the line is pasted into an ordinary shell, as an operator would):
 *
 *   sudo      `sudo <command>` makes the command run as "root" (under `fakeroot`: uid 0 for the line's checks, its download and the root
 *             step, nothing is really changed); `sudo -u <account> -H <command>` runs it as the real user again — with the stand-in
 *             account's HOME, USER and LOGNAME — the way sudo would hand the command to that account. Once an account's PAIRING has run,
 *             the account's launcher is replaced by a TRAP (the account's own doing, as an agent's code could): started by root — uid 0
 *             — it leaves the file `trap.hit` and the flow goes red; started as the account it just runs the real launcher
 *   id        answers for the stand-in accounts (uid, groups); everything else is the real `id`
 *   getent    the stand-in accounts' passwd entries; everything else is the real `getent`
 *   loginctl  records the call; `show-user … Linger` says yes
 *   systemctl records the call; `--user is-system-running` says «running»; `daemon-reload` fails while the file `fail-reload` exists
 *
 * Every call of a stand-in is appended to `calls.log` as one line (the long pairing script is cut short), in order.
 *
 * Not a program of the PATH but of the runner's Node: {@link renderNpmStandIn}, the `npm` that sits beside the `node` the line installs.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

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
  /** Appears when something started by ROOT ran the account's trapped launcher: root must never run anything of the account's. */
  trapFile: string;
  /** One line per `sudo -u <account>` call: what the call was started with — its standard input, its group, its terminal (see {@link readStandInIsolation}). */
  isolationLogPath: string;
}

const logLineWidth = 140;
/** Wider: the line starts with what the call was started with, and the pairing's own words come after the long path of the program. */
const isolationLogLineWidth = 320;

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
  const trapFile = path.join(binDir, 'trap.hit');
  const isolationLogPath = path.join(binDir, 'isolation.log');
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
    // What the root step started this call with: /dev/null for input, the head of a group (and session) of its own, no controlling terminal.
    `  echo "stdin=$(readlink /proc/$$/fd/0) leader=$([ "$(ps -o pgid= -p $$ | tr -d ' ')" = "$$" ] && echo yes || echo no) terminal=$(ps -o tty= -p $$ | tr -d ' ') $*" | cut -c1-${isolationLogLineWidth} >> "${isolationLogPath}"`,
    '  case "$user" in',
    ...accounts.map((account) => `    ${account.name}) home="${account.homeDir}";;`),
    '    *) echo "sudo: unknown user $user" >&2; exit 1;;',
    '  esac',
    // `test -w <path>`: the stand-in accounts own nothing the flow\'s folders are made of — the real user the flow runs as does, and would answer yes.
    '  if [ "$1" = test ] && [ "$2" = -w ]; then exit 1; fi',
    '  env -u LD_PRELOAD -u FAKEROOTKEY -u FAKED_MODE HOME="$home" USER="$user" LOGNAME="$user" "$@"',
    '  code=$?',
    '  case " $* " in',
    '    *" pair "*)',
    '      launcher="$home/.charness-runner/bin/charness-runner"',
    '      if [ -f "$launcher" ] && [ ! -f "$launcher.real" ]; then',
    '        mv "$launcher" "$launcher.real"',
    `        printf '#!/bin/sh\\n[ "$(id -u)" = 0 ] && : > "${trapFile}"\\nexec "%s" "$@"\\n' "$launcher.real" > "$launcher"`,
    '        chmod 755 "$launcher"',
    '      fi;;',
    '  esac',
    '  exit $code',
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
  return { binDir, logPath, failReloadFlag, trapFile, isolationLogPath };
}

/** @description The calls recorded so far, in order. */
export function readStandInCalls(standIns: AdminStandIns): string[] {
  try {
    return fs.readFileSync(standIns.logPath, 'utf8').split('\n').filter((line) => line !== '');
  } catch {
    return [];
  }
}

/** @description How each `sudo -u <account>` call was started, in order: `stdin=<what fd 0 is> leader=<yes|no> terminal=<its tty> <the call>`. */
export function readStandInIsolation(standIns: AdminStandIns): string[] {
  try {
    return fs.readFileSync(standIns.isolationLogPath, 'utf8').split('\n').filter((line) => line !== '');
  } catch {
    return [];
  }
}

const npmStandInCallSchema = z.strictObject({
  args: z.array(z.string()),
  cwd: z.string(),
  /** The PATH npm was started with. */
  path: z.string(),
  /** The `node` that ran the stand-in: the one `#!/usr/bin/env node` found. */
  node: z.string(),
});

/** @name NpmStandInCall @description One run of the stand-in npm, as it recorded it. */
export type NpmStandInCall = z.infer<typeof npmStandInCallSchema>;

/**
 * @description The text of a stand-in `npm` for the Node the line installs (the mirror's `bin/npm`; there is no registry in a flow). Like the real one it is a
 * `#!/usr/bin/env node` script, so it only starts where `env` finds a `node` on the PATH it is given — the point of using it: the utility's own install runs it
 * for real, instead of the shortcut that links `node_modules` without starting npm. It serves `npm ci` by linking `modulesDir` as the app's `node_modules` and
 * records every run (its arguments, folder, PATH and Node) as a line of JSON in `recordPath`.
 */
export function renderNpmStandIn(modulesDir: string, recordPath: string): string {
  return [
    '#!/usr/bin/env node',
    'const fs = require("fs");',
    'const path = require("path");',
    `fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), path: process.env.PATH, node: process.execPath }) + "\\n");`,
    'if (process.argv[2] !== "ci") { process.stderr.write("stand-in npm: only `ci` is served\\n"); process.exit(2); }',
    `fs.symlinkSync(${JSON.stringify(modulesDir)}, path.join(process.cwd(), "node_modules"), "dir");`,
    '',
  ].join('\n');
}

/** @description The runs of the stand-in npm recorded so far, in order. */
export function readNpmStandInCalls(recordPath: string): NpmStandInCall[] {
  try {
    return fs.readFileSync(recordPath, 'utf8').split('\n').filter((line) => line !== '').map((line) => npmStandInCallSchema.parse(JSON.parse(line)));
  } catch {
    return [];
  }
}
