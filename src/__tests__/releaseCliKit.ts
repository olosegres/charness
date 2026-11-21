/**
 * @description The sandbox of the release CLI tests (`releaseCli.test.ts`, `releaseCliChecks.test.ts`, `releaseCliCommit.test.ts`): the CLI transpiled once per file, a throwaway git repository with its own HOME and git
 * config per case, and the helpers that run git and the CLI in it. Split from the test file because a file runs under one time limit and one ran 60 s alone on a loaded box.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { after, afterEach, before, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';

export const tsxCliPath = require.resolve('tsx/cli');
export const sourceRootDir = path.resolve(__dirname, '..');
export const releaseCliPath = path.join(sourceRootDir, 'release', 'cli.ts');
export const lastTag = 'v3.2.0';
export const cliTimeoutMs = 90_000;

export const initialPackage = {
  name: 'demo-package',
  version: '3.2.0',
  files: ['dist/', 'stt/gigaam_sidecar.py', 'runner-scripts/runner-package-lock.json', 'runner-scripts/ensureNode.sh', 'agent-plugin/', 'README.md', 'LICENSE', 'LICENSE-COMMERCIAL.md', 'CHANGELOG.md'],
  // No "./": npm >= 11.10 drops a "./dist/…" bin entry at publish, and check-pack refuses it.
  bin: { charness: 'dist/cli.js' },
  scripts: { version: 'tsx src/release/cli.ts changelog && git add CHANGELOG.md', test: 'node --test' },
  dependencies: { left: '^1.0.0' },
  devDependencies: { dev: '^1.0.0' },
};

export const initialChangelog = [
  '# Changelog',
  '',
  '## Unreleased',
  '',
  '**A change users see.** With its details.',
  '',
  '## 3.2.0 — 2026-10-16',
  '',
  '**Older.** Entry.',
  '',
].join('\n');

/** A dependency the shrinkwrap pins BELOW the newest version its range allows (^2.0.0 resolves to 2.1.x): which one npm installed tells whether it read the shrinkwrap. */
export const pinnedDependency = {
  name: 'ms',
  range: '^2.0.0',
  version: '2.0.0',
  integrity: 'sha512-Tpp60P6IUJDTuOq/5Z8cdskzJujfwqfOTkrwIwj7IRISpnkJnT6SyJ4PCPnGMoFjC9ddhal5KVIYtAt97ix05A==',
};

/** The shrinkwrap of the fixture package at `version`, pinning {@link pinnedDependency}, as `hubShrinkwrap.ts` writes it. */
export function createFixtureShrinkwrap(version: string): string {
  const shrinkwrap = {
    name: initialPackage.name,
    version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: initialPackage.name, version, dependencies: { [pinnedDependency.name]: pinnedDependency.range } },
      [`node_modules/${pinnedDependency.name}`]: {
        version: pinnedDependency.version,
        resolved: `https://registry.npmjs.org/${pinnedDependency.name}/-/${pinnedDependency.name}-${pinnedDependency.version}.tgz`,
        integrity: pinnedDependency.integrity,
      },
    },
  };
  return `${JSON.stringify(shrinkwrap, null, 2)}\n`;
}

export let transpiledDir: string;
export let transpiledCliPath: string;
export let sandboxDir: string;
export let repoDir: string;
export let homeDir: string;
export let githubOutputPath: string;

export function getTranspiledPath(sourcePath: string): string {
  return path.join(transpiledDir, path.relative(sourceRootDir, sourcePath)).replace(/\.ts$/, '.js');
}

/** A module and every relative import under it as plain JavaScript (CommonJS like the build), laid out as in `src/` so the imports resolve. */
export function transpileModuleTree(sourcePath: string, writtenPaths: Set<string> = new Set()): void {
  if (writtenPaths.has(sourcePath)) return;
  writtenPaths.add(sourcePath);
  const source = fs.readFileSync(sourcePath, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    fileName: sourcePath,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  const outputPath = getTranspiledPath(sourcePath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, outputText);
  for (const { fileName: specifier } of ts.preProcessFile(source).importedFiles) {
    if (specifier.startsWith('.')) transpileModuleTree(path.resolve(path.dirname(sourcePath), `${specifier}.ts`), writtenPaths);
  }
}

export function transpileReleaseCli(): void {
  transpiledDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-release-cli-'));
  transpileModuleTree(releaseCliPath);
  transpiledCliPath = getTranspiledPath(releaseCliPath);
}

/** Where the transpiled CLI finds its packages (`zod`, through the runner's lock module): it runs from a folder outside the checkout. */
export const checkoutNodeModulesPath = path.resolve(sourceRootDir, '..', 'node_modules');

/** The environment of the CLI under test: no git identity, so the identity the CLI itself sets is what a commit shows. */
export function createChildEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    NODE_PATH: checkoutNodeModulesPath,
    HOME: homeDir,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull,
    npm_config_cache: path.join(homeDir, '.npm'),
    npm_config_update_notifier: 'false',
    GITHUB_OUTPUT: githubOutputPath,
  };
}

/** The test's own git calls and the `npm version` path: they need an identity the CLI does not provide. */
export function createGitEnv(): NodeJS.ProcessEnv {
  return {
    ...createChildEnv(),
    GIT_AUTHOR_NAME: 'Release Test',
    GIT_AUTHOR_EMAIL: 'release-test@example.invalid',
    GIT_COMMITTER_NAME: 'Release Test',
    GIT_COMMITTER_EMAIL: 'release-test@example.invalid',
  };
}

export function runGit(...args: string[]): string {
  const result = spawnSync('git', args, { cwd: repoDir, env: createGitEnv(), encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

export function writeRepoFile(relativePath: string, content: string): void {
  const filePath = path.join(repoDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

export function commitFile(relativePath: string, content: string, message: string): void {
  writeRepoFile(relativePath, content);
  runGit('add', '-A');
  runGit('commit', '-q', '-m', message);
}

export function runCli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [transpiledCliPath, ...args], {
    cwd: repoDir,
    env: createChildEnv(),
    encoding: 'utf8',
    timeout: cliTimeoutMs,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function readGithubOutput(): Record<string, string> {
  if (!fs.existsSync(githubOutputPath)) return {};
  const entries = fs
    .readFileSync(githubOutputPath, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line): [string, string] => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]);
  return Object.fromEntries(entries);
}


/** Register the hooks every release CLI test file needs: transpile once, then a fresh repository per case. */
export function useReleaseSandbox(): void {
  before(transpileReleaseCli);

  after(() => {
    fs.rmSync(transpiledDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-release-'));
    repoDir = path.join(sandboxDir, 'repo');
    homeDir = path.join(sandboxDir, 'home');
    githubOutputPath = path.join(sandboxDir, 'github-output');
    fs.mkdirSync(repoDir);
    fs.mkdirSync(homeDir);
    runGit('init', '-q', '-b', 'main');
    writeRepoFile('package.json', `${JSON.stringify(initialPackage, null, 2)}\n`);
    writeRepoFile('CHANGELOG.md', initialChangelog);
    writeRepoFile('src/bot.ts', 'export const bot = 1;\n');
    writeRepoFile('README.md', '# demo\n');
    runGit('add', '-A');
    runGit('commit', '-q', '-m', 'chore: initial');
    runGit('tag', '-a', lastTag, '-m', lastTag);
  });

  afterEach(() => {
    fs.rmSync(sandboxDir, { recursive: true, force: true });
  });

}
