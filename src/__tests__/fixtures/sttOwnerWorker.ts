/**
 * A stand-in for a bot "worker" process in the lifecycle tests: it runs the REAL owner (`ensure`) against the
 * fake sidecar and prints the endpoint as one JSON line.
 *
 *   node --import tsx sttOwnerWorker.ts <dataDir> <owner> <mode>
 *
 * `owner` is `self` (this process owns the sidecar) or `<pid>:<startToken>`. `mode`: `ensure` prints and exits
 * (a worker that is replaced by a hot reload), `ensure-and-stay` prints and then lives on until killed (a
 * decoy owner: the test SIGKILLs it and expects the sidecar to follow).
 */
import * as path from 'path';
import { getProcessIdentity } from '../../installManager';
import {
  createDefaultSttSidecarOwnerDeps,
  createSttSidecarOwner,
  type SttOwnerContext,
} from '../../stt/sttSidecarOwner';

const [dataDir, ownerArg, mode] = process.argv.slice(2);
const fakeSidecarPath = path.join(__dirname, 'fakeSttSidecar.cjs');

function resolveOwner(): SttOwnerContext {
  if (ownerArg === 'self') {
    const identity = getProcessIdentity(process.pid);
    if (!identity) throw new Error('cannot read the own start token');
    return { pid: identity.pid, startToken: identity.startToken };
  }
  const [pid, startToken] = ownerArg.split(':');
  return { pid: Number(pid), startToken };
}

const owner = resolveOwner();
const deps = {
  ...createDefaultSttSidecarOwnerDeps(() => dataDir),
  getOwnerContext: () => owner,
  getLaunch: () => ({ command: process.execPath, args: [fakeSidecarPath] }),
  log: () => {},
};

createSttSidecarOwner(deps)
  .ensure({ idleMinutes: 15, workers: 4 })
  .then((endpoint) => {
    console.log(JSON.stringify(endpoint));
    if (mode === 'ensure-and-stay') setInterval(() => {}, 1000);
    else process.exit(0);
  })
  .catch((error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
