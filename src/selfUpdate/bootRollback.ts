import * as fs from 'fs';
import { runCommand as defaultRunCommand, type CommandRunner } from './commandRunner';
import { createGitSource } from './gitSource';
import { detectInstallKind, type InstallKindFs } from './installKind';
import { createNpmSource, UpdateSourceError } from './npmSource';
import type { UpdatePendingMarker } from './updatePending';

/**
 * Putting the PREVIOUS version back when a new one cannot boot — run by the boot itself, before the bot module is imported.
 * It re-detects the install kind (the marker says what was installed, not where) and goes back the way the update went:
 * npm reinstalls the previous version from the cache where it can, a checkout resets to the previous commit and rebuilds.
 */

export interface BootRollbackOptions {
  /** The folder of the install that is running (holds `package.json` and `dist/`). */
  packageRoot: string;
  execPath: string;
  platform: NodeJS.Platform;
  hasExecve: boolean;
  /** A hot worker: the checkout's watcher rebuilds after the reset, a second build beside it would race. */
  isHotWorker: boolean;
  runCommand?: CommandRunner;
  filesystem?: InstallKindFs;
}

function createDefaultFilesystem(): InstallKindFs {
  return {
    checkExists: (target) => fs.existsSync(target),
    checkIsWritable: (directory) => {
      try {
        fs.accessSync(directory, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** @description The function {@link runBootUpdateCheck} calls to go back; it throws an {@link UpdateSourceError} the log can print. */
export function createBootRollback(options: BootRollbackOptions): (marker: UpdatePendingMarker) => Promise<void> {
  const runCommand = options.runCommand ?? defaultRunCommand;
  return async (marker) => {
    const installKind = detectInstallKind({
      packageRoot: options.packageRoot,
      fs: options.filesystem ?? createDefaultFilesystem(),
      platform: options.platform,
      hasExecve: options.hasExecve,
    });
    if (marker.kind === 'npm') {
      if (installKind.kind !== 'npmGlobal') throw new UpdateSourceError(`this install is not an npm global one any more (${installKind.kind})`);
      await createNpmSource({ runCommand, execPath: options.execPath, prefix: installKind.prefix }).install(marker.from.version, { isRollback: true });
      return;
    }
    if (installKind.kind !== 'checkout') throw new UpdateSourceError(`this install is not a git checkout any more (${installKind.kind})`);
    if (marker.from.commit === null || marker.to.commit === null) throw new UpdateSourceError('the marker names no commit to go back to');
    await createGitSource({ runCommand, root: installKind.root }).rollback({ from: marker.from.commit, to: marker.to.commit, isHot: options.isHotWorker });
  };
}
