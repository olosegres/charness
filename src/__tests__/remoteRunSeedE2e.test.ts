/**
 * @description `charness remote-run` at PROCESS level, a NEW project copy seeded from a sibling (`runner.sh` `seed_new_copy`), against a runner made of a throwaway loopback `sshd` and a private Pueue
 * (`remoteRunE2e/remoteRunFlowKit.ts`, `remoteRunFlowHarness.ts`): the built CLI is run as an agent runs it. Checkouts of one repository in folders of DIFFERENT names are copies of their own on the runner and are told to
 * be one repository by the root commit the CLI sends; a second repository that happens to be in a folder of the same name is not. The runner's disk here (tmpfs) cannot clone files, so the jobs' `PATH` starts with a `cp` that does
 * `--reflink=always` as the plain copy it can. In order, each step on the state the one before left:
 *
 *   the first copy installs (the dependencies step runs once) and holds a `node_modules` with a package and the build output a native build left in it, and an Expo app's native `ios` (its Pods, its build output)
 *   → the second checkout (a clone in a folder of another name) is seeded on its first run: the package, the `ios` with its Pods are there, the build output of neither is, the dependencies step did not run (the keys are equal), and
 *     the first copy still has everything
 *   → a third checkout with another lockfile is seeded too, and its dependencies step still runs on top of the seeded folders, once
 *   → another repository whose folder has the SAME name as the first is not seeded from it, and installs
 *   → the first copy, idle for more than a day, loses its Xcode derived data (`ios/build` but for its `generated` folder, the codegen pods' sources; and nothing else) a moment after a submit of another project, and its next job says so
 *
 * Needs sshd, ssh, rsync, Pueue and the built CLI (`yarn build`): a local run without them is SKIPPED with the reason, CI (`CI` is `true` or `1`) installs them and fails without. Test case: N/A — Charness has no Jira tracker.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createProject, createProjectClone, createRunnerEntry, readProjectFile, writeProjectFile, writeRunnersJson, type FlowProject } from './remoteRunE2e/remoteRunFlowKit';
import { layout, project, readDepsCounter, run, setUpFlow, skipReason, tearDownFlow } from './remoteRunE2e/remoteRunFlowHarness';
import { readDetachedRunPid, waitForDetachedRunToEnd } from './remoteRunRunnerScriptKit';

const seededPackageContent = 'installed in the first copy';
const buildOutputFile = 'node_modules/pkg/android/build/outputs/app.aar';
const podFile = 'the first copy\'s Podfile';
/** What `pod install` writes into `ios/build/generated`: the codegen pods' sources, which a build with its `pod install` skipped needs, and so which neither the seed nor the trim may take. */
const codegenPodspecFile = 'ios/build/generated/ios/ReactCodegen/ReactCodegen.podspec';
const codegenPodspec = 'the codegen pod\'s podspec';
const readCopyCommand = `sh -c 'cat node_modules/pkg/index.js ios/Podfile ios/Pods/Pod/pod.h ${codegenPodspecFile}; test ! -e ${buildOutputFile} && test ! -e ios/build/Products && test ! -e ios/build/Build && echo no-build-output'`;
const carriedContent = `${seededPackageContent}${podFile}pod${codegenPodspec}`;

function readCopyDepsCounter(copy: FlowProject): number {
  return Number(fs.readFileSync(path.join(copy.runnerDirectory, 'deps-counter'), 'utf8').trim());
}

/**
 * The tools of a runner whose disk clones: a `cp` that does `--reflink=always` as the plain copy this box's tmpfs can, first on the PATH of the jobs. A job gets the environment of the `pueue add` that queued it, so the runner's
 * `pueue` is a wrapper that puts the folder first on the PATH. A Debian bash that a job starts reads ~/.bashrc when the environment says «ssh» (SSH_CONNECTION), and a rc file may reset the PATH: the wrapper drops that sign.
 * The runner script finds the daemon next to the `pueue` it is given (`pueued_bin`) and only else on the PATH of the ssh session — which on a CI runner has no `~/.local/bin` (where pueue is installed there), though on a box
 * whose rc files add it the PATH lookup hides the omission: so the wrapper folder holds a `pueued` too.
 */
