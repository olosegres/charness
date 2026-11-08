/**
 * @description `remoteRun/runner.sh` — what it removes from a project copy after a job that SUCCEEDED, because the project's `.remote-run` says so (`clean-after-success:`; off unless it does): `clean_after_success`
 * on its own (a folder goes whole, a glob names several, a read-only folder and a link are handled, `.git` is never entered, a root that leaves the copy is refused, a removal that fails is said and does not stop the
 * rest), and `runner.sh job` end to end (only an exit code 0 cleans, after the files the job's `pull:` names were collected, off without the setting).
 *
 * The patterns reach the script the way the main box sends them: compiled by `pathPatterns.ts` into the job's `clean-after-success.ere` / `.roots`.
 *
 * rsync is needed for the job runs (the apply step): a local run without it is SKIPPED with the reason, CI installs it and fails without. Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { compilePathPatterns, getPathPatternSearchRoots } from '../remoteRun/pathPatterns';
import { jobId, scriptPath, slug, writeFile } from './remoteRunRunnerScriptKit';

const isCi = process.env.CI === 'true' || process.env.CI === '1';
const hasRsync = spawnSync('rsync', ['--version'], { stdio: 'ignore' }).status === 0;
const rsyncSkip = !hasRsync && !isCi ? 'rsync is not installed here (CI installs it)' : false;
const jobPollMs = 100;
const jobGiveUpMs = 40_000;

let workRoot = '';
let workDir = '';

function getPaths(): { project: string; tree: string; stage: string; jobDir: string } {
  const project = path.join(workDir, 'p', slug);
  return { project, tree: path.join(project, 'tree'), stage: path.join(project, 'stage', jobId), jobDir: path.join(project, 'jobs', jobId) };
}

/** The job files the main box writes for `clean-after-success: <patterns>` (`submit.ts`). */
function writeCleanFiles(patterns: readonly string[], roots: readonly string[] = getPathPatternSearchRoots(patterns)): void {
  const { jobDir } = getPaths();
  writeFile(jobDir, 'clean-after-success.ere', compilePathPatterns(patterns).map((expression) => `${expression}\n`).join(''));
  writeFile(jobDir, 'clean-after-success.roots', roots.map((root) => `${root}\n`).join(''));
}

/** Every file and link under the copy, relative to it (folders only when empty), sorted. */
function listTree(): string[] {
  const { tree } = getPaths();
  const found: string[] = [];
  const visit = (directory: string): void => {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    if (entries.length === 0 && directory !== tree) found.push(`${path.relative(tree, directory)}/`);
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else found.push(path.relative(tree, entryPath));
    }
  };
  visit(tree);
  return found.sort();
}

beforeEach(() => {
  workRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-script-clean-after-')));
  workDir = path.join(workRoot, 'work');
  fs.mkdirSync(workDir);
  fs.mkdirSync(getPaths().jobDir, { recursive: true });
  fs.mkdirSync(getPaths().tree, { recursive: true });
});
afterEach(() => {
  // A case may leave a read-only folder behind (a failed assertion): `rm` would stop at it.
  spawnSync('chmod', ['-R', 'u+rwX', workRoot]);
  fs.rmSync(workRoot, { recursive: true, force: true });
});

