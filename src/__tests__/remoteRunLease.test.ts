/**
 * @description The lease and the interrupt plan: how long a runner waits for a foreground run's heartbeat before it kills the job
 * (production 45 s; the test seam `CHARNESS_TEST_TIMINGS` may only shorten it, never below the floor), how often the caller beats, and
 * which exit code each interrupting signal gives after the remote job is killed.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { killGraceSeconds, planInterrupt, remoteRunExitCodes, simulatorShutdownGraceSeconds } from '../remoteRun/exitCodes';
import { killCallTimeoutMs } from '../remoteRun/interrupts';
import { getHeartbeatIntervalMs, readRemoteRunLeaseMs, remoteRunLeaseMinMs, remoteRunLeaseMs } from '../remoteRun/leaseTiming';
import { testTimingsEnvName } from '../testTimings';

const env = (value: string | undefined): NodeJS.ProcessEnv => (value === undefined ? {} : { [testTimingsEnvName]: value });

describe('readRemoteRunLeaseMs', () => {
  it('production without the seam: 45 s, beats of 5 s', () => {
    assert.equal(readRemoteRunLeaseMs(env(undefined)), 45_000);
    assert.equal(remoteRunLeaseMs, 45_000);
    assert.equal(getHeartbeatIntervalMs(45_000), 5000);
  });

  it('a shorter value of the seam is taken', () => {
    assert.equal(readRemoteRunLeaseMs(env(JSON.stringify({ remoteRunLeaseMs: 4000 }))), 4000);
    assert.equal(readRemoteRunLeaseMs(env(JSON.stringify({ remoteRunLeaseMs: remoteRunLeaseMinMs }))), remoteRunLeaseMinMs);
  });

  it('anything else keeps the production lease: unset, blank, not JSON, no key, a longer or shorter-than-floor value, not a whole number', () => {
    for (const value of [undefined, '', '  ', '{nope', '[]', '{}', JSON.stringify({ remoteRunLeaseMs: 45_001 }), JSON.stringify({ remoteRunLeaseMs: remoteRunLeaseMinMs - 1 }), JSON.stringify({ remoteRunLeaseMs: 4000.5 }), JSON.stringify({ remoteRunLeaseMs: '4000' }), JSON.stringify({ otherKey: 4000 })]) {
      assert.equal(readRemoteRunLeaseMs(env(value)), 45_000, String(value));
    }
  });

  it('beats several times per lease, so one lost beat never kills a healthy job', () => {
    for (const lease of [3000, 4000, 45_000]) assert.ok(getHeartbeatIntervalMs(lease) * 3 <= lease, String(lease));
  });
});

describe('planInterrupt', () => {
  it('SIGINT, SIGTERM, SIGHUP and SIGPIPE (a closed stdout) end the run with the shell\'s 128 + signal, after the job is killed', () => {
    assert.equal(planInterrupt('SIGINT').exitCode, 130);
    assert.equal(planInterrupt('SIGTERM').exitCode, 143);
    assert.equal(planInterrupt('SIGHUP').exitCode, 129);
    assert.equal(planInterrupt('SIGPIPE').exitCode, 141);
    assert.equal(planInterrupt('SIGINT').killGraceSeconds, 10);
  });

  it('the codes remote-run reports itself are the documented ones', () => {
    assert.deepEqual(remoteRunExitCodes, { usage: 2, timedOut: 124, failed: 125, hangup: 129, interrupted: 130, killed: 137, brokenPipe: 141, terminated: 143 });
  });
});

describe('the hub\'s kill call against the runner\'s kill', () => {
  const script = fs.readFileSync(path.resolve(__dirname, '..', '..', 'remoteRun', 'runner.sh'), 'utf8');
  const readRunnerSeconds = (name: string): number => Number(new RegExp(`^${name}=(\\d+)$`, 'm').exec(script)?.[1]);

  it('the numbers the hub keeps are the runner script\'s own: the grace after SIGTERM, and what a job shutting its Simulator down is given on top', () => {
    assert.equal(killGraceSeconds, readRunnerSeconds('kill_grace_sec'));
    assert.equal(simulatorShutdownGraceSeconds, readRunnerSeconds('ios_device_shutdown_sec') + readRunnerSeconds('simulator_shutdown_slack_sec'));
  });

  it('a kill call is given longer than the runner\'s worst case - the grace, the Simulator shutdown with its slack, and the second the runner sleeps after a hard kill - so a slow shutdown is not reported as a failed kill', () => {
    const runnerWorstCaseSeconds = readRunnerSeconds('kill_grace_sec') + readRunnerSeconds('ios_device_shutdown_sec') + readRunnerSeconds('simulator_shutdown_slack_sec') + 1;
    assert.ok(killCallTimeoutMs / 1000 > runnerWorstCaseSeconds, `${killCallTimeoutMs / 1000} s against ${runnerWorstCaseSeconds} s`);
  });
});
