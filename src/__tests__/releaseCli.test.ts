/**
 * @description Coverage for `src/release/cli.ts` — the release workflow's wrapper — run as a real process
 * against a throwaway git repository the test builds (commits, an annotated release tag, a CHANGELOG, a
 * package.json). `plan` and `apply` / `changelog` / `notes` / `check-pack` are checked by what they print,
 * write to `$GITHUB_OUTPUT` and change on disk. The child runs with its own HOME and git config and never
 * touches the checkout's repository.
 *
 * The CLI is transpiled ONCE per file and every case runs the plain JavaScript with `node`: a `tsx` start costs ~0.35 s
 * of CPU, and ~60 cases starting it summed to most of the file's work — a loaded machine stretched that past the unit
 * runner's per-file limit. Only the `npm version` case starts the CLI through `tsx`, the way the workflow and the
 * `version` script do.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';
import { getReleaseDate } from '../release/releasePlan';

const tsxCliPath = require.resolve('tsx/cli');
const sourceRootDir = path.resolve(__dirname, '..');
const releaseCliPath = path.join(sourceRootDir, 'release', 'cli.ts');
const lastTag = 'v3.2.0';
const cliTimeoutMs = 90_000;

const initialPackage = {
  name: 'demo-package',
  version: '3.2.0',
  files: ['dist/', 'stt/gigaam_sidecar.py', 'remoteRun/runner-package-lock.json', 'remoteRun/ensureNode.sh', 'agent-plugin/', 'README.md', 'LICENSE', 'CHANGELOG.md'],
  // No "./": npm >= 11.10 drops a "./dist/…" bin entry at publish, and check-pack refuses it.
  bin: { charness: 'dist/cli.js' },
  scripts: { version: 'tsx src/release/cli.ts changelog && git add CHANGELOG.md', test: 'node --test' },
  dependencies: { left: '^1.0.0' },
  devDependencies: { dev: '^1.0.0' },
};

const initialChangelog = [
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
const pinnedDependency = {
  name: 'ms',
  range: '^2.0.0',
  version: '2.0.0',
  integrity: 'sha512-Tpp60P6IUJDTuOq/5Z8cdskzJujfwqfOTkrwIwj7IRISpnkJnT6SyJ4PCPnGMoFjC9ddhal5KVIYtAt97ix05A==',
};

/** The shrinkwrap of the fixture package at `version`, pinning {@link pinnedDependency}, as `hubShrinkwrap.ts` writes it. */
function createFixtureShrinkwrap(version: string): string {
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

let transpiledDir: string;
let transpiledCliPath: string;
let sandboxDir: string;
let repoDir: string;
let homeDir: string;
let githubOutputPath: string;

function getTranspiledPath(sourcePath: string): string {
  return path.join(transpiledDir, path.relative(sourceRootDir, sourcePath)).replace(/\.ts$/, '.js');
}

/** A module and every relative import under it as plain JavaScript (CommonJS like the build), laid out as in `src/` so the imports resolve. */
function transpileModuleTree(sourcePath: string, writtenPaths: Set<string> = new Set()): void {
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

function transpileReleaseCli(): void {
  transpiledDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-release-cli-'));
  transpileModuleTree(releaseCliPath);
  transpiledCliPath = getTranspiledPath(releaseCliPath);
}

/** Where the transpiled CLI finds its packages (`zod`, through the runner's lock module): it runs from a folder outside the checkout. */
const checkoutNodeModulesPath = path.resolve(sourceRootDir, '..', 'node_modules');

/** The environment of the CLI under test: no git identity, so the identity the CLI itself sets is what a commit shows. */
function createChildEnv(): NodeJS.ProcessEnv {
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
function createGitEnv(): NodeJS.ProcessEnv {
  return {
    ...createChildEnv(),
    GIT_AUTHOR_NAME: 'Release Test',
    GIT_AUTHOR_EMAIL: 'release-test@example.invalid',
    GIT_COMMITTER_NAME: 'Release Test',
    GIT_COMMITTER_EMAIL: 'release-test@example.invalid',
  };
}

function runGit(...args: string[]): string {
  const result = spawnSync('git', args, { cwd: repoDir, env: createGitEnv(), encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function writeRepoFile(relativePath: string, content: string): void {
  const filePath = path.join(repoDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function commitFile(relativePath: string, content: string, message: string): void {
  writeRepoFile(relativePath, content);
  runGit('add', '-A');
  runGit('commit', '-q', '-m', message);
}

function runCli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [transpiledCliPath, ...args], {
    cwd: repoDir,
    env: createChildEnv(),
    encoding: 'utf8',
    timeout: cliTimeoutMs,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function readGithubOutput(): Record<string, string> {
  if (!fs.existsSync(githubOutputPath)) return {};
  const entries = fs
    .readFileSync(githubOutputPath, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line): [string, string] => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]);
  return Object.fromEntries(entries);
}

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

describe('plan', () => {
  test('a feat touching src → release, minor, 3.3.0; outputs reach $GITHUB_OUTPUT', () => {
    commitFile('src/bot.ts', 'export const bot = 2;\n', 'fix: a');
    commitFile('src/limits.ts', 'export const limits = 1;\n', 'feat(limits): a switch board');
    const result = runCli('plan');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Release 3\.3\.0 \(minor\)\./);
    assert.deepEqual(readGithubOutput(), { kind: 'release', message: 'Release 3.3.0 (minor).', version: '3.3.0', bump: 'minor' });
  });

  test('only a fix touching src → patch', () => {
    commitFile('src/bot.ts', 'export const bot = 2;\n', 'fix: a');
    assert.equal(runCli('plan').status, 0);
    assert.equal(readGithubOutput().version, '3.2.1');
  });

  test('docs-only and tests-only commits → green skip, nothing to release', () => {
    commitFile('README.md', '# demo changed\n', 'docs: readme');
    commitFile('src/__tests__/bot.test.ts', 'export {};\n', 'test: a test');
    const result = runCli('plan');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Nothing to release: Nothing shipped changed since v3\.2\.0/);
    assert.equal(readGithubOutput().kind, 'skip');
  });

  test('a change and its revert → the net diff is empty → skip', () => {
    commitFile('src/bot.ts', 'export const bot = 2;\n', 'feat: a');
    commitFile('src/bot.ts', 'export const bot = 1;\n', 'revert: a');
    assert.equal(runCli('plan').status, 0);
    assert.equal(readGithubOutput().kind, 'skip');
  });

  test('package.json changed only in scripts → skip; a dependencies change → release', () => {
    const scripted = { ...initialPackage, scripts: { ...initialPackage.scripts, lint: 'eslint .' } };
    commitFile('package.json', `${JSON.stringify(scripted, null, 2)}\n`, 'chore: a script');
    assert.equal(runCli('plan').status, 0);
    assert.equal(readGithubOutput().kind, 'skip');

    fs.rmSync(githubOutputPath);
    const withDependency = { ...scripted, dependencies: { left: '^1.0.0', right: '^2.0.0' } };
    commitFile('package.json', `${JSON.stringify(withDependency, null, 2)}\n`, 'chore: a dependency');
    assert.equal(runCli('plan').status, 0);
    assert.equal(readGithubOutput().kind, 'release');
  });

  test('a breaking commit on bump auto → exit 1, the commit named, no version output', () => {
    commitFile('src/bot.ts', 'export const bot = 2;\n', 'feat!: drop the old command');
    const result = runCli('plan');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /feat!: drop the old command/);
    assert.equal(readGithubOutput().kind, 'fail');
    assert.equal(readGithubOutput().version, undefined);
  });

  test('--bump major releases 4.0.0 over a breaking commit', () => {
    commitFile('src/bot.ts', 'export const bot = 2;\n', 'feat!: drop it');
    assert.equal(runCli('plan', '--bump', 'major').status, 0);
    assert.equal(readGithubOutput().version, '4.0.0');
  });

  test('HEAD carrying the release tag → skip; --force still releases', () => {
    assert.equal(runCli('plan').status, 0);
    assert.match(readGithubOutput().message, /HEAD already carries a release tag \(v3\.2\.0\)/);
    fs.rmSync(githubOutputPath);
    assert.equal(runCli('plan', '--force', 'true').status, 0);
    assert.equal(readGithubOutput().version, '3.2.1');
  });

  test('--force on a docs-only day → a patch release', () => {
    commitFile('README.md', '# demo changed\n', 'docs: readme');
    assert.equal(runCli('plan', '--force', 'true').status, 0);
    assert.deepEqual([readGithubOutput().kind, readGithubOutput().version], ['release', '3.2.1']);
  });

  test('a main that merged since the tag still plans from the commits of the merged side', () => {
    runGit('checkout', '-q', '-b', 'side');
    commitFile('src/side.ts', 'export const side = 1;\n', 'fix: on the side');
    runGit('checkout', '-q', 'main');
    commitFile('README.md', '# demo changed\n', 'docs: on main');
    runGit('merge', '-q', '--no-ff', '-m', 'Merge branch side', 'side');
    assert.equal(runCli('plan').status, 0);
    assert.equal(readGithubOutput().version, '3.2.1');
  });

  test('an entry without a bold first sentence fails the plan before any gate, quoting the line', () => {
    writeRepoFile('CHANGELOG.md', initialChangelog.replace('**A change users see.** With its details.', 'A change users see, not bold.'));
    runGit('add', '-A');
    runGit('commit', '-q', '-m', 'docs: changelog');
    commitFile('src/bot.ts', 'export const bot = 2;\n', 'fix: a');
    const result = runCli('plan');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /A change users see, not bold\./);
    assert.equal(readGithubOutput().kind, 'fail');
  });

  test('a CHANGELOG without ## Unreleased fails the plan', () => {
    commitFile('CHANGELOG.md', '# Changelog\n\n## 3.2.0 — 2026-10-16\n\n**Older.** Entry.\n', 'docs: drop unreleased');
    commitFile('src/bot.ts', 'export const bot = 2;\n', 'fix: a');
    const result = runCli('plan');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no "## Unreleased" heading/);
  });

  test('an unknown --bump value is refused', () => {
    const result = runCli('plan', '--bump', 'huge');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--bump must be one of/);
  });

  test('no release tag in the repository → fail', () => {
    runGit('tag', '-d', lastTag);
    const result = runCli('plan');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No release tag/);
  });
});