describe('clean_after_success', () => {
  /** `clean_after_success` for the job, as a sourced function (`prelude` first: a stand-in for a command, say). `--norc`, no stdin: see the collect_artifacts tests. */
  function cleanAfterSuccess(prelude = 'true'): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync('bash', ['--norc', '--noprofile', '-c', `source ${scriptPath}; set_paths ${workDir} ${slug} ${jobId}; ${prelude}; clean_after_success`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it('removes what the patterns name — a folder whole, a glob for several — and leaves everything else of the copy', () => {
    const { tree } = getPaths();
    writeFile(tree, 'ios/build/Intermediates.noindex/Pods/a/b.o');
    writeFile(tree, 'ios/build/Products/app.txt');
    writeFile(tree, 'projects/one/ios/build/Debug-iphonesimulator/Intermediates.noindex/x.o');
    writeFile(tree, 'projects/two/ios/build/Intermediates.noindex/y.o');
    writeFile(tree, 'projects/one/ios/build/Release/Products/z.txt');
    writeFile(tree, 'projects/one/ios/src/Intermediates.noindex/keep.txt');
    writeFile(tree, 'src/keep.ts');
    writeFile(tree, 'node_modules/pkg/index.js');
    writeCleanFiles(['ios/build/Intermediates.noindex', 'projects/*/ios/build/**/Intermediates.noindex']);
    const outcome = cleanAfterSuccess();
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.deepEqual(listTree(), [
      'ios/build/Products/app.txt',
      'node_modules/pkg/index.js',
      'projects/one/ios/build/Debug-iphonesimulator/',
      'projects/one/ios/build/Release/Products/z.txt',
      'projects/one/ios/src/Intermediates.noindex/keep.txt',
      'projects/two/ios/build/',
      'src/keep.ts',
    ]);
    assert.match(outcome.stdout, /^remote-run: clean-after-success: removed 3 paths of the copy$/m, 'and says how many went: the folders, not the files in them');
  });

  it('with no setting — no files, or none that name a pattern — nothing is removed and nothing is said', () => {
    const { tree, jobDir } = getPaths();
    writeFile(tree, 'ios/build/Intermediates.noindex/a.o');
    const none = cleanAfterSuccess();
    assert.equal(none.status, 0, none.stderr);
    assert.equal(none.stdout, '');
    writeFile(jobDir, 'clean-after-success.ere', '');
    writeFile(jobDir, 'clean-after-success.roots', '');
    const empty = cleanAfterSuccess();
    assert.equal(empty.status, 0, empty.stderr);
    assert.equal(empty.stdout, '');
    assert.deepEqual(listTree(), ['ios/build/Intermediates.noindex/a.o']);
  });

  it('a pattern that names nothing in the copy removes nothing and says nothing', () => {
    const { tree } = getPaths();
    writeFile(tree, 'src/keep.ts');
    writeCleanFiles(['ios/build/Intermediates.noindex', '**/DerivedData']);
    const outcome = cleanAfterSuccess();
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.equal(outcome.stdout, '');
    assert.deepEqual(listTree(), ['src/keep.ts']);
  });

  it('read-only folders go the way the prune removes them: the tree is made writable first, and a read-only parent is the last resort', () => {
    const { tree } = getPaths();
    writeFile(tree, 'ios/build/Intermediates.noindex/Pods/xcframework/a.h');
    writeFile(tree, 'ios/build/Products/app.txt');
    fs.chmodSync(path.join(tree, 'ios/build/Intermediates.noindex/Pods/xcframework'), 0o555);
    fs.chmodSync(path.join(tree, 'ios/build/Intermediates.noindex'), 0o555);
    fs.chmodSync(path.join(tree, 'ios/build'), 0o555);
    writeCleanFiles(['ios/build/Intermediates.noindex']);
    const outcome = cleanAfterSuccess();
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.deepEqual(listTree(), ['ios/build/Products/app.txt']);
    assert.match(outcome.stdout, /removed 1 path of the copy/);
  });

  it('never enters a `.git`: what a pattern would name inside one stays, wherever the `.git` is', () => {
    const { tree } = getPaths();
    writeFile(tree, '.git/Intermediates.noindex/head');
    writeFile(tree, 'vendor/lib/.git/Intermediates.noindex/head');
    writeFile(tree, 'vendor/lib/Intermediates.noindex/o.o');
    writeCleanFiles(['**/Intermediates.noindex']);
    assert.equal(cleanAfterSuccess().status, 0);
    assert.deepEqual(listTree(), ['.git/Intermediates.noindex/head', 'vendor/lib/.git/Intermediates.noindex/head']);
  });

  it('a link that a pattern names goes as the link — what it points at is never touched — and a link to a folder is not walked into', () => {
    const { tree } = getPaths();
    const outside = path.join(workRoot, 'outside');
    writeFile(outside, 'data/o.o', 'outside the copy');
    writeFile(outside, 'Intermediates.noindex/precious.txt', 'outside the copy');
    // Read-only, as the prune's `chmod -R u+rwX` would have made it writable if it followed the link.
    fs.chmodSync(path.join(outside, 'data'), 0o555);
    writeFile(tree, 'ios/build/Products/app.txt');
    fs.symlinkSync(path.join(outside, 'data'), path.join(tree, 'ios/build/Intermediates.noindex'));
    fs.symlinkSync(outside, path.join(tree, 'linked'));
    writeCleanFiles(['**/Intermediates.noindex']);
    const outcome = cleanAfterSuccess();
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.deepEqual(listTree(), ['ios/build/Products/app.txt', 'linked']);
    assert.ok(fs.existsSync(path.join(outside, 'data/o.o')), 'the target of the removed link is intact');
    assert.equal(fs.statSync(path.join(outside, 'data')).mode & 0o777, 0o555, 'and its permissions were not touched');
    assert.ok(fs.existsSync(path.join(outside, 'Intermediates.noindex/precious.txt')), 'nothing was removed through the link to the outside');
  });

  it('a root that is a link, or is reached through one, is skipped: the walk never starts there', () => {
    const { tree } = getPaths();
    const outside = path.join(workRoot, 'outside');
    writeFile(outside, 'data/o.o', 'outside the copy');
    writeFile(outside, 'Intermediates.noindex/precious.txt', 'outside the copy');
    fs.symlinkSync(path.join(outside, 'data'), path.join(tree, 'Intermediates.noindex'));
    fs.symlinkSync(outside, path.join(tree, 'linked'));
    writeCleanFiles(['Intermediates.noindex', 'linked/Intermediates.noindex']);
    const outcome = cleanAfterSuccess();
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.equal(outcome.stdout, '');
    assert.deepEqual(listTree(), ['Intermediates.noindex', 'linked']);
    assert.ok(fs.existsSync(path.join(outside, 'data/o.o')));
    assert.ok(fs.existsSync(path.join(outside, 'Intermediates.noindex/precious.txt')));
  });

  it('a name with a newline in it cannot make the script remove something outside the copy: find\'s listing is one path per line, and a cut-in-two name must not read as `../victim`', () => {
    const { tree, project } = getPaths();
    writeFile(project, 'victim', 'next to the copy, not in it');
    writeFile(tree, 'd1\n../victim');
    writeFile(tree, 'src/keep.ts');
    writeCleanFiles(['**/victim']);
    const outcome = cleanAfterSuccess();
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.ok(fs.existsSync(path.join(project, 'victim')), 'what lies beside the copy is untouched');
  });

  it('a root that leaves the copy — `..` or absolute — is refused: nothing outside is looked at, let alone removed', () => {
    const { tree } = getPaths();
    const outside = path.join(workRoot, 'outside');
    writeFile(outside, 'o.o');
    writeFile(tree, 'src/keep.ts');
    writeCleanFiles(['outside'], [path.relative(tree, outside), outside]);
    const outcome = cleanAfterSuccess();
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.equal(outcome.stdout, '');
    assert.ok(fs.existsSync(path.join(outside, 'o.o')));
    assert.deepEqual(listTree(), ['src/keep.ts']);
  });

  it('a removal that does not work is said by name and the rest still goes; the job is not touched (exit 0)', () => {
    const { tree } = getPaths();
    writeFile(tree, 'a/Intermediates.noindex/o.o');
    writeFile(tree, 'b/Intermediates.noindex/o.o');
    writeCleanFiles(['**/Intermediates.noindex']);
    // `rm` that does nothing for the folder under a/ (the stand-in for a folder that will not go), the real one for the rest.
    const outcome = cleanAfterSuccess('rm() { case "$*" in *"/a/Intermediates"*) return 0 ;; esac; command rm "$@"; }');
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.match(outcome.stdout, /^remote-run: clean-after-success: could not remove a\/Intermediates\.noindex$/m);
    assert.match(outcome.stdout, /^remote-run: clean-after-success: removed 1 path of the copy$/m);
    assert.deepEqual(listTree(), ['a/Intermediates.noindex/o.o', 'b/']);
  });
});

describe('a job that ends (runner.sh job)', () => {
  const buildCommand = 'mkdir -p build/Intermediates.noindex build/Products && echo object > build/Intermediates.noindex/o.o && echo app > build/Products/app.txt';

  /** A job folder as `prepare` + `submit` leave it, ready for `runner.sh job` to run directly (as Pueue would). */
  function prepareJob(options: { command: string; timeoutSec?: number; clean?: readonly string[]; pull?: readonly string[] }): void {
    const paths = getPaths();
    fs.mkdirSync(paths.stage, { recursive: true });
    writeFile(paths.stage, 'a.txt');
    writeFile(paths.jobDir, 'manifest', 'a.txt\n');
    writeFile(paths.jobDir, 'subfolder', '');
    writeFile(paths.jobDir, 'cmd', options.command);
    writeFile(paths.jobDir, 'timeout-sec', `${options.timeoutSec ?? 120}`);
    writeFile(paths.jobDir, 'task-id', '1\n');
    writeFile(paths.jobDir, 'queued-at', `${Math.floor(Date.now() / 1000)}\n`);
    if (options.pull !== undefined) {
      writeFile(paths.jobDir, 'pull.ere', compilePathPatterns(options.pull).map((expression) => `${expression}\n`).join(''));
      writeFile(paths.jobDir, 'pull.roots', getPathPatternSearchRoots(options.pull).map((root) => `${root}\n`).join(''));
    }
    if (options.clean !== undefined) writeCleanFiles(options.clean);
  }

  /** `runner.sh job` as Pueue starts it: a process group of its own. Resolves with the exit file's content. */
  async function runJobUntilItEnds(): Promise<string> {
    const startedAt = Date.now();
    const child = spawn('bash', [scriptPath, 'job', workDir, slug, jobId], { detached: true, stdio: 'ignore', env: { ...process.env, PUEUE_BIN: '/nonexistent/pueue' } });
    const exitPath = path.join(getPaths().jobDir, 'exit');
    try {
      while (Date.now() - startedAt < jobGiveUpMs) {
        if (fs.existsSync(exitPath)) return fs.readFileSync(exitPath, 'utf8').trim();
        await new Promise((resolve) => setTimeout(resolve, jobPollMs));
      }
      return 'still running';
    } finally {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* ended */
        }
      }
    }
  }

  function readJobLog(): string {
    return fs.readFileSync(path.join(getPaths().jobDir, 'log'), 'utf8');
  }

  it('a job that succeeded: the files its `pull:` names are collected FIRST, then what `clean-after-success:` names is removed — in the same folder, if it comes to that', { skip: rsyncSkip }, async () => {
    prepareJob({ command: buildCommand, clean: ['build/Intermediates.noindex'], pull: ['build/Intermediates.noindex/o.o'] });
    assert.equal(await runJobUntilItEnds(), '0');
    const paths = getPaths();
    assert.deepEqual(listTree().filter((entry) => entry.startsWith('build/')), ['build/Products/app.txt'], 'the build products stay, the intermediates are gone');
    assert.equal(fs.readFileSync(path.join(paths.jobDir, 'artifacts', 'build/Intermediates.noindex/o.o'), 'utf8'), 'object\n', 'and the file the job was to bring back was kept before it went');
    assert.match(readJobLog(), /remote-run: clean-after-success: removed 1 path of the copy/);
    assert.equal(fs.readFileSync(path.join(paths.jobDir, 'phase'), 'utf8').trim(), 'done');
  });

  it('a job that failed (exit 3) cleans nothing: its copy is what a person looks at to find out why', { skip: rsyncSkip }, async () => {
    prepareJob({ command: `${buildCommand} && exit 3`, clean: ['build/Intermediates.noindex'] });
    assert.equal(await runJobUntilItEnds(), '3');
    assert.deepEqual(listTree().filter((entry) => entry.startsWith('build/')), ['build/Intermediates.noindex/o.o', 'build/Products/app.txt']);
    assert.ok(!readJobLog().includes('clean-after-success'));
  });

  it('a job that ran out of time (124) cleans nothing', { skip: rsyncSkip }, async () => {
    prepareJob({ command: `${buildCommand} && sleep 120`, timeoutSec: 3, clean: ['build/Intermediates.noindex'] });
    assert.equal(await runJobUntilItEnds(), '124');
    assert.deepEqual(listTree().filter((entry) => entry.startsWith('build/')), ['build/Intermediates.noindex/o.o', 'build/Products/app.txt']);
  });

  it('a job of a project that did not ask for it (no setting, or an older main box that sends none) cleans nothing — the default is off', { skip: rsyncSkip }, async () => {
    prepareJob({ command: buildCommand });
    assert.equal(await runJobUntilItEnds(), '0');
    assert.deepEqual(listTree().filter((entry) => entry.startsWith('build/')), ['build/Intermediates.noindex/o.o', 'build/Products/app.txt']);
    assert.ok(!readJobLog().includes('clean-after-success'));
  });
});
