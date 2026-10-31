/**
 * @description The lease and the interrupt plan: how long a runner waits for a foreground run's heartbeat before it kills the job
 * (production 45 s; the test seam `CHARNESS_TEST_TIMINGS` may only shorten it, never below the floor), how often the caller beats, and
 * which exit code each interrupting signal gives after the remote job is killed.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planInterrupt, remoteRunExitCodes } from '../remoteRun/exitCodes';
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
  it('SIGINT, SIGTERM and SIGHUP end the run with the shell\'s 128 + signal, after the job is killed', () => {
    assert.equal(planInterrupt('SIGINT').exitCode, 130);
    assert.equal(planInterrupt('SIGTERM').exitCode, 143);
    assert.equal(planInterrupt('SIGHUP').exitCode, 129);
    assert.equal(planInterrupt('SIGINT').killGraceSeconds, 10);
  });

  it('the codes remote-run reports itself are the documented ones', () => {
    assert.deepEqual(remoteRunExitCodes, { usage: 2, timedOut: 124, failed: 125, hangup: 129, interrupted: 130, killed: 137, terminated: 143 });
  });
});
