/**
 * @description A git checkout of charness for the update flows: a copy of this repository's sources and its built `dist/` in a temp
 * folder, committed, with a bare "remote" next to it and a second clone through which "somebody else pushes". The bot runs FROM the
 * checkout (`dist/cli.js`), so `scripts/self-update.sh` has a real repository to fetch, fast-forward and rebuild. `node_modules`
 * is this repository's (a symlink), and `yarn` is a stand-in that builds with `tsc` and installs nothing — a real Yarn would need the
 * network and a dependency tree the copy does not have.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const copiedEntries = ['src', 'scripts', 'stt', 'package.json', 'tsconfig.json', 'nodemon.json', 'yarn.lock', 'CHANGELOG.md', 'LICENSE'];
const gitTimeoutMs = 2 * 60 * 1000;

export interface CheckoutFixture {
  /** The checkout the bot runs from. */
  checkoutDir: string;
  remoteDir: string;
  /** The clone through which "somebody else" pushes. */
  otherDir: string;
  /** `git` in the checkout, asserting success; its trimmed stdout. */
  git: (...args: string[]) => string;
  /** The short commit the checkout is on. */
  getHead: () => string;
  /** Commit `files` (a path → new content, or a function of the old content) in the other clone and push; the short commit. */
  pushCommit: (files: Record<string, string | ((previous: string) => string)>, message: string) => string;
  /** The path of the built entry the bot starts. */
  cliPath: string;
}

function createGitEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_AUTHOR_NAME: 'Flow Test',
    GIT_AUTHOR_EMAIL: 'flow-test@example.invalid',
    GIT_COMMITTER_NAME: 'Flow Test',
    GIT_COMMITTER_EMAIL: 'flow-test@example.invalid',
  };
}