describe('apply and changelog', () => {
  function readPackageText(): string {
    return fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8');
  }

  function readChangelog(): string {
    return fs.readFileSync(path.join(repoDir, 'CHANGELOG.md'), 'utf8');
  }

  function getAcceptableDates(run: () => void): string[] {
    const before = getReleaseDate(new Date());
    run();
    return [before, getReleaseDate(new Date())];
  }

  test('apply writes the version into package.json in place and moves the CHANGELOG heading', () => {
    commitFile('src/bot.ts', 'export const bot = 2;\n', 'fix: a');
    const originalText = readPackageText();
    let status: number | null = null;
    const dates = getAcceptableDates(() => {
      status = runCli('apply', '3.2.1').status;
    });
    assert.equal(status, 0);
    // Only the version line changed: formatting, key order and the `version` script are untouched.
    assert.equal(readPackageText(), originalText.replace('"version": "3.2.0"', '"version": "3.2.1"'));
    const changelog = readChangelog();
    assert.match(changelog, /## Unreleased\n\n## 3\.2\.1 — (\d{4}-\d{2}-\d{2})\n\n\*\*A change users see\.\*\* With its details\.\n\n## 3\.2\.0/);
    const date = /## 3\.2\.1 — (\S+)/.exec(changelog)?.[1] ?? '';
    assert.ok(dates.includes(date), `${date} is not today in Tbilisi (${dates.join(' / ')})`);
  });

  test('apply writes the version into npm-shrinkwrap.json too — its own and its root entry\'s, as npm version does —, and the result is the tested commit plus its release', () => {
    commitFile('npm-shrinkwrap.json', createFixtureShrinkwrap('3.2.0'), 'build: the shrinkwrap');
    const tested = runGit('rev-parse', 'HEAD');
    assert.equal(runCli('apply', '3.2.1').status, 0);
    assert.equal(fs.readFileSync(path.join(repoDir, 'npm-shrinkwrap.json'), 'utf8'), createFixtureShrinkwrap('3.2.1'));
    const delta = runCli('verify-delta', '--base', tested);
    assert.equal(delta.status, 0, `${delta.stdout}\n${delta.stderr}`);
  });

  test('apply fills an empty Unreleased from the feat / fix subjects since the tag', () => {
    writeRepoFile('CHANGELOG.md', initialChangelog.replace('**A change users see.** With its details.\n\n', ''));
    runGit('add', '-A');
    runGit('commit', '-q', '-m', 'docs: empty unreleased');
    commitFile('src/limits.ts', 'export const limits = 1;\n', 'feat(limits): a switch board');
    commitFile('src/bot.ts', 'export const bot = 2;\n', 'fix: a restart lost the wait');
    assert.equal(runCli('apply', '3.3.0').status, 0);
    const changelog = readChangelog();
    assert.match(changelog, /### Added\n- \*\*A switch board\.\*\*\n\n### Fixed\n- \*\*A restart lost the wait\.\*\*\n\n## 3\.2\.0/);
  });

  test('apply refuses a bad version and a violating entry, changing nothing it should not', () => {
    const bad = runCli('apply', 'three');
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /Expected a version X\.Y\.Z/);

    writeRepoFile('CHANGELOG.md', initialChangelog.replace('**A change users see.**', 'Not bold.'));
    const violating = runCli('apply', '3.2.1');
    assert.equal(violating.status, 1);
    assert.match(violating.stderr, /Not bold\./);
  });

  test('the version script path: `changelog` moves the heading for the version package.json already carries', () => {
    writeRepoFile('package.json', readPackageText().replace('"version": "3.2.0"', '"version": "3.3.0"'));
    assert.equal(runCli('changelog').status, 0);
    assert.match(readChangelog(), /## Unreleased\n\n## 3\.3\.0 — \d{4}-\d{2}-\d{2}\n\n\*\*A change users see\./);
  });

  test('notes prints the body of the version section; a missing one fails', () => {
    assert.equal(runCli('apply', '3.3.0').status, 0);
    const notes = runCli('notes', '3.3.0');
    assert.equal(notes.status, 0, notes.stderr);
    assert.equal(notes.stdout, '**A change users see.** With its details.\n');
    const missing = runCli('notes', '9.9.9');
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /no non-empty section for 9\.9\.9/);
  });
});

describe('check-pack', () => {
  const sidecarPath = 'stt/gigaam_sidecar.py';

  function writePackableFiles(): void {
    writeRepoFile('package.json', `${JSON.stringify({ ...initialPackage, files: [...initialPackage.files, 'npm-shrinkwrap.json'], dependencies: { [pinnedDependency.name]: pinnedDependency.range } }, null, 2)}\n`);
    writeRepoFile('npm-shrinkwrap.json', createFixtureShrinkwrap(initialPackage.version));
    writeRepoFile('dist/cli.js', '#!/usr/bin/env node\nprocess.stdout.write(`${require("../package.json").version}\\n`);\n');
    fs.chmodSync(path.join(repoDir, 'dist', 'cli.js'), 0o755);
    writeRepoFile(sidecarPath, '# sidecar\n');
    // The lock the hub gives its runners (`runners/runnerLock.ts`): a package without it cannot pair a machine.
    writeRepoFile('remoteRun/runner-package-lock.json', '{}\n');
    writeRepoFile('remoteRun/ensureNode.sh', '#!/bin/sh\n');
    // The skills the bot gives its agents; the manifest sits in a dot-folder npm must still pack.
    writeRepoFile('agent-plugin/.claude-plugin/plugin.json', '{ "name": "charness" }\n');
    writeRepoFile('agent-plugin/skills/charness-orchestration/SKILL.md', '---\nname: charness-orchestration\ndescription: d\n---\n');
    writeRepoFile('LICENSE', 'MIT\n');
  }

  test('a sound package passes the listing check and installs the way a user installs it — from a registry, by its shrinkwrap — printing the new version', () => {
    writePackableFiles();
    const result = runCli('check-pack', '--version', '3.2.0');
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Package contents ok/);
    assert.match(result.stdout, /charness --version prints 3\.2\.0, and npm installed the tree npm-shrinkwrap\.json pins/);
  });

  test('check-install installs a tarball packed elsewhere (the release\'s own job) and checks npm took the pinned version, not the newest of the range', () => {
    writePackableFiles();
    const packDir = path.join(sandboxDir, 'packed');
    fs.mkdirSync(packDir);
    const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', packDir], { cwd: repoDir, env: createChildEnv(), encoding: 'utf8', timeout: cliTimeoutMs });
    assert.equal(packed.status, 0, packed.stderr);
    const tarballPath = path.join(packDir, `${initialPackage.name}-${initialPackage.version}.tgz`);
    const result = runCli('check-install', '--tarball', tarballPath, '--version', '3.2.0');
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /npm installed the tree npm-shrinkwrap\.json pins/);
    const wrongVersion = runCli('check-install', '--tarball', tarballPath, '--version', '9.9.9');
    assert.equal(wrongVersion.status, 1);
    assert.match(wrongVersion.stderr, /prints version 3\.2\.0, expected 9\.9\.9/);
    assert.match(runCli('check-install').stderr, /check-install needs --tarball/);
  });

  test('a package without its shrinkwrap is not fit to publish', () => {
    writePackableFiles();
    fs.rmSync(path.join(repoDir, 'npm-shrinkwrap.json'));
    const result = runCli('check-pack', '--skip-install');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing from the package: npm-shrinkwrap\.json/);
  });

  test('the version the package prints must be the expected one', () => {
    writePackableFiles();
    const result = runCli('check-pack', '--version', '3.9.9', '--skip-install');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /the package version is 3\.2\.0, expected 3\.9\.9/);
  });

  test('a bin path written "./dist/cli.js" is refused before anything is packed', () => {
    writePackableFiles();
    writeRepoFile('package.json', `${JSON.stringify({ ...initialPackage, bin: { charness: './dist/cli.js', telegramcode: 'dist/cli.js' } }, null, 2)}\n`);
    const result = runCli('check-pack', '--skip-install');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /bin paths npm >= 11\.10 drops at publish/);
    assert.match(result.stderr, /bin\.charness: \.\/dist\/cli\.js/);
    assert.doesNotMatch(result.stderr, /bin\.telegramcode/);
    assert.doesNotMatch(result.stdout, /Package contents ok/);
  });

  test('a missing required file and a shipped source file are both named', () => {
    writePackableFiles();
    fs.rmSync(path.join(repoDir, 'LICENSE'));
    writeRepoFile('src/leaked.ts', 'export {};\n');
    writeRepoFile('package.json', `${JSON.stringify({ ...initialPackage, files: [...initialPackage.files, 'src/'] }, null, 2)}\n`);
    const result = runCli('check-pack', '--skip-install');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing from the package: LICENSE/);
    assert.match(result.stderr, /must not ship: src\/leaked\.ts/);
  });
});

