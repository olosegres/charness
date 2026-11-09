/**
 * @description `remoteRun/runner.sh`, the first job of a NEW project copy: its dependencies are carried over from a sibling copy of the same project (`seed_new_copy`) instead of being installed from scratch — run against the real
 * script (`runner.sh job`, as Pueue starts it) and real folders. What these pin: which sibling is taken (the same install key first, then the most recently used; never another project's, never a copy whose project lock is held — a
 * job of it may be in its dependencies step — nor one an `exec` runs in), what is carried (every top-level `node_modules`, `ios/Pods`; never the build output, never a workspace the new revision lacks), that the dependencies step
 * is skipped ONLY when the keys are equal, that a seed which fails leaves nothing behind and the job installs as before, and that a copy which has run before is never seeded. A Mac's `cp -c` is checked by its command line (the Linux
 * box has no clonefile).
 *
 * rsync is needed for the jobs (the apply step): a local run without it is SKIPPED with the reason, CI installs it and fails without.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { checkIsRsyncAvailable, createRunnerState, getRunEnvironment, runJob, startJob, waitUntil, type JobOutcome, type JobSpec, type RunnerState } from './remoteRunRunnerJobKit';
import { scriptPath, startRunnerStandIn, startStrangerProcess, stopRunnerStandIns, writeFile } from './remoteRunRunnerScriptKit';

const isCi = process.env.CI === 'true' || process.env.CI === '1';
const rsyncSkip = !checkIsRsyncAvailable() && !isCi ? 'rsync is not installed here (CI installs it)' : false;
const hourMs = 3600 * 1000;
const dayMs = 24 * hourMs;
const siblingSlug = 'app-aaaaaaaaaa';
const otherSiblingSlug = 'app-cccccccccc';
const newSlug = 'app-bbbbbbbbbb';

let root = '';
let state: RunnerState;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seed-')));
  state = createRunnerState(root, null);
});
afterEach(() => {
  stopRunnerStandIns();
  fs.rmSync(root, { recursive: true, force: true });
});

const installRunsFile = (): string => path.join(root, 'install-runs');
const countInstallRuns = (): number => (fs.existsSync(installRunsFile()) ? fs.readFileSync(installRunsFile(), 'utf8').split('\n').filter((line) => line !== '').length : 0);
const copyDir = (slugName: string): string => path.join(state.workDir, 'p', slugName);
const treePath = (slugName: string, relativePath: string): string => path.join(copyDir(slugName), 'tree', relativePath);
const readTreeFile = (slugName: string, relativePath: string): string | null => (fs.existsSync(treePath(slugName, relativePath)) ? fs.readFileSync(treePath(slugName, relativePath), 'utf8') : null);
const readDepsHash = (slugName: string): string | null => (fs.existsSync(path.join(copyDir(slugName), 'deps.hash')) ? fs.readFileSync(path.join(copyDir(slugName), 'deps.hash'), 'utf8').trim() : null);

/** What a finished copy of a React-Native-like monorepo holds: the dependency folders to carry, the build output not to carry, a workspace the new revision does not have, and a source file. */
function createSiblingFiles(slugName: string): Record<string, string> {
  return {
    'node_modules/pkg/index.js': `root of ${slugName}`,
    'node_modules/pkg/android/build/outputs/app.aar': 'gradle output',
    'node_modules/pkg/android/.cxx/cache.txt': 'cmake cache',
    'node_modules/pkg/.gradle/state.bin': 'gradle state',
    'node_modules/inner/node_modules/deep/index.js': 'nested',
    'projects/x/node_modules/dep/index.js': `workspace of ${slugName}`,
    'projects/x/ios/Pods/Pod/pod.h': 'pod',
    'projects/x/ios/build/Products/app.txt': 'derived data',
    'projects/x/android/build/out.txt': 'gradle output',
    'projects/y/node_modules/gone/index.js': 'workspace the new revision does not have',
    '.gradle/cache.bin': 'gradle cache',
    'src/code.ts': 'the sibling\'s own source',
  };
}

