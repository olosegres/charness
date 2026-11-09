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
import { jobId, scriptPath, slug, writeFile, removeTestRoot } from './remoteRunRunnerScriptKit';

const isCi = process.env.CI === 'true' || process.env.CI === '1';
const hasRsync = spawnSync('rsync', ['--version'], { stdio: 'ignore' }).status === 0;
const rsyncSkip = !hasRsync && !isCi ? 'rsync is not installed here (CI installs it)' : false;
const jobPollMs = 100;
const jobGiveUpMs = 40_000;
const slowRemovalSec = 5;

let workRoot = '';
let workDir = '';

const secondJobId = 'box1-bbbbbb';

function getPaths(id: string = jobId): { project: string; tree: string; stage: string; jobDir: string } {
  const project = path.join(workDir, 'p', slug);
  return { project, tree: path.join(project, 'tree'), stage: path.join(project, 'stage', id), jobDir: path.join(project, 'jobs', id) };
}

/** The job files the main box writes for `clean-after-success: <patterns>` (`submit.ts`). */
function writeCleanFiles(patterns: readonly string[], roots: readonly string[] = getPathPatternSearchRoots(patterns), id: string = jobId): void {
  const { jobDir } = getPaths(id);
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
  removeTestRoot(workRoot);
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
    writeFile(tree, 'ios/build/Intermediates.noindex/Pods.build/a/b.o');
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

  it('a pattern that names nothing in the copy removes nothing and SAYS so — «removed 0 paths» — so a wrong path is told from a removal that never ran', () => {
    const { tree } = getPaths();
    writeFile(tree, 'src/keep.ts');
    writeCleanFiles(['ios/build/Intermediates.noindex', '**/DerivedData']);
    const outcome = cleanAfterSuccess();
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.equal(outcome.stdout.trim(), 'remote-run: clean-after-success: removed 0 paths of the copy');
    assert.deepEqual(listTree(), ['src/keep.ts']);
  });

  it('read-only folders go the way the prune removes them: the tree is made writable first, and a read-only parent is the last resort', () => {
    const { tree } = getPaths();
    writeFile(tree, 'ios/build/Intermediates.noindex/Pods.build/xcframework/a.h');
    writeFile(tree, 'ios/build/Products/app.txt');
    fs.chmodSync(path.join(tree, 'ios/build/Intermediates.noindex/Pods.build/xcframework'), 0o555);
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

  it('a pattern that goes INTO `.git` (`.git/hooks`, `.git/objects`) removes nothing: the root is dropped, so the repository of the copy keeps its hooks and objects', () => {
    const { tree } = getPaths();
    writeFile(tree, '.git/hooks/pre-commit');
    writeFile(tree, '.git/objects/ab/cdef');
    writeFile(tree, 'vendor/lib/.git/hooks/pre-push');
    writeFile(tree, 'src/keep.ts');
    writeCleanFiles(['.git/hooks', '.git/objects', 'vendor/lib/.git/hooks']);
    const outcome = cleanAfterSuccess();
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.equal(outcome.stdout.trim(), 'remote-run: clean-after-success: removed 0 paths of the copy');
    assert.deepEqual(listTree(), ['.git/hooks/pre-commit', '.git/objects/ab/cdef', 'src/keep.ts', 'vendor/lib/.git/hooks/pre-push']);
  });

  it('`node_modules` and `Pods` are not walked and not cleaned, however a pattern reaches them: `**/build` takes the project\'s build folders and leaves the installed packages\' own', () => {
    const { tree } = getPaths();
    writeFile(tree, 'src/build/o.o');
    writeFile(tree, 'node_modules/pkg/build/index.js');
    writeFile(tree, 'node_modules/@scope/pkg/dist/build/x.js');
    writeFile(tree, 'ios/Pods/Target Support Files/build/y.xcconfig');
    writeFile(tree, 'ios/build/Intermediates.noindex/z.o');
    writeCleanFiles(['**/build']);
    const outcome = cleanAfterSuccess();
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.deepEqual(listTree().filter((entry) => !entry.startsWith('src/') && !entry.startsWith('ios/build')), [
      'ios/Pods/Target Support Files/build/y.xcconfig',
      'node_modules/@scope/pkg/dist/build/x.js',
      'node_modules/pkg/build/index.js',
    ]);
    assert.ok(!fs.existsSync(path.join(tree, 'src/build')) && !fs.existsSync(path.join(tree, 'ios/build')), 'and the project\'s own build folders are gone');
  });

  it('a root inside the dependencies (a job file from an older or a hostile main box) is dropped too — nothing is walked, nothing removed', () => {
    const { tree } = getPaths();
    writeFile(tree, 'node_modules/pkg/build/index.js');
    writeFile(tree, 'ios/Pods/build/y.xcconfig');
    writeCleanFiles(['node_modules/pkg/build', 'ios/Pods/build']);
    const outcome = cleanAfterSuccess();
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.equal(outcome.stdout.trim(), 'remote-run: clean-after-success: removed 0 paths of the copy');
    assert.deepEqual(listTree(), ['ios/Pods/build/y.xcconfig', 'node_modules/pkg/build/index.js']);
  });

  it('a folder a pattern names goes whole — unless it HOLDS a `node_modules` or `Pods` below it (`ios` over `ios/Pods`, `packages/*` over per-package dependencies): then it is kept whole, and the log says so', () => {
    const { tree } = getPaths();
    writeFile(tree, 'ios/Pods/Pod.h');
    writeFile(tree, 'ios/App.xcodeproj/project.pbxproj');
    writeFile(tree, 'packages/x/node_modules/m/index.js');
    writeFile(tree, 'packages/x/src.ts');
    writeFile(tree, 'packages/y/y.ts');
    writeFile(tree, 'tools/gen/g.ts');
    writeCleanFiles(['ios', 'packages/*', 'tools/*']);
    const outcome = cleanAfterSuccess();
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.deepEqual(listTree(), [
      'ios/App.xcodeproj/project.pbxproj',
      'ios/Pods/Pod.h',
      'packages/x/node_modules/m/index.js',
      'packages/x/src.ts',
      'tools/',
    ]);
    for (const kept of ['ios', 'packages/x']) {
      assert.match(outcome.stdout, new RegExp(`^remote-run: clean-after-success: kept ${kept} \\(it holds a node_modules or Pods below it`, 'm'), kept);
    }
    assert.match(outcome.stdout, /^remote-run: clean-after-success: removed 2 paths of the copy$/m, 'packages/y and tools/gen went');
  });

  it('a `.git` below a named folder does NOT keep it: a build tool\'s checkouts (Xcode\'s Swift packages in a derived-data folder) are re-fetched by the next build, so `build` goes whole', () => {
    const { tree } = getPaths();
    writeFile(tree, 'build/SourcePackages/checkouts/p/.git/HEAD');
    writeFile(tree, 'build/SourcePackages/checkouts/p/Package.swift');
    writeFile(tree, 'build/Products/app.txt');
    writeFile(tree, 'src/keep.ts');
    writeCleanFiles(['build']);
    const outcome = cleanAfterSuccess();
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.deepEqual(listTree(), ['src/keep.ts']);
    assert.equal(outcome.stdout.trim(), 'remote-run: clean-after-success: removed 1 path of the copy');
  });

  it('a pattern that names something INSIDE a kept folder still applies there — only the patterns that name the kept folder itself are «kept with it»', () => {
    const { tree } = getPaths();
    writeFile(tree, 'ios/Pods/x');
    writeFile(tree, 'ios/App.swift');
    writeFile(tree, 'ios/build/Intermediates.noindex/o.o');
    writeFile(tree, 'ios/build/Products/app.txt');
    writeCleanFiles(['ios', 'ios/build/Intermediates.noindex']);
    const outcome = cleanAfterSuccess();
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.deepEqual(listTree().filter((entry) => !entry.endsWith('/')), ['ios/App.swift', 'ios/Pods/x', 'ios/build/Products/app.txt']);
    assert.ok(!fs.existsSync(path.join(tree, 'ios/build/Intermediates.noindex')), 'the intermediates the second pattern names are gone');
    assert.match(outcome.stdout, /^remote-run: clean-after-success: kept ios \(/m);
    assert.match(outcome.stdout, /^remote-run: clean-after-success: removed 1 path of the copy$/m);
  });

  it('a keep inside a keep does not end the outer one: `ios` and `ios/vendor` are both kept, and a third pattern still reaches `ios/build/Intermediates.noindex` whatever order the folders are listed in', () => {
    const { tree } = getPaths();
    writeFile(tree, 'ios/Pods/x');
    writeFile(tree, 'ios/vendor/node_modules/m');
    writeFile(tree, 'ios/vendor/v.c');
    writeFile(tree, 'ios/build/Intermediates.noindex/o.o');
    writeFile(tree, 'ios/App.swift');
    writeCleanFiles(['ios', 'ios/vendor', 'ios/build/Intermediates.noindex']);
    const outcome = cleanAfterSuccess();
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.deepEqual(listTree().filter((entry) => !entry.endsWith('/')), ['ios/App.swift', 'ios/Pods/x', 'ios/vendor/node_modules/m', 'ios/vendor/v.c']);
    assert.match(outcome.stdout, /^remote-run: clean-after-success: kept ios \(/m);
    assert.match(outcome.stdout, /^remote-run: clean-after-success: kept ios\/vendor \(/m);
    assert.match(outcome.stdout, /^remote-run: clean-after-success: removed 1 path of the copy$/m);
  });

  it('a `find` that cannot answer the question — an error, or one without `-quit` — keeps the folder: a doubt is never a removal', () => {
    const { tree } = getPaths();
    writeFile(tree, 'build/Products/app.txt');
    writeCleanFiles(['build']);
    // A `find` that fails when it is asked with `-quit` (the look below a matched folder) and works for the walk.
    const outcome = cleanAfterSuccess('find() { case "$*" in *-quit*) return 2 ;; esac; command find "$@"; }');
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.deepEqual(listTree(), ['build/Products/app.txt']);
    assert.match(outcome.stdout, /^remote-run: clean-after-success: kept build \(it could not be searched for a node_modules or Pods below it\)$/m);
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
    assert.equal(outcome.stdout.trim(), 'remote-run: clean-after-success: removed 0 paths of the copy');
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

  it('a name with a newline in it is ONE name: a cut-in-two name cannot make `rm` reach through a link inside the copy to a file outside it', () => {
    const { tree } = getPaths();
    const outside = path.join(workRoot, 'outside');
    writeFile(outside, 'x.o', 'outside the copy');
    fs.mkdirSync(path.join(tree, 'ios/build'), { recursive: true });
    fs.symlinkSync(outside, path.join(tree, 'ios/build/linked'));
    // The folder is called "d", a newline, "ios": listed one path per line this is «d» and «ios/build/linked/x.o» — the real, linked path of the file outside.
    writeFile(tree, 'd\nios/build/linked/x.o', 'the copy\'s own file');
    writeFile(tree, 'src/keep.ts');
    writeCleanFiles(['**/*.o']);
    const outcome = cleanAfterSuccess();
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.ok(fs.existsSync(path.join(outside, 'x.o')), 'the file outside the copy is untouched');
    assert.ok(!fs.existsSync(path.join(tree, 'd\nios/build/linked/x.o')), 'while the copy\'s own file of that odd name, which the pattern does name, is removed as the one name it is');
  });

  it('a root that leaves the copy — `..` or absolute — is refused: nothing outside is looked at, let alone removed', () => {
    const { tree } = getPaths();
    const outside = path.join(workRoot, 'outside');
    writeFile(outside, 'o.o');
    writeFile(tree, 'src/keep.ts');
    writeCleanFiles(['outside'], [path.relative(tree, outside), outside]);
    const outcome = cleanAfterSuccess();
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.equal(outcome.stdout.trim(), 'remote-run: clean-after-success: removed 0 paths of the copy');
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
  function prepareJob(options: { command: string; timeoutSec?: number; clean?: readonly string[]; pull?: readonly string[] }, id: string = jobId): void {
    const paths = getPaths(id);
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
    if (options.clean !== undefined) writeCleanFiles(options.clean, getPathPatternSearchRoots(options.clean), id);
  }

  interface StartedJob {
    /** Resolves when the `runner.sh job` process has ended. */
    ended: Promise<void>;
    /** Kills what is left of its process group. */
    stop: () => void;
  }

  /** `runner.sh job` as Pueue starts it: a process group of its own. */
  function startJob(env: NodeJS.ProcessEnv = {}, id: string = jobId): StartedJob {
    const child = spawn('bash', [scriptPath, 'job', workDir, slug, id], { detached: true, stdio: 'ignore', env: { ...process.env, PUEUE_BIN: '/nonexistent/pueue', ...env } });
    const ended = new Promise<void>((resolve) => child.once('close', () => resolve()));
    const stop = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* ended */
      }
    };
    return { ended, stop };
  }

  /** Runs the job until its process has ended (the exit file is written BEFORE a cleanup after success, which goes on behind it); resolves with the exit file's content. */
  async function runJobUntilItEnds(): Promise<string> {
    const job = startJob();
    let giveUpTimer: NodeJS.Timeout | undefined;
    try {
      const outcome = await Promise.race([job.ended.then(() => 'ended'), new Promise<string>((resolve) => { giveUpTimer = setTimeout(() => resolve('still running'), jobGiveUpMs); })]);
      return outcome === 'ended' ? readJobFile('exit') : outcome;
    } finally {
      clearTimeout(giveUpTimer);
      job.stop();
    }
  }

  function readJobFile(name: string, id: string = jobId): string {
    const filePath = path.join(getPaths(id).jobDir, name);
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8').trim() : '';
  }

  async function waitFor(description: string, check: () => boolean): Promise<void> {
    const startedAt = Date.now();
    while (!check()) {
      if (Date.now() - startedAt > jobGiveUpMs) throw new Error(`${description} did not happen`);
      await new Promise((resolve) => setTimeout(resolve, jobPollMs));
    }
  }

  /** The job is in its removal and its result is written: the state `check_lock_is_stale` and `clean` have to respect. */
  function isRemovalUnderWay(): boolean {
    return readJobFile('phase') === 'cleaning' && readJobFile('exit') === '0';
  }

  /** A folder with a `rm` in front of the real one that takes its time over anything in an `Intermediates.noindex`: a removal that is still going when the test looks. */
  function installSlowRm(): string {
    const folder = path.join(workRoot, 'slow-rm');
    fs.mkdirSync(folder);
    const realRm = spawnSync('which', ['rm'], { encoding: 'utf8' }).stdout.trim();
    fs.writeFileSync(path.join(folder, 'rm'), `#!/bin/sh\ncase "$*" in *Intermediates.noindex*) sleep ${slowRemovalSec} ;; esac\nexec ${realRm} "$@"\n`, { mode: 0o755 });
    return folder;
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
    assert.equal(readJobFile('phase'), 'done');
    assert.equal(fs.existsSync(path.join(paths.project, 'lock')), false, 'and the project lock is released');
  });

  it('the result is final BEFORE the removal begins: a `kill` while it goes on finds the job ended with 0 — it cannot turn a job that worked into 137 — and the lock stays held until the removal is over', { skip: rsyncSkip }, async () => {
    prepareJob({ command: buildCommand, clean: ['build/Intermediates.noindex'] });
    const job = startJob({ PATH: `${installSlowRm()}:${process.env.PATH}` });
    try {
      await waitFor('the job to reach the removal', () => isRemovalUnderWay());
      assert.equal(readJobFile('exit'), '0', 'the result is written already');
      assert.match(readJobLog(), /^remote-run: clean-after-success: removing what the project names from the copy now/m, 'and the log said what is about to go BEFORE that — a foreground run streams the log only up to the result');
      assert.ok(!readJobLog().includes('clean-after-success: removed'), 'while the count is for after the removal');
      assert.ok(fs.existsSync(path.join(getPaths().project, 'lock')), 'and the project lock is still held');
      const killed = spawnSync('bash', [scriptPath, 'kill', workDir, slug, jobId], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, PUEUE_BIN: '/nonexistent/pueue' } });
      assert.equal(killed.stdout.trim(), 'already-ended 0', killed.stderr);
      assert.equal(readJobFile('exit'), '0', 'the kill did not rewrite it');
      assert.ok(fs.existsSync(path.join(getPaths().tree, 'build/Intermediates.noindex')), 'and did not stop the removal: it is still under way');
      await job.ended;
      assert.deepEqual(listTree().filter((entry) => entry.startsWith('build/')), ['build/Products/app.txt'], 'the removal ran to its end');
      assert.equal(readJobFile('exit'), '0');
      assert.equal(readJobFile('phase'), 'done');
      assert.equal(fs.existsSync(path.join(getPaths().project, 'lock')), false, 'and only then was the lock released');
    } finally {
      job.stop();
    }
  });

  it('a second job of the project that is waiting for the lock WAITS through the removal — the result being written does not make the lock stale — and builds on the cleaned tree afterwards', { skip: rsyncSkip }, async () => {
    prepareJob({ command: buildCommand, clean: ['build/Intermediates.noindex'] });
    prepareJob({ command: 'mkdir -p build/Intermediates.noindex && echo fresh > build/Intermediates.noindex/fresh.o' }, secondJobId);
    const first = startJob({ PATH: `${installSlowRm()}:${process.env.PATH}` });
    let second: StartedJob | null = null;
    try {
      await waitFor('the first job to reach the removal', () => isRemovalUnderWay());
      second = startJob({}, secondJobId);
      await waitFor('the second job to queue behind the lock', () => readJobFile('phase', secondJobId) === 'waiting-lock');
      // Several polls of the lock (once a second) while the removal is still under way: the second job must not break the lock and start its build on the tree being emptied.
      const watchUntil = Date.now() + (slowRemovalSec - 2) * 1000;
      while (Date.now() < watchUntil) {
        assert.equal(readJobFile('phase', secondJobId), 'waiting-lock', 'the second job is still behind the lock');
        assert.equal(readJobFile('phase'), 'cleaning', 'while the first is removing');
        await new Promise((resolve) => setTimeout(resolve, jobPollMs));
      }
      await first.ended;
      await second.ended;
      assert.equal(readJobFile('exit', secondJobId), '0');
      assert.equal(fs.readFileSync(path.join(getPaths().tree, 'build/Intermediates.noindex/fresh.o'), 'utf8'), 'fresh\n', 'what the second job built after the removal is there — the removal did not take it');
      assert.ok(!fs.existsSync(path.join(getPaths().tree, 'build/Intermediates.noindex/o.o')), 'and the first job\'s intermediates are gone');
    } finally {
      first.stop();
      second?.stop();
    }
  });

  it('`clean` while the removal goes on — the results already fetched, so only the lock speaks — is refused with the lock: the copy is not taken from under the removal', { skip: rsyncSkip }, async () => {
    prepareJob({ command: buildCommand, clean: ['build/Intermediates.noindex'] });
    const job = startJob({ PATH: `${installSlowRm()}:${process.env.PATH}` });
    try {
      await waitFor('the job to reach the removal', () => isRemovalUnderWay());
      const env = { ...process.env, PUEUE_BIN: '/nonexistent/pueue' };
      assert.equal(spawnSync('bash', [scriptPath, 'fetched', workDir, '-', jobId], { env, timeout: 60_000 }).status, 0);
      const cleaned = spawnSync('bash', [scriptPath, 'clean', workDir, slug], { encoding: 'utf8', env, timeout: 60_000 });
      assert.match(cleaned.stdout, new RegExp(`^busy=${slug} kind=lock job=${jobId}$`, 'm'), `${cleaned.stdout}${cleaned.stderr}`);
      assert.ok(fs.existsSync(getPaths().tree), 'the copy is still there');
      await job.ended;
      assert.equal(readJobFile('phase'), 'done');
      assert.deepEqual(listTree().filter((entry) => entry.startsWith('build/')), ['build/Products/app.txt']);
    } finally {
      job.stop();
    }
  });

  it('a job that failed (exit 3) cleans nothing: its copy is what a person looks at to find out why', { skip: rsyncSkip }, async () => {
    prepareJob({ command: `${buildCommand} && exit 3`, clean: ['build/Intermediates.noindex'] });
    assert.equal(await runJobUntilItEnds(), '3');
    assert.deepEqual(listTree().filter((entry) => entry.startsWith('build/')), ['build/Intermediates.noindex/o.o', 'build/Products/app.txt']);
    assert.ok(!readJobLog().includes('clean-after-success'));
  });

  it('a job that ran out of time (124) cleans nothing', { skip: rsyncSkip }, async () => {
    // The limit counts from the job's start, so it must outlast the job's own start-up on a loaded box (a job told to stop before its command is forked never starts it, and then there is no build output to keep).
    prepareJob({ command: `${buildCommand} && sleep 120`, timeoutSec: 10, clean: ['build/Intermediates.noindex'] });
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
