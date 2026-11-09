/**
 * @description `remoteRun/runner.sh`, the first job of a NEW project copy: its dependencies are carried over from a sibling copy of the same REPOSITORY (`seed_new_copy`) instead of being installed from scratch — run against the real
 * script (`runner.sh job`, as Pueue starts it) and real folders. Siblings are told by the job's `project-key` (the main box's hash of the user and the repository's root commit), never by the folder's name: every sibling below has a
 * folder name of its own, as the worktrees and checkouts of one repository do, and a copy that merely shares a name with another repository's is not one. What these pin: which sibling is taken (the same install key first, then the
 * most recently used; never a copy without the key, nor one whose project lock is held — a job of it may be in its dependencies step — nor one an `exec` runs in), that nothing is seeded where the disk cannot clone (a plain copy
 * would take more space than the install), what is carried (every top-level `node_modules`; an app's whole `ios` when the new tree has none, else just its `Pods`; never the build output, never a folder whose parent the new tree lacks), that
 * the dependencies step is skipped ONLY when the keys are equal, the marks the prune reads (`seeded-from`, `seed-shared`), that a seed which fails leaves nothing behind and the job installs as before, and that a copy which has run
 * before is never seeded. A Mac's `/bin/cp -cR` is checked by its command line (the Linux box has no clonefile); a disk that clones is a `cp` stand-in, as this box's disks do not.
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
/** Three checkouts of ONE repository, each in a folder of its own name (the slug's first part is the folder's name). */
const siblingSlug = 'overview-aaaaaaaaaa';
const otherSiblingSlug = 'lingua-cccccccccc';
const newSlug = 'timeline-bbbbbbbbbb';
const repositoryKey = 'a'.repeat(32);
const anotherRepositoryKey = 'b'.repeat(32);

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
const readCopyFile = (slugName: string, name: string): string | null => (fs.existsSync(path.join(copyDir(slugName), name)) ? fs.readFileSync(path.join(copyDir(slugName), name), 'utf8').trim() : null);

/** What a finished copy of a React-Native-like monorepo holds: the dependency folders to carry, the build output not to carry, a workspace the new revision does not have, an Expo app's native project, and a source file. */
function createSiblingFiles(slugName: string): Record<string, string> {
  return {
    'node_modules/pkg/index.js': `root of ${slugName}`,
    'node_modules/pkg/android/build/outputs/app.aar': 'gradle output',
    'node_modules/pkg/android/.cxx/cache.txt': 'cmake cache',
    'node_modules/pkg/.gradle/state.bin': 'gradle state',
    'node_modules/inner/node_modules/deep/index.js': 'nested',
    'projects/x/node_modules/dep/index.js': `workspace of ${slugName}`,
    'projects/x/ios/Podfile': 'the sibling\'s podfile',
    'projects/x/ios/.e2e-prebuild.json': '{"fingerprint":"f"}',
    'projects/x/ios/Pods/Pod/pod.h': 'pod',
    'projects/x/ios/build/Products/app.txt': 'derived data',
    'projects/x/android/build/out.txt': 'gradle output',
    'projects/y/node_modules/gone/index.js': 'workspace the new revision does not have',
    '.gradle/cache.bin': 'gradle cache',
    'src/code.ts': 'the sibling\'s own source',
  };
}

/** A copy that has run before: files in its tree, a manifest, the repository it is of, the key its dependencies step finished with, and a mark of use `usedAgoMs` ago. */
function createSiblingCopy(slugName: string, options: { key?: string; usedAgoMs?: number; files?: Record<string, string>; projectKey?: string | null } = {}): void {
  const files = options.files ?? createSiblingFiles(slugName);
  for (const [relativePath, content] of Object.entries(files)) writeFile(path.join(copyDir(slugName), 'tree'), relativePath, content);
  writeFile(copyDir(slugName), 'manifest', 'src/code.ts\n');
  if (options.projectKey !== null) writeFile(copyDir(slugName), 'project-key', `${options.projectKey ?? repositoryKey}\n`);
  if (options.key !== undefined) writeFile(copyDir(slugName), 'deps.hash', `${options.key}\n`);
  writeFile(copyDir(slugName), 'used', '');
  const usedAt = new Date(Date.now() - (options.usedAgoMs ?? hourMs));
  fs.utimesSync(path.join(copyDir(slugName), 'used'), usedAt, usedAt);
}

