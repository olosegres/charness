import * as fs from 'fs';
import * as path from 'path';
import { getOutputTail, type CommandRunner } from '../selfUpdate/commandRunner';
import { isInside } from './homeFolders';
import { sharedNodeBase } from './serviceCommon';
import type { RunnerHomePaths } from './runnerHome';

/**
 * @description A runner runs on its OWN Node.js, never on a shared one (a system or Homebrew Node is the admin's to change, and a job that wants a
 * package manager or a global package cannot write into a system folder). The official build from nodejs.org is put in place by the package's
 * `remoteRun/ensureNode.sh` (download, SHA-256 against nodejs.org's `SHASUMS256.txt`, unpack, move whole):
 *
 *   the admin line      as ROOT, into `sharedNodeBase` (`serviceCommon.ts`) — a folder only root can write, because root runs that Node (the root step, the pairing it
 *                       starts as the account) and must never run what the account, who runs the agents' code, can change
 *   the plain line      as the account, into `~/.charness-runner/node` (`paths.ownNodeDir`): nobody else is involved
 *   an older runner     (paired on a system Node) moves itself at its next link start, as the account, into `paths.ownNodeDir` — root is not there then, and
 *                       the Node of a link that runs as the account only needs to be the account's. Root never runs that copy: the root steps of an
 *                       admin line use the shared one the line installed.
 *
 * What a job may write stays out of the Node's folder either way: `NPM_CONFIG_PREFIX`, `COREPACK_HOME` and the `corepack` wrapper of `packageManagerShims.ts`.
 */

export const ensureNodeScriptRelativePath = path.join('remoteRun', 'ensureNode.sh');
/** A download of ~40 MB and its unpacking, on a slow line. */
const moveDeadlineMs = 15 * 60 * 1000;

/** Test seam, set only by a flow's environment: a `file://` folder laid out like `nodejs.org/dist`, for the move to download from (no network in a flow). */
export const testNodeDistEnvName = 'CHARNESS_TEST_RUNNER_NODE_DIST';
/** Test seam, set only by a flow's environment (`1`): the runner keeps the Node it was started with, so a flow that is not about the move needs no download. */
export const testKeepNodeEnvName = 'CHARNESS_TEST_RUNNER_KEEP_NODE';

function getRealPath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

/** @description Is `nodePath` (by its real path) inside the shared Node folder or the runner's own one? */
export function checkIsManagedNode(nodePath: string, paths: Pick<RunnerHomePaths, 'ownNodeDir'>, sharedBase: string = sharedNodeBase): boolean {
  const realPath = getRealPath(nodePath);
  return [sharedBase, paths.ownNodeDir].some((base) => isInside(getRealPath(base), realPath));
}

export type NodeMoveOutcome =
  | { kind: 'managed' }
  | { kind: 'moved'; nodePath: string; log: string }
  | { kind: 'failed'; reason: string };

export interface NodeMoveDeps {
  runner: CommandRunner;
  /** The Node this process runs under (`process.execPath`). */
  currentNodePath: string;
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
    scriptPath: path.join(appDir, ensureNodeScriptRelativePath),
    distUrl: distUrl === undefined || distUrl === '' ? null : distUrl,
    sharedBase: sharedNodeBase,
    checkScriptExists: fs.existsSync,
  };
}

/**
 * @description Put the runner on its own Node.js: `managed` when the running Node already is one; otherwise the package's script installs (or finds) the
 * Node in `paths.ownNodeDir` and `moved` names it — the caller rewrites the launcher and restarts onto it. Never throws; `failed` carries the reason, and
 * the runner stays on the Node it has.
 */
export async function moveToOwnNode(paths: Pick<RunnerHomePaths, 'ownNodeDir'>, deps: NodeMoveDeps): Promise<NodeMoveOutcome> {
  if (checkIsManagedNode(deps.currentNodePath, paths, deps.sharedBase)) return { kind: 'managed' };
  if (!deps.checkScriptExists(deps.scriptPath)) return { kind: 'failed', reason: `the package has no ${ensureNodeScriptRelativePath} (${deps.scriptPath})` };
  const result = await deps.runner('sh', [deps.scriptPath, 'own', paths.ownNodeDir, ...(deps.distUrl === null ? [] : [deps.distUrl])], { timeoutMs: moveDeadlineMs });
  const nodePath = result.stdout.trim().split('\n').pop() ?? '';
  if (result.isTimedOut) return { kind: 'failed', reason: `the Node.js install did not finish within ${moveDeadlineMs / 60_000} minutes` };
  if (!result.ok) return { kind: 'failed', reason: getOutputTail(result, 2) || `the Node.js install failed (exit ${result.exitCode ?? 'none'})` };
  if (!path.isAbsolute(nodePath) || !checkIsManagedNode(nodePath, paths, deps.sharedBase)) return { kind: 'failed', reason: `the Node.js install named ${nodePath === '' ? 'no Node' : nodePath}, which is not inside ${paths.ownNodeDir}` };
  return { kind: 'moved', nodePath, log: result.stderr.trim() };
}