describe('check-publish', () => {
  /** A stand-in `npm` ahead of the real one on the PATH: prints `script` and exits with `exitCode`, whatever the arguments. */
  function runWithFakeNpm(output: string, exitCode: number): { status: number | null; stdout: string; stderr: string } {
    const binDir = path.join(homeDir, 'fake-bin');
    fs.mkdirSync(binDir, { recursive: true });
    const outputFile = path.join(binDir, 'npm-output.txt');
    fs.writeFileSync(outputFile, output);
    fs.writeFileSync(path.join(binDir, 'npm'), `#!/bin/sh\ncat '${outputFile}' >&2\nexit ${exitCode}\n`, { mode: 0o755 });
    const result = spawnSync(process.execPath, [transpiledCliPath, 'check-publish'], {
      cwd: repoDir,
      env: { ...createChildEnv(), PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
      encoding: 'utf8',
      timeout: cliTimeoutMs,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  test('a dry run that only prints notices passes', () => {
    const result = runWithFakeNpm('npm notice\nnpm notice 📦  demo-package@3.3.0\n+ demo-package@3.3.0\n', 0);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /nothing in package\.json is dropped or rewritten/);
  });

  test('a dry run that exits 0 but says it removed a field is refused, naming the field', () => {
    const result = runWithFakeNpm(
      'npm warn publish npm auto-corrected some errors in your package.json when publishing.\nnpm warn publish "bin[charness]" script name dist/cli.js was invalid and removed\n',
      0,
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /npm would change package\.json when publishing/);
    assert.match(result.stderr, /"bin\[charness\]" script name dist\/cli\.js was invalid and removed/);
    assert.match(result.stdout, /^::error title=Release failed::/m);
  });

  test('a dry run that fails itself fails the check, with the output tail', () => {
    const result = runWithFakeNpm('npm error You cannot publish over the previously published versions: 3.3.0.\n', 1);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /`npm publish --dry-run` failed \(exit 1\)/);
    assert.match(result.stderr, /cannot publish over the previously published versions/);
  });
});

describe('verify-delta', () => {
  function getHeadSha(): string {
    return runGit('rev-parse', 'HEAD');
  }

  function bumpVersionAndChangelog(): void {
    writeRepoFile('package.json', fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8').replace('"version": "3.2.0"', '"version": "3.3.0"'));
    writeRepoFile('CHANGELOG.md', initialChangelog.replace('## Unreleased', '## Unreleased\n\n## 3.3.0 — 2026-10-23'));
  }

  test('the working tree with only the version bump and the CHANGELOG moved is the tested commit plus its release', () => {
    const tested = getHeadSha();
    bumpVersionAndChangelog();
    const result = runCli('verify-delta', '--base', tested);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /differs from the tested commit [0-9a-f]{7} only in the version and the CHANGELOG/);
  });

  test('a committed release is checked against the tested commit through --head', () => {
    const tested = getHeadSha();
    bumpVersionAndChangelog();
    runGit('add', '-A');
    runGit('commit', '-q', '-m', 'chore(release): 3.3.0');
    assert.equal(runCli('verify-delta', '--base', tested, '--head', 'HEAD').status, 0);
  });

  test('another file differing — an untested commit that landed in between — is named and refused', () => {
    const tested = getHeadSha();
    commitFile('src/bot.ts', 'export const bot = 2;\n', 'fix: something nobody tested');
    bumpVersionAndChangelog();
    runGit('add', '-A');
    runGit('commit', '-q', '-m', 'chore(release): 3.3.0');
    const result = runCli('verify-delta', '--base', tested, '--head', 'HEAD');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /The release is not the tested commit [0-9a-f]{7} plus its version bump; nothing is published/);
    assert.match(result.stderr, /src\/bot\.ts differs from the tested commit/);
  });

  test('package.json changed beyond its version line is refused', () => {
    const tested = getHeadSha();
    bumpVersionAndChangelog();
    writeRepoFile('package.json', fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8').replace('"left": "^1.0.0"', '"left": "^9.0.0"'));
    const result = runCli('verify-delta', '--base', tested);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /package\.json differs from the tested commit in more than its "version" line/);
  });

  test('--base is required', () => {
    const result = runCli('verify-delta');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /verify-delta needs --base/);
  });
});

