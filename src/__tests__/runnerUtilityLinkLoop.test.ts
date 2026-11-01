/**
 * @description `runnerUtility/linkLoop.ts` + `appUpdate.ts`: the backoff of a link that keeps dropping, the «removed» state when the hub
 * refuses the runner's key (asked again once an hour), and when an update is taken — only to a package the hub names and the runner does
 * not have, only while idle, not again right after a failure — with the archive checked against the id the hub announced.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { gzipSync } from 'zlib';
import { decideUpdate, getPackageIdOfArchive, updateRetryDelayMs } from '../runnerUtility/appUpdate';
import { HubConnectionError } from '../runnerUtility/hubClient';
import { computeBackoffMs, createLinkLoop, removedRetryMs } from '../runnerUtility/linkLoop';
import { readRunnerStatus, type RunnerConfig } from '../runnerUtility/runnerConfig';
import { getRunnerHomePaths, type RunnerHomePaths } from '../runnerUtility/runnerHome';
import { createRunnerServers } from '../runnerUtility/runnerServers';
import { createTarArchive } from '../runners/tarArchive';
import { generateEd25519KeyPair } from '../runners/sshKeys';

const noRandom = 0.5;
let home = '';
let paths: RunnerHomePaths;

function createConfig(): RunnerConfig {
  return {
    runnerId: 'abcdef012345',
    name: 'mac',
    hub: { host: 'host.example', port: 22, user: 'hubuser', hostKey: generateEd25519KeyPair('h').publicKey, publicKey: generateEd25519KeyPair('p').publicKey, label: '@ExampleBot' },
    packageId: '0123456789abcdef',
    pairedAtMs: 1,
  };
}

function createLoopFixture(connect: () => Promise<never>, sleeps: number[], abort: AbortController, abortAfterSleeps: number) {
  const keys = { client: generateEd25519KeyPair('c'), server: generateEd25519KeyPair('s') };
  const config = createConfig();
  const servers = createRunnerServers({ serverPrivateKey: keys.server.privateKey, hubPublicKey: config.hub.publicKey, readEnv: () => ({}), cwd: home });
  return createLinkLoop({
    paths,
    config,
    keys,
    servers,
    random: () => noRandom,
    now: () => 1_000,
    connect,
    sleep: async (ms) => {
      sleeps.push(ms);
      if (sleeps.length >= abortAfterSleeps) abort.abort();
    },
  });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'll-'));
  paths = getRunnerHomePaths(home);
  fs.mkdirSync(paths.root, { recursive: true });
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('backoff', () => {
  it('doubles from a second to five minutes with the jitter centred on the value', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 8, 20].map((failures) => computeBackoffMs(failures, noRandom)), [1000, 2000, 4000, 8000, 16000, 256000, 300000]);
  });

  it('stays within ±20 % of the base', () => {
    assert.equal(computeBackoffMs(2, 0), 3200);
    assert.equal(computeBackoffMs(2, 0.999999), 4800);
  });
});

describe('the link loop', () => {
  it('keeps trying with growing waits while the hub cannot be reached, and says so in the status', async () => {
    const sleeps: number[] = [];
    const abort = new AbortController();
    const loop = createLoopFixture(async () => { throw new HubConnectionError('network', 'connect ECONNREFUSED'); }, sleeps, abort, 4);
    assert.equal(await loop.run(abort.signal), 0);
    assert.deepEqual(sleeps, [1000, 2000, 4000, 8000]);
    const status = readRunnerStatus(paths);
    assert.equal(status?.state, 'error');
    assert.match(status?.lastError ?? '', /ECONNREFUSED/);
    assert.equal(status?.pid, process.pid);
  });

  it('a hub that refuses the key is «removed»: the status says by whom, and it is asked again in an hour — not with the backoff', async () => {
    const sleeps: number[] = [];
    const abort = new AbortController();
    const loop = createLoopFixture(async () => { throw new HubConnectionError('auth', 'the hub refused the runner\'s key'); }, sleeps, abort, 2);
    await loop.run(abort.signal);
    assert.deepEqual(sleeps, [removedRetryMs, removedRetryMs]);
    assert.equal(removedRetryMs, 60 * 60 * 1000);
    const status = readRunnerStatus(paths);
    assert.equal(status?.state, 'removed');
    assert.equal(status?.lastError, 'removed by @ExampleBot');
  });

  it('a wrong host key is a failure to retry, not a removal', async () => {
    const sleeps: number[] = [];
    const abort = new AbortController();
    const loop = createLoopFixture(async () => { throw new HubConnectionError('hostKey', 'the hub\'s ssh host key is not the one pinned at pairing'); }, sleeps, abort, 1);
    await loop.run(abort.signal);
    assert.equal(readRunnerStatus(paths)?.state, 'error');
    assert.deepEqual(sleeps, [1000]);
  });

  it('stops at once when told to, without connecting', async () => {
    const abort = new AbortController();
    abort.abort();
    let connected = false;
    const loop = createLoopFixture(async () => { connected = true; throw new Error('unreachable'); }, [], abort, 1);
    assert.equal(await loop.run(abort.signal), 0);
    assert.equal(connected, false);
  });
});

describe('update decision', () => {
  const base = { hubPackageId: 'bbbbbbbbbbbbbbbb', installedPackageId: 'aaaaaaaaaaaaaaaa', activeExecCount: 0, failedPackageId: null, failedAtMs: 0, nowMs: 1_000_000 };

  it('updates an idle runner to a package it does not have', () => {
    assert.equal(decideUpdate(base), 'update-now');
  });

  it('waits for the commands that run over the link to end', () => {
    assert.equal(decideUpdate({ ...base, activeExecCount: 2 }), 'wait-until-idle');
  });

  it('does nothing when the hub names the installed package, none, or nothing', () => {
    assert.equal(decideUpdate({ ...base, hubPackageId: 'aaaaaaaaaaaaaaaa' }), 'none');
    assert.equal(decideUpdate({ ...base, hubPackageId: 'none' }), 'none');
    assert.equal(decideUpdate({ ...base, hubPackageId: undefined }), 'none');
  });

  it('does not try a package that just failed again for ten minutes', () => {
    const failed = { ...base, failedPackageId: 'bbbbbbbbbbbbbbbb', failedAtMs: 1_000_000 - 1000 };
    assert.equal(decideUpdate(failed), 'none');
    assert.equal(decideUpdate({ ...failed, nowMs: failed.failedAtMs + updateRetryDelayMs }), 'update-now');
    assert.equal(decideUpdate({ ...failed, hubPackageId: 'cccccccccccccccc' }), 'update-now', 'a newer package is tried at once');
  });
});

describe('package id', () => {
  it('is the first 16 hex digits of the sha256 of the tar before compression — what the hub computes', () => {
    const tar = createTarArchive([{ path: 'package.json', content: Buffer.from('{}'), mode: 0o644 }]);
    assert.equal(getPackageIdOfArchive(gzipSync(tar)), createHash('sha256').update(tar).digest('hex').slice(0, 16));
  });
});
