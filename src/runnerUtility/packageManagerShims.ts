import * as fs from 'fs';
import * as path from 'path';
import { writeTextFileAtomically } from '../configDirFile';
import { runCommand, type CommandRunner } from '../selfUpdate/commandRunner';
import { shellSingleQuote } from '../utils/tmuxExec';
import { getJobPathDirectories } from './execEnv';
import type { RunnerHomePaths } from './runnerHome';

/**
 * @description Jobs need `yarn` (and `pnpm`) on their PATH, and a job's PATH is `<root>/bin`, the folder of the Node that runs the link, and the
 * Homebrew / system folders. A Node from nvm, Volta or Homebrew ships Corepack but not its shims: `yarn` is in the Node's folder only when
 * somebody ran `npm i -g yarn` or `corepack enable` THERE. A link restarted under another Node (the owner switched nvm's default; the service
 * moved) then lost `yarn` for every job — exit 127, and nothing said why (the first real run on a Mac).
 *
 * So at every link start, and on `check`: for each manager the job PATH does not offer (outside `<root>/bin`), Corepack's shims of the Node that
 * runs the link are put into `<root>/bin` (`corepack enable --install-directory <root>/bin <names>`: symlinks, nothing downloaded until a job
 * first runs the manager); a shim made earlier for a manager that is now offered by the Node or the system is removed again, so a Node's own
 * `yarn` is never shadowed by a stale one. A Node without Corepack (25 and later) cannot be helped: the manager is reported as missing, with
 * the way out, and `charness remote-run runners` shows it.
 *
 * The Node's own folder is one the account cannot write (the runner's Node is the shared one, owned by root), and a bare `corepack enable` — what a
 * project's install step runs — writes its shims right there and fails. So `<root>/bin` also gets a `corepack` wrapper, first on a job's PATH: it hands
 * `enable` / `disable` the same `--install-directory <root>/bin` when the job named none, and passes everything else through. Its cache is
 * `COREPACK_HOME` (`execEnv.ts`), also the account's.
 */

export const jobPackageManagers = ['yarn', 'pnpm'] as const;
export type JobPackageManager = (typeof jobPackageManagers)[number];

const corepackDeadlineMs = 30 * 1000;
const corepackName = 'corepack';
const wrapperMode = 0o755;
/** The first comment of the wrapper: what makes a `<root>/bin/corepack` ours to rewrite or remove. */
const wrapperMarker = '# Written by charness-runner: corepack wrapper.';

/** @description What the job PATH offers of one manager: its own copy (the Node's or the system's), a Corepack shim kept in `<root>/bin`, or nothing (with the reason). */
export type ShimOutcome =
  | { manager: JobPackageManager; kind: 'offered'; folder: string }
  | { manager: JobPackageManager; kind: 'shim' }
  | { manager: JobPackageManager; kind: 'missing'; reason: string };

export interface ShimDeps {
  runner: CommandRunner;
  /** The folder of the Node that runs the link: its Corepack, and the first folder after `<root>/bin` of a job's PATH. */
  nodeDir: string;
  /** The utility's own environment (a PATH for Corepack to find `node` by, nothing more is taken from it). */
  environment: NodeJS.ProcessEnv;
  /** Is `candidate` a file this account can run? */
  checkIsExecutable: (candidate: string) => boolean;
}

export function createShimDeps(): ShimDeps {
  return {
    runner: runCommand,
    nodeDir: path.dirname(process.execPath),
    environment: process.env,
    checkIsExecutable: (candidate) => {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    },
  };
}

/** A shim Corepack made is a symlink into its own `dist` folder; anything else in `<root>/bin/<name>` is not ours to remove. */
function checkIsCorepackShim(shimPath: string): boolean {
  try {
    return fs.lstatSync(shimPath).isSymbolicLink() && fs.readlinkSync(shimPath).split(path.sep).includes(corepackName);
  } catch {
    return false;
  }
}

/**
 * @description The `corepack` wrapper for `<root>/bin` (see the head of the file): `enable` and `disable` get `--install-directory` unless the job gave one.
 * The real Corepack and the folder are single-quoted into the text; nothing else varies.
 */
export function renderCorepackWrapper(realCorepack: string, installDirectory: string): string {
  return [
    '#!/bin/sh',
    wrapperMarker,
    '# The Node folder is not writable by this account: `corepack enable` without --install-directory would fail there, so it is given this runner\'s bin.',
    `REAL=${shellSingleQuote(realCorepack)}`,
    `INSTALL_DIRECTORY=${shellSingleQuote(installDirectory)}`,
    'case "$1" in',
    '  enable|disable)',
    '    for argument in "$@"; do',
    '      case "$argument" in --install-directory|--install-directory=*) exec "$REAL" "$@";; esac',
    '    done',
    '    command=$1; shift',
    '    exec "$REAL" "$command" --install-directory "$INSTALL_DIRECTORY" "$@";;',
    'esac',
    'exec "$REAL" "$@"',
    '',
  ].join('\n');
}

function readTextOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/** Put the wrapper in `<root>/bin` when the Node has a Corepack; take our own back out when it has none (a Node without Corepack, a file that is not ours stays). */
function syncCorepackWrapper(paths: RunnerHomePaths, deps: ShimDeps): void {
  const wrapperPath = path.join(paths.binDir, corepackName);
  const realCorepack = path.join(deps.nodeDir, corepackName);
  const current = readTextOrNull(wrapperPath);
  if (!deps.checkIsExecutable(realCorepack)) {
    if (current !== null && current.includes(wrapperMarker)) fs.rmSync(wrapperPath, { force: true });
    return;
  }
  if (current !== null && !current.includes(wrapperMarker)) return;
  const text = renderCorepackWrapper(realCorepack, paths.binDir);
  if (current === text) return;
  fs.mkdirSync(paths.binDir, { recursive: true, mode: 0o700 });
  writeTextFileAtomically(wrapperPath, text, wrapperMode);
}

/** @description Make the job PATH offer `yarn` and `pnpm` where a Corepack is at hand; never throws — what cannot be done is a `missing` outcome with its reason. */
export async function ensurePackageManagerShims(paths: RunnerHomePaths, deps: ShimDeps): Promise<ShimOutcome[]> {
  syncCorepackWrapper(paths, deps);
  const otherFolders = getJobPathDirectories(paths, deps.nodeDir).filter((folder) => folder !== paths.binDir);
  const outcomes: ShimOutcome[] = [];
  const unoffered: JobPackageManager[] = [];
  for (const manager of jobPackageManagers) {
    const folder = otherFolders.find((candidate) => deps.checkIsExecutable(path.join(candidate, manager)));
    if (folder === undefined) {
      unoffered.push(manager);
      continue;
    }
    const shimPath = path.join(paths.binDir, manager);
    if (checkIsCorepackShim(shimPath)) fs.rmSync(shimPath, { force: true });
    outcomes.push({ manager, kind: 'offered', folder });
  }
  if (unoffered.length > 0) outcomes.push(...(await enableCorepackShims(paths, deps, unoffered)));
  return jobPackageManagers.map((manager) => outcomes.find((outcome) => outcome.manager === manager)).filter((outcome): outcome is ShimOutcome => outcome !== undefined);
}

async function enableCorepackShims(paths: RunnerHomePaths, deps: ShimDeps, managers: readonly JobPackageManager[]): Promise<ShimOutcome[]> {
  const corepackPath = path.join(deps.nodeDir, corepackName);
  const reportMissing = (reason: string): ShimOutcome[] => managers.map((manager) => ({ manager, kind: 'missing', reason }));
  if (!deps.checkIsExecutable(corepackPath)) return reportMissing(`the Node that runs the link (${deps.nodeDir}) has no Corepack — install ${managers.join(' and ')} for it (\`npm install -g ${managers.join(' ')}\`)`);
  fs.mkdirSync(paths.binDir, { recursive: true, mode: 0o700 });
  // Corepack's own launcher finds `node` through PATH.
  const environment = { ...deps.environment, PATH: [deps.nodeDir, deps.environment.PATH ?? ''].filter((part) => part !== '').join(path.delimiter) };
  const result = await deps.runner(corepackPath, ['enable', '--install-directory', paths.binDir, ...managers], { env: environment, timeoutMs: corepackDeadlineMs });
  if (!result.ok) {
    const lastLine = result.stderr.trim().split('\n').pop() ?? '';
    return reportMissing(`\`corepack enable\` failed: ${result.isTimedOut ? 'no answer in time' : lastLine === '' ? `exit ${result.exitCode ?? 'none'}` : lastLine}`);
  }
  return managers.map((manager) => (deps.checkIsExecutable(path.join(paths.binDir, manager)) ? { manager, kind: 'shim' } : { manager, kind: 'missing', reason: '`corepack enable` made no shim for it' }));
}

/** @description One line: what the job PATH offers of each manager, and for a missing one why. */
export function formatShimLine(outcomes: readonly ShimOutcome[]): string {
  const parts = outcomes.map((outcome) => {
    if (outcome.kind === 'offered') return `${outcome.manager} (${outcome.folder})`;
    if (outcome.kind === 'shim') return `${outcome.manager} (Corepack shim)`;
    return `${outcome.manager}: MISSING — ${outcome.reason}`;
  });
  return `  package managers for jobs: ${parts.join(' · ')}`;
}
