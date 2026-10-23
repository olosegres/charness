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
import { spawn, spawnSync } from 'node:child_process';
import * as http from 'node:http';
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

let sandboxDir: string;
let repoDir: string;
let homeDir: string;
let githubOutputPath: string;

/** The environment of the CLI under test: no git identity, so the identity the CLI itself sets is what a commit shows. */
function createChildEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
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
    const result = spawnSync(process.execPath, [tsxCliPath, releaseCliPath, 'check-publish'], {
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
      response.writeHead(apiStatus, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ workflow_runs: apiRuns }));
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
      const child = spawn(process.execPath, [tsxCliPath, releaseCliPath, 'test-gate', ...args], {
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

  test('main that keeps moving fails after three attempts and publishes no tag', () => {
    applyRelease('3.3.0');
    installMovingMainHook(99);
    const result = runCli('commit-release', '3.3.0');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /failed 3 times because main kept moving; nothing was published/);
    assert.equal(spawnSync('git', ['rev-parse', '-q', '--verify', 'refs/tags/v3.3.0'], { cwd: remoteDir, encoding: 'utf8' }).status, 1);
  });

  test('a merge conflict fails the run, leaves no merge in progress and no tag on the remote', () => {
    applyRelease('3.3.0');
    // Someone adds an entry at the very spot the release rewrites.
    const changelogPath = path.join(otherDir, 'CHANGELOG.md');
    runGitIn(otherDir, 'pull', '-q', '--rebase', 'origin', 'main');
    fs.writeFileSync(changelogPath, fs.readFileSync(changelogPath, 'utf8').replace('## Unreleased\n', '## Unreleased\n\n**A newer entry.** Lands first.\n'));
    runGitIn(otherDir, 'add', '-A');
    runGitIn(otherDir, 'commit', '-q', '-m', 'docs(changelog): a newer entry');
    runGitIn(otherDir, 'push', '-q', 'origin', 'main');

    const result = runCli('commit-release', '3.3.0');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /merging it into the release v3\.3\.0 conflicts; nothing was published/);
    assert.equal(fs.existsSync(path.join(repoDir, '.git', 'MERGE_HEAD')), false);
    assert.equal(spawnSync('git', ['rev-parse', '-q', '--verify', 'refs/tags/v3.3.0'], { cwd: remoteDir, encoding: 'utf8' }).status, 1);
    assert.equal(runGitIn(remoteDir, 'log', '-1', '--format=%s', 'refs/heads/main'), 'docs(changelog): a newer entry');
  });

  test('a push refused for another reason (nothing to merge) fails at once with the git message', () => {
    applyRelease('3.3.0');
    const hookPath = path.join(remoteDir, 'hooks', 'pre-receive');
    fs.writeFileSync(hookPath, '#!/bin/sh\necho "protected branch" >&2\nexit 1\n', { mode: 0o755 });
    const result = runCli('commit-release', '3.3.0');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /has nothing new to merge; nothing was published/);
    assert.match(result.stderr, /protected branch/);
  });

  test('refuses a version that is not X.Y.Z', () => {
    const result = runCli('commit-release', 'next');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Expected a version X\.Y\.Z/);
  });
});
