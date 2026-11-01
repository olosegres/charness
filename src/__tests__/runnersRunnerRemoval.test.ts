/**
 * @description `runners/runnerRemoval.ts`: removing a runner ends the work the hub's agents left on it. Pueue outlives any link, so cutting
 * the link alone leaves their background jobs running on a machine that is no longer theirs; for a runner that is ONLINE the hub runs
 * `pueue reset --force` there over the link that is still open — after the registry entry is gone, before the link is cut.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { getPairedRunnerPueue } from '../remoteRun/pairedRunners';
import type { SshRunParams } from '../remoteRun/ssh';
import { getRunnerLinkPaths } from '../runners/hubPaths';
import { readPairedFile, writePairedFile } from '../runners/hubRegistry';
import { removeRunnerAndEndItsWork, stopRunnerJobsOverLink, type RunnerRemovalDeps } from '../runners/runnerRemoval';
import { createPairedRunnerFixture, pairedRunnerId, pairedRunnerWorkDir } from './remoteRunPairedKit';
import { createHubFixture, type HubFixture } from './runnersTestKit';

let hub: HubFixture;
let sshCalls: SshRunParams[];
/** Did the link's socket still exist at the moment each ssh call ran? */
let socketExistedAtCall: boolean[];

function getSocketPath(): string {
  return getRunnerLinkPaths(hub.ctx.dir, pairedRunnerId).socket;
}

function createDeps(options: { isOnline: boolean; exitCode?: number | null }): RunnerRemovalDeps {
  return {
    isLinkOnline: async () => options.isOnline,
    runSsh: async (params) => {
      sshCalls.push(params);
      socketExistedAtCall.push(fs.existsSync(getSocketPath()));
      return { exitCode: options.exitCode ?? 0, stdout: '', stderr: '', isTimedOut: false };
    },
    cacheDir: path.join(hub.root, 'cache'),
  };
}

function pairRunner(workDir: string = pairedRunnerWorkDir): void {
  writePairedFile(hub.ctx.dir, { rev: 1, runners: [createPairedRunnerFixture({ workDir })] });
  fs.mkdirSync(path.dirname(getSocketPath()), { recursive: true });
  fs.writeFileSync(getSocketPath(), '');
}

beforeEach(() => {
  hub = createHubFixture();
  sshCalls = [];
  socketExistedAtCall = [];
});
afterEach(() => {
  hub.cleanup();
});

describe('removing a runner that is online', () => {
  it('resets its Pueue over the open link — after the entry is gone, before the link is cut — and the entry and the link are gone afterwards', async () => {
    pairRunner();
    const removed = await removeRunnerAndEndItsWork(hub.ctx, 'mac', 1000, createDeps({ isOnline: true }));
    assert.equal(removed?.id, pairedRunnerId);
    assert.equal(sshCalls.length, 1);
    const pueue = getPairedRunnerPueue(pairedRunnerWorkDir);
    assert.equal(sshCalls[0].remoteCommand, `${pueue?.bin} --config ${pueue?.config} reset --force`);
    assert.deepEqual(sshCalls[0].runner.sshOptions?.slice(0, 2), ['-o', 'ControlMaster=no'], 'no master is left behind for a link about to be cut');
    assert.deepEqual(socketExistedAtCall, [true], 'the link was still up while the jobs were stopped');
    assert.equal(readPairedFile(hub.ctx.dir).runners.length, 0);
    assert.equal(fs.existsSync(getSocketPath()), false, 'and cut afterwards');
  });

  it('a Pueue that did not answer (ssh 255) does not stop the removal: the runner is removed, the link cut, and the runner falls back to its own inference', async () => {
    pairRunner();
    const removed = await removeRunnerAndEndItsWork(hub.ctx, 'mac', 1000, createDeps({ isOnline: true, exitCode: 255 }));
    assert.equal(removed?.id, pairedRunnerId);
    assert.equal(readPairedFile(hub.ctx.dir).runners.length, 0);
    assert.equal(fs.existsSync(getSocketPath()), false);
  });

  it('a work dir that does not follow the runner utility\'s layout gives no Pueue to reset: nothing is run, the removal still goes through', async () => {
    pairRunner('/srv/runner-work');
    const removed = await removeRunnerAndEndItsWork(hub.ctx, 'mac', 1000, createDeps({ isOnline: true }));
    assert.equal(removed?.id, pairedRunnerId);
    assert.deepEqual(sshCalls, []);
    assert.equal(readPairedFile(hub.ctx.dir).runners.length, 0);
  });
});

describe('removing a runner that is offline, or unknown', () => {
  it('an offline runner is not called (nothing answers): it is removed and its link files cut, and it stops its own jobs when it finds out', async () => {
    pairRunner();
    const removed = await removeRunnerAndEndItsWork(hub.ctx, 'mac', 1000, createDeps({ isOnline: false }));
    assert.equal(removed?.id, pairedRunnerId);
    assert.deepEqual(sshCalls, []);
    assert.equal(readPairedFile(hub.ctx.dir).runners.length, 0);
  });

  it('a name nobody is paired under removes nothing and calls nothing', async () => {
    pairRunner();
    assert.equal(await removeRunnerAndEndItsWork(hub.ctx, 'nobody', 1000, createDeps({ isOnline: true })), null);
    assert.deepEqual(sshCalls, []);
    assert.equal(readPairedFile(hub.ctx.dir).runners.length, 1);
  });

  it('stopRunnerJobsOverLink reports whether the reset was done', async () => {
    pairRunner();
    const runner = createPairedRunnerFixture({});
    assert.equal(await stopRunnerJobsOverLink(hub.ctx, runner, createDeps({ isOnline: true })), true);
    assert.equal(await stopRunnerJobsOverLink(hub.ctx, runner, createDeps({ isOnline: true, exitCode: 1 })), false);
    assert.equal(await stopRunnerJobsOverLink(hub.ctx, runner, createDeps({ isOnline: false })), false);
  });
});
