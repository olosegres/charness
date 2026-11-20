/**
 * @description The `charness remote-run` process-level flow, lifecycle part 2 of 5 (see `remoteRunLifecycleE2e.test.ts`) — time limits: `--timeout` of a foreground and of a background job, the limit counted from the moment a job is queued (a background and a foreground job that waited it out behind a busy group).
 *
 * "Nothing left" is asserted on real pids: every decoy writes its own pid and its child's.
 *
 * Needs sshd, ssh, rsync, Pueue and the built CLI (`yarn build`): a local run without them is SKIPPED with the reason, CI (`CI` is `true` or `1`) installs them and fails without. Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
  project,
  readJobId,
  run,
  registerOpenJobCleanup,
  expectNothingLeft,
  readNewestJobState,
} from './remoteRunE2e/remoteRunFlowHarness';
import { describeLifecycleFlowPart, decoyLimitSeconds } from './remoteRunE2e/remoteRunLifecycleFlow';

describeLifecycleFlowPart('time limits', () => {
  describe('time limits', () => {
    registerOpenJobCleanup();
    it('`--timeout` of a foreground run: 124, and nothing is left', async () => {
      const decoy = createDecoyCommand('decoy-timeout');
      const result = await run(['--timeout', `${decoyLimitSeconds}s`, decoy]);
      assert.equal(result.exitCode, 124, result.stderr);
      assert.match(result.stderr, new RegExp(`timed out after ${decoyLimitSeconds}s`));
      await expectNothingLeft(await waitForPidFile(project, 'decoy-timeout.pid'), await waitForPidFile(project, 'decoy-timeout.child'), 20_000);
    });

    it('`--timeout` of a background job is the runner\'s own watchdog: `wait` gives 124 and nothing is left', async () => {
      const jobId = readJobId(await run(['--bg', '--timeout', `${decoyLimitSeconds}s`, createDecoyCommand('decoy-bgtimeout')]));
      const decoyPid = await waitForPidFile(project, 'decoy-bgtimeout.pid');
      const childPid = await waitForPidFile(project, 'decoy-bgtimeout.child');
      const waited = await run(['wait', jobId]);
      assert.equal(waited.exitCode, 124, waited.stderr);
      assert.match(waited.stderr, /the job timed out and was killed/);
      await expectNothingLeft(decoyPid, childPid, 20_000);
      assert.match(await readNewestJobState(), /timed out/);
    });

    it('the limit counts from the moment a job is queued: a `--bg` job that waited it out behind a busy group is over when it starts, and never runs', async () => {
      const holder = readJobId(await run(['--bg', '--group', 'emulator', createGatedCommand('gate-qlimit', { before: 'echo started > ../qlimit-holder-started', after: 'true' })]));
      await waitUntil('the holder to hold the emulator group', 60_000, () => fs.existsSync(path.join(project.runnerDirectory, 'qlimit-holder-started')));
      const limitSeconds = 6;
      const waiting = readJobId(await run(['--bg', '--group', 'emulator', '--timeout', `${limitSeconds}s`, "sh -c 'touch ../qlimit-waiting-ran'"]));
      // Counted from the moment the runner queued it (staging takes a variable time), not from when this test asked.
      const queuedAtFile = path.join(project.runnerDirectory, 'jobs', waiting, 'queued-at');
      await waitUntil('the limit to run out while the job is still queued', 60_000, () => fs.existsSync(queuedAtFile) && Date.now() / 1000 - Number(fs.readFileSync(queuedAtFile, 'utf8').trim()) > limitSeconds + 2);
      assert.match((await run(['status', waiting])).stdout, /— queued/, 'it is still waiting for the group');
      openGate(project, 'gate-qlimit');
      assert.equal((await run(['wait', holder])).exitCode, 0);
      const waited = await run(['wait', waiting]);
      assert.equal(waited.exitCode, 124, waited.stderr);
      assert.match(waited.stderr, /the job timed out and was killed/);
      assert.equal(fs.existsSync(path.join(project.runnerDirectory, 'qlimit-waiting-ran')), false, 'its command never ran');
      assert.match(await readNewestJobState(), /timed out/);
    });

    it('a foreground run that waited behind a busy group until its limit ran out is recorded as TIMED OUT — the same word its exit code 124 says — not as killed', async () => {
      const holder = readJobId(await run(['--bg', '--group', 'emulator', createGatedCommand('gate-fglimit', { before: 'echo started > ../fglimit-holder-started', after: 'true' })]));
      await waitUntil('the holder to hold the emulator group', 60_000, () => fs.existsSync(path.join(project.runnerDirectory, 'fglimit-holder-started')));
      // Nothing runs on the runner for this job yet, so only the CLI's own timer can end it — and it used to record a plain kill.
      const queued = await run(['--group', 'emulator', '--timeout', '4s', 'true'], { timeoutMs: 90_000 });
      assert.equal(queued.exitCode, 124, queued.stderr);
      assert.match(queued.stderr, /timed out after 4s/);
      assert.match(await readNewestJobState(), /timed out/, 'ls says timed out, as the exit code does');
      openGate(project, 'gate-fglimit');
      assert.equal((await run(['wait', holder])).exitCode, 0);
    });
  });
});