/** A copy that has run before: files in its tree, a manifest, the key its dependencies step finished with, and a mark of use `usedAgoMs` ago. */
function createSiblingCopy(slugName: string, options: { key?: string; usedAgoMs?: number; files?: Record<string, string> } = {}): void {
  const files = options.files ?? createSiblingFiles(slugName);
  for (const [relativePath, content] of Object.entries(files)) writeFile(path.join(copyDir(slugName), 'tree'), relativePath, content);
  writeFile(copyDir(slugName), 'manifest', 'src/code.ts\n');
  if (options.key !== undefined) writeFile(copyDir(slugName), 'deps.hash', `${options.key}\n`);
  writeFile(copyDir(slugName), 'used', '');
  const usedAt = new Date(Date.now() - (options.usedAgoMs ?? hourMs));
  fs.utimesSync(path.join(copyDir(slugName), 'used'), usedAt, usedAt);
}

/** The first job of a new copy; its dependencies step counts its runs in `install-runs`. */
function newCopyJob(extra: Partial<JobSpec> = {}): JobSpec {
  return { slug: newSlug, jobId: 'box1-nnnnnn', command: 'true', installCommand: `echo ran >> '${installRunsFile()}'`, installKey: 'key', stagedFiles: ['projects/x/package.json', 'projects/x/ios/Podfile'], ...extra };
}

function runNewCopyJob(extra: Partial<JobSpec> = {}, env: NodeJS.ProcessEnv = {}): JobOutcome {
  const outcome = runJob(state.workDir, newCopyJob(extra), env);
  assert.equal(outcome.exit, '0', outcome.log);
  return outcome;
}

/** A folder to put first on the PATH with `tools` (name → script text) in it. */
function createToolStubs(tools: Record<string, string>): string {
  const binDir = path.join(root, 'stub-bin');
  fs.mkdirSync(binDir, { recursive: true });
  for (const [name, script] of Object.entries(tools)) fs.writeFileSync(path.join(binDir, name), `#!/bin/bash\n${script}\n`, { mode: 0o755 });
  return binDir;
}

const getRealTool = (name: string): string => spawnSync('which', [name], { encoding: 'utf8' }).stdout.trim();

