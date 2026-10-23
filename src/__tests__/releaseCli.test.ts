/**
 * @description Coverage for `src/release/cli.ts` — the release workflow's wrapper — run as a real process
 * against a throwaway git repository the test builds (commits, an annotated release tag, a CHANGELOG, a
 * package.json). `plan` and `apply` / `changelog` / `notes` / `check-pack` are checked by what they print,
 * write to `$GITHUB_OUTPUT` and change on disk. The child runs with its own HOME and git config and never
 * touches the checkout's repository.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getReleaseDate } from '../release/releasePlan';

const tsxCliPath = require.resolve('tsx/cli');
const releaseCliPath = path.resolve(__dirname, '..', 'release', 'cli.ts');
const lastTag = 'v3.2.0';
const cliTimeoutMs = 90_000;

const initialPackage = {
  name: 'demo-package',
  version: '3.2.0',
  files: ['dist/', 'stt/gigaam_sidecar.py', 'README.md', 'LICENSE', 'CHANGELOG.md'],
  bin: { charness: './dist/cli.js' },
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

let sandboxDir: string;
let repoDir: string;
let homeDir: string;
let githubOutputPath: string;

function createChildEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: homeDir,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_AUTHOR_NAME: 'Release Test',
    GIT_AUTHOR_EMAIL: 'release-test@example.invalid',
    GIT_COMMITTER_NAME: 'Release Test',
    GIT_COMMITTER_EMAIL: 'release-test@example.invalid',
    npm_config_cache: path.join(homeDir, '.npm'),
    npm_config_update_notifier: 'false',
    GITHUB_OUTPUT: githubOutputPath,
  };
}

function runGit(...args: string[]): string {
  const result = spawnSync('git', args, { cwd: repoDir, env: createChildEnv(), encoding: 'utf8' });
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
  const result = spawnSync(process.execPath, [tsxCliPath, releaseCliPath, ...args], {
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
    writeRepoFile('dist/cli.js', '#!/usr/bin/env node\nprocess.stdout.write(`${require("../package.json").version}\\n`);\n');
    fs.chmodSync(path.join(repoDir, 'dist', 'cli.js'), 0o755);
    writeRepoFile(sidecarPath, '# sidecar\n');
    writeRepoFile('LICENSE', 'MIT\n');
  }

  test('a sound package passes the listing check and installs from its tarball printing the new version', () => {
    writePackableFiles();
    const result = runCli('check-pack', '--version', '3.2.0');
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Package contents ok/);
    assert.match(result.stdout, /charness --version prints 3\.2\.0/);
  });

  test('the version the package prints must be the expected one', () => {
    writePackableFiles();
    const result = runCli('check-pack', '--version', '3.9.9', '--skip-install');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /the package version is 3\.2\.0, expected 3\.9\.9/);
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

    const result = spawnSync('npm', ['version', 'minor'], { cwd: repoDir, env: createChildEnv(), encoding: 'utf8', timeout: cliTimeoutMs });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    assert.equal(runGit('log', '-1', '--format=%s'), 'chore(release): 3.3.0');
    assert.equal(runGit('tag', '--points-at', 'HEAD'), 'v3.3.0');
    assert.deepEqual(runGit('show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['CHANGELOG.md', 'package.json']);
    assert.match(runGit('show', 'HEAD:CHANGELOG.md'), /## Unreleased\n\n## 3\.3\.0 — \d{4}-\d{2}-\d{2}\n\n\*\*A change users see\./);
  });
});
