/**
 * @description The `charness remote-run` process-level flow, lifecycle part 5 of 5 (see `remoteRunLifecycleE2e.test.ts`) — `clean` refuses a copy a job or an `exec` is using and removes it (saying what it freed) once nothing is; `clean-after-success:` of `.remote-run` empties the named folders of the copy after a job that succeeded — and only then.
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
  type FlowProject,
  createDecoyCommand,
  createProject,
  startCli,
  waitForPidFile,
  waitUntil,
  writeProjectFile,
} from './remoteRunE2e/remoteRunFlowKit';
import {
  flowEnv,
  afterInterruptTimeoutMs,
  layout,
  readJobId,
  run,
  registerOpenJobCleanup,
  waitForExit,
  expectNothingLeft,
} from './remoteRunE2e/remoteRunFlowHarness';
import { describeLifecycleFlowPart } from './remoteRunE2e/remoteRunLifecycleFlow';

describeLifecycleFlowPart('clean', () => {
  describe('clean', () => {
    registerOpenJobCleanup();
    // A project of its own: the copy of a project folder is shared by everything run from it, and the jobs the other steps of this flow left in the flow's project (killed, never fetched) would — rightly — keep it.
    let cleanProject: FlowProject;
    const runHere = (args: string[]): ReturnType<typeof run> => run(args, { cwd: cleanProject.root });
    before(() => {
      cleanProject = createProject(layout, 'clean-app', { 'src/a.txt': 'version A\n' });
    });
    /** The copy of this project on the runner: made (again) by a foreground job. */
    async function makeCopy(): Promise<void> {
      writeProjectFile(cleanProject, 'src/a.txt', 'version A\n');
      assert.equal((await runHere(['true'])).exitCode, 0);
      assert.ok(fs.existsSync(path.join(cleanProject.runnerDirectory, 'tree', 'src', 'a.txt')));
    }
    /** A background job that runs on a decoy and is killed: ended (137), its results not fetched by anybody. */
    async function startAndKillBackgroundJob(name: string): Promise<string> {
      const jobId = readJobId(await runHere(['--bg', createDecoyCommand(name)]));
      const decoyPid = await waitForPidFile(cleanProject, `${name}.pid`);
      const childPid = await waitForPidFile(cleanProject, `${name}.child`);
      const refused = await runHere(['clean']);
      assert.equal(refused.exitCode, 125, refused.stderr);
      assert.match(refused.stdout, new RegExp(`^box1: NOT cleaned — ${jobId} is running in it`, 'm'));
      assert.ok(fs.existsSync(path.join(cleanProject.runnerDirectory, 'tree', 'src', 'a.txt')), 'the copy is untouched');
      assert.equal((await runHere(['kill', jobId])).exitCode, 0);
      await expectNothingLeft(decoyPid, childPid, 20_000);
      return jobId;
    }

    it('right after a foreground run it takes the copy and says what it freed — the run has handed over its results, so nothing keeps the copy — and a second clean has nothing to do; the next run sends the project afresh', async () => {
      await makeCopy();
      const cleaned = await runHere(['clean']);
      assert.equal(cleaned.exitCode, 0, cleaned.stderr);
      assert.match(cleaned.stdout, /^box1: removed the project copy \S+( \(freed [0-9.]+ GB\))?$/m);
      assert.equal(fs.existsSync(cleanProject.runnerDirectory), false, 'nothing of the copy is left on the runner');
      const again = await runHere(['clean']);
      assert.equal(again.exitCode, 0, again.stderr);
      assert.match(again.stdout, /^box1: no copy of \S+ \(nothing to clean\)$/m);
      const rerun = await runHere(['cat src/a.txt']);
      assert.equal(rerun.exitCode, 0, rerun.stderr);
      assert.match(rerun.stdout, /version A/);
    });

    it('is refused, naming the job, while a job of the project runs; once it is killed its results are still nobody\'s until `wait` fetches them — then the copy goes', async () => {
      await makeCopy();
      const jobId = await startAndKillBackgroundJob('decoy-clean');
      const unfetched = await runHere(['clean']);
      assert.equal(unfetched.exitCode, 125, unfetched.stderr);
      assert.match(unfetched.stdout, new RegExp(`^box1: NOT cleaned — ${jobId} ended less than an hour ago and its results were not fetched`, 'm'));
      assert.ok(fs.existsSync(path.join(cleanProject.runnerDirectory, 'jobs', jobId, 'log')), 'and the job\'s log is still there to be read');
      assert.equal((await runHere(['wait', jobId])).exitCode, 137);
      const cleaned = await runHere(['clean']);
      assert.equal(cleaned.exitCode, 0, cleaned.stderr);
      assert.match(cleaned.stdout, /^box1: removed the project copy /m);
      assert.equal(fs.existsSync(cleanProject.runnerDirectory), false);
    });

    it('`fetch` hands the results over too: the copy of a job that was killed and fetched goes', async () => {
      await makeCopy();
      const jobId = await startAndKillBackgroundJob('decoy-clean-fetch');
      assert.equal((await runHere(['clean'])).exitCode, 125);
      const fetched = await runHere(['fetch', jobId]);
      assert.equal(fetched.exitCode, 0, fetched.stderr);
      const cleaned = await runHere(['clean']);
      assert.equal(cleaned.exitCode, 0, cleaned.stderr);
      assert.match(cleaned.stdout, /^box1: removed the project copy /m);
    });

    it('is refused while an `exec` runs in the copy, and removes it once the exec has ended', async () => {
      await makeCopy();
      const cli = startCli(layout, ['exec', createDecoyCommand('decoy-clean-exec')], { cwd: cleanProject.root, env: flowEnv });
      const decoyPid = await waitForPidFile(cleanProject, 'decoy-clean-exec.pid');
      const childPid = await waitForPidFile(cleanProject, 'decoy-clean-exec.child');
      const refused = await runHere(['clean']);
      assert.equal(refused.exitCode, 125, refused.stderr);
      assert.match(refused.stdout, /^box1: NOT cleaned — an `exec` is running in it/m);
      assert.ok(fs.existsSync(path.join(cleanProject.runnerDirectory, 'tree')), 'the copy is untouched');
      cli.child.kill('SIGINT');
      assert.equal(await waitForExit(cli, afterInterruptTimeoutMs), 130, cli.stderr());
      await expectNothingLeft(decoyPid, childPid, 20_000);
      await waitUntil('the exec to take its marker out of the copy', 20_000, () => (fs.readdirSync(cleanProject.runnerDirectory).some((name) => name.startsWith('exec.')) ? null : true));
      const cleaned = await runHere(['clean']);
      assert.equal(cleaned.exitCode, 0, cleaned.stderr);
      assert.match(cleaned.stdout, /^box1: removed the project copy /m);
      assert.equal(fs.existsSync(cleanProject.runnerDirectory), false);
    });
  });

  describe('clean-after-success', () => {
    registerOpenJobCleanup();
    // A project of its own: its `.remote-run` names the folder, and its copy is not shared with the other steps of this flow.
    let buildProject: FlowProject;
    const runHere = (args: string[]): ReturnType<typeof run> => run(args, { cwd: buildProject.root });
    const buildCommand = 'mkdir -p build/Intermediates.noindex build/Products && echo object > build/Intermediates.noindex/o.o && echo app > build/Products/app.txt';
    const getRunnerPath = (relativePath: string): string => path.join(buildProject.runnerDirectory, 'tree', relativePath);
    before(() => {
      buildProject = createProject(layout, 'clean-after-app', { 'src/a.txt': 'version A\n', '.remote-run': 'clean-after-success: build/Intermediates.noindex\n' });
    });

    it('a job that fails keeps what it built in the runner\'s copy — it is what a person looks at to find out why', async () => {
      const failed = await runHere([`${buildCommand} && exit 3`]);
      assert.equal(failed.exitCode, 3, failed.stderr);
      assert.ok(fs.existsSync(getRunnerPath('build/Intermediates.noindex/o.o')), 'the intermediates of the failed job are still there');
      assert.ok(fs.existsSync(getRunnerPath('build/Products/app.txt')));
    });

    it('a job that succeeds leaves the copy without the folder the project named (also what an earlier, failed job left in it) — the rest stays for the next job', async () => {
      const succeeded = await runHere([buildCommand]);
      assert.equal(succeeded.exitCode, 0, succeeded.stderr);
      assert.match(succeeded.stderr, /remote-run: clean-after-success: removing what the project names from the copy now/, 'the run says the removal is under way (on stderr, as the runner\'s own lines are); the count, after the result, is in the job\'s log');
      // The job's result is recorded BEFORE the removal starts (a run does not wait for it), so the folder goes a moment after the run has returned.
      await waitUntil('the named folder to be removed', 20_000, () => (fs.existsSync(getRunnerPath('build/Intermediates.noindex')) ? null : true));
      assert.ok(fs.existsSync(getRunnerPath('build/Products/app.txt')), 'the products are not named, so they stay');
      assert.ok(fs.existsSync(getRunnerPath('src/a.txt')), 'and so does the project');
      const next = await runHere(['cat build/Products/app.txt']);
      assert.equal(next.exitCode, 0, next.stderr);
      assert.match(next.stdout, /^app$/m, 'the next job finds the copy as it was left');
    });
  });
});
