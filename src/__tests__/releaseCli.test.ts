/**
 * @description Coverage for `src/release/cli.ts` — the release workflow's wrapper — run as a real process
 * against a throwaway git repository the test builds (commits, an annotated release tag, a CHANGELOG, a
 * package.json). `plan` and `apply` / `changelog` / `notes` are checked by what they print,
 * write to `$GITHUB_OUTPUT` and change on disk. The child runs with its own HOME and git config and never
 * touches the checkout's repository.
 *
 * The CLI is transpiled ONCE per file and every case runs the plain JavaScript with `node`: a `tsx` start costs ~0.35 s
 * of CPU, and ~60 cases starting it summed to most of the file's work — a loaded machine stretched that past the unit
 * runner's per-file limit. Only the `npm version` case starts the CLI through `tsx`, the way the workflow and the
 * `version` script do.
 *
 * The sandbox (the transpiled CLI, the throwaway repository and its helpers) is `releaseCliKit.ts`; `commit-release` is `releaseCliCommit.test.ts`, and `check-pack`, `check-publish`, `verify-delta` and `check-registry` are `releaseCliChecks.test.ts` (split because a file runs under one time limit and one ran 60 s, then 93 s,
 * alone on a loaded box).
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getReleaseDate } from '../release/releasePlan';
import { tsxCliPath, releaseCliPath, lastTag, cliTimeoutMs, initialPackage, initialChangelog, createFixtureShrinkwrap, transpiledCliPath, sandboxDir, repoDir, githubOutputPath, createChildEnv, createGitEnv, runGit, writeRepoFile, commitFile, runCli, readGithubOutput, useReleaseSandbox } from './releaseCliKit';

useReleaseSandbox();

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