describe('a new copy is seeded from a sibling copy of the same project', { skip: rsyncSkip }, () => {
  it('with the same install key it carries every top-level node_modules and ios/Pods, none of the build output, skips the dependencies step and leaves the sibling as it was', () => {
    createSiblingCopy(siblingSlug, { key: 'key' });
    const outcome = runNewCopyJob();
    assert.match(outcome.log, /remote-run: seeded from the copy app-aaaaaaaaaa of this project: 3 dependency folders cloned; its dependencies are the same, so the dependencies step is skipped/);
    assert.equal(countInstallRuns(), 0, 'the dependencies step did not run');
    assert.ok(!outcome.log.includes('installing dependencies'), outcome.log);
    assert.equal(readDepsHash(newSlug), 'key');
    // Carried, with their content.
    assert.equal(readTreeFile(newSlug, 'node_modules/pkg/index.js'), `root of ${siblingSlug}`);
    assert.equal(readTreeFile(newSlug, 'projects/x/node_modules/dep/index.js'), `workspace of ${siblingSlug}`);
    assert.equal(readTreeFile(newSlug, 'projects/x/ios/Pods/Pod/pod.h'), 'pod');
    assert.equal(readTreeFile(newSlug, 'node_modules/inner/node_modules/deep/index.js'), 'nested', 'a nested node_modules comes with the one it is in');
    // Not carried: the build output, the sibling's sources, a workspace the new revision lacks.
    for (const notCarried of [
      'node_modules/pkg/android/build',
      'node_modules/pkg/android/.cxx',
      'node_modules/pkg/.gradle',
      'projects/x/ios/build',
      'projects/x/android/build',
      '.gradle',
      'src/code.ts',
      'projects/y',
    ]) {
      assert.equal(fs.existsSync(treePath(newSlug, notCarried)), false, `${notCarried} must not be carried`);
    }
    // The sibling is untouched and its lock is given back.
    assert.equal(readTreeFile(siblingSlug, 'node_modules/pkg/android/build/outputs/app.aar'), 'gradle output');
    assert.equal(readTreeFile(siblingSlug, 'projects/x/ios/build/Products/app.txt'), 'derived data');
    assert.equal(fs.existsSync(path.join(copyDir(siblingSlug), 'lock')), false);
    assert.equal(fs.existsSync(path.join(copyDir(newSlug), 'seed.tmp')), false, 'the staging folder is gone');
  });

  it('a folder whose parent the new revision does not have is not carried (a workspace that is gone, an app with no ios folder), and one the new copy already holds is left alone', () => {
    createSiblingCopy(siblingSlug, { key: 'key' });
    const outcome = runNewCopyJob({ stagedFiles: ['projects/x/package.json', 'node_modules/own/index.js'] });
    // Of the sibling's four dependency folders: `projects/y` is gone, `projects/x/ios` is not in the new tree, the root `node_modules` is there already.
    assert.match(outcome.log, /seeded from the copy app-aaaaaaaaaa of this project: 1 dependency folder cloned/);
    assert.equal(readTreeFile(newSlug, 'projects/x/node_modules/dep/index.js'), `workspace of ${siblingSlug}`);
    assert.equal(fs.existsSync(treePath(newSlug, 'projects/x/ios')), false);
    assert.equal(fs.existsSync(treePath(newSlug, 'projects/y')), false);
    assert.equal(readTreeFile(newSlug, 'node_modules/own/index.js'), 'x', 'what the copy had is not replaced');
    assert.equal(fs.existsSync(treePath(newSlug, 'node_modules/pkg')), false);
  });

  it('a clone is not a link: a file changed in the new copy does not change the sibling\'s', () => {
    createSiblingCopy(siblingSlug, { key: 'key' });
    runNewCopyJob({ command: "echo changed > node_modules/pkg/index.js" });
    assert.equal(readTreeFile(newSlug, 'node_modules/pkg/index.js')?.trim(), 'changed');
    assert.equal(readTreeFile(siblingSlug, 'node_modules/pkg/index.js'), `root of ${siblingSlug}`);
  });

  it('with another install key it carries the same folders and the dependencies step still runs, on top of them', () => {
    createSiblingCopy(siblingSlug, { key: 'old-key' });
    const outcome = runNewCopyJob({ installKey: 'new-key', installCommand: `cat node_modules/pkg/index.js >> '${installRunsFile()}'; echo >> '${installRunsFile()}'` });
    assert.match(outcome.log, /seeded from the copy app-aaaaaaaaaa of this project: 3 dependency folders cloned; its dependencies differ, so the dependencies step still runs on top/);
    assert.match(outcome.log, /installing dependencies:/);
    assert.equal(fs.readFileSync(installRunsFile(), 'utf8').trim(), `root of ${siblingSlug}`, 'the step found the sibling\'s node_modules already there');
    assert.equal(readDepsHash(newSlug), 'new-key', 'the key is the step\'s own, written after it ran');
    assert.equal(readTreeFile(newSlug, 'projects/x/ios/Pods/Pod/pod.h'), 'pod');
  });

  it('without a sibling the dependencies step runs as before and nothing is carried', () => {
    const outcome = runNewCopyJob();
    assert.equal(countInstallRuns(), 1);
    assert.ok(!outcome.log.includes('seeded'), outcome.log);
    assert.equal(fs.existsSync(treePath(newSlug, 'node_modules')), false);
    assert.equal(readDepsHash(newSlug), 'key');
  });

  it('a copy of another project is never the source — also one whose name only starts with this project\'s — and a sibling whose dependencies step never finished (no deps.hash) is not either', () => {
    createSiblingCopy('other-aaaaaaaaaa', { key: 'key' });
    createSiblingCopy('app-x-aaaaaaaaaa', { key: 'key' });
    createSiblingCopy(otherSiblingSlug, {});
    const outcome = runNewCopyJob();
    assert.equal(countInstallRuns(), 1, 'nothing to seed from: the step runs');
    assert.ok(!outcome.log.includes('seeded'), outcome.log);
    assert.equal(fs.existsSync(treePath(newSlug, 'node_modules')), false);
  });

  it('a job that installs nothing (no install command) is not seeded', () => {
    createSiblingCopy(siblingSlug, { key: 'key' });
    const outcome = runJob(state.workDir, { slug: newSlug, jobId: 'box1-nnnnnn', command: 'true', stagedFiles: ['projects/x/package.json'] });
    assert.equal(outcome.exit, '0', outcome.log);
    assert.equal(fs.existsSync(treePath(newSlug, 'node_modules')), false);
    assert.ok(!outcome.log.includes('seeded'), outcome.log);
  });

  it('only the FIRST job of a copy seeds it: a copy that has run before keeps what it has', () => {
    runNewCopyJob({ jobId: 'box1-aaaaaa' });
    assert.equal(countInstallRuns(), 1);
    createSiblingCopy(siblingSlug, { key: 'newer-key' });
    const outcome = runNewCopyJob({ jobId: 'box1-bbbbbb', installKey: 'newer-key' });
    assert.ok(!outcome.log.includes('seeded'), outcome.log);
    assert.equal(countInstallRuns(), 2, 'the step ran for the changed key, as it always did');
    assert.equal(fs.existsSync(treePath(newSlug, 'node_modules')), false);
  });

  it('a seed that an earlier job left half-made (cut off) is removed when the next job of the copy starts', () => {
    runNewCopyJob({ jobId: 'box1-aaaaaa' });
    writeFile(copyDir(newSlug), 'seed.tmp/node_modules/half/file', 'x');
    runNewCopyJob({ jobId: 'box1-bbbbbb' });
    assert.equal(fs.existsSync(path.join(copyDir(newSlug), 'seed.tmp')), false);
  });
});

