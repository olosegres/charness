import * as path from 'path';
import { createConfigFileLoader, type ConfigFileLoad } from '../configDirFile';
import { getRunnerHomePaths } from '../runnerUtility/runnerHome';
import { createHubContext, getHubFilePaths, getRunnerHostAlias, getRunnerLinkPaths } from '../runners/hubPaths';
import { pairedFileSchema, type PairedFile, type PairedRunner } from '../runners/hubRegistry';
import type { PairedRunnerLink, RunnerConfig } from './runnersConfig';

/**
 * @description Paired runners as `remote-run` sees them: the same `RunnerConfig` an entry of `runners.json` gives, built from the hub's
 * registry (`paired.json`, `src/runners/`), so everything above the ssh layer — the script upload, rsync, Pueue, the lease — is phase 1
 * unchanged. Only the way ssh reaches the machine differs: no host and port, but a `ProxyCommand` that joins ssh to the unix socket of
 * the runner's link (`charness runner-proxy`), the runner's host key pinned under an alias from the hub's own `known_hosts`, and the
 * hub's key. Nothing here talks to the network or to the runner; whether the link is up is `linkControl.ts`'s question.
 */

/** The ssh options below name files and a command line: a character that cannot be quoted for ssh AND rsync's `-e` parser is refused. */
const unquotablePattern = /["'\\$`\r\n]/;
const plainWordPattern = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** @description A path this machine's registry or program lives in cannot be put on an ssh command line; the runner stays out of the catalog, with the reason. */
export class PairedRunnerSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PairedRunnerSetupError';
  }
}

/** ssh expands `%`-tokens in a ProxyCommand, an identity file and a known-hosts path: a literal `%` is written `%%`. */
function escapeSshTokens(value: string): string {
  return value.replace(/%/g, '%%');
}

/**
 * A path as the VALUE of an `-o` option. ssh reads `-o` like a line of its config file, and `UserKnownHostsFile` there is a LIST of files
 * separated by whitespace: `/home/my user/…/known_hosts` would be the files `/home/my` and `user/…/known_hosts`, the pin would not be found
 * and strict checking would refuse the runner. Double quotes keep one path one word (ssh_config(5): «arguments may optionally be enclosed in
 * double quotes»); `-i` takes its path as a plain argument and needs none.
 */
