import { createHash } from 'crypto';
import * as path from 'path';
import { installNone, type ProjectConfig } from './projectConfig';
import { createPathMatcher } from './pathPatterns';

/**
 * @description The dependencies step: which command, and the KEY that says whether it must run again. The step runs on the runner only
 * when the key changed since the last successful install in its copy (or the last one failed).
 *
 * Defaults by lockfile at the project root: `yarn.lock` → `yarn install --immutable`, `pnpm-lock.yaml` → `pnpm install
 * --frozen-lockfile`, `package-lock.json` → `npm ci`; none → no step. Default key: the lockfile, every `package.json`,
 * `.yarnrc.yml`, everything under `patches/`. `.remote-run` replaces either (`install:`, `install-key:`).
 */

interface LockfileDefault {
  lockfile: string;
  command: string;
}

/** In this order: a repository that keeps two lockfiles is read as the first. */
const lockfileDefaults: readonly LockfileDefault[] = [
  { lockfile: 'yarn.lock', command: 'yarn install --immutable' },
  { lockfile: 'pnpm-lock.yaml', command: 'pnpm install --frozen-lockfile' },
  { lockfile: 'package-lock.json', command: 'npm ci' },
];
const yarnConfigFile = '.yarnrc.yml';
const patchesDirectory = 'patches/';
const packageManifestName = 'package.json';

export interface DepsPlan {
  command: string;
  /** The files whose content makes the key, relative to the project root, sorted. */
  keyFiles: string[];
}

/** @description The dependencies plan for the files being sent, or `null` when there is no step (no lockfile and no `install:`, or `install: none`). */
export function planDepsStep(sentFiles: readonly string[], config: Pick<ProjectConfig, 'install' | 'installKey'>): DepsPlan | null {
  if (config.install === installNone) return null;
  const lockfile = lockfileDefaults.find((candidate) => sentFiles.includes(candidate.lockfile));
  const command = config.install ?? lockfile?.command ?? null;
  if (command === null) return null;
  let keyFiles: string[];
  if (config.installKey !== null) {
    const isNamed = createPathMatcher(config.installKey);
    keyFiles = sentFiles.filter((file) => isNamed(file));
  } else {
    keyFiles = sentFiles.filter(
      (file) => file === lockfile?.lockfile || path.posix.basename(file) === packageManifestName || file === yarnConfigFile || file.startsWith(patchesDirectory),
    );
  }
  return { command, keyFiles: [...keyFiles].sort() };
}

/** @description The key: a hash of the command and of every key file's path and content hash. A changed command re-runs the step as well. */
export function computeDepsKey(command: string, keyFiles: ReadonlyArray<{ path: string; contentHash: string }>): string {
  const hash = createHash('sha256').update(`${command}\0`);
  for (const keyFile of [...keyFiles].sort((first, second) => (first.path < second.path ? -1 : first.path > second.path ? 1 : 0))) {
    hash.update(`${keyFile.path}\0${keyFile.contentHash}\n`);
  }
  return hash.digest('hex');
}

/** @description The hash of one file's content, as the key takes it. */
export function hashContent(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
