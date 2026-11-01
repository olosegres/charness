import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getAppDirPath, type RunnerHomePaths } from './runnerHome';

/**
 * @description Installing a copy of the hub's charness package for the runner to run, and switching to it. BUILTINS ONLY: the first
 * `charness-runner pair` is started from a package that has no `node_modules` yet, and this is the step that makes them.
 *
 * An app lives in `app.<random id>/` and is never renamed or changed once it runs; `current` is a symlink that is replaced whole. The
 * launcher (`launcher.ts`) starts whatever `current` points at, so an update is: install next to the old one, point `current` at it,
 * exit with {@link restartExitCode}.
 */

/** The exit code that asks the launcher to start the app again (EX_TEMPFAIL) — after an update. */
export const restartExitCode = 75;
const npmInstallTimeoutMs = 10 * 60 * 1000;
const appsToKeep = 2;
const appDirPattern = /^app\.[0-9a-f]+$/;
const randomIdBytes = 6;
const maxBufferBytes = 64 * 1024 * 1024;

/** Test seam, set only by a flow's environment: the folder to link as `node_modules` instead of running `npm install` (no registry in a flow). */
export const testNodeModulesEnvName = 'CHARNESS_TEST_RUNNER_NODE_MODULES';

export function createAppId(): string {
  let id = '';
  for (let index = 0; index < randomIdBytes; index += 1) id += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  return id;
}

function findNpm(): string {
  const besideNode = path.join(path.dirname(process.execPath), 'npm');
  return fs.existsSync(besideNode) ? besideNode : 'npm';
}

/** Install the production dependencies of the package in `appDir`; scripts are not run (nothing the runner needs builds). Throws with npm's last words. */
export function installDependencies(appDir: string, env: NodeJS.ProcessEnv = process.env): void {
  const linked = env[testNodeModulesEnvName];
  if (linked !== undefined && linked !== '') {
    fs.symlinkSync(linked, path.join(appDir, 'node_modules'), 'dir');
    return;
  }
  const result = spawnSync(findNpm(), ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-progress'], {
    cwd: appDir,
    encoding: 'utf8',
    timeout: npmInstallTimeoutMs,
    maxBuffer: maxBufferBytes,
    env,
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = `${result.stderr ?? ''}`.trim().split('\n').slice(-3).join(' | ');
    throw new Error(`npm install failed${result.error === undefined ? '' : ` (${result.error.message})`}${detail === '' ? '' : `: ${detail}`}`);
  }
}

/** @description Copy an unpacked package into a new app folder and install its dependencies; returns the folder. Removes it again if the install fails. */
export function installAppFromDirectory(sourceDir: string, paths: RunnerHomePaths): string {
  const appDir = getAppDirPath(paths, createAppId());
  fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  fs.cpSync(sourceDir, appDir, { recursive: true });
  try {
    installDependencies(appDir);
  } catch (error) {
    fs.rmSync(appDir, { recursive: true, force: true });
    throw error;
  }
  return appDir;
}

/** @description Unpack a gzip tar archive (the hub's package) into a new app folder with the system `tar`, and install its dependencies. */
export function installAppFromArchive(archivePath: string, paths: RunnerHomePaths): string {
  const appDir = getAppDirPath(paths, createAppId());
  fs.mkdirSync(appDir, { recursive: true, mode: 0o700 });
  try {
    const unpacked = spawnSync('tar', ['-xzf', archivePath, '-C', appDir], { encoding: 'utf8' });
    if (unpacked.status !== 0) throw new Error(`could not unpack the package (tar exit ${unpacked.status ?? 'none'})`);
    installDependencies(appDir);
  } catch (error) {
    fs.rmSync(appDir, { recursive: true, force: true });
    throw error;
  }
  return appDir;
}

/** @description Point `current` at `appDir` in one atomic step. */
export function switchCurrentApp(paths: RunnerHomePaths, appDir: string): void {
  const temporaryLink = `${paths.currentApp}.${process.pid}.tmp`;
  fs.rmSync(temporaryLink, { force: true });
  fs.symlinkSync(appDir, temporaryLink, 'dir');
  fs.renameSync(temporaryLink, paths.currentApp);
}

/** @description Remove old app folders: all but the one `current` points at and the newest other one (the previous version, in case the new one must be rolled back by hand). */
export function removeOldApps(paths: RunnerHomePaths): void {
  let currentTarget: string | null = null;
  try {
    currentTarget = fs.realpathSync(paths.currentApp);
  } catch {
    currentTarget = null;
  }
  const apps = fs.readdirSync(paths.root)
    .filter((name) => appDirPattern.test(name))
    .map((name) => ({ name, dir: path.join(paths.root, name), modifiedAt: fs.statSync(path.join(paths.root, name)).mtimeMs }))
    .filter((app) => currentTarget === null || fs.realpathSync(app.dir) !== currentTarget)
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
  for (const app of apps.slice(appsToKeep - 1)) fs.rmSync(app.dir, { recursive: true, force: true });
}