function createCloningRunnerTools(): { pueueBin: string } {
  const binDir = path.join(layout.root, 'cloning-bin');
  fs.mkdirSync(binDir, { recursive: true });
  const realCp = execFileSync('which', ['cp'], { encoding: 'utf8' }).trim();
  const pueuedBesidePueue = path.join(path.dirname(layout.pueueBin), 'pueued');
  const realPueued = fs.existsSync(pueuedBesidePueue) ? pueuedBesidePueue : execFileSync('which', ['pueued'], { encoding: 'utf8' }).trim();
  const writeTool = (name: string, lines: string[]): void => fs.writeFileSync(path.join(binDir, name), ['#!/bin/bash', ...lines, ''].join('\n'), { mode: 0o755 });
  writeTool('cp', ['arguments=()', 'for argument; do', '  [ "$argument" = --reflink=always ] && argument=--reflink=auto', '  arguments+=("$argument")', 'done', `exec ${realCp} "\${arguments[@]}"`]);
  writeTool('pueue', ['unset SSH_CONNECTION SSH_CLIENT SSH_TTY', `export PATH="${binDir}:$PATH"`, `exec ${layout.pueueBin} "$@"`]);
  writeTool('pueued', [`exec ${realPueued} "$@"`]);
  return { pueueBin: path.join(binDir, 'pueue') };
}

