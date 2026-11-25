/**
 * @description Coverage for the checks of `src/release/cli.ts` — `check-pack` (the tarball `npm pack` builds), `check-publish` (what `npm publish` says about the manifest), `verify-delta` and `check-registry` —
 * run as real processes against the throwaway git repository of `releaseCliKit.ts`. The rest of the release CLI (`plan`, `apply`, `test-gate`, the manual `npm version` path) is `releaseCli.test.ts` and
 * `commit-release` is `releaseCliCommit.test.ts`; split because a file runs under one time limit and one ran 93 s alone on a loaded box.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cliTimeoutMs, initialPackage, initialChangelog, pinnedDependency, createFixtureShrinkwrap, transpiledCliPath, sandboxDir, repoDir, homeDir, createChildEnv, createGitEnv, runGit, writeRepoFile, commitFile, runCli, useReleaseSandbox } from './releaseCliKit';

useReleaseSandbox();

describe('check-pack', () => {
  const sidecarPath = 'stt/gigaam_sidecar.py';

  function writePackableFiles(): void {
    writeRepoFile('package.json', `${JSON.stringify({ ...initialPackage, files: [...initialPackage.files, 'npm-shrinkwrap.json'], dependencies: { [pinnedDependency.name]: pinnedDependency.range } }, null, 2)}\n`);
    writeRepoFile('npm-shrinkwrap.json', createFixtureShrinkwrap(initialPackage.version));
    writeRepoFile('dist/cli.js', '#!/usr/bin/env node\nprocess.stdout.write(`${require("../package.json").version}\\n`);\n');
    fs.chmodSync(path.join(repoDir, 'dist', 'cli.js'), 0o755);
    writeRepoFile(sidecarPath, '# sidecar\n');
    // The lock the hub gives its runners (`runners/runnerLock.ts`): a package without it cannot pair a machine.
    writeRepoFile('runner-scripts/runner-package-lock.json', '{}\n');
    writeRepoFile('runner-scripts/ensureNode.sh', '#!/bin/sh\n');
    // The skills the bot gives its agents; the manifest sits in a dot-folder npm must still pack.
    writeRepoFile('agent-plugin/.claude-plugin/plugin.json', '{ "name": "charness" }\n');
    writeRepoFile('agent-plugin/skills/charness-orchestration/SKILL.md', '---\nname: charness-orchestration\ndescription: d\n---\n');
    writeRepoFile('LICENSE', 'MIT\n');
    writeRepoFile('licensing.json', '{}\n');
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

describe('check-registry', () => {
  let registryServer: http.Server;
  let registryUrl: string;
  let registryRequests: { url: string; accept: string | undefined }[];
  let registryAnswer: { status: number; versions: string[] };
  /** How many requests get a 503 before the registry answers with {@link registryAnswer}. */
  let registryFailuresBeforeAnswer: number;

  beforeEach(async () => {
    registryRequests = [];
    registryAnswer = { status: 200, versions: [] };
    registryFailuresBeforeAnswer = 0;
    registryServer = http.createServer((request, response) => {
      registryRequests.push({ url: request.url ?? '', accept: request.headers.accept });
      const status = registryRequests.length <= registryFailuresBeforeAnswer ? 503 : registryAnswer.status;
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(status === 200 ? { name: initialPackage.name, versions: Object.fromEntries(registryAnswer.versions.map((version) => [version, { version }])) } : { error: 'Not found' }));
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
    assert.match(result.stderr, /Re-run failed jobs/);
    assert.match(result.stderr, /A version with no release run \(published by hand, or its tag only on another remote\): push its vX\.Y\.Z tag to GitHub\. Nothing is published or pushed\./);
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

  test('a registry that answers 503 is read again after a pause, and the next answer decides', async () => {
    registryFailuresBeforeAnswer = 1;
    registryAnswer = { status: 200, versions: ['3.2.0', '3.2.1'] };
    const result = await runRegistryCheck('3.3.0');
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /npm holds demo-package 3\.2\.1/);
    assert.equal(registryRequests.length, 2);
    assert.match(result.stdout, /The registry could not be read \(the registry answered 503\); trying again in 1 s\./);
  });

  test('a registry that cannot be read after three tries stops the run; a refusal that is not transient (403) is not read again', async () => {
    registryAnswer = { status: 500, versions: [] };
    const result = await runRegistryCheck('3.3.0');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Cannot read the versions the registry holds of demo-package: the registry answered 500 \(3 tries\); nothing is published\./);
    assert.equal(registryRequests.length, 3);

    registryRequests = [];
    registryAnswer = { status: 403, versions: [] };
    const forbidden = await runRegistryCheck('3.3.0');
    assert.equal(forbidden.status, 1);
    assert.match(forbidden.stderr, /the registry answered 403; nothing is published\./);
    assert.equal(registryRequests.length, 1);
  });

  test('a tag that npm never got does not hide the unfinished version below it on the next run', async () => {
    commitFile('src/bot.ts', 'export const bot = 2;\n', 'fix: a');
    runGit('tag', '-a', 'v3.3.0', '-m', 'v3.3.0');
    registryAnswer = { status: 200, versions: ['3.2.0', '3.2.1'] };
    const result = await runRegistryCheck('3.3.1');
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /npm holds demo-package 3\.2\.1/);
  });
});

describe('check-license-tag', () => {
  const licenseTag = 'license-2.0';
  const licenseText = `Required Notice: Licensed under the Demo License 2.0: https://github.com/example/demo/blob/${licenseTag}/LICENSE\n\n# Demo License 2.0\n`;
  let remoteDir: string;

  beforeEach(() => {
    remoteDir = path.join(sandboxDir, 'license-remote.git');
    const init = spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remoteDir], { env: createGitEnv(), encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    runGit('remote', 'add', 'origin', remoteDir);
    commitFile('LICENSE', licenseText, 'docs: the licence');
  });

  test('a tag the notice names that the remote does not have yet passes: the release creates it', () => {
    const result = runCli('check-license-tag');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /origin has no tag license-2\.0 yet; the release creates it on the release commit and pushes it/);
  });

  test('a notice that names a branch is refused', () => {
    commitFile('LICENSE', licenseText.replace(`blob/${licenseTag}/`, 'blob/main/'), 'docs: a moving licence link');
    const result = runCli('check-license-tag');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /names "main", not a tag of the form license-<version>/);
  });

  test('the tag on the remote with this LICENSE passes; a LICENSE changed after the tag is refused', () => {
    runGit('tag', licenseTag);
    runGit('push', '-q', 'origin', licenseTag);
    runGit('tag', '-d', licenseTag);
    const passing = runCli('check-license-tag');
    assert.equal(passing.status, 0, passing.stderr);
    assert.match(passing.stdout, /tag license-2\.0 on origin holds this very text/);

    commitFile('LICENSE', `${licenseText}A changed clause.\n`, 'docs: change the licence');
    const changed = runCli('check-license-tag');
    assert.equal(changed.status, 1);
    assert.match(changed.stderr, /tag license-2\.0 holds another LICENSE text than this commit/);
  });
});
