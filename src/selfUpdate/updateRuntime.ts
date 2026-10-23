import * as fs from 'fs';
import * as path from 'path';
import { getProcessIdentity } from '../installManager';
import { getOutputTail, runCommand as defaultRunCommand, type CommandRunner } from './commandRunner';
import { queryTimeoutMs, selfCheckTimeoutMs } from './constants';
import { createGitSource } from './gitSource';
import { acquireHostLock } from './hostLock';
import { getStaleSupervisorModules, readHotSupervisorRecord, requestSupervisorReexec } from './hotSupervisor';
import { detectInstallKind, type InstallKindFs } from './installKind';
import { createNpmSource, getHostLockPath } from './npmSource';
import { getReexecTarget } from './restart';
import {
  clearUpdatePending,
  readUpdatePending,
  writeUpdatePending,
} from './updatePending';
import type { UpdateEngineDeps } from './updateEngine';

/**
 * The real, process-bound half of the update engine's dependencies: what THIS install is, where it lives, how to ask the
 * registry / the checkout, how to probe a new install. Everything that belongs to the bot itself — the settings, the state
 * store, the idle verdict, Telegram, the shutdown sequence — is passed in beside it by `bot.ts`.
 */

const changelogFileName = 'CHANGELOG.md';
const shortShaLength = 7;

export type UpdateRuntime = Pick<
  UpdateEngineDeps,
  | 'running'
  | 'runningNode'
  | 'installKind'
  | 'isHotMode'
  | 'npm'
  | 'git'
  | 'hostLock'
  | 'readInstalledVersion'
  | 'readInstalledChangelog'
  | 'countCommits'
  | 'runSelfCheck'
  | 'reexecTarget'
  | 'marker'
  | 'supervisor'
>;

export interface UpdateRuntimeOptions {
  dataDir: string;
  /** The folder of the running install (holds `package.json` and `dist/`), symlinks resolved. */
  packageRoot: string;
  execPath: string;
  platform: NodeJS.Platform;
  nodeVersion: string;
  argv: readonly string[];
  isHotMode: boolean;
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

function readTextOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function readVersionOrNull(packageRoot: string): string | null {
  const text = readTextOrNull(path.join(packageRoot, 'package.json'));
  if (text === null) return null;
  try {
    const manifest: { version?: string } = JSON.parse(text);
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

/**
 * @description Build the runtime of this process. The running version is read from `package.json` ONCE, here: an in-place
 * install overwrites that file under a running process, and "what am I running" must not change with it.
 */
export async function createUpdateRuntime(options: UpdateRuntimeOptions): Promise<UpdateRuntime> {
  const runCommand = options.runCommand ?? defaultRunCommand;
  const installKind = detectInstallKind({
    packageRoot: options.packageRoot,
    fs: options.filesystem ?? createDefaultFilesystem(),
    platform: options.platform,
    hasExecve: typeof process.execve === 'function',
  });
  const isCheckoutLike = installKind.kind === 'checkout' || (installKind.kind === 'notifyOnly' && installKind.isCheckout);

  let commit: string | null = null;
  if (isCheckoutLike) {
    const head = await runCommand('git', ['rev-parse', `--short=${shortShaLength}`, 'HEAD'], { cwd: options.packageRoot, timeoutMs: queryTimeoutMs });
    commit = head.ok ? head.stdout.trim() : null;
  }

  const packageRoot = options.packageRoot;
  const distDirectory = path.join(packageRoot, 'dist');
  const cliPath = path.join(distDirectory, 'cli.js');
  const npmPrefix = installKind.kind === 'npmGlobal' ? installKind.prefix : '';

  return {
    running: { version: readVersionOrNull(packageRoot) ?? 'unknown', commit },
    runningNode: options.nodeVersion,
    installKind,
    isHotMode: options.isHotMode,
    npm: isCheckoutLike || installKind.kind === 'ephemeral' ? null : createNpmSource({ runCommand, execPath: options.execPath, prefix: npmPrefix }),
    git: installKind.kind === 'checkout' ? createGitSource({ runCommand, root: installKind.root }) : null,
    hostLock: installKind.kind === 'npmGlobal' ? { acquire: () => acquireHostLock(getHostLockPath(installKind.prefix)) } : null,
    readInstalledVersion: () => readVersionOrNull(packageRoot),
    readInstalledChangelog: () => readTextOrNull(path.join(packageRoot, changelogFileName)),
    async countCommits(from, to) {
      const result = await runCommand('git', ['rev-list', '--count', `${from}..${to}`], { cwd: packageRoot, timeoutMs: queryTimeoutMs });
      const count = Number(result.stdout.trim());
      return result.ok && Number.isInteger(count) ? count : null;
    },
    async runSelfCheck(expectVersion) {
      const args = [cliPath, 'self-check', ...(expectVersion === null ? [] : ['--expect', expectVersion])];
      const result = await runCommand(options.execPath, args, { cwd: packageRoot, timeoutMs: selfCheckTimeoutMs });
      return { ok: result.ok, detail: result.ok ? '' : result.isTimedOut ? 'the self-check did not finish in time' : getOutputTail(result, 3) };
    },
    reexecTarget: getReexecTarget({ execPath: options.execPath, packageRoot, argv: options.argv }),
    marker: {
      read: () => readUpdatePending(options.dataDir),
      write: (marker) => writeUpdatePending(options.dataDir, marker),
      clear: () => clearUpdatePending(options.dataDir),
    },
    supervisor: {
      readRecord: () => readHotSupervisorRecord(options.dataDir),
      getStaleModules: (record) => getStaleSupervisorModules(record, distDirectory),
      requestReexec: (record) =>
        requestSupervisorReexec(record, {
          getStartToken: (pid) => getProcessIdentity(pid)?.startToken ?? null,
          kill: (pid, signal) => process.kill(pid, signal),
        }),
    },
  };
}