describe('test-gate', () => {
  type FakeRun = { id: number; head_sha: string; status: string; conclusion: string | null; created_at: string; html_url: string };
  const workflowRunsPath = '/repos/example-owner/example-repo/actions/workflows/test.yml/runs';
  let apiServer: http.Server;
  let apiUrl: string;
  let requests: { url: string; authorization: string | undefined }[];
  let apiStatus: number;
  let apiRuns: FakeRun[];

  beforeEach(async () => {
    requests = [];
    apiStatus = 200;
    apiRuns = [];
    apiServer = http.createServer((request, response) => {
      requests.push({ url: request.url ?? '', authorization: request.headers.authorization });
      const askedSha = new URL(request.url ?? '', 'http://localhost').searchParams.get('head_sha');
      response.writeHead(apiStatus, { 'Content-Type': 'application/json' });
      // Like GitHub: only the runs of the commit that was asked for.
      response.end(JSON.stringify({ workflow_runs: apiRuns.filter((run) => run.head_sha === askedSha) }));
    });
    await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
    const address = apiServer.address();
    assert.ok(address && typeof address !== 'string');
    apiUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => apiServer.close(() => resolve()));
  });

  /** The server answers from THIS process, so the CLI is an async child (spawnSync would block the server it asks). */
  function runGateCli(...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [transpiledCliPath, 'test-gate', ...args], {
        cwd: repoDir,
        env: { ...createChildEnv(), GITHUB_API_URL: apiUrl, GITHUB_REPOSITORY: 'example-owner/example-repo', GITHUB_TOKEN: 'fake-token-for-the-loopback-api', GITHUB_STEP_SUMMARY: path.join(sandboxDir, 'summary') },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
  }

  function createFakeRun(overrides: Partial<FakeRun> = {}): FakeRun {
    return { id: 1, head_sha: runGit('rev-parse', 'HEAD'), status: 'completed', conclusion: 'success', created_at: '2026-10-23T09:00:00Z', html_url: 'https://github.example/runs/1', ...overrides };
  }

  test('asks the API for the Tests workflow\'s runs of the exact HEAD commit, with the token', async () => {
    apiRuns = [createFakeRun()];
    const sha = runGit('rev-parse', 'HEAD');
    const result = await runGateCli('--event', 'schedule');
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, `${workflowRunsPath}?head_sha=${sha}&per_page=100`);
    assert.equal(requests[0].authorization, 'Bearer fake-token-for-the-loopback-api');
  });

  test('a green run → proceed without the suite; the outputs say so', async () => {
    apiRuns = [createFakeRun()];
    const result = await runGateCli('--event', 'workflow_dispatch');
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(
      [readGithubOutput().state, readGithubOutput().proceed, readGithubOutput().runSuite, readGithubOutput().sha],
      ['passed', 'true', 'false', runGit('rev-parse', 'HEAD')],
    );
    assert.match(result.stdout, /does not run the suite again/);
    assert.match(fs.readFileSync(path.join(sandboxDir, 'summary'), 'utf8'), /### Tests of [0-9a-f]{7}/);
  });

  test('no run of the commit (only another commit\'s) → proceed and run the suite here', async () => {
    apiRuns = [createFakeRun({ head_sha: 'f'.repeat(40) })];
    const result = await runGateCli('--event', 'workflow_dispatch');
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual([readGithubOutput().state, readGithubOutput().proceed, readGithubOutput().runSuite], ['none', 'true', 'true']);
  });

  test('a red head on the daily run → exit 0, proceed=false, a warning with the reason', async () => {
    apiRuns = [createFakeRun({ conclusion: 'failure' })];
    const result = await runGateCli('--event', 'schedule');
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual([readGithubOutput().state, readGithubOutput().proceed, readGithubOutput().runSuite], ['failed', 'false', 'false']);
    assert.match(result.stdout, /^::warning title=No release today::No release today: the Tests run for [0-9a-f]{7} did not pass: failure/m);
  });

  test('a red or still-running commit on a manual dispatch → exit 1 with a clear reason, nothing proceeds', async () => {
    apiRuns = [createFakeRun({ status: 'in_progress', conclusion: null })];
    const running = await runGateCli('--event', 'workflow_dispatch');
    assert.equal(running.status, 1);
    assert.match(running.stderr, /Refusing to release: the Tests run for [0-9a-f]{7} is still in progress.*wait for it to finish/);
    apiRuns = [createFakeRun({ conclusion: 'cancelled' })];
    const cancelled = await runGateCli('--event', 'push');
    assert.equal(cancelled.status, 1);
    assert.match(cancelled.stderr, /did not pass: cancelled/);
    assert.equal(readGithubOutput().proceed, 'false');
  });

  describe('a hand-pushed tag (--through-parent)', () => {
    /** The tested commit and, on top of it, what `npm version` makes: the version bump and the moved CHANGELOG heading. */
    function commitVersionBump(extraFile?: { path: string; content: string }): { parent: string; tagged: string } {
      const parent = runGit('rev-parse', 'HEAD');
      writeRepoFile('package.json', fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8').replace('"version": "3.2.0"', '"version": "3.3.0"'));
      writeRepoFile('CHANGELOG.md', initialChangelog.replace('## Unreleased', '## Unreleased\n\n## 3.3.0 — 2026-10-23'));
      if (extraFile) writeRepoFile(extraFile.path, extraFile.content);
      runGit('add', '-A');
      runGit('commit', '-q', '-m', 'chore(release): 3.3.0');
      return { parent, tagged: runGit('rev-parse', 'HEAD') };
    }

    test('a green parent and a tag that is only the version bump: the release goes on at once — the tag\'s own run (still going) is not waited for', async () => {
      const { parent, tagged } = commitVersionBump();
      apiRuns = [createFakeRun({ head_sha: parent }), createFakeRun({ id: 2, head_sha: tagged, status: 'in_progress', conclusion: null })];
      const result = await runGateCli('--event', 'push', '--through-parent');
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.deepEqual(
        [readGithubOutput().state, readGithubOutput().proceed, readGithubOutput().runSuite, readGithubOutput().sha],
        ['passed', 'true', 'false', parent],
      );
      assert.match(result.stdout, /differs from it only in the version and the CHANGELOG/);
      assert.equal(requests.length, 1, 'only the parent was looked up');
    });

    test('a tag that carries another change too does not ride on its parent: its own run decides — still running refuses', async () => {
      const { parent, tagged } = commitVersionBump({ path: 'src/bot.ts', content: 'export const bot = 2;\n' });
      apiRuns = [createFakeRun({ head_sha: parent }), createFakeRun({ id: 2, head_sha: tagged, status: 'in_progress', conclusion: null })];
      const result = await runGateCli('--event', 'push', '--through-parent');
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Refusing to release: the Tests run for [0-9a-f]{7} is still in progress/);
      assert.equal(readGithubOutput().sha, tagged);
      assert.equal(requests.length, 2, 'the parent first, then the tagged commit');
    });

    test('a parent that is red or still running falls back to the tagged commit\'s own run, which may be green', async () => {
      const { parent, tagged } = commitVersionBump();
      apiRuns = [createFakeRun({ head_sha: parent, conclusion: 'failure' }), createFakeRun({ id: 2, head_sha: tagged })];
      const result = await runGateCli('--event', 'push', '--through-parent');
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.deepEqual([readGithubOutput().state, readGithubOutput().sha], ['passed', tagged]);
    });

    test('no run for the parent and none for the tag: the suite runs here, as for any commit nobody tested', async () => {
      const { tagged } = commitVersionBump();
      const result = await runGateCli('--event', 'push', '--through-parent');
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.deepEqual([readGithubOutput().state, readGithubOutput().runSuite, readGithubOutput().sha], ['none', 'true', tagged]);
    });

    test('a commit with no parent (nothing to ride on) is gated on itself', async () => {
      const root = runGit('rev-list', '--max-parents=0', 'HEAD');
      runGit('checkout', '-q', root);
      apiRuns = [createFakeRun({ head_sha: root })];
      const result = await runGateCli('--event', 'push', '--through-parent');
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.deepEqual([readGithubOutput().state, readGithubOutput().sha], ['passed', root]);
    });

    test('without the flag the parent is never looked at (a dispatch or the daily run gates the head itself)', async () => {
      const { parent, tagged } = commitVersionBump();
      apiRuns = [createFakeRun({ head_sha: parent }), createFakeRun({ id: 2, head_sha: tagged, status: 'in_progress', conclusion: null })];
      const result = await runGateCli('--event', 'push');
      assert.equal(result.status, 1);
      assert.equal(readGithubOutput().sha, tagged);
      assert.equal(requests.length, 1);
    });
  });

  test('a --sha that is not a full commit SHA is refused before any request', async () => {
    const result = await runGateCli('--sha', 'abc123&per_page=1', '--event', 'schedule');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--sha must be a full 40-character commit SHA/);
    assert.equal(requests.length, 0);
  });

  test('an explicit --sha is the one looked up', async () => {
    const otherSha = 'c'.repeat(40);
    apiRuns = [createFakeRun({ head_sha: otherSha })];
    const result = await runGateCli('--sha', otherSha, '--event', 'workflow_dispatch');
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(requests[0].url, `${workflowRunsPath}?head_sha=${otherSha}&per_page=100`);
    assert.equal(readGithubOutput().state, 'passed');
  });

  test('an API that cannot be reached refuses, naming the lookup', async () => {
    apiUrl = 'http://127.0.0.1:1';
    const result = await runGateCli('--event', 'schedule');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Cannot look up the Tests runs of [0-9a-f]{7}: /);
    assert.equal(readGithubOutput().proceed, undefined);
  });

  test('outside GitHub Actions (no repository in the environment) it says so instead of guessing', () => {
    const result = runCli('test-gate');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /GITHUB_REPOSITORY is not set; the test gate runs inside GitHub Actions/);
  });

  test('a lookup that cannot be made refuses: the API answering an error says what the job needs', async () => {
    apiStatus = 403;
    const result = await runGateCli('--event', 'schedule');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /GitHub answered 403 for test\.yml \(the job needs `actions: read`\)/);
    assert.equal(readGithubOutput().proceed, undefined);
  });
});

