/**
 * @description The detached reaper of one runner-flow layout (`remoteRunFlowKit.ts`): started in its own session, so a SIGKILL of the
 * test's process group — which no `exit` handler of the test ever sees — does not reach it. It polls the layout's owner file; once the
 * owning test process is gone it sweeps the layout (`remoteRunFlowSweep.ts`: sshd, Pueue's daemon, the runner script, the CLI children,
 * every decoy) and removes the folder. A folder removed by the test's own cleanup ends it.
 *
 * Usage: node --import tsx remoteRunFlowReaper.ts <layoutRoot>
 */

import * as fs from 'fs';
import { checkIsFlowLayoutOwnerAlive, readFlowLayoutOwner, sweepFlowLayout } from './remoteRunFlowSweep';

const pollIntervalMs = 1000;

function main(): void {
  const root = process.argv[2];
  if (!root) throw new Error('usage: remoteRunFlowReaper.ts <layoutRoot>');
  const timer = setInterval(() => {
    if (!fs.existsSync(root)) {
      clearInterval(timer);
      return;
    }
    const owner = readFlowLayoutOwner(root);
    if (owner === null || checkIsFlowLayoutOwnerAlive(owner)) return;
    sweepFlowLayout(root);
    clearInterval(timer);
  }, pollIntervalMs);
}

main();