function runGit(cwd: string, home: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, env: createGitEnv(home), encoding: 'utf8', timeout: gitTimeoutMs });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} (${cwd}) failed: ${result.stderr}`);
  return result.stdout.trim();
}

function copyEntry(entry: string, destinationRoot: string): void {
  const source = path.join(repoRoot, entry);
  if (!fs.existsSync(source)) return;
  // The flows' own tests are not part of the product: the checkout compiles and ships only the sources.
  fs.cpSync(source, path.join(destinationRoot, entry), { recursive: true, filter: (from) => !from.endsWith(`${path.sep}__tests__`) });
}

export interface CheckoutFixtureOptions {
  /**
   * `node_modules` as a folder of links to this repository's entries instead of one link to the folder, so a file the flow writes
   * INTO it (the image's install stamp) lands in the temp checkout and never in this repository's dependency tree.
   */
  isolatedNodeModules?: boolean;
}

/** @description Build the fixture under `root` (a folder of the flow's layout); `home` is the git home of the flow. */
export function createCheckoutFixture(root: string, home: string, options: CheckoutFixtureOptions = {}): CheckoutFixture {
  const checkoutDir = path.join(root, 'checkout');
  const remoteDir = path.join(root, 'remote.git');
  const otherDir = path.join(root, 'other');
  fs.mkdirSync(checkoutDir, { recursive: true });
  for (const entry of copiedEntries) copyEntry(entry, checkoutDir);
  fs.cpSync(path.join(repoRoot, 'dist'), path.join(checkoutDir, 'dist'), { recursive: true });
  const repoModules = path.join(repoRoot, 'node_modules');
  if (options.isolatedNodeModules) {
    fs.mkdirSync(path.join(checkoutDir, 'node_modules'));
    for (const entry of fs.readdirSync(repoModules)) fs.symlinkSync(path.join(repoModules, entry), path.join(checkoutDir, 'node_modules', entry));
  } else {
    fs.symlinkSync(repoModules, path.join(checkoutDir, 'node_modules'));
  }
  fs.writeFileSync(path.join(checkoutDir, '.gitignore'), 'dist/\nnode_modules\n');

  runGit(root, home, ['init', '-q', '--bare', '-b', 'main', remoteDir]);
  const git = (...args: string[]): string => runGit(checkoutDir, home, args);
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'the version that runs');
  git('remote', 'add', 'origin', remoteDir);
  git('push', '-q', '-u', 'origin', 'main');
  runGit(root, home, ['clone', '-q', remoteDir, otherDir]);

  return {
    checkoutDir,
    remoteDir,
    otherDir,
    git,
    getHead: () => git('rev-parse', '--short=7', 'HEAD'),
    cliPath: path.join(checkoutDir, 'dist', 'cli.js'),
    pushCommit: (files, message) => {
      runGit(otherDir, home, ['pull', '-q', '--rebase', 'origin', 'main']);
      for (const [relativePath, change] of Object.entries(files)) {
        const filePath = path.join(otherDir, relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, typeof change === 'string' ? change : change(fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''));
      }
      runGit(otherDir, home, ['add', '-A']);
      runGit(otherDir, home, ['commit', '-q', '-m', message]);
      runGit(otherDir, home, ['push', '-q', 'origin', 'main']);
      return runGit(otherDir, home, ['rev-parse', '--short=7', 'HEAD']);
    },
  };
}

/**
 * @description The instance's `yarn`: `build` is what the real one runs (`tsc`, then the executable bits), `install` does nothing.
 * `self-update.sh` and the rollback call it from inside the checkout.
 */
export function writeYarnStandIn(binDir: string): void {
  fs.writeFileSync(
    path.join(binDir, 'yarn'),
    [
      '#!/bin/sh',
      'case "$1" in',
      '  build) node node_modules/typescript/bin/tsc && chmod +x dist/cli.js dist/index.js ;;',
      '  install) exit 0 ;;',
      '  *) echo "yarn stand-in: unsupported command $1" >&2; exit 1 ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
}

/**
 * @description What the image's entrypoint leaves in `node_modules` once it installed the dependencies for THIS `yarn.lock`
 * (`node_modules/.charness-image`, the lock's sha256) — written ahead, so the entrypoint finds the install current and runs nothing
 * the `yarn` stand-in cannot do. Needs the fixture's `isolatedNodeModules`.
 */
export function writeImageInstallStamp(checkoutDir: string): void {
  const lockHash = createHash('sha256').update(fs.readFileSync(path.join(checkoutDir, 'yarn.lock'))).digest('hex');
  fs.writeFileSync(path.join(checkoutDir, 'node_modules', '.charness-image'), `${lockHash}\n`);
}

export interface PatchedDockerScripts {
  entrypointPath: string;
  restartBotPath: string;
  supervisorPidFile: string;
}

/**
 * @description The image's own `docker/entrypoint.sh` (the hot-mode restart loop) and `docker/restart-bot.sh`, with ONLY their paths
 * pointed into `directory` (the checkout, the supervisor pid file, the restart marker) and the restart delay set to `delaySeconds` —
 * so the real loop and the real command run on a host that has no Docker and no `/opt/charness`. Everything else in them is untouched.
 */
export function writePatchedDockerScripts(directory: string, checkoutDir: string, delaySeconds: number): PatchedDockerScripts {
  const supervisorPidFile = path.join(directory, 'charness-supervisor.pid');
  const restartNowFile = path.join(directory, 'charness-restart-now');
  const patch = (source: string): string =>
    source
      .replace('checkout=/opt/charness\n', `checkout=${checkoutDir}\n`)
      .replace('supervisorPidFile=/tmp/charness-supervisor.pid', `supervisorPidFile=${supervisorPidFile}`)
      .replace('restartNowFile=/tmp/charness-restart-now', `restartNowFile=${restartNowFile}`)
      .replace('restartDelaySeconds=20', `restartDelaySeconds=${delaySeconds}`);
  fs.mkdirSync(directory, { recursive: true });
  const entrypointPath = path.join(directory, 'charness-entrypoint');
  const restartBotPath = path.join(directory, 'charness-restart-bot');
  fs.writeFileSync(entrypointPath, patch(fs.readFileSync(path.join(repoRoot, 'docker', 'entrypoint.sh'), 'utf8')), { mode: 0o755 });
  fs.writeFileSync(restartBotPath, patch(fs.readFileSync(path.join(repoRoot, 'docker', 'restart-bot.sh'), 'utf8')), { mode: 0o755 });
  return { entrypointPath, restartBotPath, supervisorPidFile };
}