describe('check-registry', () => {
  let registryServer: http.Server;
  let registryUrl: string;
  let registryRequests: { url: string; accept: string | undefined }[];
  let registryAnswer: { status: number; versions: string[] };

  beforeEach(async () => {
    registryRequests = [];
    registryAnswer = { status: 200, versions: [] };
    registryServer = http.createServer((request, response) => {
      registryRequests.push({ url: request.url ?? '', accept: request.headers.accept });
      response.writeHead(registryAnswer.status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(registryAnswer.status === 200 ? { name: initialPackage.name, versions: Object.fromEntries(registryAnswer.versions.map((version) => [version, { version }])) } : { error: 'Not found' }));
    });
    await new Promise<void>((resolve) => registryServer.listen(0, '127.0.0.1', resolve));
    const address = registryServer.address();
    assert.ok(address && typeof address !== 'string');
    registryUrl = `http://127.0.0.1:${address.port}/`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => registryServer.close(() => resolve()));
  });

  /** The fake registry answers from THIS process: the CLI runs as an async child. */
  function runRegistryCheck(version: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [transpiledCliPath, 'check-registry', '--version', version, '--registry', registryUrl], { cwd: repoDir, env: createChildEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
  }

  test('npm holds 3.2.1, which no tag has (a release that did not finish): releasing 3.3.0 is refused, naming it', async () => {
    registryAnswer = { status: 200, versions: ['3.1.0', '3.2.0', '3.2.1'] };
    const result = await runRegistryCheck('3.3.0');
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /npm holds demo-package 3\.2\.1, which no release tag of the repository has/);
    assert.match(result.stderr, /Releasing 3\.3\.0 now would leave 3\.2\.1 without a tag, a release commit and a CHANGELOG section for good/);
    assert.match(result.stderr, /Re-run failed jobs.*Nothing is published or pushed\./);
    assert.deepEqual(registryRequests.map(({ url }) => url), ['/demo-package']);
    assert.match(registryRequests[0].accept ?? '', /application\/vnd\.npm\.install-v1\+json/);
  });

  test('only tagged versions, or this run\'s own (a re-run), or a package npm does not know: it goes on', async () => {
    registryAnswer = { status: 200, versions: ['3.1.0', '3.2.0', '3.3.0'] };
    const ownVersion = await runRegistryCheck('3.3.0');
    assert.equal(ownVersion.status, 0, ownVersion.stderr);
    assert.match(ownVersion.stdout, /npm holds no demo-package version newer than the release tags but 3\.3\.0 itself/);
    registryAnswer = { status: 404, versions: [] };
    const unknown = await runRegistryCheck('3.3.0');
    assert.equal(unknown.status, 0, unknown.stderr);
  });

  test('a hand-pushed tag: the tag of the version itself does not hide an unfinished version below it', async () => {
    commitFile('src/bot.ts', 'export const bot = 2;\n', 'fix: a');
    runGit('tag', '-a', 'v3.3.0', '-m', 'v3.3.0');
    registryAnswer = { status: 200, versions: ['3.2.0', '3.2.1'] };
    const result = await runRegistryCheck('3.3.0');
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /npm holds demo-package 3\.2\.1/);
  });

  test('a registry that cannot be read stops the run: nothing is published', async () => {
    registryAnswer = { status: 500, versions: [] };
    const result = await runRegistryCheck('3.3.0');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Cannot read the versions the registry holds of demo-package: the registry answered 500; nothing is published\./);
  });
});

