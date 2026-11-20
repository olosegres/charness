/**
 * @description The `charness remote-run` process-level flow, lifecycle part 3 of 5 (see `remoteRunLifecycleE2e.test.ts`) — `kill`: of a job that already finished, of one killed while queued (Pueue hands its task number to another job), of a command that ignores SIGTERM (SIGKILLed after the grace time, its exit recorded — 137, and 124 for the limit), the lock of such a job passing to the jobs queued behind it one at a time, and of a plain background job.
 *
 * "Nothing left" is asserted on real pids: every decoy writes its own pid and its child's.
 *
 * Needs sshd, ssh, rsync, Pueue and the built CLI (`yarn build`): a local run without them is SKIPPED with the reason, CI (`CI` is `true` or `1`) installs them and fails without. Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createDecoyCommand,
  createGatedCommand,
  openGate,
  waitForPidFile,
  waitUntil,
} from './remoteRunE2e/remoteRunFlowKit';
import {
  runnerScriptPath,
  layout,
  project,
  readJobId,
  run,
  registerOpenJobCleanup,
  expectNothingLeft,
  readNewestJobState,
} from './remoteRunE2e/remoteRunFlowHarness';
import { describeLifecycleFlowPart, decoyLimitSeconds } from './remoteRunE2e/remoteRunLifecycleFlow';

describeLifecycleFlowPart('kill', () => {
  describe('kill', () => {
    registerOpenJobCleanup();
    it('`kill` of a job that has already finished says it had already ended, with its exit code — and does not mark it killed', async () => {
      const finishedId = readJobId(await run(['--bg', "sh -c 'exit 3'"]));
      assert.equal((await run(['wait', finishedId])).exitCode, 3);
      const killed = await run(['kill', finishedId]);
      assert.equal(killed.exitCode, 0, killed.stderr);
      assert.match(killed.stderr, new RegExp(`job ${finishedId} had already ended \\(exit 3\\) — nothing to kill`));
      assert.ok(!/ killed\s*$/.test(killed.stderr.trim()), killed.stderr);
      assert.match(await readNewestJobState(), /failed/, 'it is still the failed job it was');
    });

    it('a job killed while queued: Pueue gives its task number to the next job, and `wait` / `logs -f` of the killed job still end at once with its own 137 instead of following the other job', async () => {
      const holder = readJobId(await run(['--bg', '--group', 'emulator', createGatedCommand('gate-reuse', { before: 'echo started > ../reuse-holder-started', after: 'true' })]));
      await waitUntil('the holder to hold the emulator group', 60_000, () => fs.existsSync(path.join(project.runnerDirectory, 'reuse-holder-started')));
      const killedId = readJobId(await run(['--bg', '--group', 'emulator', 'true']));
      assert.match((await run(['status', killedId])).stdout, /— queued/, 'it waits behind the holder');
      assert.equal((await run(['kill', killedId])).exitCode, 0);
      const nextId = readJobId(await run(['--bg', '--group', 'emulator', 'true']));
      const readTaskNumber = (id: string): string => fs.readFileSync(path.join(project.runnerDirectory, 'jobs', id, 'task-id'), 'utf8').trim();
      assert.equal(readTaskNumber(nextId), readTaskNumber(killedId), 'the setup: Pueue gave the freed number to the next job');

      // The next job is queued behind the closed gate for as long as this test wants: a wait that follows its number cannot return.
      const waited = await run(['wait', killedId], { timeoutMs: 30_000 });
      assert.equal(waited.exitCode, 137, `wait followed the other job instead of ending: ${waited.stderr}`);
      const followed = await run(['logs', '-f', killedId], { timeoutMs: 30_000 });
      assert.equal(followed.exitCode, 0, followed.stderr);
      assert.match(await readNewestJobState(), /queued/, 'and the next job is still waiting behind the holder');

      // Whose number is whose, as the runner script asks Pueue itself (the real status output, not a stand-in for it).
      const ask = (taskNumber: string, jobName: string): number | null => spawnSync('bash', ['-c', `source ${runnerScriptPath}; check_task_belongs_to_job ${taskNumber} ${jobName}`], {
        env: { ...process.env, PUEUE_BIN: layout.pueueBin, PUEUE_CONFIG: layout.pueueConfigPath },
        timeout: 30_000,
      }).status;
      assert.equal(ask(readTaskNumber(nextId), nextId), 0, 'the number is the next job\'s');
      assert.notEqual(ask(readTaskNumber(killedId), killedId), 0, 'and not the killed job\'s, whose record still holds it');

      openGate(project, 'gate-reuse');
      assert.equal((await run(['wait', holder])).exitCode, 0);
      assert.equal((await run(['wait', nextId])).exitCode, 0, 'the next job runs as any other');
    });

    it('a command that ignores SIGTERM is SIGKILLed after the grace time and still ends as an ENDED job: its exit is recorded — 137 for `kill`, 124 for the time limit — so prune can remove it', async () => {
      const killedId = readJobId(await run(['--bg', createDecoyCommand('decoy-stubborn-killed', { isIgnoringTerm: true })]));
      const killedPid = await waitForPidFile(project, 'decoy-stubborn-killed.pid');
      const killedChild = await waitForPidFile(project, 'decoy-stubborn-killed.child');
      assert.equal((await run(['kill', killedId])).exitCode, 0);
      await expectNothingLeft(killedPid, killedChild, 30_000);
      assert.equal(fs.readFileSync(path.join(project.runnerDirectory, 'jobs', killedId, 'exit'), 'utf8').trim(), '137', 'the kill is on record');
      assert.equal((await run(['wait', killedId])).exitCode, 137);

      const limitedId = readJobId(await run(['--bg', '--timeout', `${decoyLimitSeconds}s`, createDecoyCommand('decoy-stubborn-limited', { isIgnoringTerm: true })]));
      const limitedPid = await waitForPidFile(project, 'decoy-stubborn-limited.pid');
      const limitedChild = await waitForPidFile(project, 'decoy-stubborn-limited.child');
      const waited = await run(['wait', limitedId]);
      assert.equal(waited.exitCode, 124, waited.stderr);
      await expectNothingLeft(limitedPid, limitedChild, 30_000);
      assert.equal(fs.readFileSync(path.join(project.runnerDirectory, 'jobs', limitedId, 'exit'), 'utf8').trim(), '124', 'the limit\'s kill is on record');
    });

    it('the lock of a job that had to be SIGKILLed passes to the jobs queued behind it ONE at a time — two of them never run on the project together', async () => {
      const holder = readJobId(await run(['--bg', createDecoyCommand('decoy-lockholder', { isIgnoringTerm: true })]));
      const holderPid = await waitForPidFile(project, 'decoy-lockholder.pid');
      const holderChild = await waitForPidFile(project, 'decoy-lockholder.child');
      const section = "sh -c 'echo start >> ../lock-sections; sleep 2; echo end >> ../lock-sections'";
      const first = readJobId(await run(['--bg', section]));
      const second = readJobId(await run(['--bg', section]));
      // Both wait for the holder's project without a Pueue slot: stashed (the runner's mark in the job's folder).
      for (const waiting of [first, second]) {
        await waitUntil(`${waiting} to be stashed behind the holder`, 60_000, () => fs.existsSync(path.join(project.runnerDirectory, 'jobs', waiting, 'stashed')));
      }
      // The holder ignores SIGTERM: after the grace time it is SIGKILLed. It cannot give the lock back, nor enqueue its successor — the `kill` that SIGKILLed it does: the first job goes, finds a dead holder's lock and takes it,
      // and the second is enqueued by the first one's end.
      assert.equal((await run(['kill', holder])).exitCode, 0);
      await expectNothingLeft(holderPid, holderChild, 30_000);
      assert.equal((await run(['wait', first])).exitCode, 0);
      assert.equal((await run(['wait', second])).exitCode, 0);
      const sections = fs.readFileSync(path.join(project.runnerDirectory, 'lock-sections'), 'utf8').split('\n').filter((line) => line !== '');
      assert.deepEqual(sections, ['start', 'end', 'start', 'end'], 'each ran alone, one after the other');
    });

    it('`kill <id>` of a background job leaves nothing; `wait` then gives 137', async () => {
      const jobId = readJobId(await run(['--bg', createDecoyCommand('decoy-killed')]));
      const decoyPid = await waitForPidFile(project, 'decoy-killed.pid');
      const childPid = await waitForPidFile(project, 'decoy-killed.child');
      const killed = await run(['kill', jobId]);
      assert.equal(killed.exitCode, 0, killed.stderr);
      await expectNothingLeft(decoyPid, childPid, 20_000);
      const waited = await run(['wait', jobId]);
      assert.equal(waited.exitCode, 137, waited.stderr);
      const status = await run(['status', jobId]);
      assert.match(status.stdout, new RegExp(`^job ${jobId} — killed \\(exit 137\\)`));
    });
  });
});