describe('which sibling is taken', { skip: rsyncSkip }, () => {
  it('the one with this job\'s install key, even when another sibling was used more recently', () => {
    createSiblingCopy(siblingSlug, { key: 'key', usedAgoMs: 3 * dayMs });
    createSiblingCopy(otherSiblingSlug, { key: 'other-key', usedAgoMs: 60_000 });
    const outcome = runNewCopyJob();
    assert.match(outcome.log, /seeded from the copy app-aaaaaaaaaa /);
    assert.equal(readTreeFile(newSlug, 'node_modules/pkg/index.js'), `root of ${siblingSlug}`);
    assert.equal(countInstallRuns(), 0);
  });

  it('among siblings with the same key, the most recently used', () => {
    createSiblingCopy(siblingSlug, { key: 'key', usedAgoMs: 3 * dayMs });
    createSiblingCopy(otherSiblingSlug, { key: 'key', usedAgoMs: hourMs });
    const outcome = runNewCopyJob();
    assert.match(outcome.log, /seeded from the copy app-cccccccccc /);
    assert.equal(readTreeFile(newSlug, 'node_modules/pkg/index.js'), `root of ${otherSiblingSlug}`);
  });

  it('with no sibling of this key, the most recently used of the others — and the step runs', () => {
    createSiblingCopy(siblingSlug, { key: 'older-key', usedAgoMs: 3 * dayMs });
    createSiblingCopy(otherSiblingSlug, { key: 'recent-key', usedAgoMs: hourMs });
    const outcome = runNewCopyJob();
    assert.match(outcome.log, /seeded from the copy app-cccccccccc .*differ/);
    assert.equal(readTreeFile(newSlug, 'node_modules/pkg/index.js'), `root of ${otherSiblingSlug}`);
    assert.equal(countInstallRuns(), 1);
  });

  describe('under the sibling\'s project lock, tried once and never waited for', () => {
    it('a sibling whose lock a live job holds is passed over for the next one, and its lock is left as it was', () => {
      createSiblingCopy(siblingSlug, { key: 'key', usedAgoMs: hourMs });
      createSiblingCopy(otherSiblingSlug, { key: 'other-key', usedAgoMs: 3 * dayMs });
      const holderPid = startRunnerStandIn();
      writeFile(copyDir(siblingSlug), 'lock', `${holderPid}\nsome-job\n`);
      const outcome = runNewCopyJob();
      assert.match(outcome.log, /seeded from the copy app-cccccccccc /);
      assert.equal(readTreeFile(newSlug, 'node_modules/pkg/index.js'), `root of ${otherSiblingSlug}`);
      assert.equal(fs.readFileSync(path.join(copyDir(siblingSlug), 'lock'), 'utf8'), `${holderPid}\nsome-job\n`);
      assert.equal(fs.existsSync(path.join(copyDir(otherSiblingSlug), 'lock')), false, 'the lock it took it gave back');
    });

    it('when every sibling is busy nothing is carried: the step installs from scratch and the log says why', () => {
      createSiblingCopy(siblingSlug, { key: 'key' });
      const holderPid = startRunnerStandIn();
      writeFile(copyDir(siblingSlug), 'lock', `${holderPid}\nsome-job\n`);
      const outcome = runNewCopyJob();
      assert.match(outcome.log, /not seeded from another copy of this project: they are all busy right now/);
      assert.equal(countInstallRuns(), 1);
      assert.equal(fs.existsSync(treePath(newSlug, 'node_modules')), false);
    });

    it('a sibling whose job is IN ITS DEPENDENCIES STEP is not touched: the step holds its lock', async () => {
      createSiblingCopy(siblingSlug, { key: 'key' });
      const deepInInstall = path.join(root, 'sibling-in-deps');
      const installingJob: JobSpec = { slug: siblingSlug, jobId: 'box1-iiiiii', command: 'true', installKey: 'changed-key', installCommand: `touch '${deepInInstall}'; sleep 60` };
      const child = startJob(state.workDir, installingJob);
      try {
        await waitUntil('the sibling\'s job to be in its dependencies step', () => fs.existsSync(deepInInstall));
        const outcome = runNewCopyJob({ installKey: 'key' });
        assert.match(outcome.log, /not seeded from another copy of this project: they are all busy right now/);
        assert.equal(countInstallRuns(), 1, 'the new copy installed on its own');
        assert.equal(fs.existsSync(treePath(newSlug, 'node_modules')), false);
      } finally {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      }
    });

    it('a lock whose holder is gone is broken and the sibling is used', () => {
      createSiblingCopy(siblingSlug, { key: 'key' });
      // A live process that is not the script's own reads as a holder that is gone (its pid went to a stranger).
      writeFile(copyDir(siblingSlug), 'lock', `${startStrangerProcess()}\nlong-gone-job\n`);
      const outcome = runNewCopyJob();
      assert.match(outcome.log, /seeded from the copy app-aaaaaaaaaa /);
      assert.equal(fs.existsSync(path.join(copyDir(siblingSlug), 'lock')), false);
      assert.deepEqual(fs.readdirSync(copyDir(siblingSlug)).filter((name) => name.startsWith('lock')), [], 'the right to break the old lock is not left behind');
    });

    it('a sibling an `exec` runs in (it takes no lock) is passed over', () => {
      createSiblingCopy(siblingSlug, { key: 'key' });
      writeFile(copyDir(siblingSlug), `exec.${startRunnerStandIn()}`, '');
      const outcome = runNewCopyJob();
      assert.match(outcome.log, /not seeded from another copy of this project: they are all busy right now/);
      assert.equal(countInstallRuns(), 1);
    });
  });
});