/** The first job of a new copy; its dependencies step counts its runs in `install-runs`. It stages a tracked `ios/Podfile` unless the test says otherwise. */
function newCopyJob(extra: Partial<JobSpec> = {}): JobSpec {
  return {
    slug: newSlug,
    jobId: 'box1-nnnnnn',
    command: 'true',
    installCommand: `echo ran >> '${installRunsFile()}'`,
    installKey: 'key',
    projectKey: repositoryKey,
    stagedFiles: ['projects/x/package.json', 'projects/x/ios/Podfile'],
    ...extra,
  };
}

/**
 * The tools of a disk that clones files, as this box's disks (tmpfs, ext4) cannot: a `cp` that does `--reflink=always` as the plain copy it can do here, and a `mv`, each failing from its Nth call that works on the staging folder
 * (`FAKE_CP_FAIL_FROM`, `FAKE_MV_FAIL_FROM`); `FAKE_NO_REFLINK=1` is a disk that cannot clone (`cp` refuses `--reflink=always`, as it does on ext4).
 */
function createCloningDiskTools(): string {
  const binDir = path.join(root, 'cloning-bin');
  if (fs.existsSync(binDir)) return binDir;
  fs.mkdirSync(binDir, { recursive: true });
  const countingGate = (variable: string, counterName: string): string => [
    'counted=0',
    'for argument; do',
    '  case "$argument" in */seed.tmp/*) counted=1 ;; esac',
    'done',
    'if [ "$counted" = 1 ]; then',
    `  seen=$(cat '${path.join(root, counterName)}' 2> /dev/null || echo 0); seen=$((seen + 1)); echo "$seen" > '${path.join(root, counterName)}'`,
    `  if [ -n "\${${variable}:-}" ] && [ "$seen" -ge "\${${variable}}" ]; then echo "stub: refused" >&2; exit 1; fi`,
    'fi',
  ].join('\n');
  const realCp = getRealTool('cp');
  const realMv = getRealTool('mv');
  fs.writeFileSync(path.join(binDir, 'cp'), [
    '#!/bin/bash',
    countingGate('FAKE_CP_FAIL_FROM', 'cp-counter'),
    'arguments=()',
    'for argument; do',
    '  if [ "$argument" = --reflink=always ]; then',
    '    [ -n "${FAKE_NO_REFLINK:-}" ] && { echo "cp: failed to clone: Operation not supported" >&2; exit 1; }',
    '    argument=--reflink=auto',
    '  fi',
    '  arguments+=("$argument")',
    'done',
    `exec ${realCp} "\${arguments[@]}"`,
    '',
  ].join('\n'), { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, 'mv'), ['#!/bin/bash', countingGate('FAKE_MV_FAIL_FROM', 'mv-counter'), `exec ${realMv} "$@"`, ''].join('\n'), { mode: 0o755 });
  return binDir;
}

/** The environment of a job on a disk that clones; `extra` replaces or adds to it. */
function cloningEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PATH: `${createCloningDiskTools()}:${process.env.PATH ?? ''}`, ...extra };
}

