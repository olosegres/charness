import * as path from 'path';
import { getOutputTail, type CommandRunner } from './commandRunner';
import { installTimeoutMs, queryTimeoutMs } from './constants';
import type { NpmLatest } from './updatePolicy';

/** The package this updater follows. */
export const npmPackageName = 'charness';
const distTag = 'latest';
const hostLockFileName = '.charness-update.lock';
const nodeModulesRelativePath = path.join('lib', 'node_modules');

/** @description A source (registry, remote, installer) did not do what was asked; the message is for the operator. */
export class UpdateSourceError extends Error {}

export interface NpmSourceDeps {
  runCommand: CommandRunner;
  /** The running `node`: its sibling `npm` is the one that installed this charness (nvm-safe), honouring the user's `.npmrc`. */
  execPath: string;
  /** The npm global prefix this install sits under. */
  prefix: string;
  env?: NodeJS.ProcessEnv;
}

export interface NpmSource {
  /** What `latest` is now; throws {@link UpdateSourceError} when the registry does not answer. */
  getLatest: () => Promise<NpmLatest>;
  /** Install exactly `version` into the prefix; throws {@link UpdateSourceError} with the output's tail. */
  install: (version: string, options?: { isRollback?: boolean }) => Promise<void>;
}

/** @description The `npm` next to a `node` binary. */
export function getNpmBinary(execPath: string): string {
  return path.join(path.dirname(execPath), 'npm');
}

/** @description Where the host-wide lock of an npm global install lives. */
export function getHostLockPath(prefix: string): string {
  return path.join(prefix, nodeModulesRelativePath, hostLockFileName);
}

interface NpmViewOutput {
  version?: string;
  engines?: { node?: string } | string;
  deprecated?: string;
}

/**
 * @description Reads `npm view charness@latest version engines deprecated --json`. A package that names no `engines` or
 * is not deprecated has no such key; `engines` is the `node` range, `deprecated` a message.
 */
export function parseNpmViewOutput(stdout: string): NpmLatest {
  let output: NpmViewOutput;
  try {
    output = JSON.parse(stdout);
  } catch {
    throw new UpdateSourceError(`npm view printed something unreadable: ${stdout.slice(0, 200)}`);
  }
  if (typeof output?.version !== 'string') throw new UpdateSourceError('npm view named no version');
  const nodeRange = typeof output.engines === 'object' ? output.engines.node : undefined;
  return {
    version: output.version,
    engines: typeof nodeRange === 'string' ? nodeRange : null,
    isDeprecated: typeof output.deprecated === 'string' && output.deprecated !== '',
  };
}

export function createNpmSource({ runCommand, execPath, prefix, env }: NpmSourceDeps): NpmSource {
  const npm = getNpmBinary(execPath);
  // A quiet, prompt-free npm: no update notifier, no audit or fund noise on the install's output tail.
  const commonArguments = ['--no-fund', '--no-audit', '--loglevel=error'];
  return {
    async getLatest() {
      const result = await runCommand(npm, ['view', `${npmPackageName}@${distTag}`, 'version', 'engines', 'deprecated', '--json', ...commonArguments], {
        env,
        timeoutMs: queryTimeoutMs,
      });
      if (!result.ok) {
        throw new UpdateSourceError(result.isTimedOut ? 'the registry did not answer in time' : `the registry did not answer: ${getOutputTail(result, 2)}`);
      }
      return parseNpmViewOutput(result.stdout);
    },
    async install(version, options = {}) {
      // A rollback prefers what the npm cache already holds: the registry may be the very thing that is down.
      const args = ['install', '-g', '--prefix', prefix, `${npmPackageName}@${version}`, ...commonArguments, ...(options.isRollback ? ['--prefer-offline'] : [])];
      const result = await runCommand(npm, args, { env, timeoutMs: installTimeoutMs });
      if (!result.ok) {
        throw new UpdateSourceError(result.isTimedOut ? `npm install ${version} did not finish in time` : `npm install ${version} failed: ${getOutputTail(result)}`);
      }
    },
  };
}
