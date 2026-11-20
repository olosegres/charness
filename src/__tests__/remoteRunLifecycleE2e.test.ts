/**
 * @description The `charness remote-run` process-level flow, lifecycle part 1 of 5 — what ends a job when the CALLER goes away. The lifecycle flow is five files that run side by side with the first half (`remoteRunE2e.test.ts`), each with a runner of its own (a throwaway loopback `sshd` and a private Pueue; `remoteRunE2e/remoteRunLifecycleFlow.ts` is what they share): a single file ran 852 s alone on a loaded box, against the 20 minutes a flow may take.
 *
 *   SIGINT, SIGTERM, SIGHUP of a foreground run kill the whole remote job (also a command that ignores SIGTERM)
 *   → a closed stdout (`remote-run … | head`) stops the job and SAYS why, `exec` too; a read-only `ls` just ends
 *   → SIGKILL of a foreground run, and a frozen one (no heartbeat), end the job when the lease runs out
 *
 * "Nothing left" is asserted on real pids: every decoy writes its own pid and its child's.
 *
 * Needs sshd, ssh, rsync, Pueue and the built CLI (`yarn build`): a local run without them is SKIPPED with the reason, CI (`CI` is `true` or `1`) installs them and fails without. Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createChattyDecoyCommand,
  jobStartTimeoutMs,
  startCli,
  waitForPidFile,
  waitUntil,
} from './remoteRunE2e/remoteRunFlowKit';
import {
  flowLeaseMs,
  flowEnv,
  afterInterruptTimeoutMs,
  afterLeaseLostTimeoutMs,
  layout,
  project,
  run,
  registerOpenJobCleanup,
  startDecoyRun,
  waitForExit,
  expectNothingLeft,
  readNewestJobState,
} from './remoteRunE2e/remoteRunFlowHarness';
import { describeLifecycleFlowPart } from './remoteRunE2e/remoteRunLifecycleFlow';

describeLifecycleFlowPart('interrupts and closed streams', () => {
  describe('an interrupted foreground run', () => {
    registerOpenJobCleanup();
    for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
      it(`${signal} kills the whole remote job and ends with ${exitCode}`, async () => {
        const { cli, decoyPid, childPid } = await startDecoyRun(`decoy-${signal.toLowerCase()}`);
        cli.child.kill(signal);
        assert.equal(await waitForExit(cli, afterInterruptTimeoutMs), exitCode, cli.stderr());
        assert.match(cli.stderr(), /interrupted — job box1-[a-z2-7]{6} was stopped on box1/);
        await expectNothingLeft(decoyPid, childPid, 20_000);
        assert.match(await readNewestJobState(), /\bkilled\b/);
      });
    }

    it('a command that ignores SIGTERM is killed after the runner\'s grace time — nothing is left', async () => {
      const { cli, decoyPid, childPid } = await startDecoyRun('decoy-stubborn', { isIgnoringTerm: true });
      const interruptedAt = Date.now();
      cli.child.kill('SIGINT');
      assert.equal(await waitForExit(cli, afterInterruptTimeoutMs), 130, cli.stderr());
      assert.ok(Date.now() - interruptedAt >= 9000, 'the grace time was given before the kill');
      await expectNothingLeft(decoyPid, childPid, 20_000);
    });
  });

  describe('a caller that stops reading', () => {
    registerOpenJobCleanup();
    it('a foreground run whose stdout is closed (piped into `head`) stops its job, says why on stderr and ends with 141 — nothing is left', async () => {
      const name = 'decoy-chatty';
      const cli = startCli(layout, [createChattyDecoyCommand(name)], { cwd: project.root, env: flowEnv });
      const decoyPid = await waitForPidFile(project, `${name}.pid`);
      const childPid = await waitForPidFile(project, `${name}.child`);
      await waitUntil('the first line of the job to arrive', jobStartTimeoutMs, () => cli.stdout().includes('line\n'));
      cli.child.stdout?.destroy();
      assert.equal(await waitForExit(cli, afterInterruptTimeoutMs), 141, cli.stderr());
      assert.match(cli.stderr(), /remote-run: stdout was closed \(what reads it, a pipe into `head` for one, is gone\) — job box1-[a-z2-7]{6} was stopped on box1; to read only a part of a long output, start it with --bg and use `charness remote-run logs box1-[a-z2-7]{6} --tail <lines>`/);
      assert.doesNotMatch(cli.stderr(), /interrupted —|unexpected error|EPIPE/);
      await expectNothingLeft(decoyPid, childPid, 20_000);
      assert.match(await readNewestJobState(), /\bkilled\b/);
    });

    it('`exec` whose stdout is closed stops its command and says why', async () => {
      const name = 'decoy-chatty-exec';
      const cli = startCli(layout, ['exec', createChattyDecoyCommand(name)], { cwd: project.root, env: flowEnv });
      const decoyPid = await waitForPidFile(project, `${name}.pid`);
      const childPid = await waitForPidFile(project, `${name}.child`);
      await waitUntil('the first line of the command to arrive', jobStartTimeoutMs, () => cli.stdout().includes('line\n'));
      cli.child.stdout?.destroy();
      assert.equal(await waitForExit(cli, afterInterruptTimeoutMs), 141, cli.stderr());
      assert.match(cli.stderr(), /remote-run: stdout was closed \(what reads it, a pipe into `head` for one, is gone\) — the command was stopped on box1; /);
      await expectNothingLeft(decoyPid, childPid, 20_000);
    });

    it('`ls`, which owns no job, ends with its own code when its stdout is closed — no crash, no message', async () => {
      const listed = await run(['ls']);
      assert.equal(listed.exitCode, 0, listed.stderr);
      const cli = startCli(layout, ['ls', '--all'], { cwd: project.root, env: flowEnv });
      cli.child.stdout?.destroy();
      const exitCode = await waitForExit(cli, afterInterruptTimeoutMs);
      assert.ok(exitCode === 0 || exitCode === 141, `ended with ${exitCode}; ${cli.stderr()}`);
      assert.doesNotMatch(cli.stderr(), /unexpected error|EPIPE|at .*\.js:/);
    });
  });

  describe('a foreground run that cannot say goodbye', () => {
    registerOpenJobCleanup();
    it('SIGKILL (no handler runs): the runner kills the job when the caller\'s stream ends — nothing is left', async () => {
      const { cli, decoyPid, childPid } = await startDecoyRun('decoy-sigkill');
      cli.child.kill('SIGKILL');
      await waitForExit(cli, 30_000);
      await expectNothingLeft(decoyPid, childPid, afterLeaseLostTimeoutMs);
    });

    it('a frozen run (SIGSTOP: the connection stays open, the heartbeat stops): the lease runs out and the job is killed', async () => {
      const { cli, decoyPid, childPid } = await startDecoyRun('decoy-frozen');
      const frozenAt = Date.now();
      cli.child.kill('SIGSTOP');
      try {
        await expectNothingLeft(decoyPid, childPid, afterLeaseLostTimeoutMs);
        assert.ok(Date.now() - frozenAt >= flowLeaseMs - 1000, `the job died ${Date.now() - frozenAt} ms after the freeze: before its lease of ${flowLeaseMs} ms could have run out`);
      } finally {
        cli.child.kill('SIGKILL');
        await cli.finished;
      }
    });
  });
});