function runNewCopyJob(extra: Partial<JobSpec> = {}, env: NodeJS.ProcessEnv = cloningEnv()): JobOutcome {
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

describe('a new copy is seeded from a sibling copy of the same repository', { skip: rsyncSkip }, () => {
  it('with the same install key it carries every top-level node_modules and the Pods, none of the build output, skips the dependencies step, leaves the sibling as it was and marks who shares what', () => {
    createSiblingCopy(siblingSlug, { key: 'key' });
    const outcome = runNewCopyJob();
    assert.match(outcome.log, /remote-run: seeded from the copy overview-aaaaaaaaaa of this project: 3 folders cloned; its dependencies are the same, so the dependencies step is skipped/);
    assert.equal(countInstallRuns(), 0, 'the dependencies step did not run');
    assert.ok(!outcome.log.includes('installing dependencies'), outcome.log);
    assert.equal(readCopyFile(newSlug, 'deps.hash'), 'key');
    assert.equal(readCopyFile(newSlug, 'project-key'), repositoryKey, 'the copy remembers which repository it is of');
    // Carried, with their content.
    assert.equal(readTreeFile(newSlug, 'node_modules/pkg/index.js'), `root of ${siblingSlug}`);
    assert.equal(readTreeFile(newSlug, 'projects/x/node_modules/dep/index.js'), `workspace of ${siblingSlug}`);
    assert.equal(readTreeFile(newSlug, 'projects/x/ios/Pods/Pod/pod.h'), 'pod');
    assert.equal(readTreeFile(newSlug, 'node_modules/inner/node_modules/deep/index.js'), 'nested', 'a nested node_modules comes with the one it is in');
    // The new tree has an `ios` of its own (a tracked Podfile): only the Pods are carried into it.
    assert.equal(readTreeFile(newSlug, 'projects/x/ios/Podfile'), 'x', 'what the new revision has is not replaced by the sibling\'s');
    assert.equal(fs.existsSync(treePath(newSlug, 'projects/x/ios/.e2e-prebuild.json')), false);
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
    // The sibling is untouched and its lock is given back; the marks the prune reads are there.
    assert.equal(readTreeFile(siblingSlug, 'node_modules/pkg/android/build/outputs/app.aar'), 'gradle output');
    assert.equal(readTreeFile(siblingSlug, 'projects/x/ios/build/Products/app.txt'), 'derived data');
    assert.equal(fs.existsSync(path.join(copyDir(siblingSlug), 'lock')), false);
    assert.equal(fs.existsSync(path.join(copyDir(newSlug), 'seed.tmp')), false, 'the staging folder is gone');
    assert.equal(readCopyFile(newSlug, 'seeded-from'), siblingSlug);
    assert.equal(fs.existsSync(path.join(copyDir(siblingSlug), 'seed-shared')), true);
  });

  it('an app whose `ios` the new tree does not have (git ignores it) gets the sibling\'s whole `ios` — its prebuild marker and Pods — without `ios/build`; a workspace the new revision dropped and a node_modules it already holds are left alone', () => {
    createSiblingCopy(siblingSlug, { key: 'key' });
    const outcome = runNewCopyJob({ stagedFiles: ['projects/x/package.json', 'node_modules/own/index.js'] });
    // Of the sibling's folders: the root node_modules is there already, `projects/y` is gone; left are the workspace's node_modules and the app's `ios`.
    assert.match(outcome.log, /seeded from the copy overview-aaaaaaaaaa of this project: 2 folders cloned/);
    assert.equal(readTreeFile(newSlug, 'projects/x/node_modules/dep/index.js'), `workspace of ${siblingSlug}`);
    assert.equal(readTreeFile(newSlug, 'projects/x/ios/Podfile'), 'the sibling\'s podfile');
    assert.equal(readTreeFile(newSlug, 'projects/x/ios/.e2e-prebuild.json'), '{"fingerprint":"f"}', 'the prebuild marker comes with the native project');
    assert.equal(readTreeFile(newSlug, 'projects/x/ios/Pods/Pod/pod.h'), 'pod');
    assert.equal(fs.existsSync(treePath(newSlug, 'projects/x/ios/build')), false, 'the build output does not');
    assert.equal(fs.existsSync(treePath(newSlug, 'projects/y')), false);
    assert.equal(readTreeFile(newSlug, 'node_modules/own/index.js'), 'x', 'what the copy had is not replaced');
    assert.equal(fs.existsSync(treePath(newSlug, 'node_modules/pkg')), false);
    assert.equal(readTreeFile(siblingSlug, 'projects/x/ios/build/Products/app.txt'), 'derived data', 'and the sibling keeps its own');
  });

  it('an app folder the new tree does not have gets nothing — not even an `ios` — whatever the sibling has there', () => {
    createSiblingCopy(siblingSlug, { key: 'key' });
    const outcome = runNewCopyJob({ stagedFiles: [] });
    // Only the root node_modules has a parent in the new tree.
    assert.match(outcome.log, /seeded from the copy overview-aaaaaaaaaa of this project: 1 folder cloned/);
    assert.equal(fs.existsSync(treePath(newSlug, 'projects')), false);
    assert.equal(readTreeFile(newSlug, 'node_modules/pkg/index.js'), `root of ${siblingSlug}`);
  });

  it('a clone is not a link: a file changed in the new copy does not change the sibling\'s', () => {
    createSiblingCopy(siblingSlug, { key: 'key' });
    runNewCopyJob({ command: 'echo changed > node_modules/pkg/index.js' });
    assert.equal(readTreeFile(newSlug, 'node_modules/pkg/index.js')?.trim(), 'changed');
    assert.equal(readTreeFile(siblingSlug, 'node_modules/pkg/index.js'), `root of ${siblingSlug}`);
  });

  it('with another install key it carries the same folders and the dependencies step still runs, on top of them', () => {
    createSiblingCopy(siblingSlug, { key: 'old-key' });
    const outcome = runNewCopyJob({ installKey: 'new-key', installCommand: `cat node_modules/pkg/index.js >> '${installRunsFile()}'; echo >> '${installRunsFile()}'` });
    assert.match(outcome.log, /seeded from the copy overview-aaaaaaaaaa of this project: 3 folders cloned; its dependencies differ, so the dependencies step still runs on top/);
    assert.match(outcome.log, /installing dependencies:/);
    assert.equal(fs.readFileSync(installRunsFile(), 'utf8').trim(), `root of ${siblingSlug}`, 'the step found the sibling\'s node_modules already there');
    assert.equal(readCopyFile(newSlug, 'deps.hash'), 'new-key', 'the key is the step\'s own, written after it ran');
    assert.equal(readTreeFile(newSlug, 'projects/x/ios/Pods/Pod/pod.h'), 'pod');
  });

  it('without a sibling the dependencies step runs as before and nothing is carried', () => {
    const outcome = runNewCopyJob();
    assert.equal(countInstallRuns(), 1);
    assert.ok(!outcome.log.includes('seeded'), outcome.log);
    assert.equal(fs.existsSync(treePath(newSlug, 'node_modules')), false);
    assert.equal(readCopyFile(newSlug, 'deps.hash'), 'key');
    assert.equal(fs.existsSync(path.join(copyDir(newSlug), 'seeded-from')), false);
  });

  it('a seeded copy can be the source of the next one: the group of copies that share blocks is named after the copy they first came from', () => {
    createSiblingCopy(siblingSlug, { key: 'key', usedAgoMs: 5 * dayMs });
    runNewCopyJob({ jobId: 'box1-aaaaaa' });
    // The first clone is the most recently used one now: the next is seeded from IT, and still names the original.
    const third = runJob(state.workDir, newCopyJob({ slug: 'third-dddddddddd', jobId: 'box1-bbbbbb' }), cloningEnv());
    assert.equal(third.exit, '0', third.log);
    assert.match(third.log, /seeded from the copy timeline-bbbbbbbbbb /);
    assert.equal(readCopyFile('third-dddddddddd', 'seeded-from'), siblingSlug);
    assert.equal(readCopyFile(newSlug, 'seeded-from'), siblingSlug);
    assert.equal(fs.existsSync(path.join(copyDir(newSlug), 'seed-shared')), true);
  });

  it('only a copy of the same REPOSITORY is a source: the same folder name with another repository\'s key is not, and a copy with no key is not either', () => {
    createSiblingCopy('timeline-aaaaaaaaaa', { key: 'key', projectKey: anotherRepositoryKey });
    createSiblingCopy('timeline-cccccccccc', { key: 'key', projectKey: null });
    const outcome = runNewCopyJob();
    assert.equal(countInstallRuns(), 1, 'nothing to seed from: the step runs');
    assert.ok(!outcome.log.includes('seeded'), outcome.log);
    assert.equal(fs.existsSync(treePath(newSlug, 'node_modules')), false);
  });

  it('a sibling whose dependencies step never finished (no deps.hash) is not a source', () => {
    createSiblingCopy(siblingSlug, {});
    const outcome = runNewCopyJob();
    assert.equal(countInstallRuns(), 1);
    assert.ok(!outcome.log.includes('seeded'), outcome.log);
    assert.equal(fs.existsSync(treePath(newSlug, 'node_modules')), false);
  });

  it('a job with no repository key (a repository with no commit yet) is never seeded', () => {
    createSiblingCopy(siblingSlug, { key: 'key' });
    const outcome = runNewCopyJob({ projectKey: undefined });
    assert.equal(countInstallRuns(), 1);
    assert.ok(!outcome.log.includes('seeded'), outcome.log);
    assert.equal(fs.existsSync(treePath(newSlug, 'node_modules')), false);
    assert.equal(fs.existsSync(path.join(copyDir(newSlug), 'project-key')), false);
  });

  it('a job that installs nothing (no install command) is not seeded', () => {
    createSiblingCopy(siblingSlug, { key: 'key' });
    const outcome = runJob(state.workDir, { slug: newSlug, jobId: 'box1-nnnnnn', command: 'true', projectKey: repositoryKey, stagedFiles: ['projects/x/package.json'] }, cloningEnv());
    assert.equal(outcome.exit, '0', outcome.log);
    assert.equal(fs.existsSync(treePath(newSlug, 'node_modules')), false);
    assert.ok(!outcome.log.includes('seeded'), outcome.log);
  });

  it('the copy remembers its repository from the job that applied its stage; a later job without one takes it back', () => {
    runNewCopyJob({ jobId: 'box1-aaaaaa' });
    assert.equal(readCopyFile(newSlug, 'project-key'), repositoryKey);
    runNewCopyJob({ jobId: 'box1-bbbbbb', projectKey: undefined });
    assert.equal(fs.existsSync(path.join(copyDir(newSlug), 'project-key')), false, 'a copy of unknown repository is never a source');
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
    assert.match(outcome.log, /seeded from the copy overview-aaaaaaaaaa /);
    assert.equal(readTreeFile(newSlug, 'node_modules/pkg/index.js'), `root of ${siblingSlug}`);
    assert.equal(countInstallRuns(), 0);
  });

  it('among siblings with the same key, the most recently used', () => {
    createSiblingCopy(siblingSlug, { key: 'key', usedAgoMs: 3 * dayMs });
    createSiblingCopy(otherSiblingSlug, { key: 'key', usedAgoMs: hourMs });
    const outcome = runNewCopyJob();
    assert.match(outcome.log, /seeded from the copy lingua-cccccccccc /);
    assert.equal(readTreeFile(newSlug, 'node_modules/pkg/index.js'), `root of ${otherSiblingSlug}`);
  });

  it('with no sibling of this key, the most recently used of the others — and the step runs', () => {
    createSiblingCopy(siblingSlug, { key: 'older-key', usedAgoMs: 3 * dayMs });
    createSiblingCopy(otherSiblingSlug, { key: 'recent-key', usedAgoMs: hourMs });
    const outcome = runNewCopyJob();
    assert.match(outcome.log, /seeded from the copy lingua-cccccccccc .*differ/);
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
      assert.match(outcome.log, /seeded from the copy lingua-cccccccccc /);
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
      const installingJob: JobSpec = { slug: siblingSlug, jobId: 'box1-iiiiii', command: 'true', projectKey: repositoryKey, installKey: 'changed-key', installCommand: `touch '${deepInInstall}'; sleep 60` };
      const child = startJob(state.workDir, installingJob, cloningEnv());
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
      assert.match(outcome.log, /seeded from the copy overview-aaaaaaaaaa /);
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

describe('a disk that cannot clone files gets no seed', { skip: rsyncSkip }, () => {
  it('with no copy-on-write (ext4) nothing is carried — a plain copy would take more disk than the install, which links files into a store — and the log says so; the step installs', () => {
    createSiblingCopy(siblingSlug, { key: 'key' });
    const outcome = runNewCopyJob({}, cloningEnv({ FAKE_NO_REFLINK: '1' }));
    assert.match(outcome.log, /remote-run: not seeded from another copy of this project: this runner's disk cannot clone files \(copy-on-write\), and a plain copy would take more space than installing/);
    assert.equal(countInstallRuns(), 1);
    assert.equal(fs.existsSync(treePath(newSlug, 'node_modules')), false);
    assert.equal(fs.existsSync(path.join(copyDir(newSlug), 'seed.tmp')), false);
    assert.equal(fs.existsSync(path.join(copyDir(siblingSlug), 'lock')), false, 'the sibling was not even locked');
    assert.equal(readCopyFile(newSlug, 'deps.hash'), 'key', 'the step wrote the key itself');
  });
});

describe('a seed that fails seeds nothing and never fails the job', { skip: rsyncSkip }, () => {
  it('a clone that fails after others were made: the partial seed is removed, one line says so, and the dependencies are installed from scratch', () => {
    createSiblingCopy(siblingSlug, { key: 'key' });
    const outcome = runNewCopyJob({}, cloningEnv({ FAKE_CP_FAIL_FROM: '3' }));
    assert.match(outcome.log, /remote-run: could not seed this copy from the copy overview-aaaaaaaaaa \(cloning \S+ failed\): the dependencies are installed from scratch/);
    assert.equal(fs.existsSync(treePath(newSlug, 'node_modules')), false, 'no node_modules of the partial seed is left');
    assert.equal(fs.existsSync(treePath(newSlug, 'projects/x/node_modules')), false);
    assert.equal(fs.existsSync(treePath(newSlug, 'projects/x/ios/Pods')), false);
    assert.equal(fs.existsSync(path.join(copyDir(newSlug), 'seed.tmp')), false, 'the staging folder with the clones made so far is gone');
    assert.equal(countInstallRuns(), 1, 'the step ran');
    assert.equal(readCopyFile(newSlug, 'deps.hash'), 'key', 'the step wrote the key itself');
    assert.equal(fs.existsSync(path.join(copyDir(newSlug), 'seeded-from')), false, 'a seed that failed shares nothing');
    assert.equal(fs.existsSync(path.join(copyDir(siblingSlug), 'lock')), false, 'the sibling\'s lock is given back');
    assert.equal(fs.existsSync(path.join(copyDir(siblingSlug), 'seed-shared')), false);
    assert.equal(readTreeFile(siblingSlug, 'node_modules/pkg/index.js'), `root of ${siblingSlug}`);
  });

  it('folders already moved into place when a later move fails are removed again', () => {
    createSiblingCopy(siblingSlug, { key: 'key' });
    const outcome = runNewCopyJob({}, cloningEnv({ FAKE_MV_FAIL_FROM: '3' }));
    assert.match(outcome.log, /could not seed this copy from the copy overview-aaaaaaaaaa \(moving \S+ into place failed\)/);
    assert.equal(fs.existsSync(treePath(newSlug, 'node_modules')), false, 'the folders that had been moved are gone again');
    assert.equal(fs.existsSync(treePath(newSlug, 'projects/x/node_modules')), false);
    assert.equal(fs.existsSync(treePath(newSlug, 'projects/x/ios/Pods')), false);
    assert.equal(fs.existsSync(path.join(copyDir(newSlug), 'seed.tmp')), false);
    assert.equal(countInstallRuns(), 1);
    assert.equal(readCopyFile(newSlug, 'deps.hash'), 'key');
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
  /** The functions of the script, sourced in a process of their own with the globals of one copy (its repository key written down), the PATH starting with the stub folder. */
  function runSourced(body: string, binDir: string): { stdout: string; stderr: string; status: number | null } {
    const program = [`source ${scriptPath}`, `work=${state.workDir}; slug=${newSlug}; proj="$work/p/$slug"; tree="$proj/tree"; job=; killed=0; mkdir -p "$tree"; echo ${repositoryKey} > "$proj/project-key"`, body].join('\n');
    const result = spawnSync('bash', ['-c', program], { encoding: 'utf8', env: getRunEnvironment({ PATH: `${binDir}:${process.env.PATH ?? ''}` }), timeout: 60_000 });
    return { stdout: result.stdout, stderr: result.stderr, status: result.status };
  }

  it('on a Mac a folder is cloned with the SYSTEM\'s `/bin/cp -cR` — a GNU `cp` first on the PATH (Homebrew coreutils) is not asked — anywhere else with `cp -a --reflink=always`', () => {
    const calls = path.join(root, 'cp-calls');
    const realCp = getRealTool('cp');
    // On a Linux box `cp -cR` is no option: the stand-in for the system's cp records the Mac's command line and copies the way this box can; the `cp` on the PATH refuses `-c`, as GNU cp's `--preserve=context` would.
    const systemCp = path.join(root, 'system-cp');
    fs.writeFileSync(systemCp, `#!/bin/bash\nprintf 'system %s\\n' "$*" >> '${calls}'\nif [ "$1" = -cR ]; then exec ${realCp} -a "$2" "$3"; fi\nexit 1\n`, { mode: 0o755 });
    const macBin = createToolStubs({
      uname: 'echo Darwin',
      cp: `printf 'path %s\\n' "$*" >> '${calls}'\necho "cp: invalid option -- c" >&2\nexit 1`,
    });
    fs.mkdirSync(path.join(root, 'from', 'node_modules'), { recursive: true });
    writeFile(root, 'from/node_modules/file', 'x');
    const mac = runSourced(`darwin_cp='${systemCp}'; clone_folder '${path.join(root, 'from', 'node_modules')}' '${path.join(root, 'mac-copy')}'`, macBin);
    assert.equal(mac.status, 0, mac.stderr);
    assert.equal(fs.readFileSync(path.join(root, 'mac-copy', 'file'), 'utf8'), 'x');
    const linuxBin = path.join(root, 'linux-bin');
    fs.mkdirSync(linuxBin);
    fs.writeFileSync(path.join(linuxBin, 'cp'), `#!/bin/bash\nprintf 'path %s\\n' "$*" >> '${calls}'\nexec ${realCp} "\${@/--reflink=always/--reflink=auto}"\n`, { mode: 0o755 });
    const linux = runSourced(`clone_folder '${path.join(root, 'from', 'node_modules')}' '${path.join(root, 'linux-copy')}'`, linuxBin);
    assert.equal(linux.status, 0, linux.stderr);
    assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'), [
      `system -cR ${path.join(root, 'from', 'node_modules')} ${path.join(root, 'mac-copy')}`,
      `path -a --reflink=always ${path.join(root, 'from', 'node_modules')} ${path.join(root, 'linux-copy')}`,
    ]);
  });

  it('a job that was told to stop clones nothing and takes no sibling\'s lock', () => {
    createSiblingCopy(siblingSlug, { key: 'key' });
    const run = runSourced('killed=1; seed_new_copy key; echo "seeded=$(ls "$tree" | grep -c node_modules)"', createCloningDiskTools());
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /seeded=0/);
    assert.equal(fs.existsSync(path.join(copyDir(newSlug), 'seed.tmp')), false);
    assert.equal(fs.existsSync(path.join(copyDir(siblingSlug), 'lock')), false);
  });

  it('a stop that comes while the folders are cloned removes what was cloned and says so', () => {
    createSiblingCopy(siblingSlug, { key: 'key' });
    // The first clone is done when the stop arrives (the TERM trap of a job sets the flag after the foreground copy it runs): the next folder is not cloned.
    const run = runSourced('mkdir -p "$tree/projects/x/ios"\nclone_folder() { cp -a --reflink=auto "$1" "$2" && killed=1; }\nseed_new_copy key; echo "nm=$(ls "$tree" | grep -c node_modules)"', createCloningDiskTools());
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /could not seed this copy from the copy overview-aaaaaaaaaa \(the job was stopped\)/);
    assert.match(run.stdout, /nm=0/);
    assert.equal(fs.existsSync(path.join(copyDir(newSlug), 'seed.tmp')), false);
    assert.equal(fs.existsSync(path.join(copyDir(siblingSlug), 'lock')), false);
  });
});
