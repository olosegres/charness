import * as path from 'path';
import { getOutputTail, type CommandRunner } from './commandRunner';
import { installTimeoutMs, queryTimeoutMs } from './constants';
import { UpdateSourceError } from './npmSource';
import type { GitCheckStatus, GitSkipReason } from './types';
import type { GitCheck } from './updatePolicy';

const selfUpdateScriptRelativePath = path.join('scripts', 'self-update.sh');
const changelogFileName = 'CHANGELOG.md';
const manifestFileNames = ['yarn.lock', 'package.json'];
/** Enough context lines that the diff of CHANGELOG.md holds the whole file (an entry's `###` heading included). */
const wholeFileContext = '--unified=100000';
const heldBreakingExitCode = 3;
const scriptKeyPattern = /^(status|reason|from|to|behind|migrationGuides)=(.*)$/;

const gitCheckStatuses: readonly GitCheckStatus[] = ['upToDate', 'behind', 'skip'];
const gitSkipReasons: readonly GitSkipReason[] = ['dirty', 'diverged', 'noUpstream', 'inProgress', 'fetchFailed'];

/** What `self-update.sh` (without `--check`) did. */
export type GitApplyResult =
  | { status: 'updated'; from: string; to: string; migrationGuides: string[] }
  | { status: 'held'; from: string; to: string; migrationGuides: string[] }
  | { status: 'upToDate' }
  | { status: 'skip'; reason: GitSkipReason | null };

export interface GitSource {
  /** What an update would do; throws {@link UpdateSourceError} when the script cannot run at all. */
  check: () => Promise<GitCheck>;
  /** Pull (and install, and build when no watcher owns the checkout). `holdBreaking`: stop at a range that adds a migration guide. */
  apply: (options: { holdBreaking: boolean }) => Promise<GitApplyResult>;
  /** The diff of CHANGELOG.md between two commits with the whole file as context. */
  getChangelogDiff: (from: string, to: string) => Promise<string>;
  /** Put the checkout back on `from` (after an install of `to` failed) and rebuild unless a watcher does. */
  rollback: (options: { from: string; to: string; isHot: boolean }) => Promise<void>;
}

/** @description The `key=value` lines of the script's stdout (its log lines are ignored). */
export function parseScriptKeys(stdout: string): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const match = scriptKeyPattern.exec(line);
    if (match) keys[match[1]] = match[2];
  }
  return keys;
}

function splitGuides(text: string | undefined): string[] {
  return (text ?? '').split(' ').filter((guide) => guide !== '');
}

function toSkipReason(text: string | undefined): GitSkipReason | null {
  return gitSkipReasons.find((reason) => reason === text) ?? null;
}

/** @description The check a `--check` run printed. */
export function parseGitCheck(stdout: string): GitCheck {
  const keys = parseScriptKeys(stdout);
  const status = gitCheckStatuses.find((candidate) => candidate === keys.status);
  if (!status) throw new UpdateSourceError(`self-update.sh --check printed no status: ${stdout.slice(0, 200)}`);
  return {
    status,
    reason: status === 'skip' ? toSkipReason(keys.reason) : null,
    from: keys.from ?? '',
    to: keys.to ?? '',
    behind: Number(keys.behind ?? 0),
    migrationGuides: splitGuides(keys.migrationGuides),
  };
}

export function createGitSource({ runCommand, root, env }: { runCommand: CommandRunner; root: string; env?: NodeJS.ProcessEnv }): GitSource {
  const script = path.join(root, selfUpdateScriptRelativePath);

  async function runGit(args: string[], timeoutMs: number): Promise<string> {
    const result = await runCommand('git', args, { cwd: root, env, timeoutMs });
    if (!result.ok) throw new UpdateSourceError(`git ${args[0]} failed: ${getOutputTail(result, 2)}`);
    return result.stdout;
  }

  return {
    async check() {
      const result = await runCommand('bash', [script, '--check'], { cwd: root, env, timeoutMs: queryTimeoutMs });
      if (!result.ok) throw new UpdateSourceError(result.isTimedOut ? 'the remote did not answer in time' : `self-update.sh --check failed: ${getOutputTail(result, 2)}`);
      return parseGitCheck(result.stdout);
    },

    async apply({ holdBreaking }) {
      const result = await runCommand('bash', [script, ...(holdBreaking ? ['--hold-breaking'] : [])], { cwd: root, env, timeoutMs: installTimeoutMs });
      const keys = parseScriptKeys(result.stdout);
      if (result.exitCode === heldBreakingExitCode) {
        return { status: 'held', from: keys.from ?? '', to: keys.to ?? '', migrationGuides: splitGuides(keys.migrationGuides) };
      }
      if (!result.ok) throw new UpdateSourceError(result.isTimedOut ? 'the update did not finish in time' : `self-update.sh failed: ${getOutputTail(result)}`);
      if (keys.status === 'updated') return { status: 'updated', from: keys.from ?? '', to: keys.to ?? '', migrationGuides: splitGuides(keys.migrationGuides) };
      if (keys.status === 'upToDate') return { status: 'upToDate' };
      if (keys.status === 'skip') return { status: 'skip', reason: toSkipReason(keys.reason) };
      throw new UpdateSourceError(`self-update.sh printed no status: ${getOutputTail(result)}`);
    },

    async getChangelogDiff(from, to) {
      return runGit(['diff', wholeFileContext, `${from}..${to}`, '--', changelogFileName], queryTimeoutMs);
    },

    async rollback({ from, to, isHot }) {
      const changedFiles = (await runGit(['diff', '--name-only', from, to], queryTimeoutMs)).split('\n');
      // `--keep`: refuses rather than overwrite a local change the update never touched.
      await runGit(['reset', '--keep', from], queryTimeoutMs);
      const isManifestChanged = changedFiles.some((file) => manifestFileNames.includes(file));
      if (isManifestChanged) {
        const install = await runCommand('yarn', ['install', '--immutable'], { cwd: root, env, timeoutMs: installTimeoutMs });
        if (!install.ok) throw new UpdateSourceError(`yarn install failed on the way back: ${getOutputTail(install)}`);
      }
      // A hot watcher rebuilds the reset checkout by itself; a second build beside it would race its writes.
      if (!isHot) {
        const build = await runCommand('yarn', ['build'], { cwd: root, env, timeoutMs: installTimeoutMs });
        if (!build.ok) throw new UpdateSourceError(`yarn build failed on the way back: ${getOutputTail(build)}`);
      }
    },
  };
}