function quoteSshOptionPath(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

/** @description `value` as an ssh path, or a {@link PairedRunnerSetupError} naming what it is the path of. */
function getUsableSshPath(value: string, what: string): string {
  if (unquotablePattern.test(value)) throw new PairedRunnerSetupError(`the path of ${what} holds a quote, a backslash, a $ or a line break, which ssh cannot be given safely`);
  return value;
}

/**
 * One word of the `ProxyCommand` (run by the user's shell): plain words stay as they are, anything else is double-quoted. No single quote
 * ever appears in the result — `buildRsyncSshCommand` wraps the whole option in single quotes for rsync's `-e`, whose parser has no way to
 * nest them.
 */
function quoteProxyWord(word: string, what: string): string {
  return plainWordPattern.test(getUsableSshPath(word, what)) ? word : `"${word}"`;
}

export interface PairedSshOptionsInput {
  runnerId: string;
  nodePath: string;
  cliPath: string;
  hubDir: string;
}

/**
 * @description The ssh options of every call to a paired runner (the operator's `-F /dev/null` stands in for a config file: the machine's
 * own ssh config must not change how the link is reached). The host key is checked strictly against the one the runner gave at pairing.
 */
export function buildPairedSshOptions(input: PairedSshOptionsInput): string[] {
  const files = getHubFilePaths(input.hubDir);
  const socketPath = getRunnerLinkPaths(input.hubDir, input.runnerId).socket;
  const proxyCommand = [quoteProxyWord(input.nodePath, 'node'), quoteProxyWord(input.cliPath, 'the charness cli'), 'runner-proxy', quoteProxyWord(socketPath, 'the runner link')].join(' ');
  return [
    '-F', '/dev/null',
    '-o', `ProxyCommand=${escapeSshTokens(proxyCommand)}`,
    '-o', `HostKeyAlias=${getRunnerHostAlias(input.runnerId)}`,
    '-o', `UserKnownHostsFile=${quoteSshOptionPath(escapeSshTokens(getUsableSshPath(files.knownHosts, 'the hub known_hosts')))}`,
    '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'StrictHostKeyChecking=yes',
    '-i', escapeSshTokens(getUsableSshPath(files.hubKey, 'the hub key')),
    '-o', 'IdentitiesOnly=yes',
    '-o', 'IdentityAgent=none',
    '-o', 'LogLevel=ERROR',
  ];
}

/**
 * @description Where the runner's Pueue lives, from the work dir it reported: the runner utility keeps `work/`, `bin/` and `pueue/` side by
 * side in `~/.charness-runner/` (`runnerHome.ts` is the one place that layout is written down). A work dir that does not follow it gives
 * `undefined` — the runner script then finds Pueue on the `PATH` as for any hand-made runner.
 */
export function getPairedRunnerPueue(workDir: string): RunnerConfig['pueue'] {
  const stateRoot = path.posix.dirname(workDir);
  const homeDir = path.posix.dirname(stateRoot);
  const paths = getRunnerHomePaths(homeDir);
  if (paths.workDir !== workDir) return undefined;
  return { bin: path.posix.join(paths.binDir, 'pueue'), config: paths.pueueConfig };
}

export interface PairedHubEnvironment {
  hubDir: string;
  nodePath: string;
  cliPath: string;
}

/** @description The `RunnerConfig` of one registry entry. Throws a {@link PairedRunnerSetupError} when the paths of this machine cannot be put on an ssh command line. */
export function buildPairedRunnerConfig(runner: PairedRunner, hub: PairedHubEnvironment): RunnerConfig {
  const link: PairedRunnerLink = { runnerId: runner.id, hubDir: hub.hubDir, isPausedByHub: runner.isPaused, os: runner.os };
  return {
    name: runner.name,
    ssh: getRunnerHostAlias(runner.id),
    sshOptions: buildPairedSshOptions({ runnerId: runner.id, nodePath: hub.nodePath, cliPath: hub.cliPath, hubDir: hub.hubDir }),
    workDir: runner.workDir,
    pueue: getPairedRunnerPueue(runner.workDir),
    paired: link,
  };
}

export interface PairedRunnersLoad {
  runners: RunnerConfig[];
  /** One line per problem; the runners that could not be built are not in `runners`. */
  errors: string[];
}

const pairedFileLoader = createConfigFileLoader<PairedFile>({
  fileName: 'paired.json',
  createEmpty: () => ({ rev: 0, runners: [] }),
  validate: (parsedJson) => {
    const parsed = pairedFileSchema.safeParse(parsedJson);
    if (parsed.success) return { ok: true, config: parsed.data };
    return { ok: false, errors: parsed.error.issues.map((issue) => `paired.json ${issue.path.join('.') || '(root)'}: ${issue.message}`) };
  },
});

function buildRunners(file: PairedFile, hub: PairedHubEnvironment): PairedRunnersLoad {
  const runners: RunnerConfig[] = [];
  const errors: string[] = [];
  for (const entry of file.runners) {
    try {
      runners.push(buildPairedRunnerConfig(entry, hub));
    } catch (error) {
      if (!(error instanceof PairedRunnerSetupError)) throw error;
      errors.push(`paired runner "${entry.name}": ${error.message}`);
    }
  }
  return { runners, errors };
}

/**
 * @description The paired runners of the user whose home is `homeDir`, from `paired.json` (stamp-cached like `runners.json`: the bot MCP
 * asks on every connect). Missing = none paired; invalid = its errors and the last good list of this process, if any.
 */
export function loadPairedRunners(homeDir: string): ConfigFileLoad<PairedRunnersLoad> {
  const context = createHubContext({ homeDir });
  const hub: PairedHubEnvironment = { hubDir: context.dir, nodePath: context.nodePath, cliPath: context.cliPath };
  const load = pairedFileLoader.load(getHubFilePaths(context.dir).paired);
  if (load.status === 'invalid') return { status: 'invalid', config: load.config === null ? null : buildRunners(load.config, hub), errors: load.errors };
  const built = buildRunners(load.config, hub);
  return built.errors.length === 0 ? { status: load.status, config: built } : { status: 'invalid', config: built, errors: built.errors };
}

/** @description Forget the cached loads (tests that swap files under one path). */
export function resetPairedRunnersCache(): void {
  pairedFileLoader.resetCache();
}
