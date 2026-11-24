/**
 * @description Coverage for `src/release/cli.ts commit-release` — the release workflow's commit step — run as a real process against the throwaway git repository of `releaseCliKit.ts`. The rest of the
 * release CLI is `releaseCli.test.ts` (`plan`, `apply`, `test-gate`, …) and `releaseCliChecks.test.ts` (`check-pack`, …); split because a file runs under one time limit and one ran 60 s alone on a loaded box.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */


import { beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { lastTag, createFixtureShrinkwrap, sandboxDir, repoDir, githubOutputPath, createGitEnv, runGit, writeRepoFile, commitFile, runCli, readGithubOutput, useReleaseSandbox } from './releaseCliKit';

useReleaseSandbox();

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
    assert.deepEqual(readGithubOutput(), { isPushed: 'true' }, 'no `tag` output: the workflow takes the tag from the gate');
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

  describe('the licence\'s fixed-text tag', () => {
    const licenseTag = 'license-2.0';
    const licenseText = `Required Notice: Licensed under the Demo License 2.0: https://github.com/example/demo/blob/${licenseTag}/LICENSE\n\n# Demo License 2.0\n`;

    test('a release whose remote has no licence tag creates it on the release commit and pushes it with main and the v tag', () => {
      commitFile('LICENSE', licenseText, 'docs: the licence');
      applyRelease('3.3.0');
      const result = runCli('commit-release', '3.3.0');
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /Pushed v3\.3\.0 and license-2\.0\./);
      assert.equal(runGitIn(remoteDir, 'rev-parse', `${licenseTag}^{commit}`), runGitIn(remoteDir, 'rev-parse', 'v3.3.0^{commit}'));
      assert.equal(runGitIn(remoteDir, 'show', `${licenseTag}:LICENSE`), licenseText.trimEnd());
    });

    test('--prepare creates the licence tag locally and names it for the push step; a remote tag with this text is left alone', () => {
      commitFile('LICENSE', licenseText, 'docs: the licence');
      applyRelease('3.3.0');
      const prepared = runCli('commit-release', '3.3.0', '--prepare');
      assert.equal(prepared.status, 0, `${prepared.stdout}\n${prepared.stderr}`);
      assert.equal(readGithubOutput().licenseTag, licenseTag);
      assert.match(prepared.stdout, /push HEAD to main and v3\.3\.0 and license-2\.0/);
      assert.equal(checkHasRemoteTag(licenseTag), false, 'nothing pushed by --prepare');
      assert.equal(runGit('rev-parse', `${licenseTag}^{commit}`), runGit('rev-parse', 'v3.3.0^{commit}'));

      // A re-run of the release, the licence tag on GitHub already: back to the tested commit, the same release applied again.
      runGit('push', '-q', 'origin', `refs/tags/${licenseTag}`);
      runGit('tag', '-d', 'v3.3.0');
      runGit('reset', '-q', '--hard', 'HEAD~1');
      assert.equal(runCli('apply', '3.3.0').status, 0);
      fs.rmSync(githubOutputPath);
      const again = runCli('commit-release', '3.3.0', '--prepare');
      assert.equal(again.status, 0, `${again.stdout}\n${again.stderr}`);
      assert.equal(readGithubOutput().licenseTag, '', 'GitHub has the tag with this very text: nothing to push');
    });

    test('a licence tag the remote holds with another text refuses the release before anything is pushed', () => {
      commitFile('LICENSE', `${licenseText}An older clause.\n`, 'docs: the older licence text');
      runGit('tag', licenseTag);
      runGit('push', '-q', 'origin', `refs/tags/${licenseTag}`);
      runGit('tag', '-d', licenseTag);
      commitFile('LICENSE', licenseText, 'docs: the licence changed without a new version');
      applyRelease('3.3.0');
      const result = runCli('commit-release', '3.3.0');
      assert.equal(result.status, 1);
      assert.match(result.stderr, /tag license-2\.0 holds another LICENSE text than this commit: a changed licence needs a new version and a new tag/);
      assert.equal(checkHasRemoteTag('v3.3.0'), false);
    });

    test('prepare-license-tag (a hand-pushed v tag): creates the tag on HEAD when the remote has none, and names nothing once it is there', () => {
      commitFile('LICENSE', licenseText, 'docs: the licence');
      const first = runCli('prepare-license-tag');
      assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
      assert.equal(readGithubOutput().licenseTag, licenseTag);
      assert.equal(runGit('rev-parse', `${licenseTag}^{commit}`), runGit('rev-parse', 'HEAD'));

      runGit('push', '-q', 'origin', `refs/tags/${licenseTag}`);
      fs.rmSync(githubOutputPath);
      const second = runCli('prepare-license-tag');
      assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
      assert.equal(readGithubOutput().licenseTag, '');
    });
  });
});
