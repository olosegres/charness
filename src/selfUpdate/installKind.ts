import * as path from 'path';

/**
 * @description How this charness was installed — decided by what the package folder IS and by what the bot may
 * write there, never by "is this a container": a Docker image mounting a git checkout is a checkout.
 *
 *   - `npmGlobal`: `npm install -g`, the prefix writable → `npm install -g charness@X` into the SAME prefix.
 *   - `checkout`: a git checkout (`npm link` and a mounted checkout included), writable → `scripts/self-update.sh`.
 *   - `notifyOnly`: it cannot update itself (no write access, a package manager we do not drive, a Node without
 *     `process.execve`): for an npm-style install it says a new version is out and names the command to run by hand; a
 *     checkout (`isCheckout`) is not watched at all — `/update` names the reason and the command.
 *   - `ephemeral`: `npx` — gone after the run, nothing to update.
 */
export type InstallKind =
  | { kind: 'npmGlobal'; prefix: string }
  | { kind: 'checkout'; root: string }
  | { kind: 'notifyOnly'; reason: NotifyOnlyReason; manualCommand: string; isCheckout: boolean }
  | { kind: 'ephemeral' };

/** @name NotifyOnlyReason @description Why an install can only notify; the `/update` screen words each one. */
export type NotifyOnlyReason = 'readOnlyPrefix' | 'readOnlyCheckout' | 'packageManager' | 'localInstall' | 'noExecve';

/** What the detector needs from the filesystem — injected, so a test needs no real prefix. */
export interface InstallKindFs {
  checkExists: (target: string) => boolean;
  /** Whether the current process may create and replace entries in the directory. */
  checkIsWritable: (directory: string) => boolean;
}

export interface InstallKindInput {
  /** The package's folder, symlinks resolved (`fs.realpathSync`) — the folder `dist/cli.js` sits in. */
  packageRoot: string;
  fs: InstallKindFs;
  platform: NodeJS.Platform;
  /** Whether this Node has `process.execve` (22.15+, POSIX): the plain-mode restart needs it. */
  hasExecve: boolean;
}

const ephemeralFolderName = '_npx';
const nodeModulesFolderName = 'node_modules';
const gitEntryName = '.git';
const selfUpdateScriptRelativePath = path.join('scripts', 'self-update.sh');
const npmGlobalLibFolderName = 'lib';
const npmGlobalBinFolderName = 'bin';
/** Path fragments of the package managers whose global installs we do not drive. */
const foreignPackageManagerFragments: ReadonlyArray<{ fragment: string; manualCommand: string }> = [
  { fragment: `${path.sep}.pnpm${path.sep}`, manualCommand: 'pnpm add -g charness@latest' },
  { fragment: `${path.sep}pnpm${path.sep}global${path.sep}`, manualCommand: 'pnpm add -g charness@latest' },
  { fragment: `${path.sep}.bun${path.sep}`, manualCommand: 'bun add -g charness@latest' },
  { fragment: `${path.sep}yarn${path.sep}global${path.sep}`, manualCommand: 'yarn global add charness@latest' },
  { fragment: `${path.sep}.yarn${path.sep}`, manualCommand: 'yarn global add charness@latest' },
];
export const npmManualCommand = 'npm install -g charness@latest';

function getCheckoutManualCommand(root: string): string {
  return path.join(root, selfUpdateScriptRelativePath);
}

/**
 * The npm global prefix a package folder sits under: `<prefix>/lib/node_modules/charness` on POSIX,
 * `<prefix>/node_modules/charness` on Windows. `null` when the folder is not directly inside a `node_modules`.
 */
function getNpmPrefix(packageRoot: string, platform: NodeJS.Platform): { prefix: string; isGlobalLayout: boolean } | null {
  const nodeModulesDirectory = path.dirname(packageRoot);
  if (path.basename(nodeModulesDirectory) !== nodeModulesFolderName) return null;
  const parent = path.dirname(nodeModulesDirectory);
  if (platform === 'win32') return { prefix: parent, isGlobalLayout: true };
  return path.basename(parent) === npmGlobalLibFolderName
    ? { prefix: path.dirname(parent), isGlobalLayout: true }
    : { prefix: parent, isGlobalLayout: false };
}

/** @description Decide the install kind of a package folder. */
export function detectInstallKind({ packageRoot, fs: filesystem, platform, hasExecve }: InstallKindInput): InstallKind {
  if (packageRoot.split(path.sep).includes(ephemeralFolderName)) return { kind: 'ephemeral' };

  if (filesystem.checkExists(path.join(packageRoot, gitEntryName))) {
    const manualCommand = getCheckoutManualCommand(packageRoot);
    if (!hasExecve) return { kind: 'notifyOnly', reason: 'noExecve', manualCommand, isCheckout: true };
    const canWrite = filesystem.checkIsWritable(packageRoot) && filesystem.checkExists(path.join(packageRoot, selfUpdateScriptRelativePath));
    return canWrite ? { kind: 'checkout', root: packageRoot } : { kind: 'notifyOnly', reason: 'readOnlyCheckout', manualCommand, isCheckout: true };
  }

  const foreign = foreignPackageManagerFragments.find(({ fragment }) => `${packageRoot}${path.sep}`.includes(fragment));
  if (foreign) return { kind: 'notifyOnly', reason: 'packageManager', manualCommand: foreign.manualCommand, isCheckout: false };

  const npmPrefix = getNpmPrefix(packageRoot, platform);
  if (npmPrefix === null || !npmPrefix.isGlobalLayout) {
    return { kind: 'notifyOnly', reason: 'localInstall', manualCommand: 'npm install charness@latest', isCheckout: false };
  }
  if (!hasExecve) return { kind: 'notifyOnly', reason: 'noExecve', manualCommand: npmManualCommand, isCheckout: false };

  const nodeModulesDirectory = path.dirname(packageRoot);
  const binDirectory = path.join(npmPrefix.prefix, npmGlobalBinFolderName);
  const canWrite =
    filesystem.checkIsWritable(nodeModulesDirectory) && (platform === 'win32' || filesystem.checkIsWritable(binDirectory));
  return canWrite
    ? { kind: 'npmGlobal', prefix: npmPrefix.prefix }
    : { kind: 'notifyOnly', reason: 'readOnlyPrefix', manualCommand: npmManualCommand, isCheckout: false };
}
