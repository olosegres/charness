import * as os from 'os';
import * as path from 'path';
import { getRunnersConfigPath } from '../remoteRun/runnersConfig';

/**
 * @description Where the hub keeps what paired runners need. ONE folder per OS user — `~/.config/charness/runners/`, beside the
 * hand-made `runners.json` — and every `authorized_keys` line NAMES it (`gate --dir <dir>`), so nothing the gate does depends on
 * `$HOME`, `DATA_DIR` or which instance runs it: any charness instance of the user, the bot and the CLI alike, shares one registry.
 */

const runnersDirName = 'runners';
const sshDirName = '.ssh';
const authorizedKeysFileName = 'authorized_keys';
const cliFileName = 'cli.js';

/** @description Everything the hub side needs to know about the machine it runs on; tests build their own. */
export interface HubContext {
  /** The registry folder (0700). */
  dir: string;
  /** The `authorized_keys` file sshd reads for the account (a flow test points its sshd at a temp one). */
  authorizedKeysPath: string;
  /** The node binary and the charness `cli.js` the gate wrapper runs. */
  nodePath: string;
  cliPath: string;
  /** The folder with `package.json`, `dist/` and `remoteRun/` — the package a runner installs. */
  packageRoot: string;
}

export interface HubFilePaths {
  paired: string;
  pending: string;
  hubKey: string;
  hubPublicKey: string;
  knownHosts: string;
  gate: string;
  linkDir: string;
  packageDir: string;
}

/** @description The hand-made `runners.json` that sits beside the registry folder (see {@link createHubContext}). */
export function getHandMadeRunnersPath(dir: string): string {
  return path.join(path.dirname(dir), 'runners.json');
}

export interface RunnerLinkPaths {
  socket: string;
  state: string;
}

/** @description `dist/cli.js` of the running charness: this file is `dist/runners/hubPaths.js`. */
function getOwnCliPath(): string {
  return path.resolve(__dirname, '..', cliFileName);
}

/** @description The context of the real machine for `homeDir`; every field can be overridden. */
export function createHubContext(overrides: Partial<HubContext> & { homeDir?: string } = {}): HubContext {
  const homeDir = overrides.homeDir ?? os.homedir();
  const cliPath = overrides.cliPath ?? getOwnCliPath();
  return {
    dir: overrides.dir ?? path.join(path.dirname(getRunnersConfigPath(homeDir)), runnersDirName),
    authorizedKeysPath: overrides.authorizedKeysPath ?? path.join(homeDir, sshDirName, authorizedKeysFileName),
    nodePath: overrides.nodePath ?? process.execPath,
    cliPath,
    packageRoot: overrides.packageRoot ?? path.resolve(path.dirname(cliPath), '..'),
  };
}

export function getHubFilePaths(dir: string): HubFilePaths {
  return {
    paired: path.join(dir, 'paired.json'),
    pending: path.join(dir, 'pending.json'),
    hubKey: path.join(dir, 'hub_ed25519'),
    hubPublicKey: path.join(dir, 'hub_ed25519.pub'),
    knownHosts: path.join(dir, 'known_hosts'),
    gate: path.join(dir, 'gate'),
    linkDir: path.join(dir, 'link'),
    packageDir: path.join(dir, 'package'),
  };
}

/** @description The socket the gate of runner `runnerId` listens on, and the file that says who holds it. */
export function getRunnerLinkPaths(dir: string, runnerId: string): RunnerLinkPaths {
  const linkDir = getHubFilePaths(dir).linkDir;
  return { socket: path.join(linkDir, `${runnerId}.sock`), state: path.join(linkDir, `${runnerId}.json`) };
}

/** @description The host alias of a runner in the hub's `known_hosts` (and the `HostKeyAlias` of the ssh calls to it). */
export function getRunnerHostAlias(runnerId: string): string {
  return `charness-runner-${runnerId}`;
}
