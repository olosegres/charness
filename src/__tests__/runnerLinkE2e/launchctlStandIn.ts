/**
 * @description A `launchctl` for a flow that runs on Linux: it keeps the state of ONE account's GUI domain (`gui/<uid>`: a session, the login session's agent loaded or
 * not) in files, records every call, and can be told to fail `bootstrap` the way launchd does (error 5). Put its folder first on a runner's `PATH`; not a test itself.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface LaunchctlStandIn {
  /** The folder to put first on the runner's `PATH`. */
  binDir: string;
  /** Every call made so far, one `verb arguments…` string each. */
  readCalls: () => string[];
  /** Is a job loaded in the account's domain: a `bootstrap` came and no `bootout` since. */
  checkIsLoaded: () => boolean;
  /** From now on `bootstrap` fails (`true`) or works (`false`). */
  setBootstrapFailing: (isFailing: boolean) => void;
}

const standInFolderName = 'launchctl-standin';

export function createLaunchctlStandIn(root: string): LaunchctlStandIn {
  const folder = path.join(root, standInFolderName);
  const binDir = path.join(folder, 'bin');
  const callsFile = path.join(folder, 'calls.log');
  const loadedFile = path.join(folder, 'loaded');
  const failFile = path.join(folder, 'fail-bootstrap');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(callsFile, '');
  // A stand-in made again starts from a domain with nothing loaded, whatever an earlier one left.
  fs.rmSync(loadedFile, { force: true });
  fs.rmSync(failFile, { force: true });
  const script = [
    '#!/bin/sh',
    `echo "$*" >> '${callsFile}'`,
    'uid=$(id -u)',
    'case "$1 $2" in',
    '  "print gui/$uid") exit 0 ;;',
    `  "print gui/$uid/"*) [ -f '${loadedFile}' ] && exit 0; echo 'Could not find service in domain for user gui: '"$uid" >&2; exit 113 ;;`,
    `  "bootout gui/$uid/"*) rm -f '${loadedFile}'; exit 0 ;;`,
    `  "bootstrap gui/$uid") if [ -f '${failFile}' ]; then echo 'Bootstrap failed: 5: Input/output error' >&2; exit 5; fi; : > '${loadedFile}'; exit 0 ;;`,
    'esac',
    'echo "unexpected launchctl call: $*" >&2',
    'exit 64',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(binDir, 'launchctl'), script, { mode: 0o755 });
  return {
    binDir,
    readCalls: () => fs.readFileSync(callsFile, 'utf8').split('\n').filter((line) => line !== ''),
    checkIsLoaded: () => fs.existsSync(loadedFile),
    setBootstrapFailing: (isFailing) => {
      if (isFailing) fs.writeFileSync(failFile, '');
      else fs.rmSync(failFile, { force: true });
    },
  };
}
