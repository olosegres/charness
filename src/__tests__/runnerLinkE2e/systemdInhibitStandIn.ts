/**
 * @description A `systemd-inhibit` for a flow that must not depend on the box having a working one (no D-Bus session, a container, a CI image): it takes the options of the real tool
 * (`--what=idle --who=… --why=… --mode=block`) and runs the command after them for as long as the command lasts — the lock being nothing but that process. Put its folder first on a runner's `PATH`
 * and the link's sleep-assertion holder is `systemd-inhibit` everywhere; the process shows as `sh …/systemd-inhibit --what=idle --who=charness-runner …` (what the runner's own check of a recorded holder
 * looks for), and ends with a TERM like the real one. The real tool is exercised by the unit suite (`runnerUtilityKeepAwake.test.ts`) where the box has one. Not a test itself.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const standInScript = `#!/bin/sh
while [ $# -gt 0 ]; do
  case "$1" in
    --*) shift ;;
    *) break ;;
  esac
done
"$@" &
child=$!
trap 'kill "$child" 2> /dev/null; exit 0' TERM INT
wait "$child"
`;

/** @description Create the stand-in under `root`; returns the folder to put first on the runner's `PATH`. */
export function createSystemdInhibitStandIn(root: string): string {
  const binDir = path.join(root, 'systemd-inhibit-standin', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'systemd-inhibit'), standInScript, { mode: 0o755 });
  return binDir;
}
