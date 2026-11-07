import * as fs from 'fs';
import * as path from 'path';
import { getOutputTail, type CommandRunner } from '../selfUpdate/commandRunner';
import { isInside } from './homeFolders';
import { sharedNodeBase } from './serviceCommon';
import type { RunnerHomePaths } from './runnerHome';

/**
 * @description A runner runs on its OWN Node.js, never on a shared one (a system or Homebrew Node is the admin's to change, and a job that wants a
 * package manager or a global package cannot write into a system folder). The official build from nodejs.org is put in place by the package's
 * `remoteRun/ensureNode.sh` (the newest LTS release from 22.12 up to the last line that ships Corepack; download, SHA-256 against nodejs.org's
 * `SHASUMS256.txt`, unpack, move whole):
 *
 *   the admin line      as ROOT, into `sharedNodeBase` (`serviceCommon.ts`) — a folder only root can write, because root runs that Node (the root step, the pairing
 *                       it starts as the account) and must never run what the account, who runs the agents' code, can change. It is refreshed only by the next
 *                       admin line.
 *   the plain line      as the account, into `~/.charness-runner/node` (`paths.ownNodeDir`): nobody else is involved
 *   an older runner     (paired on a system Node) moves itself once its link is up (`nodeUpkeep.ts`), as the account, into `paths.ownNodeDir` — root is not there
 *                       then, and the Node of a link that runs as the account only needs to be the account's. Root never runs that copy: the root steps of an
 *                       admin line use the shared one the line installed.
 *   an own install      looks now and then for a newer release of ITS line (the same major), so it gets security fixes; the folders of versions no process uses
 *                       any more are removed (`nodeUpkeep.ts`)
 *
 * What a job may write stays out of the Node's folder: `NPM_CONFIG_PREFIX`, `COREPACK_HOME` and the `corepack` wrapper of `packageManagerShims.ts`.
 */

/** The package's script (a POSIX path inside it: it is also named in the pasted lines, which are `sh`). */
export const ensureNodeScriptRelativePath = 'remoteRun/ensureNode.sh';
/**
 * The script's own limits add up to 2 × 60 s (the list of releases, the release's checksums) + 900 s (the archive), plus unpacking: this is more than that,
 * so the script ends by its own limits and says why, and this deadline is only the last resort.
 */
export const moveDeadlineMs = 25 * 60 * 1000;

/** Test seam, set only by a flow's environment: a `file://` folder laid out like `nodejs.org/dist`, for the install to download from (no network in a flow). */
export const testNodeDistEnvName = 'CHARNESS_TEST_RUNNER_NODE_DIST';
/** Test seam, set only by a flow's environment (`1`): the runner keeps the Node it was started with, so a flow that is not about the Node needs no download. */
export const testKeepNodeEnvName = 'CHARNESS_TEST_RUNNER_KEEP_NODE';

function getRealPath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

/** @description Is `nodePath` (by its real path) inside the shared Node folder? */
export function checkIsSharedNode(nodePath: string, sharedBase: string = sharedNodeBase): boolean {
  return isInside(getRealPath(sharedBase), getRealPath(nodePath));
}

/** @description Is `nodePath` (by its real path) inside the runner's own Node folder? */
export function checkIsOwnNode(nodePath: string, paths: Pick<RunnerHomePaths, 'ownNodeDir'>): boolean {
  return isInside(getRealPath(paths.ownNodeDir), getRealPath(nodePath));
}

/** @description Is `nodePath` (by its real path) inside the shared Node folder or the runner's own one? */
export function checkIsManagedNode(nodePath: string, paths: Pick<RunnerHomePaths, 'ownNodeDir'>, sharedBase: string = sharedNodeBase): boolean {
  return checkIsSharedNode(nodePath, sharedBase) || checkIsOwnNode(nodePath, paths);
}

/** @description What a log calls the Node.js at `nodePath` whose version is `version`: `Node.js 24.22.2 at /path/node`. */
export function describeNode(nodePath: string, version: string): string {
  return `Node.js ${version} at ${nodePath}`;
}

/** @description The version of an install by the name of its folder (`<base>/v24.22.2/bin/node` → `24.22.2`); `unknown` for a Node that is not in such a folder. */
export function getInstalledVersion(nodePath: string): string {
  const folderName = path.basename(path.dirname(path.dirname(nodePath)));
  return /^v\d+\.\d+\.\d+$/.test(folderName) ? folderName.slice(1) : 'unknown';
}

/** @description The version folder (`<ownNodeDir>/v24.22.2`) a Node of the runner's own is in, or `null`. */
export function getOwnInstallFolder(nodePath: string, paths: Pick<RunnerHomePaths, 'ownNodeDir'>): string | null {
  if (!checkIsOwnNode(nodePath, paths)) return null;
  const [versionName] = path.relative(getRealPath(paths.ownNodeDir), getRealPath(nodePath)).split(path.sep);
  return path.join(getRealPath(paths.ownNodeDir), versionName);
}

