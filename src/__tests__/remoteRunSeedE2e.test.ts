/**
 * @description `charness remote-run` at PROCESS level, a NEW project copy seeded from a sibling (`runner.sh` `seed_new_copy`), against a runner made of a throwaway loopback `sshd` and a private Pueue
 * (`remoteRunE2e/remoteRunFlowKit.ts`, `remoteRunFlowHarness.ts`): the built CLI is run as an agent runs it. Two checkouts of one project (another folder, the same name) are two copies on the runner. In order,
 * each step on the state the one before left:
 *
 *   the first copy installs (the dependencies step runs once) and holds a `node_modules` with a package and the build output a native build left in it
 *   → the second copy's first run is seeded from it: the package is there, the build output is not, the dependencies step did not run (the keys are equal), and the first copy still has everything
 *   → a third checkout with another lockfile is seeded too, and its dependencies step still runs on top of the seeded folders, once
 *   → a project of another name is not seeded from it, and installs
 *
 * Needs sshd, ssh, rsync, Pueue and the built CLI (`yarn build`): a local run without them is SKIPPED with the reason, CI (`CI` is `true` or `1`) installs them and fails without. Test case: N/A — Charness has no Jira tracker.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createProject, readProjectFile, type FlowProject } from './remoteRunE2e/remoteRunFlowKit';
import { baseRemoteRunConfig, layout, project, readDepsCounter, run, setUpFlow, skipReason, tearDownFlow } from './remoteRunE2e/remoteRunFlowHarness';

const seededPackageContent = 'installed in the first copy';
const buildOutputFile = 'node_modules/pkg/android/build/outputs/app.aar';
const readPackageCommand = `sh -c 'cat node_modules/pkg/index.js; test ! -e ${buildOutputFile} && echo no-build-output'`;

/** The files of a checkout of the flow's project; the second checkout has the same lockfile, so the same install key. */
function createProjectFiles(lockfile: string): Record<string, string> {
  return {
    '.gitignore': 'node_modules/\nout/\n',
    'package.json': '{ "name": "app" }\n',
    'yarn.lock': lockfile,
    'src/a.txt': 'version A\n',
    '.remote-run': baseRemoteRunConfig,
  };
}

function readCopyDepsCounter(copy: FlowProject): number {
  return Number(fs.readFileSync(path.join(copy.runnerDirectory, 'deps-counter'), 'utf8').trim());
}

describe('a new project copy is seeded from a sibling copy, against a loopback runner', { skip: skipReason }, () => {

  before(setUpFlow);
  after(tearDownFlow);

  it('the first copy installs, and holds a package and the build output a native build left in it', async () => {
    const first = await run(['echo', 'first copy']);
    assert.equal(first.exitCode, 0, first.stderr);
    assert.match(first.stderr, /installing dependencies:/);
    assert.equal(readDepsCounter(), 1);
    assert.ok(!first.stderr.includes('seeded'), 'the very first copy has nobody to be seeded from');
    const firstTree = path.join(project.runnerDirectory, 'tree');
    for (const [relativePath, content] of [['node_modules/pkg/index.js', seededPackageContent], [buildOutputFile, 'a build of the first copy']]) {
      fs.mkdirSync(path.dirname(path.join(firstTree, relativePath)), { recursive: true });
      fs.writeFileSync(path.join(firstTree, relativePath), content);
    }
  });

  it('the second checkout of the project is seeded on its first run: the package is there, the build output is not, and the dependencies step did not run', async () => {
    const lockfile = readProjectFile(project, 'yarn.lock');
    assert.notEqual(lockfile, null);
    const secondCheckout = createProject(layout, 'second/app', createProjectFiles(lockfile ?? ''));
    assert.notEqual(secondCheckout.runnerDirectory, project.runnerDirectory, 'a copy of its own on the runner');
    const seeded = await run([readPackageCommand], { cwd: secondCheckout.root });
    assert.equal(seeded.exitCode, 0, seeded.stderr);
    assert.match(seeded.stderr, /remote-run: seeded from the copy app-[0-9a-f]+ of this project: 1 dependency folder cloned; its dependencies are the same, so the dependencies step is skipped/);
    assert.ok(!seeded.stderr.includes('installing dependencies'), seeded.stderr);
    assert.match(seeded.stdout, new RegExp(seededPackageContent));
    assert.match(seeded.stdout, /no-build-output/, 'the build output of the first copy did not come along');
    assert.equal(fs.existsSync(path.join(secondCheckout.runnerDirectory, 'deps-counter')), false, 'the dependencies step never ran in the second copy');
    assert.equal(fs.existsSync(path.join(secondCheckout.runnerDirectory, 'seed.tmp')), false);
    // The first copy keeps all of it and is free to run again.
    assert.equal(fs.readFileSync(path.join(project.runnerDirectory, 'tree', buildOutputFile), 'utf8'), 'a build of the first copy');
    assert.equal(fs.existsSync(path.join(project.runnerDirectory, 'lock')), false);
    const again = await run(['echo', 'first copy again']);
    assert.equal(again.exitCode, 0, again.stderr);
    assert.equal(readDepsCounter(), 1);
  });

  it('a third checkout with another lockfile is seeded too, and its dependencies step still runs on top of the seeded folders', async () => {
    const thirdCheckout = createProject(layout, 'third/app', createProjectFiles('# a lockfile that changed\n'));
    const result = await run([readPackageCommand], { cwd: thirdCheckout.root });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stderr, /remote-run: seeded from the copy app-[0-9a-f]+ of this project: 1 dependency folder cloned; its dependencies differ, so the dependencies step still runs on top/);
    assert.match(result.stderr, /installing dependencies:/);
    assert.equal(readCopyDepsCounter(thirdCheckout), 1);
    assert.match(result.stdout, new RegExp(seededPackageContent), 'the folders the seed put there are still there');
    assert.match(result.stdout, /no-build-output/);
    const second = await run([readPackageCommand], { cwd: thirdCheckout.root });
    assert.equal(second.exitCode, 0, second.stderr);
    assert.ok(!second.stderr.includes('seeded') && !second.stderr.includes('installing dependencies'), 'only the first run of a copy seeds it, and an unchanged key runs no step');
  });

  it('a project of another name is not seeded from it: it installs from scratch', async () => {
    const lockfile = readProjectFile(project, 'yarn.lock') ?? '';
    const otherProject = createProject(layout, 'other', createProjectFiles(lockfile));
    const result = await run(["sh -c 'test ! -e node_modules && echo nothing-seeded'"], { cwd: otherProject.root });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /nothing-seeded/);
    assert.match(result.stderr, /installing dependencies:/);
    assert.ok(!result.stderr.includes('seeded'), result.stderr);
    assert.equal(readCopyDepsCounter(otherProject), 1);
  });
});
