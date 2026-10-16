/**
 * A stand-in for a bot "worker" process in the lifecycle tests: it runs the REAL owner (`ensure`) against the
 * fake sidecar and prints the endpoint as one JSON line.
 *
 *   node --import tsx sttOwnerWorker.ts <dataDir> <owner> <mode> [<fake sidecar args as JSON>]
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

const [dataDir, ownerArg, mode, fakeArgsJson] = process.argv.slice(2);
const fakeArgs: string[] = fakeArgsJson ? JSON.parse(fakeArgsJson) : [];
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
const defaultDeps = createDefaultSttSidecarOwnerDeps(() => dataDir);
const deps = {
  ...defaultDeps,
  getOwnerContext: () => owner,
  getLaunch: () => ({ command: process.execPath, args: [fakeSidecarPath, ...fakeArgs] }),
  // Tells the test the sidecar exists, so it can replace this worker while the sidecar is still starting.
  startProcess: async (command: string, args: string[], env: NodeJS.ProcessEnv) => {
    const identity = await defaultDeps.startProcess(command, args, env);
    console.log(`SPAWNED ${identity.pid}`);
    return identity;
  },
  log: () => {},
};

createSttSidecarOwner(deps)
  .ensure({ idleMinutes: 15, workers: 4 })
  .then((endpoint) => {
    console.log(`ENDPOINT ${JSON.stringify(endpoint)}`);
    if (mode === 'ensure-and-stay') setInterval(() => {}, 1000);
    else process.exit(0);
  })
  .catch((error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
