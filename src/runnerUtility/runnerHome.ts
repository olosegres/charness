import * as os from 'os';
import * as path from 'path';

/**
 * @description Where the runner utility keeps its state: `~/.charness-runner/` (0700) of the account that runs the jobs. Builtins only:
 * the very first step of a pairing (before any dependency is installed) already needs these paths.
 *
 *   config.json   who the runner serves (hub address and pinned host key, the hub's public key, its own id and name)
 *   status.json   what the link is doing right now (written by `run`, read by `status`)
 *   keys/         the runner's client key (logs in to the hub) and the host key of its built-in ssh server
 *   app.<id>/     an installed copy of the hub's charness package; `current` points at the one in use
 *   bin/          the `charness-runner` launcher, pueue, pueued, rsync when built
 *   env           the operator's KEY=VALUE lines, added to every job's environment
 *   work/         the work dir of remote-run (phase 1); pueue/ the private Pueue; logs/; build/ scratch for the rsync build
 */

const stateDirName = '.charness-runner';
const binDirName = 'bin';
const launcherName = 'charness-runner';

/** @description The launcher relative to the account's home, `/`-separated — the admin pairing line (`runners/bootstrapLine.ts`) runs it by this name. */
export const launcherPathInHome = [stateDirName, binDirName, launcherName].join('/');

export interface RunnerHomePaths {
  homeDir: string;
  root: string;
  config: string;
  status: string;
  /** A pairing that was started and not finished (see `pairingRecovery.ts`). */
  pairing: string;
  /** An empty file: the operator paused this runner ("is this machine busy"). Read by `runner.sh probe` as `paused=`. */
  pausedFlag: string;
  /** One word, `user-service` or `system-service`, while a service is installed. Read by `runner.sh probe` as `service=`. */
  serviceMarker: string;
  /** The iOS Simulator boot check's last result (`iosCheck.ts`). Read by `runner.sh probe` as `ios_boot=`. */
  iosCheck: string;
  keysDir: string;
  clientKey: string;
  serverKey: string;
  currentApp: string;
  binDir: string;
  launcher: string;
  envFile: string;
  workDir: string;
  pueueDir: string;
  pueueConfig: string;
  logsDir: string;
  buildDir: string;
}

export function getRunnerHomePaths(homeDir: string = os.homedir()): RunnerHomePaths {
  const root = path.join(homeDir, stateDirName);
  return {
    homeDir,
    root,
    config: path.join(root, 'config.json'),
    status: path.join(root, 'status.json'),
    pairing: path.join(root, 'pairing.json'),
    pausedFlag: path.join(root, 'paused'),
    serviceMarker: path.join(root, 'service'),
    iosCheck: path.join(root, 'ios-check.json'),
    keysDir: path.join(root, 'keys'),
    clientKey: path.join(root, 'keys', 'client_ed25519'),
    serverKey: path.join(root, 'keys', 'server_host_ed25519'),
    currentApp: path.join(root, 'current'),
    binDir: path.join(root, binDirName),
    launcher: path.join(root, binDirName, launcherName),
    envFile: path.join(root, 'env'),
    workDir: path.join(root, 'work'),
    pueueDir: path.join(root, 'pueue'),
    pueueConfig: path.join(root, 'pueue', 'pueue.yml'),
    logsDir: path.join(root, 'logs'),
    buildDir: path.join(root, 'build'),
  };
}

/** @description The folder of one installed copy of the package. */
export function getAppDirPath(paths: RunnerHomePaths, appId: string): string {
  return path.join(paths.root, `app.${appId}`);
}
