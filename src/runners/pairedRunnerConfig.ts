import * as path from 'path';
import { joinShellWords } from '../remoteRun/ssh';
import type { RunnerConfig } from '../remoteRun/runnersConfig';
import { getHubFilePaths, getRunnerHostAlias, getRunnerLinkPaths, type HubContext } from './hubPaths';
import type { PairedRunner } from './hubRegistry';

/**
 * @description A paired runner as the phase-1 `remote-run` core sees a runner: a `RunnerConfig` whose ssh goes through the link
 * (`runner-proxy` as the `ProxyCommand`, the hub key, the hub's own `known_hosts`, the host key pinned under the runner's alias). The
 * runner's private Pueue lives beside its work folder (`<state dir>/pueue/pueue.yml`, `<state dir>/bin/pueue` — the layout of
 * `runnerUtility/runnerHome.ts`), so its paths are derived from the work dir the runner reported at pairing.
 */

const runnerStateDirName = '.charness-runner';

/** The state folder of the runner (`~/.charness-runner`) is the parent of the work dir it reported (`<state>/work`). */
function getRunnerStateDir(workDir: string): string {
  return path.posix.dirname(workDir);
}

export function buildPairedRunnerConfig(ctx: HubContext, runner: PairedRunner): RunnerConfig {
  const files = getHubFilePaths(ctx.dir);
  const alias = getRunnerHostAlias(runner.id);
  const stateDir = getRunnerStateDir(runner.workDir);
  return {
    name: runner.name,
    ssh: alias,
    sshOptions: [
      '-F', '/dev/null',
      '-o', `ProxyCommand=${joinShellWords([ctx.nodePath, ctx.cliPath, 'runner-proxy', getRunnerLinkPaths(ctx.dir, runner.id).socket])}`,
      '-o', `HostKeyAlias=${alias}`,
      '-o', `UserKnownHostsFile=${files.knownHosts}`,
      '-o', 'GlobalKnownHostsFile=/dev/null',
      '-o', 'StrictHostKeyChecking=yes',
      '-i', files.hubKey,
      '-o', 'IdentitiesOnly=yes',
      '-o', 'IdentityAgent=none',
    ],
    workDir: runner.workDir,
    pueue: stateDir.endsWith(runnerStateDirName) ? { bin: `${stateDir}/bin/pueue`, config: `${stateDir}/pueue/pueue.yml` } : undefined,
  };
}
