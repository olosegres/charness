/**
 * @description The `charness remote-run` process-level flow, lifecycle part 4 of 5 (see `remoteRunLifecycleE2e.test.ts`) — `exec`: it runs in the copy of the project's latest job (in the right subfolder, on the runner of the LAST job when there are several) and is killed like a foreground job.
 *
 * "Nothing left" is asserted on real pids: every decoy writes its own pid and its child's.
 *
 * Needs sshd, ssh, rsync, Pueue and the built CLI (`yarn build`): a local run without them is SKIPPED with the reason, CI (`CI` is `true` or `1`) installs them and fails without. Test case: N/A — Charness has no Jira tracker.
 */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createDecoyCommand,
  createRunnerEntry,
  startCli,
  waitForPidFile,
  writeProjectFile,
  writeRunnersJson,
} from './remoteRunE2e/remoteRunFlowKit';
import {
  flowEnv,
  afterInterruptTimeoutMs,
  layout,
  project,
  run,
  registerOpenJobCleanup,
  waitForExit,
  expectNothingLeft,
} from './remoteRunE2e/remoteRunFlowHarness';
import { describeLifecycleFlowPart } from './remoteRunE2e/remoteRunLifecycleFlow';

describeLifecycleFlowPart('exec', () => {
  describe('exec', () => {
    registerOpenJobCleanup();
    // exec runs in the copy the last job left: make one, with a folder of the runner's own in it, instead of relying on earlier steps.
    before(async () => {
      writeProjectFile(project, 'src/a.txt', 'version A\n');
      assert.equal((await run(['true'])).exitCode, 0);
      fs.mkdirSync(path.join(project.runnerDirectory, 'tree', 'node_modules'), { recursive: true });
    });

    it('runs in the runner\'s copy as the last job left it, and passes the command\'s code', async () => {
      const listed = await run(['exec', 'ls']);
      assert.equal(listed.exitCode, 0, listed.stderr);
      assert.match(listed.stdout, /^src$/m);
      assert.match(listed.stdout, /^node_modules$/m, 'the runner\'s own folder is there');
      const content = await run(['exec', 'cat src/a.txt']);
      assert.match(content.stdout, /version A/);
      const failing = await run(['exec', "sh -c 'echo to-stderr >&2; exit 9'"]);
      assert.equal(failing.exitCode, 9);
      assert.match(failing.stderr, /to-stderr/, 'exec keeps stderr apart');
      assert.ok(!failing.stderr.includes('\u001e'), 'and shows nothing of the exit marker');
      const exits255 = await run(['exec', "sh -c 'echo before; exit 255'"]);
      assert.equal(exits255.exitCode, 255, 'a command that really exits 255 keeps its code — it is not a lost connection');
      assert.ok(!exits255.stderr.includes('connection'), exits255.stderr);
    });

    it('is killed like a foreground job: SIGINT ends it and the command with everything it started', async () => {
      const cli = startCli(layout, ['exec', createDecoyCommand('decoy-exec')], { cwd: project.root, env: flowEnv });
      const decoyPid = await waitForPidFile(project, 'decoy-exec.pid');
      const childPid = await waitForPidFile(project, 'decoy-exec.child');
      cli.child.kill('SIGINT');
      assert.equal(await waitForExit(cli, afterInterruptTimeoutMs), 130, cli.stderr());
      await expectNothingLeft(decoyPid, childPid, 20_000);
    });

    it('in a subfolder of the project it runs in that subfolder of the copy', async () => {
      writeProjectFile(project, 'packages/lib/marker.txt', 'in a subfolder\n');
      const result = await run(['sh -c pwd'], { cwd: path.join(project.root, 'packages/lib') });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.ok(result.stdout.trim().endsWith('/tree/packages/lib'), result.stdout);
      const viaExec = await run(['exec', 'cat marker.txt'], { cwd: path.join(project.root, 'packages/lib') });
      assert.match(viaExec.stdout, /in a subfolder/);
    });

    it('with several runners and no --runner it goes to the runner of the project\'s LAST job — not to the first one in the file, which holds another copy', async () => {
      // A second runner on the same sshd and Pueue, with a work dir of its own: its copy of the project is a different folder.
      const secondWorkDir = path.join(layout.root, 'work-second');
      writeRunnersJson(layout, [createRunnerEntry(layout), createRunnerEntry(layout, { name: 'box2', workDir: secondWorkDir })]);
      try {
        const ranOnSecond = await run(['--runner', 'box2', 'true']);
        assert.equal(ranOnSecond.exitCode, 0, ranOnSecond.stderr);
        const onSecond = await run(['exec', 'pwd']);
        assert.equal(onSecond.exitCode, 0, onSecond.stderr);
        assert.ok(onSecond.stdout.trim().startsWith(`${secondWorkDir}/`), `exec ran in ${onSecond.stdout.trim()}, not in the copy on box2`);
        const ranOnFirst = await run(['--runner', 'box1', 'true']);
        assert.equal(ranOnFirst.exitCode, 0, ranOnFirst.stderr);
        const onFirst = await run(['exec', 'pwd']);
        assert.ok(onFirst.stdout.trim().startsWith(`${layout.workDir}/`), `after a job on box1, exec ran in ${onFirst.stdout.trim()}`);
        const named = await run(['exec', '--runner', 'box2', 'pwd']);
        assert.ok(named.stdout.trim().startsWith(`${secondWorkDir}/`), '--runner still names the runner');
      } finally {
        writeRunnersJson(layout, [createRunnerEntry(layout)]);
      }
    });
  });
});
