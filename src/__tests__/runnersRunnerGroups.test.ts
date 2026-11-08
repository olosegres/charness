/**
 * @description `runners/runnerGroups.ts`: a changed «jobs at once» is told to a paired runner NOW (`runner.sh apply-groups`), not left to the next job's
 * `prepare`. The outcome is told, never thrown: `applied`, `offline` (the link is down — nothing is sent; or ssh could not reach it), `failed` (the
 * runner answered with an error or not at all within the deadline). What is sent is the registry's number as the `default` group's limit.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { RunnerUnreachableError } from '../remoteRun/remoteRunError';
import type { RunnerConfig } from '../remoteRun/runnersConfig';
import type { SshRunResult } from '../remoteRun/ssh';
import { applyRunnerGroups, type RunnerGroupsDeps } from '../runners/runnerGroups';
import { createPairedRunnerFixture } from './remoteRunPairedKit';
import { createHubFixture, type HubFixture } from './runnersTestKit';

let hub: HubFixture;
let logged: string[];
let calls: Array<{ subcommand: string; args: readonly string[]; hasSignal: boolean; timeoutMs: number | undefined }>;
let configs: RunnerConfig[];
let scriptChecks: number;

function createDeps(options: { isOnline?: boolean; result?: SshRunResult; callError?: Error; scriptError?: Error }): RunnerGroupsDeps {
  return {
    isLinkOnline: async () => options.isOnline ?? true,
    createClient: (config) => {
      configs.push(config);
      return {
        ensureScript: async () => {
          scriptChecks += 1;
          if (options.scriptError !== undefined) throw options.scriptError;
        },
        call: async (subcommand, args, callOptions) => {
          calls.push({ subcommand, args, hasSignal: callOptions?.signal !== undefined, timeoutMs: callOptions?.timeoutMs });
          if (options.callError !== undefined) throw options.callError;
          return options.result ?? { exitCode: 0, stdout: '', stderr: '', isTimedOut: false };
        },
      };
    },
    log: (line) => { logged.push(line); },
  };
}

beforeEach(() => {
  hub = createHubFixture();
  logged = [];
  calls = [];
  configs = [];
  scriptChecks = 0;
});
afterEach(() => {
  hub.cleanup();
});

describe('applying a runner\'s jobs-at-once limit', () => {
  it('an online runner is sent `apply-groups` with its default group\'s limit, under a deadline, and the call is said to have applied', async () => {
    const outcome = await applyRunnerGroups(hub.ctx, createPairedRunnerFixture({ jobsAtOnce: 3 }), path.join(hub.root, 'cache'), createDeps({}), 4_000);
    assert.equal(outcome, 'applied');
    assert.equal(scriptChecks, 1, 'the script of this version is on the runner first');
    assert.deepEqual(calls, [{ subcommand: 'apply-groups', args: ['default=3'], hasSignal: true, timeoutMs: 4_000 }]);
    assert.deepEqual(logged, []);
  });

  it('an entry that never said is sent 1 — the default, so a runner that was set higher once and then reset to 1 is brought back to it', async () => {
    await applyRunnerGroups(hub.ctx, createPairedRunnerFixture(), path.join(hub.root, 'cache'), createDeps({}));
    assert.deepEqual(calls.map((call) => call.args), [['default=1']]);
  });

  it('a runner whose link is down is offline: nothing is sent, nothing is logged — the next job\'s `prepare` sets the number', async () => {
    const outcome = await applyRunnerGroups(hub.ctx, createPairedRunnerFixture({ jobsAtOnce: 2 }), path.join(hub.root, 'cache'), createDeps({ isOnline: false }));
    assert.equal(outcome, 'offline');
    assert.deepEqual([scriptChecks, calls.length, configs.length], [0, 0, 0]);
    assert.deepEqual(logged, []);
  });

  it('a runner that ssh cannot reach (the link dropped between the check and the call) is offline too', async () => {
    assert.equal(await applyRunnerGroups(hub.ctx, createPairedRunnerFixture(), path.join(hub.root, 'cache'), createDeps({ scriptError: new RunnerUnreachableError('mac', 'the runner is not connected') })), 'offline');
    assert.equal(calls.length, 0);
    assert.deepEqual(logged, []);
  });

  it('a runner that answers with an error is `failed`, and the log carries its last stderr line (not the exit alone)', async () => {
    const outcome = await applyRunnerGroups(hub.ctx, createPairedRunnerFixture(), path.join(hub.root, 'cache'), createDeps({ result: { exitCode: 125, stdout: '', stderr: 'noise\nremote-run-runner: Pueue refused a parallel limit (default=1)\n', isTimedOut: false } }));
    assert.equal(outcome, 'failed');
    assert.equal(logged.length, 1);
    assert.match(logged[0], /"mac".*exit 125.*Pueue refused a parallel limit/);
  });

  it('a call that ran past its deadline is `failed` and says so; any other throw is `failed` too, never thrown to the tap that asked', async () => {
    const timedOut = await applyRunnerGroups(hub.ctx, createPairedRunnerFixture(), path.join(hub.root, 'cache'), createDeps({ result: { exitCode: null, stdout: '', stderr: '', isTimedOut: true } }));
    assert.equal(timedOut, 'failed');
    assert.match(logged[0], /no answer in time/);
    const broken = await applyRunnerGroups(hub.ctx, createPairedRunnerFixture(), path.join(hub.root, 'cache'), createDeps({ callError: new Error('boom') }));
    assert.equal(broken, 'failed');
    assert.match(logged[1], /boom/);
  });

  it('a path of this machine that ssh cannot be given safely is `failed` (the config cannot be built), not a crash', async () => {
    const outcome = await applyRunnerGroups({ ...hub.ctx, cliPath: '/opt/char"ness/dist/cli.js' }, createPairedRunnerFixture(), path.join(hub.root, 'cache'), createDeps({}));
    assert.equal(outcome, 'failed');
    assert.equal(calls.length, 0);
    assert.equal(logged.length, 1);
  });
});
