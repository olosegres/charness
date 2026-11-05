/**
 * @description An `ioreg` for a flow that runs on a box with no lid: it prints the registry text a flow sets (`setLid`), the way `ioreg -r -k AppleClamshellState -d 4`
 * does on a MacBook. Put its folder first on a runner's `PATH` and the runner utility reports a lid like a Mac does (`checkCanReadLid`); not a test itself.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** What the registry says for each state a lid can be in (the keys and their values are the registry's own; `unreadable` is an `ioreg` that fails). */
export type StandInLid = 'open' | 'closed' | 'clamshell' | 'unreadable';

export interface IoregStandIn {
  /** The folder to put first on the runner's `PATH`. */
  binDir: string;
  /** From now on `ioreg` says this. */
  setLid: (lid: StandInLid) => void;
}

const registryTexts: Record<Exclude<StandInLid, 'unreadable'>, string> = {
  open: '"AppleClamshellCausesSleep" = Yes\n"AppleClamshellState" = No\n',
  closed: '"AppleClamshellCausesSleep" = Yes\n"AppleClamshellState" = Yes\n',
  clamshell: '"AppleClamshellCausesSleep" = No\n"AppleClamshellState" = Yes\n',
};

export function createIoregStandIn(root: string): IoregStandIn {
  const folder = path.join(root, 'ioreg-standin');
  const binDir = path.join(folder, 'bin');
  const registryFile = path.join(folder, 'registry.txt');
  const failFile = path.join(folder, 'fail');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(registryFile, registryTexts.open);
  fs.writeFileSync(path.join(binDir, 'ioreg'), `#!/bin/sh\n[ -f '${failFile}' ] && exit 1\ncat '${registryFile}'\n`, { mode: 0o755 });
  return {
    binDir,
    setLid: (lid) => {
      if (lid === 'unreadable') {
        fs.writeFileSync(failFile, '');
        return;
      }
      fs.rmSync(failFile, { force: true });
      // A temp file and a rename: the runner reads it every second and must never see half of it.
      fs.writeFileSync(`${registryFile}.tmp`, registryTexts[lid]);
      fs.renameSync(`${registryFile}.tmp`, registryFile);
    },
  };
}