describe('a new project copy is seeded from a sibling copy of the same repository, against a loopback runner', { skip: skipReason }, () => {
  before(async () => {
    await setUpFlow();
    writeRunnersJson(layout, [createRunnerEntry(layout, { pueue: { bin: createCloningRunnerTools().pueueBin, config: layout.pueueConfigPath } })]);
  });
  after(tearDownFlow);

  it('the first copy installs, and holds a package, an Expo app\'s native `ios` and the build output a native build left in them', async () => {
    const first = await run(['echo', 'first copy']);
    assert.equal(first.exitCode, 0, first.stderr);
    assert.match(first.stderr, /installing dependencies:/);
    assert.equal(readDepsCounter(), 1);
    assert.ok(!first.stderr.includes('seeded'), 'the very first copy has nobody to be seeded from');
    const firstTree = path.join(project.runnerDirectory, 'tree');
    const plantedFiles: Array<[string, string]> = [
      ['node_modules/pkg/index.js', seededPackageContent],
      [buildOutputFile, 'a build of the first copy'],
      ['ios/Podfile', podFile],
      ['ios/Pods/Pod/pod.h', 'pod'],
      ['ios/build/Products/app.txt', 'derived data'],
      ['ios/build/Build/Products/Debug/app', 'derived data too'],
      [codegenPodspecFile, codegenPodspec],
    ];
    for (const [relativePath, content] of plantedFiles) {
      fs.mkdirSync(path.dirname(path.join(firstTree, relativePath)), { recursive: true });
      fs.writeFileSync(path.join(firstTree, relativePath), content);
    }
    assert.equal(fs.readFileSync(path.join(project.runnerDirectory, 'project-key'), 'utf8').trim().length, 32, 'the copy knows which repository it is of');
  });

  it('a checkout in a folder of another name is seeded on its first run: the package and the `ios` with its Pods are there, the build output is not, and the dependencies step did not run', async () => {
    const secondCheckout = createProjectClone(layout, project, 'second/lingua');
    assert.notEqual(secondCheckout.runnerDirectory, project.runnerDirectory, 'a copy of its own on the runner');
    const seeded = await run([readCopyCommand], { cwd: secondCheckout.root });
    assert.equal(seeded.exitCode, 0, seeded.stderr);
    assert.match(seeded.stderr, /remote-run: seeded from the copy app-[0-9a-f]+ of this project: 2 folders cloned; its dependencies are the same, so the dependencies step is skipped/);
    assert.ok(!seeded.stderr.includes('installing dependencies'), seeded.stderr);
    assert.match(seeded.stdout, new RegExp(carriedContent), 'the package, the Podfile, the Pods and the codegen pods\' sources came along');
    assert.match(seeded.stdout, /no-build-output/, 'the build output and the derived data of neither did');
    assert.equal(fs.existsSync(path.join(secondCheckout.runnerDirectory, 'deps-counter')), false, 'the dependencies step never ran in the second copy');
    assert.equal(fs.existsSync(path.join(secondCheckout.runnerDirectory, 'seed.tmp')), false);
    assert.equal(fs.readFileSync(path.join(secondCheckout.runnerDirectory, 'seeded-from'), 'utf8').trim(), path.basename(project.runnerDirectory), 'the marks the prune reads');
    assert.equal(fs.existsSync(path.join(project.runnerDirectory, 'seed-shared')), true);
    // The first copy keeps all of it and is free to run again.
    assert.equal(fs.readFileSync(path.join(project.runnerDirectory, 'tree', buildOutputFile), 'utf8'), 'a build of the first copy');
    assert.equal(fs.readFileSync(path.join(project.runnerDirectory, 'tree', 'ios/build/Products/app.txt'), 'utf8'), 'derived data');
    assert.equal(fs.existsSync(path.join(project.runnerDirectory, 'lock')), false);
    const again = await run(['echo', 'first copy again']);
    assert.equal(again.exitCode, 0, again.stderr);
    assert.equal(readDepsCounter(), 1);
  });

  it('a third checkout with another lockfile is seeded too, and its dependencies step still runs on top of the seeded folders', async () => {
    const thirdCheckout = createProjectClone(layout, project, 'third/timeline');
    writeProjectFile(thirdCheckout, 'yarn.lock', '# a lockfile that changed\n');
    const result = await run([readCopyCommand], { cwd: thirdCheckout.root });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stderr, /remote-run: seeded from the copy [a-z]+-[0-9a-f]+ of this project: 2 folders cloned; its dependencies differ, so the dependencies step still runs on top/);
    assert.match(result.stderr, /installing dependencies:/);
    assert.equal(readCopyDepsCounter(thirdCheckout), 1);
    assert.match(result.stdout, new RegExp(carriedContent), 'the folders the seed put there are still there');
    assert.match(result.stdout, /no-build-output/);
    const second = await run([readCopyCommand], { cwd: thirdCheckout.root });
    assert.equal(second.exitCode, 0, second.stderr);
    assert.ok(!second.stderr.includes('seeded') && !second.stderr.includes('installing dependencies'), 'only the first run of a copy seeds it, and an unchanged key runs no step');
  });

  it('another repository in a folder of the SAME name as the first is not seeded from it: it installs from scratch', async () => {
    const lockfile = readProjectFile(project, 'yarn.lock') ?? '';
    const sameNameOtherRepository = createProject(layout, 'fourth/app', {
      '.gitignore': 'node_modules/\nout/\n',
      'package.json': '{ "name": "another-app" }\n',
      'yarn.lock': lockfile,
      'src/a.txt': 'a repository of its own\n',
      '.remote-run': readProjectFile(project, '.remote-run') ?? '',
    });
    assert.equal(path.basename(sameNameOtherRepository.root), path.basename(project.root), 'the same folder name');
    const result = await run(["sh -c 'test ! -e node_modules && test ! -e ios && echo nothing-seeded'"], { cwd: sameNameOtherRepository.root });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /nothing-seeded/);
    assert.match(result.stderr, /installing dependencies:/);
    assert.ok(!result.stderr.includes('seeded'), result.stderr);
    assert.equal(readCopyDepsCounter(sameNameOtherRepository), 1);
  });

  it('the first copy, idle for more than a day, loses the derived data of its `ios/build` — and nothing else — a moment after a submit of another project; its next job says why an iOS build starts from scratch', async () => {
    const runnerDirectory = project.runnerDirectory;
    // The sweeps are detached and niced: one that an earlier submit started may still be walking, and a sweep that is going keeps `prepare` from starting another (one at a time) - then nothing would trim. It is waited for first.
    await waitForDetachedRunToEnd(layout.workDir, 'sweep-tmpdirs');
    const earlierSweepPid = readDetachedRunPid(layout.workDir, 'sweep-tmpdirs');
    const longAgo = new Date(Date.now() - 30 * 60 * 60 * 1000);
    // Idle for 30 hours: its mark of use, and the end of its last jobs (a job that ended within the hour keeps its copy for the results).
    fs.utimesSync(path.join(runnerDirectory, 'used'), longAgo, longAgo);
    for (const jobId of fs.readdirSync(path.join(runnerDirectory, 'jobs'))) {
      const exitFile = path.join(runnerDirectory, 'jobs', jobId, 'exit');
      if (fs.existsSync(exitFile)) fs.utimesSync(exitFile, longAgo, longAgo);
    }
    // The sweep of idle copies runs at most every 6 hours after a `prepare`: its stamp is old.
    const stamp = path.join(layout.workDir, 'tmpdir-sweep.at');
    if (fs.existsSync(stamp)) fs.utimesSync(stamp, longAgo, longAgo);
    const trigger = createProject(layout, 'sixth/trigger', { 'README.md': 'a project that only submits\n' });
    const submitted = await run(['echo', 'another project'], { cwd: trigger.root });
    assert.equal(submitted.exitCode, 0, submitted.stderr);
    // The trim renames the build folders out of the tree first, then writes its note (`build-data-trimmed`), and removes the trash last: «Products is gone» is not the trim being over. And how long the sweep takes is not
    // for the test to guess (it is `nice -n 19`: on a CI runner at a load of 27 it did not finish in 45 s): the test waits for the sweep ITSELF to end.
    const sweepPid = readDetachedRunPid(layout.workDir, 'sweep-tmpdirs');
    assert.ok(sweepPid !== null && sweepPid !== earlierSweepPid, 'the submit started a sweep of its own');
    await waitForDetachedRunToEnd(layout.workDir, 'sweep-tmpdirs');
    const trimNote = path.join(runnerDirectory, 'build-data-trimmed');
    assert.equal(fs.existsSync(trimNote), true, `the sweep is over and left no note: ${fs.readdirSync(runnerDirectory).join(', ')}`);
    assert.deepEqual(fs.readdirSync(runnerDirectory).filter((name) => name.startsWith('build-trash')), [], 'and no trash');
    const firstTree = path.join(runnerDirectory, 'tree');
    assert.equal(fs.existsSync(path.join(firstTree, 'ios', 'build', 'Build')), false, 'all the derived data is gone');
    assert.equal(fs.readFileSync(path.join(firstTree, codegenPodspecFile), 'utf8'), codegenPodspec, 'the codegen pods\' sources are not: the next build, with its `pod install` skipped, needs them');
    assert.equal(fs.readFileSync(path.join(firstTree, 'ios', 'Podfile'), 'utf8'), podFile, 'the sources stay');
    assert.equal(fs.readFileSync(path.join(firstTree, 'ios', 'Pods', 'Pod', 'pod.h'), 'utf8'), 'pod');
    assert.equal(fs.readFileSync(path.join(firstTree, 'node_modules', 'pkg', 'index.js'), 'utf8'), seededPackageContent);
    assert.equal(fs.readFileSync(trimNote, 'utf8').trim(), 'ios/build');
    const next = await run(['echo', 'first copy after the trim']);
    assert.equal(next.exitCode, 0, next.stderr);
    assert.match(next.stderr, /remote-run: the Xcode build data of this copy \(ios\/build\) was removed after it had been idle for 24 hours: an iOS build here starts from scratch/);
    assert.equal(fs.existsSync(trimNote), false, 'said once');
    const again = await run(['echo', 'and again']);
    assert.ok(!again.stderr.includes('Xcode build data'), again.stderr);
  });
});
