/**
 * @description A git checkout of charness for the update flows: a copy of this repository's sources and its built `dist/` in a temp
 * folder, committed, with a bare "remote" next to it and a second clone through which "somebody else pushes". The bot runs FROM the
 * checkout (`dist/cli.js`), so `scripts/self-update.sh` has a real repository to fetch, fast-forward and rebuild. `node_modules`
 * is this repository's (a symlink), and `yarn` is a stand-in that builds with `tsc` and installs nothing — a real Yarn would need the
 * network and a dependency tree the copy does not have.
 */
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

/** @description Build the fixture under `root` (a folder of the flow's layout); `home` is the git home of the flow. */
export function createCheckoutFixture(root: string, home: string): CheckoutFixture {
  const checkoutDir = path.join(root, 'checkout');
  const remoteDir = path.join(root, 'remote.git');
  const otherDir = path.join(root, 'other');
  fs.mkdirSync(checkoutDir, { recursive: true });
  for (const entry of copiedEntries) copyEntry(entry, checkoutDir);
  fs.cpSync(path.join(repoRoot, 'dist'), path.join(checkoutDir, 'dist'), { recursive: true });
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(checkoutDir, 'node_modules'));
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