export type NodeInstallOutcome =
  /** The link runs on the shared Node the admin line installed: only the next admin line refreshes it. */
  | { kind: 'shared' }
  /** The link runs on its own Node, which is the newest release of its line. */
  | { kind: 'current' }
  /** A different Node of the runner's own is in place: a runner that moved off a system Node (`isMove`), or a newer release of the line. The caller points the launcher at it. */
  | { kind: 'installed'; nodePath: string; log: string; isMove: boolean }
  | { kind: 'failed'; reason: string };

export interface NodeMoveDeps {
  runner: CommandRunner;
  /** The Node this process runs under (`process.execPath`) and its version (`process.versions.node`). */
  currentNodePath: string;
  currentNodeVersion: string;
  /** The package's `remoteRun/ensureNode.sh` in the app that runs. */
  scriptPath: string;
  /** Where the script downloads from; `null` = nodejs.org (a flow's own mirror otherwise). */
  distUrl: string | null;
  sharedBase: string;
  checkScriptExists: (scriptPath: string) => boolean;
}

export function createNodeMoveDeps(appDir: string, runner: CommandRunner, environment: NodeJS.ProcessEnv = process.env): NodeMoveDeps {
  const distUrl = environment[testNodeDistEnvName];
  return {
    runner,
    currentNodePath: process.execPath,
    currentNodeVersion: process.versions.node,
    scriptPath: path.join(appDir, ensureNodeScriptRelativePath),
    distUrl: distUrl === undefined || distUrl === '' ? null : distUrl,
    sharedBase: sharedNodeBase,
    checkScriptExists: fs.existsSync,
  };
}

const scriptLinePrefix = 'charness-runner: ';

/** @description The words the script said, one line each, without the `charness-runner: ` it starts every line with (the log adds its own): the lines joined by `; `. */
export function formatScriptWords(text: string): string {
  return text.split('\n').map((line) => line.trim()).filter((line) => line !== '').map((line) => (line.startsWith(scriptLinePrefix) ? line.slice(scriptLinePrefix.length) : line)).join('; ');
}

/** The major of a version (`24.22.2` → `24`). */
function getMajor(version: string): string {
  return version.split('.')[0];
}

/**
 * @description Look after the runner's own Node.js: nothing on the shared one; on its own, the package's script is asked for the newest release of ITS line
 * (a runner on 22.x stays on 22.x: a new major is not a security fix, it changes what every job runs); anywhere else — a system or Homebrew Node — the
 * script puts the newest LTS in `paths.ownNodeDir` (a move). Never throws; `failed` carries the reason and the runner stays on the Node it has.
 */
export async function ensureOwnNode(paths: Pick<RunnerHomePaths, 'ownNodeDir'>, deps: NodeMoveDeps): Promise<NodeInstallOutcome> {
  if (checkIsSharedNode(deps.currentNodePath, deps.sharedBase)) return { kind: 'shared' };
  if (!deps.checkScriptExists(deps.scriptPath)) return { kind: 'failed', reason: `the package has no ${ensureNodeScriptRelativePath} (${deps.scriptPath})` };
  const isOwn = checkIsOwnNode(deps.currentNodePath, paths);
  const scriptArguments = [deps.scriptPath, 'own', paths.ownNodeDir];
  if (isOwn) scriptArguments.push(deps.distUrl ?? '', getMajor(deps.currentNodeVersion));
  else if (deps.distUrl !== null) scriptArguments.push(deps.distUrl);
  const result = await deps.runner('sh', scriptArguments, { timeoutMs: moveDeadlineMs });
  const nodePath = result.stdout.trim().split('\n').pop() ?? '';
  if (result.isTimedOut) return { kind: 'failed', reason: `the Node.js install did not finish within ${moveDeadlineMs / 60_000} minutes` };
  if (!result.ok) return { kind: 'failed', reason: formatScriptWords(getOutputTail(result, 2)) || `the Node.js install failed (exit ${result.exitCode ?? 'none'})` };
  if (!path.isAbsolute(nodePath) || !checkIsOwnNode(nodePath, paths)) return { kind: 'failed', reason: `the Node.js install named ${nodePath === '' ? 'no Node' : nodePath}, which is not inside ${paths.ownNodeDir}` };
  if (isOwn && getRealPath(nodePath) === getRealPath(deps.currentNodePath)) return { kind: 'current' };
  return { kind: 'installed', nodePath, log: formatScriptWords(result.stderr), isMove: !isOwn };
}
