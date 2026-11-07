/**
 * @description `checkRunnerReachability` (`remoteRun/runners.ts`): the one gate before any call to a runner, used by the probe and by `clean` — a paired runner whose link is down is `offline` (the link\'s own «last seen»), one with
 * its Mac\'s lid shut is `lid-closed` and is not asked at all, a script that cannot be looked for over ssh is `offline` with the ssh reason, any other failure putting the script there is `broken`, else `reachable` with the script
 * in place. The probe\'s report and `clean`\'s line are built from these answers, so they cannot say different things about the same runner.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { RemoteRunError, RunnerUnreachableError } from '../remoteRun/remoteRunError';
import { notConnectedReason, type RunnerClient } from '../remoteRun/runnerClient';
import { checkRunnerReachability, lidClosedReason, probeRunner } from '../remoteRun/runners';
import { getRunnerLinkPaths } from '../runners/hubPaths';
import { writeLidState, writeLinkState } from '../runners/linkControl';
import type { RunnerConfig } from '../remoteRun/runnersConfig';

let root = '';
const servers: net.Server[] = [];

function createClient(runner: RunnerConfig, ensureScript: () => Promise<void> = async () => undefined): { client: RunnerClient; scriptChecks: () => number } {
  let checks = 0;
  const refuse = (): never => { throw new Error('not used by the gate'); };
  const client: RunnerClient = {
    runner,
    cacheDir: path.join(root, 'cache'),
    rsyncSshCommand: 'ssh',
    ensureScript: async () => { checks += 1; await ensureScript(); },
    getAbsoluteWorkDir: refuse,
    call: async () => ({ exitCode: 0, stdout: 'os=Linux\n', stderr: '', isTimedOut: false }),
    callOrThrow: refuse,
    stream: refuse,
  };
  return { client, scriptChecks: () => checks };
}

const handMade: RunnerConfig = { name: 'box1', ssh: 'user@box1.example', workDir: '/w' };
const runnerId = 'a1b2c3d4e5f6';

function createPaired(): RunnerConfig {
  return { ...handMade, name: 'mac', ssh: `charness-runner-${runnerId}`, paired: { runnerId, hubDir: path.join(root, 'hub'), isPausedByHub: false, os: 'macOS 15.1', pairedAtMs: 0 } };
}

/** The link of the paired runner is up: its socket accepts, its status file says since when. */
async function putLinkUp(beatMs: number): Promise<void> {
  const paths = getRunnerLinkPaths(path.join(root, 'hub'), runnerId);
  fs.mkdirSync(path.dirname(paths.socket), { recursive: true });
  const server = net.createServer((connection) => connection.destroy());
  servers.push(server);
  await new Promise<void>((resolve) => { server.listen(paths.socket, resolve); });
  writeLinkState(path.join(root, 'hub'), runnerId, { pid: process.pid, sinceMs: beatMs - 1000, lastBeatMs: beatMs, endedAtMs: null });
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-run-reach-')));
  fs.mkdirSync(path.join(root, 'cache'));
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); })));
  fs.rmSync(root, { recursive: true, force: true });
});

describe('checkRunnerReachability', () => {
  it('a runner whose script is there is reachable (the script was looked for)', async () => {
    const { client, scriptChecks } = createClient(handMade);
    assert.deepEqual(await checkRunnerReachability(client), { kind: 'reachable' });
    assert.equal(scriptChecks(), 1);
  });

  it('a hand-made runner that cannot be reached over ssh is offline with the ssh reason; any other failure putting the script there is «broken» with its message', async () => {
    const lost = createClient(handMade, async () => { throw new RunnerUnreachableError('box1', 'ssh: connection timed out'); });
    assert.deepEqual(await checkRunnerReachability(lost.client), { kind: 'offline', reason: 'ssh: connection timed out', lastSeenMs: null });
    const broken = createClient(handMade, async () => { throw new RemoteRunError('could not put the runner script on "box1"'); });
    assert.deepEqual(await checkRunnerReachability(broken.client), { kind: 'broken', message: 'could not put the runner script on "box1"' });
    const odd = createClient(handMade, async () => { throw new Error(''); });
    assert.equal((await checkRunnerReachability(odd.client)).kind, 'broken');
  });

  it('a paired runner whose link is down is offline («the runner is not connected») without any ssh call', async () => {
    const { client, scriptChecks } = createClient(createPaired());
    assert.deepEqual(await checkRunnerReachability(client), { kind: 'offline', reason: notConnectedReason, lastSeenMs: null });
    assert.equal(scriptChecks(), 0);
  });

  it('a paired Mac with its lid shut is «lid-closed» and is not asked; with the lid open it is reachable', async () => {
    const beatMs = Date.now();
    await putLinkUp(beatMs);
    writeLidState(path.join(root, 'hub'), runnerId, { isClosed: true, reportedAtMs: beatMs });
    const shut = createClient(createPaired());
    assert.deepEqual(await checkRunnerReachability(shut.client), { kind: 'lid-closed', lastSeenMs: beatMs });
    assert.equal(shut.scriptChecks(), 0);
    writeLidState(path.join(root, 'hub'), runnerId, { isClosed: false, reportedAtMs: beatMs });
    const open = createClient(createPaired());
    assert.deepEqual(await checkRunnerReachability(open.client), { kind: 'reachable' });
    assert.equal(open.scriptChecks(), 1);
  });
});

describe('the probe and clean say the same about the same runner', () => {
  it('the probe of a runner the gate calls offline / lid-closed / broken reports it so, with the gate\'s reason and last-seen', async () => {
    const lost = await probeRunner(createClient(handMade, async () => { throw new RunnerUnreachableError('box1', 'ssh: connection timed out'); }).client);
    assert.ok(lost.status === 'offline' && lost.reason === 'ssh: connection timed out');
    const broken = await probeRunner(createClient(handMade, async () => { throw new RemoteRunError('could not put the runner script on "box1"'); }).client);
    assert.ok(broken.status === 'offline' && broken.reason === 'could not put the runner script on "box1"');
    const down = await probeRunner(createClient(createPaired()).client);
    assert.ok(down.status === 'offline' && down.reason === notConnectedReason);
    const beatMs = Date.now();
    await putLinkUp(beatMs);
    writeLidState(path.join(root, 'hub'), runnerId, { isClosed: true, reportedAtMs: beatMs });
    const shut = await probeRunner(createClient(createPaired()).client);
    assert.ok(shut.status === 'lid-closed' && shut.lastSeenAtMs === beatMs);
    assert.equal(lidClosedReason, 'its Mac has the lid closed');
  });
});