describe('a seed that fails seeds nothing and never fails the job', { skip: rsyncSkip }, () => {
  /** A stand-in for `cp` / `mv` that lets the calls through to the real one until the `failFrom`-th call that has the staging folder (`seed.tmp`) among its arguments — a clone into it, a move out of it — and fails that one and every one after it. */
  function createFailingTool(tool: 'cp' | 'mv', failFrom: number): string {
    const counterFile = path.join(root, `${tool}-counter`);
    const script = [
      'counted=0',
      'for argument; do',
      '  case "$argument" in */seed.tmp/*) counted=1 ;; esac',
      'done',
      'if [ "$counted" = 1 ]; then',
      `  seen=$(cat '${counterFile}' 2> /dev/null || echo 0); seen=$((seen + 1)); echo "$seen" > '${counterFile}'`,
      `  if [ "$seen" -ge ${failFrom} ]; then echo "stub ${tool}: refused" >&2; exit 1; fi`,
      'fi',
      `exec ${getRealTool(tool)} "$@"`,
    ].join('\n');
    return createToolStubs({ [tool]: script });
  }

  it('a clone that fails after others were made: the partial seed is removed, one line says so, and the dependencies are installed from scratch', () => {
    createSiblingCopy(siblingSlug, { key: 'key' });
    const binDir = createFailingTool('cp', 3);
    const outcome = runNewCopyJob({}, { PATH: `${binDir}:${process.env.PATH ?? ''}` });
    assert.match(outcome.log, /remote-run: could not seed this copy from the copy app-aaaaaaaaaa \(cloning \S+ failed\): the dependencies are installed from scratch/);
    assert.equal(fs.existsSync(treePath(newSlug, 'node_modules')), false, 'no node_modules of the partial seed is left');
    assert.equal(fs.existsSync(treePath(newSlug, 'projects/x/node_modules')), false);
    assert.equal(fs.existsSync(treePath(newSlug, 'projects/x/ios/Pods')), false);
    assert.equal(fs.existsSync(path.join(copyDir(newSlug), 'seed.tmp')), false, 'the staging folder with the clones made so far is gone');
    assert.equal(countInstallRuns(), 1, 'the step ran');
    assert.equal(readDepsHash(newSlug), 'key', 'the step wrote the key itself');
    assert.equal(fs.existsSync(path.join(copyDir(siblingSlug), 'lock')), false, 'the sibling\'s lock is given back');
    assert.equal(readTreeFile(siblingSlug, 'node_modules/pkg/index.js'), `root of ${siblingSlug}`);
  });

  it('folders already moved into place when a later move fails are removed again', () => {
    createSiblingCopy(siblingSlug, { key: 'key' });
    const binDir = createFailingTool('mv', 3);
    const outcome = runNewCopyJob({}, { PATH: `${binDir}:${process.env.PATH ?? ''}` });
    assert.match(outcome.log, /could not seed this copy from the copy app-aaaaaaaaaa \(moving \S+ into place failed\)/);
    assert.equal(fs.existsSync(treePath(newSlug, 'node_modules')), false, 'the folders that had been moved are gone again');
    assert.equal(fs.existsSync(treePath(newSlug, 'projects/x/node_modules')), false);
    assert.equal(fs.existsSync(treePath(newSlug, 'projects/x/ios/Pods')), false);
    assert.equal(fs.existsSync(path.join(copyDir(newSlug), 'seed.tmp')), false);
    assert.equal(countInstallRuns(), 1);
    assert.equal(readDepsHash(newSlug), 'key');
  });

  it('a sibling with nothing to carry (no dependency folders) leaves the step to run, without a complaint', () => {
    createSiblingCopy(siblingSlug, { key: 'key', files: { 'src/code.ts': 'only source' } });
    const outcome = runNewCopyJob();
    assert.doesNotMatch(outcome.log, /seeded|could not seed/);
    assert.equal(countInstallRuns(), 1);
    assert.equal(fs.existsSync(path.join(copyDir(siblingSlug), 'lock')), false);
  });
});

