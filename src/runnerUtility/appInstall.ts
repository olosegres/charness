import { spawn, spawnSync } from 'child_process';
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

/** How much of npm's stderr is kept to say what went wrong: its last words are the useful ones. */
const maxKeptStderrBytes = 16 * 1024;
const stderrTailLines = 3;

/**
 * Install the production dependencies of the package in `appDir`; scripts are not run (nothing the runner needs builds). Asynchronous, so the
 * step line can show that something is happening while npm works (it takes a minute). Rejects with npm's last words.
 */
export function installDependencies(appDir: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const linked = env[testNodeModulesEnvName];
  if (linked !== undefined && linked !== '') {
    fs.symlinkSync(linked, path.join(appDir, 'node_modules'), 'dir');
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const child = spawn(findNpm(), ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-progress'], { cwd: appDir, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let keptStderr = '';
    let isTimedOut = false;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { keptStderr = (keptStderr + chunk).slice(-maxKeptStderrBytes); });
    const timer = setTimeout(() => {
      isTimedOut = true;
      child.kill('SIGKILL');
    }, npmInstallTimeoutMs);
    const fail = (cause: string): void => {
      clearTimeout(timer);
      const detail = keptStderr.trim().split('\n').slice(-stderrTailLines).join(' | ');
      reject(new Error(`npm install failed${cause === '' ? '' : ` (${cause})`}${detail === '' ? '' : `: ${detail}`}`));
    };
    child.once('error', (error) => fail(error.message));
    child.once('close', (code) => {
      if (isTimedOut) fail(`timed out after ${npmInstallTimeoutMs / 60_000} minutes`);
      else if (code === 0) {
        clearTimeout(timer);
        resolve();
      } else fail('');
    });
  });
}

/** @description Copy an unpacked package into a new app folder and install its dependencies; returns the folder. Removes it again if the install fails. */
export async function installAppFromDirectory(sourceDir: string, paths: RunnerHomePaths): Promise<string> {
  const appDir = getAppDirPath(paths, createAppId());
  fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  fs.cpSync(sourceDir, appDir, { recursive: true });
  try {
    await installDependencies(appDir);
  } catch (error) {
    fs.rmSync(appDir, { recursive: true, force: true });
    throw error;
  }
  return appDir;
}

/** @description Unpack a gzip tar archive (the hub's package) into a new app folder with the system `tar`, and install its dependencies. */
export async function installAppFromArchive(archivePath: string, paths: RunnerHomePaths): Promise<string> {
  const appDir = getAppDirPath(paths, createAppId());
  fs.mkdirSync(appDir, { recursive: true, mode: 0o700 });
  try {
    const unpacked = spawnSync('tar', ['-xzf', archivePath, '-C', appDir], { encoding: 'utf8' });
    if (unpacked.status !== 0) throw new Error(`could not unpack the package (tar exit ${unpacked.status ?? 'none'})`);
    await installDependencies(appDir);
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