describe('the manual `npm version` path', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');

  test('`npm version minor` commits `chore(release): X.Y.Z` with the moved CHANGELOG heading in it and tags vX.Y.Z', () => {
    const realManifest: { scripts: { version: string } } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    // The repository's own `version` script and `.npmrc`, with `tsx <script>` pointed at this checkout's files.
    const versionScript = realManifest.scripts.version.replace('tsx src/release/cli.ts', `node ${tsxCliPath} ${releaseCliPath}`);
    assert.notEqual(versionScript, realManifest.scripts.version, 'the version script no longer runs src/release/cli.ts');
    writeRepoFile('package.json', `${JSON.stringify({ ...initialPackage, scripts: { version: versionScript } }, null, 2)}\n`);
    fs.copyFileSync(path.join(repoRoot, '.npmrc'), path.join(repoDir, '.npmrc'));
    runGit('add', '-A');
    runGit('commit', '-q', '-m', 'chore: the version script');

    const result = spawnSync('npm', ['version', 'minor'], { cwd: repoDir, env: createGitEnv(), encoding: 'utf8', timeout: cliTimeoutMs });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    assert.equal(runGit('log', '-1', '--format=%s'), 'chore(release): 3.3.0');
    assert.equal(runGit('tag', '--points-at', 'HEAD'), 'v3.3.0');
    assert.deepEqual(runGit('show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['CHANGELOG.md', 'package.json']);
    assert.match(runGit('show', 'HEAD:CHANGELOG.md'), /## Unreleased\n\n## 3\.3\.0 — \d{4}-\d{2}-\d{2}\n\n\*\*A change users see\./);
  });

  test('with a shrinkwrap, `npm version` bumps it too — and the tag is still its parent plus only the version bump (the gate of a hand-pushed tag)', () => {
    const realManifest: { scripts: { version: string } } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const versionScript = realManifest.scripts.version.replace('tsx src/release/cli.ts', `node ${tsxCliPath} ${releaseCliPath}`);
    writeRepoFile('package.json', `${JSON.stringify({ ...initialPackage, scripts: { version: versionScript } }, null, 2)}\n`);
    writeRepoFile('npm-shrinkwrap.json', createFixtureShrinkwrap(initialPackage.version));
    fs.copyFileSync(path.join(repoRoot, '.npmrc'), path.join(repoDir, '.npmrc'));
    runGit('add', '-A');
    runGit('commit', '-q', '-m', 'chore: the version script and the shrinkwrap');

    const result = spawnSync('npm', ['version', 'minor'], { cwd: repoDir, env: createGitEnv(), encoding: 'utf8', timeout: cliTimeoutMs });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    assert.deepEqual(runGit('show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['CHANGELOG.md', 'npm-shrinkwrap.json', 'package.json']);
    assert.equal(runGit('show', 'HEAD:npm-shrinkwrap.json'), createFixtureShrinkwrap('3.3.0').trimEnd(), 'the same file the release\'s apply writes');
    const delta = runCli('verify-delta', '--base', runGit('rev-parse', 'HEAD^'), '--head', 'HEAD');
    assert.equal(delta.status, 0, `${delta.stdout}\n${delta.stderr}`);
  });
});

describe('commit-release', () => {
  let remoteDir: string;
  let otherDir: string;

  function runGitIn(cwd: string, ...args: string[]): string {
    const result = spawnSync('git', args, { cwd, env: createGitEnv(), encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')} (${cwd}): ${result.stderr}`);
    return result.stdout.trim();
  }

  /** Another clone of the remote: where "someone else pushes to main while the release runs". */
  function pushFromOtherClone(fileName: string, content: string, message: string): void {
    runGitIn(otherDir, 'pull', '-q', '--rebase', 'origin', 'main');
    fs.writeFileSync(path.join(otherDir, fileName), content);
    runGitIn(otherDir, 'add', '-A');
    runGitIn(otherDir, 'commit', '-q', '-m', message);
    runGitIn(otherDir, 'push', '-q', 'origin', 'main');
  }

  /** A pre-push hook that moves the remote's main before each of the first `times` pushes go out. */
  function installMovingMainHook(times: number): void {
    const counterFile = path.join(sandboxDir, 'push-count');
    const hook = [
      '#!/bin/sh',
      'unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE',
      'export GIT_AUTHOR_NAME=Other GIT_AUTHOR_EMAIL=other@example.invalid GIT_COMMITTER_NAME=Other GIT_COMMITTER_EMAIL=other@example.invalid',
      `n=$(cat "${counterFile}" 2>/dev/null || echo 0)`,
      'n=$((n + 1))',
      `echo $n > "${counterFile}"`,
      `if [ "$n" -le ${times} ]; then`,
      `  cd "${otherDir}" && git pull -q --rebase origin main && echo "$n" > "moved-$n.txt" && git add -A && git commit -q -m "chore: moved $n" && git push -q origin main`,
      'fi',
      'exit 0',
    ].join('\n');
    const hookPath = path.join(repoDir, '.git', 'hooks', 'pre-push');
    fs.writeFileSync(hookPath, `${hook}\n`, { mode: 0o755 });
  }

  function applyRelease(version: string): void {
    commitFile('src/bot.ts', 'export const bot = 2;\n', 'fix: a');
    const result = runCli('apply', version);
    assert.equal(result.status, 0, result.stderr);
  }

  beforeEach(() => {
    remoteDir = path.join(sandboxDir, 'remote.git');
    otherDir = path.join(sandboxDir, 'other');
    runGitIn(sandboxDir, 'init', '-q', '--bare', '-b', 'main', remoteDir);
    runGit('remote', 'add', 'origin', remoteDir);
    runGit('push', '-q', 'origin', 'main', lastTag);
    runGitIn(sandboxDir, 'clone', '-q', remoteDir, otherDir);
  });

  test('commits only package.json and CHANGELOG.md as the bot, tags that commit, pushes branch and tag', () => {
    applyRelease('3.3.0');
    writeRepoFile('stray.txt', 'not part of the release\n');
    const result = runCli('commit-release', '3.3.0');
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const released = runGit('rev-parse', 'HEAD');
    assert.equal(runGit('log', '-1', '--format=%s|%an|%ae'), 'chore(release): 3.3.0|github-actions[bot]|41898282+github-actions[bot]@users.noreply.github.com');
    assert.deepEqual(runGit('show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['CHANGELOG.md', 'package.json']);
    assert.equal(runGitIn(remoteDir, 'rev-parse', 'refs/heads/main'), released);
    assert.equal(runGitIn(remoteDir, 'rev-parse', 'v3.3.0^{commit}'), released);
    assert.equal(runGitIn(remoteDir, 'cat-file', '-t', 'v3.3.0'), 'tag');
    assert.equal(readGithubOutput().tag, 'v3.3.0');
    assert.ok(fs.existsSync(path.join(repoDir, 'stray.txt')));
    assert.match(runGit('status', '--porcelain'), /\?\? stray\.txt/);
  });

  test('with a shrinkwrap, the release commit carries it too: package.json, npm-shrinkwrap.json and CHANGELOG.md', () => {
    commitFile('npm-shrinkwrap.json', createFixtureShrinkwrap('3.2.0'), 'build: the shrinkwrap');
    applyRelease('3.3.0');
    const result = runCli('commit-release', '3.3.0');
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(runGit('show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['CHANGELOG.md', 'npm-shrinkwrap.json', 'package.json']);
    assert.equal(runGit('status', '--porcelain'), '');
  });

  test('the next plan starts from the new tag: HEAD tagged → skip; a later fix → 3.3.1', () => {
    applyRelease('3.3.0');
    assert.equal(runCli('commit-release', '3.3.0').status, 0);
    fs.rmSync(githubOutputPath);
    assert.equal(runCli('plan').status, 0);
    assert.match(readGithubOutput().message, /HEAD already carries a release tag \(v3\.3\.0\)/);

    fs.rmSync(githubOutputPath);
    commitFile('src/bot.ts', 'export const bot = 3;\n', 'fix: b');
    commitFile('README.md', '# changed\n', 'docs: c');
    assert.equal(runCli('plan').status, 0);
    assert.deepEqual([readGithubOutput().kind, readGithubOutput().version], ['release', '3.3.1']);
  });

  test('main moved during the run: a merge commit lands on main, the tag stays on the release commit', () => {
    applyRelease('3.3.0');
    pushFromOtherClone('notes.txt', 'someone else\n', 'docs: notes');
    const result = runCli('commit-release', '3.3.0');
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const releaseCommit = runGitIn(remoteDir, 'rev-parse', 'v3.3.0^{commit}');
    assert.equal(runGitIn(remoteDir, 'log', '-1', '--format=%s', releaseCommit), 'chore(release): 3.3.0');
    const mainHead = runGitIn(remoteDir, 'rev-parse', 'refs/heads/main');
    assert.notEqual(mainHead, releaseCommit);
    assert.equal(runGitIn(remoteDir, 'log', '-1', '--format=%P', mainHead).split(' ').length, 2, 'main is a merge commit');
    runGitIn(remoteDir, 'merge-base', '--is-ancestor', releaseCommit, mainHead);
    assert.equal(runGitIn(remoteDir, 'show', `${mainHead}:notes.txt`), 'someone else');
    assert.match(runGitIn(remoteDir, 'show', `${mainHead}:package.json`), /"version": "3\.3\.0"/);
    assert.equal(runGitIn(remoteDir, 'show', `${releaseCommit}:README.md`), '# demo');
  });

  test('main moves twice in a row: the third push goes through', () => {
    applyRelease('3.3.0');
    installMovingMainHook(2);
    const result = runCli('commit-release', '3.3.0');
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(fs.readFileSync(path.join(sandboxDir, 'push-count'), 'utf8').trim(), '3');
    const mainHead = runGitIn(remoteDir, 'rev-parse', 'refs/heads/main');
    assert.equal(runGitIn(remoteDir, 'show', `${mainHead}:moved-1.txt`), '1');
    assert.equal(runGitIn(remoteDir, 'show', `${mainHead}:moved-2.txt`), '2');
    runGitIn(remoteDir, 'merge-base', '--is-ancestor', runGitIn(remoteDir, 'rev-parse', 'v3.3.0^{commit}'), mainHead);
  });

  test('main that keeps moving fails after three attempts, pushes no tag and says npm has the version and how to finish', () => {
    applyRelease('3.3.0');
    installMovingMainHook(99);
    const result = runCli('commit-release', '3.3.0');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /failed 3 times because main kept moving; npm has 3\.3\.0 already and the repository not yet \(no v3\.3\.0, main not bumped\): re-run this run's failed jobs/);
    assert.match(result.stderr, /npm has a version the repository does not/);
    assert.equal(spawnSync('git', ['rev-parse', '-q', '--verify', 'refs/tags/v3.3.0'], { cwd: remoteDir, encoding: 'utf8' }).status, 1);
  });

  /** Main's CHANGELOG with `entry` added at the top of `## Unreleased` (the spot the release rewrites) or at its end, pushed from the other clone. */
  function pushChangelogEntry(entry: string, where: 'top' | 'end'): void {
    runGitIn(otherDir, 'pull', '-q', '--rebase', 'origin', 'main');
    const changelogPath = path.join(otherDir, 'CHANGELOG.md');
    const text = fs.readFileSync(changelogPath, 'utf8');
    fs.writeFileSync(changelogPath, where === 'top' ? text.replace('## Unreleased\n\n', `## Unreleased\n\n${entry}\n\n`) : text.replace('\n\n## 3.2.0', `\n\n${entry}\n\n## 3.2.0`));
    runGitIn(otherDir, 'add', '-A');
    runGitIn(otherDir, 'commit', '-q', '-m', 'docs(changelog): a newer entry');
    runGitIn(otherDir, 'push', '-q', 'origin', 'main');
  }

  /** Main with a released CHANGELOG entry reworded, pushed from the other clone: a change the release cannot merge by itself. */
  function pushRewordedReleasedEntry(): void {
    runGitIn(otherDir, 'pull', '-q', '--rebase', 'origin', 'main');
    const changelogPath = path.join(otherDir, 'CHANGELOG.md');
    fs.writeFileSync(changelogPath, fs.readFileSync(changelogPath, 'utf8').replace('**A change users see.** With its details.', '**A change users see.** With its details, reworded.'));
    runGitIn(otherDir, 'add', '-A');
    runGitIn(otherDir, 'commit', '-q', '-m', 'docs(changelog): reword');
    runGitIn(otherDir, 'push', '-q', 'origin', 'main');
  }

  function checkHasRemoteTag(tag: string): boolean {
    return spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], { cwd: remoteDir, encoding: 'utf8' }).status === 0;
  }

  for (const where of ['top', 'end'] as const) {
    test(`an entry added on main at the ${where} of Unreleased during the run: merged, it stays under Unreleased; the tag keeps the released CHANGELOG`, () => {
      applyRelease('3.3.0');
      const releasedChangelog = fs.readFileSync(path.join(repoDir, 'CHANGELOG.md'), 'utf8');
      pushChangelogEntry('**A newer entry.** Lands during the run.', where);
      const result = runCli('commit-release', '3.3.0');
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const mainChangelog = runGitIn(remoteDir, 'show', 'refs/heads/main:CHANGELOG.md');
      assert.match(mainChangelog, /## Unreleased\n\n\*\*A newer entry\.\*\* Lands during the run\.\n\n## 3\.3\.0 — \d{4}-\d{2}-\d{2}\n\n\*\*A change users see\.\*\* With its details\.\n\n## 3\.2\.0/);
      assert.equal(`${runGitIn(remoteDir, 'show', 'v3.3.0:CHANGELOG.md')}\n`, releasedChangelog);
    });
  }

  test('a released entry edited on main during the run is a real conflict: the run fails, no merge left, no tag on the remote', () => {
    applyRelease('3.3.0');
    pushRewordedReleasedEntry();
    const result = runCli('commit-release', '3.3.0');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /origin\/main moved during the run and merging it into the release conflicts in CHANGELOG\.md; npm has 3\.3\.0 already/);
    assert.equal(fs.existsSync(path.join(repoDir, '.git', 'MERGE_HEAD')), false);
    assert.equal(checkHasRemoteTag('v3.3.0'), false);
    assert.equal(runGitIn(remoteDir, 'log', '-1', '--format=%s', 'refs/heads/main'), 'docs(changelog): reword');
  });

  test('a dependency change on main during the run merges with the release\'s version bump — the shrinkwrap\'s version lines do not touch its dependencies', () => {
    commitFile('npm-shrinkwrap.json', createFixtureShrinkwrap('3.2.0'), 'build: the shrinkwrap');
    runGit('push', '-q', 'origin', 'main');
    applyRelease('3.3.0');
    runGitIn(otherDir, 'pull', '-q', '--rebase', 'origin', 'main');
    const shrinkwrapPath = path.join(otherDir, 'npm-shrinkwrap.json');
    const withDependency = fs.readFileSync(shrinkwrapPath, 'utf8')
      .replace('"dependencies": {\n', '"dependencies": {\n        "abbrev": "^1.0.0",\n')
      .replace('"node_modules/ms": {', '"node_modules/abbrev": {\n      "version": "1.1.1"\n    },\n    "node_modules/ms": {');
    fs.writeFileSync(shrinkwrapPath, withDependency);
    runGitIn(otherDir, 'add', '-A');
    runGitIn(otherDir, 'commit', '-q', '-m', 'build(deps): add abbrev');
    runGitIn(otherDir, 'push', '-q', 'origin', 'main');

    const result = runCli('commit-release', '3.3.0');
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const merged = JSON.parse(runGitIn(remoteDir, 'show', 'refs/heads/main:npm-shrinkwrap.json'));
    assert.deepEqual([merged.version, merged.packages[''].version, merged.packages[''].dependencies], ['3.3.0', '3.3.0', { abbrev: '^1.0.0', ms: '^2.0.0' }]);
    assert.equal(`${runGitIn(remoteDir, 'show', 'v3.3.0:npm-shrinkwrap.json')}\n`, createFixtureShrinkwrap('3.3.0'));
  });

  test('--check commits and merges a moved main locally and pushes nothing: no tag, main untouched', () => {
    applyRelease('3.3.0');
    pushChangelogEntry('**A newer entry.** Lands during the run.', 'top');
    const mainBefore = runGitIn(remoteDir, 'rev-parse', 'refs/heads/main');
    const result = runCli('commit-release', '3.3.0', '--check');
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /main moved during the run; the release merges into it\. Nothing pushed \(--check\)/);
    assert.equal(runGitIn(remoteDir, 'rev-parse', 'refs/heads/main'), mainBefore);
    assert.equal(checkHasRemoteTag('v3.3.0'), false);
  });

  test('--check finds a real conflict before anything is published: exit 1, nothing pushed', () => {
    applyRelease('3.3.0');
    pushRewordedReleasedEntry();
    const result = runCli('commit-release', '3.3.0', '--check');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /conflicts in CHANGELOG\.md; nothing is published or pushed\./);
    assert.equal(checkHasRemoteTag('v3.3.0'), false);
  });

  test('--prepare (after the publish) commits, tags and merges a moved main without pushing; the plain push that follows lands it; a re-run finds it pushed', () => {
    applyRelease('3.3.0');
    pushChangelogEntry('**A newer entry.** Lands during the run.', 'top');
    const mainBefore = runGitIn(remoteDir, 'rev-parse', 'refs/heads/main');
    const prepared = runCli('commit-release', '3.3.0', '--prepare');
    assert.equal(prepared.status, 0, `${prepared.stdout}\n${prepared.stderr}`);
    assert.equal(readGithubOutput().isPushed, 'false');
    assert.match(prepared.stdout, /main moved during the run; the release merges into it\. Nothing pushed yet \(--prepare\): push HEAD to main and v3\.3\.0/);
    assert.equal(runGitIn(remoteDir, 'rev-parse', 'refs/heads/main'), mainBefore, 'nothing pushed by --prepare');
    assert.equal(checkHasRemoteTag('v3.3.0'), false);

    // The workflow's push step: plain git, nothing else.
    runGit('push', '-q', '--atomic', 'origin', 'HEAD:refs/heads/main', 'refs/tags/v3.3.0');
    assert.match(runGitIn(remoteDir, 'show', 'refs/heads/main:CHANGELOG.md'), /## Unreleased\n\n\*\*A newer entry\.\*\* Lands during the run\.\n\n## 3\.3\.0 — /);
    assert.equal(runGitIn(remoteDir, 'log', '-1', '--format=%s', 'v3.3.0^{commit}'), 'chore(release): 3.3.0');

    fs.rmSync(githubOutputPath);
    const rerun = runCli('commit-release', '3.3.0', '--prepare');
    assert.equal(rerun.status, 0, `${rerun.stdout}\n${rerun.stderr}`);
    assert.equal(readGithubOutput().isPushed, 'true');
  });

  test('--prepare that hits a real conflict says npm has the version already and how to finish', () => {
    applyRelease('3.3.0');
    pushRewordedReleasedEntry();
    const result = runCli('commit-release', '3.3.0', '--prepare');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /conflicts in CHANGELOG\.md; npm has 3\.3\.0 already and the repository not yet/);
    assert.equal(checkHasRemoteTag('v3.3.0'), false);
    assert.equal(runCli('commit-release', '3.3.0', '--check', '--prepare').status, 1, '--check and --prepare together are refused');
  });

  /** The applied release packed the way npm packs it (its files under `package/`), the checkout back at the tested commit. */
  function packReleaseAside(version: string): { tested: string; tarball: string } {
    commitFile('npm-shrinkwrap.json', createFixtureShrinkwrap('3.2.0'), 'build: the shrinkwrap');
    applyRelease(version);
    const packageDir = path.join(sandboxDir, 'packed', 'package');
    fs.mkdirSync(packageDir, { recursive: true });
    for (const fileName of ['package.json', 'CHANGELOG.md', 'npm-shrinkwrap.json']) fs.copyFileSync(path.join(repoDir, fileName), path.join(packageDir, fileName));
    const tarball = path.join(sandboxDir, `demo-package-${version}.tgz`);
    const packed = spawnSync('tar', ['-czf', tarball, '-C', path.dirname(packageDir), 'package'], { encoding: 'utf8' });
    assert.equal(packed.status, 0, packed.stderr);
    runGit('checkout', '-q', '--', '.');
    return { tested: runGit('rev-parse', 'HEAD'), tarball };
  }

  test('--tarball takes the release files out of the packed package, --base checks them against the tested commit; a re-run after the push finds the tag and pushes nothing', () => {
    const { tested, tarball } = packReleaseAside('3.3.0');
    const released = fs.readFileSync(path.join(sandboxDir, 'packed', 'package', 'npm-shrinkwrap.json'), 'utf8');
    const result = runCli('commit-release', '3.3.0', '--tarball', tarball, '--base', tested);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const releaseCommit = runGitIn(remoteDir, 'rev-parse', 'v3.3.0^{commit}');
    assert.equal(runGitIn(remoteDir, 'rev-parse', `${releaseCommit}^`), tested, 'the tag is the tested commit plus its version bump');
    assert.equal(`${runGitIn(remoteDir, 'show', 'v3.3.0:npm-shrinkwrap.json')}\n`, released);
    assert.match(runGitIn(remoteDir, 'show', 'v3.3.0:package.json'), /"version": "3\.3\.0"/);

    const mainAfter = runGitIn(remoteDir, 'rev-parse', 'refs/heads/main');
    const rerun = runCli('commit-release', '3.3.0', '--tarball', tarball, '--base', tested);
    assert.equal(rerun.status, 0, `${rerun.stdout}\n${rerun.stderr}`);
    assert.match(rerun.stdout, /origin already holds v3\.3\.0 \(a re-run after the push went through\); nothing to push/);
    assert.equal(runGitIn(remoteDir, 'rev-parse', 'refs/heads/main'), mainAfter);
  });

  test('a tag of that version on the remote that is not a release of the tested commit is refused', () => {
    const { tested, tarball } = packReleaseAside('3.3.0');
    runGitIn(otherDir, 'pull', '-q', '--rebase', 'origin', 'main');
    runGitIn(otherDir, 'tag', '-a', 'v3.3.0', '-m', 'v3.3.0');
    runGitIn(otherDir, 'push', '-q', 'origin', 'v3.3.0');
    const result = runCli('commit-release', '3.3.0', '--tarball', tarball, '--base', tested);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /origin already holds v3\.3\.0, on a commit that is not a release of the tested [0-9a-f]{7}; nothing is pushed/);
  });

  test('a tarball of another version, one without a release file, or a checkout that is more than the tested commit plus the bump commits nothing', () => {
    const { tested, tarball } = packReleaseAside('3.3.0');
    const wrongVersion = runCli('commit-release', '3.3.1', '--tarball', tarball, '--base', tested);
    assert.equal(wrongVersion.status, 1);
    assert.match(wrongVersion.stderr, /package\.json carries version 3\.3\.0, not 3\.3\.1: nothing is committed/);

    const incomplete = path.join(sandboxDir, 'incomplete.tgz');
    assert.equal(spawnSync('tar', ['-czf', incomplete, '-C', path.join(sandboxDir, 'packed'), 'package/package.json', 'package/CHANGELOG.md']).status, 0);
    const missingFile = runCli('commit-release', '3.3.0', '--tarball', incomplete, '--base', tested);
    assert.equal(missingFile.status, 1);
    assert.match(missingFile.stderr, /does not hold the release's package\.json, CHANGELOG\.md, npm-shrinkwrap\.json; nothing is committed/);

    runGit('checkout', '-q', '--', '.');
    writeRepoFile('src/bot.ts', 'export const bot = 99;\n');
    const extra = runCli('commit-release', '3.3.0', '--tarball', tarball, '--base', tested);
    assert.equal(extra.status, 1);
    assert.match(extra.stderr, /is not the tested commit [0-9a-f]{7} plus its version bump; nothing is committed/);
    assert.match(extra.stderr, /src\/bot\.ts/);
    assert.equal(runGit('rev-parse', 'HEAD'), tested);
    assert.equal(checkHasRemoteTag('v3.3.0'), false);
  });

  test('a push refused for another reason (nothing to merge) fails at once with the git message', () => {
    applyRelease('3.3.0');
    const hookPath = path.join(remoteDir, 'hooks', 'pre-receive');
    fs.writeFileSync(hookPath, '#!/bin/sh\necho "protected branch" >&2\nexit 1\n', { mode: 0o755 });
    const result = runCli('commit-release', '3.3.0');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /has nothing new to merge; npm has 3\.3\.0 already/);
    assert.match(result.stderr, /protected branch/);
  });

  test('refuses a version that is not X.Y.Z', () => {
    const result = runCli('commit-release', 'next');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Expected a version X\.Y\.Z/);
  });
});
