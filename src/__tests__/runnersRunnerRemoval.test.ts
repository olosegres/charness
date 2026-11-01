/**
 * @description `runners/runnerRemoval.ts`: removing a runner ends the work the hub's agents left on it. Pueue outlives any link, so cutting
 * the link alone leaves their background jobs running on a machine that is no longer theirs; for a runner that is ONLINE the hub runs
 * `pueue reset --force` there over the link that is still open — while the runner is still paired (the gate ends a link as soon as its
 * runner has left the registry, which would cut the reset off), after pausing it, and before the link is cut.
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
import { removeRunnerAndEndItsWork, type RunnerRemovalDeps } from '../runners/runnerRemoval';
import { createPairedRunnerFixture, pairedRunnerId, pairedRunnerWorkDir } from './remoteRunPairedKit';
import { createHubFixture, type HubFixture } from './runnersTestKit';

let hub: HubFixture;
let sshCalls: SshRunParams[];
/** What the registry and the link looked like at the moment each ssh call ran. */
let stateAtCall: Array<{ runnersInRegistry: number; isPaused: boolean; socketExists: boolean }>;
let logged: string[];
let onlineChecks: number;

function getSocketPath(): string {
  return getRunnerLinkPaths(hub.ctx.dir, pairedRunnerId).socket;
}

function createDeps(options: { isOnline: boolean; exitCode?: number | null; sshError?: Error; statusError?: Error }): RunnerRemovalDeps {
  return {
    isLinkOnline: async () => {
      onlineChecks += 1;
      if (options.statusError !== undefined) throw options.statusError;
      return options.isOnline;
    },
    runSsh: async (params) => {
      sshCalls.push(params);
      const registry = readPairedFile(hub.ctx.dir);
      stateAtCall.push({ runnersInRegistry: registry.runners.length, isPaused: registry.runners[0]?.isPaused === true, socketExists: fs.existsSync(getSocketPath()) });
      if (options.sshError !== undefined) throw options.sshError;
      return { exitCode: options.exitCode ?? 0, stdout: '', stderr: '', isTimedOut: false };
    },
    cacheDir: path.join(hub.root, 'cache'),
    log: (line) => { logged.push(line); },
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
  stateAtCall = [];
  logged = [];
  onlineChecks = 0;
});
afterEach(() => {
  hub.cleanup();
});

describe('removing a runner that is online', () => {
  it('pauses it and resets its Pueue over the open link WHILE IT IS STILL PAIRED — the gate would end the link under a reset that came after the removal — then removes it and cuts the link', async () => {
    pairRunner();
    const removal = await removeRunnerAndEndItsWork(hub.ctx, 'mac', 1000, createDeps({ isOnline: true }));
    assert.equal(removal?.runner.id, pairedRunnerId);
    assert.equal(removal?.jobs, 'stopped');
    assert.equal(removal?.runner.isPaused, true, 'it was paused before the reset (the removed record shows it)');
    assert.equal(onlineChecks, 1, 'whether the link is up is asked once');
    assert.equal(sshCalls.length, 1);
    const pueue = getPairedRunnerPueue(pairedRunnerWorkDir);
    assert.equal(sshCalls[0].remoteCommand, `${pueue?.bin} --config ${pueue?.config} reset --force`);
    assert.deepEqual(sshCalls[0].runner.sshOptions?.slice(0, 2), ['-o', 'ControlMaster=no'], 'no master is left behind for a link about to be cut');
    assert.deepEqual(stateAtCall, [{ runnersInRegistry: 1, isPaused: true, socketExists: true }], 'at the reset: still paired, already paused, link up');
    assert.equal(readPairedFile(hub.ctx.dir).runners.length, 0);
    assert.equal(fs.existsSync(getSocketPath()), false, 'and cut afterwards');
  });

  it('a Pueue that did not answer (ssh 255) is told as «failed», logged, and does not stop the removal: the runner is removed and its link cut', async () => {
    pairRunner();
    const removal = await removeRunnerAndEndItsWork(hub.ctx, 'mac', 1000, createDeps({ isOnline: true, exitCode: 255 }));
    assert.equal(removal?.runner.id, pairedRunnerId);
    assert.equal(removal?.jobs, 'failed');
    assert.ok(logged.some((line) => line.includes('"mac"') && line.includes('exit 255')), logged.join('\n'));
    assert.equal(readPairedFile(hub.ctx.dir).runners.length, 0);
    assert.equal(fs.existsSync(getSocketPath()), false);
  });

  it('an ssh call that throws (a cache folder that cannot be made, a spawn error) is the same: logged, «failed», and the link is still cut', async () => {
    pairRunner();
    const removal = await removeRunnerAndEndItsWork(hub.ctx, 'mac', 1000, createDeps({ isOnline: true, sshError: new Error('spawn ssh EACCES') }));
    assert.equal(removal?.jobs, 'failed');
    assert.ok(logged.some((line) => line.includes('spawn ssh EACCES')));
    assert.equal(readPairedFile(hub.ctx.dir).runners.length, 0);
    assert.equal(fs.existsSync(getSocketPath()), false, 'a failed stop must not leave the link of a removed runner up');
  });

  it('a work dir that does not follow the runner utility\'s layout gives no Pueue to reset: «failed», nothing is run, the removal still goes through', async () => {
    pairRunner('/srv/runner-work');
    const removal = await removeRunnerAndEndItsWork(hub.ctx, 'mac', 1000, createDeps({ isOnline: true }));
    assert.equal(removal?.jobs, 'failed');
    assert.deepEqual(sshCalls, []);
    assert.equal(readPairedFile(hub.ctx.dir).runners.length, 0);
  });
});

describe('removing a runner that is offline, or unknown', () => {
  it('an offline runner is not called (nothing answers) and is not paused first: it is removed and its link files cut, and it stops its own jobs when it finds out', async () => {
    pairRunner();
    const removal = await removeRunnerAndEndItsWork(hub.ctx, 'mac', 1000, createDeps({ isOnline: false }));
    assert.equal(removal?.runner.id, pairedRunnerId);
    assert.equal(removal?.jobs, 'offline');
    assert.equal(removal?.runner.isPaused, false, 'not paused first: nothing to protect on a machine nobody can reach');
    assert.deepEqual(sshCalls, []);
    assert.equal(readPairedFile(hub.ctx.dir).runners.length, 0);
  });

  it('a link state that cannot be read is NOT «offline»: it is logged and told as «failed», nothing is called, and the removal still goes through', async () => {
    pairRunner();
    const removal = await removeRunnerAndEndItsWork(hub.ctx, 'mac', 1000, createDeps({ isOnline: true, statusError: new Error('EACCES: link folder') }));
    assert.equal(removal?.jobs, 'failed');
    assert.ok(logged.some((line) => line.includes('could not tell whether "mac" is online') && line.includes('EACCES')), logged.join('\n'));
    assert.deepEqual(sshCalls, []);
    assert.equal(readPairedFile(hub.ctx.dir).runners.length, 0);
    assert.equal(fs.existsSync(getSocketPath()), false);
  });

  it('a name nobody is paired under removes nothing and calls nothing', async () => {
    pairRunner();
    assert.equal(await removeRunnerAndEndItsWork(hub.ctx, 'nobody', 1000, createDeps({ isOnline: true })), null);
    assert.deepEqual(sshCalls, []);
    assert.equal(readPairedFile(hub.ctx.dir).runners.length, 1);
  });
});