describe('the clone command and the stop', () => {
  /** The functions of the script, sourced in a process of their own with the globals of one copy, the PATH starting with the stub folder; what the stubs recorded is returned. */
  function runSourced(body: string, binDir: string | null): { stdout: string; stderr: string; status: number | null } {
    const program = [`source ${scriptPath}`, `work=${state.workDir}; slug=${newSlug}; proj="$work/p/$slug"; tree="$proj/tree"; job=; killed=0; mkdir -p "$tree"`, body].join('\n');
    const result = spawnSync('bash', ['-c', program], { encoding: 'utf8', env: getRunEnvironment(binDir === null ? {} : { PATH: `${binDir}:${process.env.PATH ?? ''}` }), timeout: 60_000 });
    return { stdout: result.stdout, stderr: result.stderr, status: result.status };
  }

  it('on a Mac a folder is cloned with `cp -cR` (clonefile), anywhere else with `cp -a --reflink=auto`', () => {
    const calls = path.join(root, 'cp-calls');
    const realCp = getRealTool('cp');
    // On a Linux box `cp -cR` is no option: the stand-in records the Mac's command line and does the copy the way this box can.
    const macBin = createToolStubs({
      uname: 'echo Darwin',
      cp: `printf '%s\\n' "$*" >> '${calls}'\nif [ "$1" = -cR ]; then exec ${realCp} -a "$2" "$3"; fi\nexec ${realCp} "$@"`,
    });
    fs.mkdirSync(path.join(root, 'from', 'node_modules'), { recursive: true });
    writeFile(root, 'from/node_modules/file', 'x');
    const mac = runSourced(`clone_folder '${path.join(root, 'from', 'node_modules')}' '${path.join(root, 'mac-copy')}'`, macBin);
    assert.equal(mac.status, 0, mac.stderr);
    assert.equal(fs.readFileSync(path.join(root, 'mac-copy', 'file'), 'utf8'), 'x');
    const linuxBin = path.join(root, 'linux-bin');
    fs.mkdirSync(linuxBin);
    fs.writeFileSync(path.join(linuxBin, 'cp'), `#!/bin/bash\nprintf '%s\\n' "$*" >> '${calls}'\nexec ${realCp} "$@"\n`, { mode: 0o755 });
    const linux = runSourced(`clone_folder '${path.join(root, 'from', 'node_modules')}' '${path.join(root, 'linux-copy')}'`, linuxBin);
    assert.equal(linux.status, 0, linux.stderr);
    assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'), [
      `-cR ${path.join(root, 'from', 'node_modules')} ${path.join(root, 'mac-copy')}`,
      `-a --reflink=auto ${path.join(root, 'from', 'node_modules')} ${path.join(root, 'linux-copy')}`,
    ]);
  });

  it('a job that was told to stop clones nothing and takes no sibling\'s lock', () => {
    createSiblingCopy(siblingSlug, { key: 'key' });
    const run = runSourced(`killed=1; seed_new_copy key; echo "seeded=$(ls "$tree" | grep -c node_modules)"`, null);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /seeded=0/);
    assert.equal(fs.existsSync(path.join(copyDir(newSlug), 'seed.tmp')), false);
    assert.equal(fs.existsSync(path.join(copyDir(siblingSlug), 'lock')), false);
  });

  it('a stop that comes while the folders are cloned removes what was cloned and says so', () => {
    createSiblingCopy(siblingSlug, { key: 'key' });
    // The first clone is done when the stop arrives (the TERM trap of a job sets the flag after the foreground copy it runs): the next folder is not cloned.
    const run = runSourced(`mkdir -p "$tree/projects/x/ios"\nclone_folder() { cp -a --reflink=auto "$1" "$2" && killed=1; }\nseed_new_copy key; echo "nm=$(ls "$tree" | grep -c node_modules)"`, null);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /could not seed this copy from the copy app-aaaaaaaaaa \(the job was stopped\)/);
    assert.match(run.stdout, /nm=0/);
    assert.equal(fs.existsSync(path.join(copyDir(newSlug), 'seed.tmp')), false);
    assert.equal(fs.existsSync(path.join(copyDir(siblingSlug), 'lock')), false);
  });
});
