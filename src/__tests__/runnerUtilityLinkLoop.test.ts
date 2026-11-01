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
import { Server, type ServerChannel } from 'ssh2';
import { gzipSync } from 'zlib';
import { decideUpdate, updateRetryDelayMs } from '../runnerUtility/appUpdate';
import { checkArchiveHasId, checkIsPackageId, getPackageIdOfArchive } from '../runnerUtility/packageId';
import { HubConnectionError } from '../runnerUtility/hubClient';
import { computeBackoffMs, createLinkLoop, removalConfirmMs, removedRetryMs } from '../runnerUtility/linkLoop';
import { readRunnerStatus, type RunnerConfig } from '../runnerUtility/runnerConfig';
import { getRunnerHomePaths, type RunnerHomePaths } from '../runnerUtility/runnerHome';
import { createHubAuthenticator, createRunnerServers, type RunnerServers } from '../runnerUtility/runnerServers';
import { formatGateAnswerHead } from '../runners/gateProtocol';
import { readRunnerVersionPollMs, runnerVersionPollMinMs, runnerVersionPollMs } from '../runnerUtility/versionPollTiming';
import { waitUntil } from './runnersTestKit';
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

function createLoopFixture(connect: () => Promise<never>, sleeps: number[], abort: AbortController, abortAfterSleeps: number, options: { stopJobs?: () => Promise<void>; unconfirmedRemovalStopAfterMs?: number } = {}) {
  let clock = 1_000;
  const keys = { client: generateEd25519KeyPair('c'), server: generateEd25519KeyPair('s') };
  const config = createConfig();
  const servers = createRunnerServers({ serverPrivateKey: keys.server.privateKey, hubPublicKey: config.hub.publicKey, readEnv: () => ({}), cwd: home });
  return createLinkLoop({
    paths,
    config,
    keys,
    servers,
    random: () => noRandom,
    now: () => clock,
    connect,
    stopJobs: options.stopJobs,
    unconfirmedRemovalStopAfterMs: options.unconfirmedRemovalStopAfterMs,
    sleep: async (ms) => {
      clock += ms;
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

  it('a hub that refuses the key twice, a little apart, shows the runner as removed — but its jobs are NOT killed on that evidence alone (a locked home folder on the hub refuses the key the same way)', async () => {
    const sleeps: number[] = [];
    const abort = new AbortController();
    let stops = 0;
    const loop = createLoopFixture(async () => { throw new HubConnectionError('auth', 'the hub refused the runner\'s key'); }, sleeps, abort, 2, { stopJobs: async () => { stops += 1; } });
    await loop.run(abort.signal);
    assert.deepEqual(sleeps, [removalConfirmMs, removedRetryMs], 'one refusal waits to be sure; the second one is the removal; then the hourly wait — not the backoff');
    assert.equal(removedRetryMs, 60 * 60 * 1000);
    assert.equal(stops, 0, 'the queue\'s jobs were left running');
    const status = readRunnerStatus(paths);
    assert.equal(status?.state, 'removed');
    assert.equal(status?.lastError, 'removed by @ExampleBot');
  });

  it('a refusal that lasts, hour after hour, without the hub ever saying more, finally stops the jobs — once the window is over', async () => {
    const sleeps: number[] = [];
    const abort = new AbortController();
    const stoppedAfterSleeps: number[] = [];
    const window = 2 * removedRetryMs;
    const loop = createLoopFixture(async () => { throw new HubConnectionError('auth', 'refused'); }, sleeps, abort, 4, {
      stopJobs: async () => { stoppedAfterSleeps.push(sleeps.length); },
      unconfirmedRemovalStopAfterMs: window,
    });
    await loop.run(abort.signal);
    assert.deepEqual(sleeps, [removalConfirmMs, removedRetryMs, removedRetryMs, removedRetryMs]);
    assert.deepEqual(stoppedAfterSleeps, [3], 'not at the second or third attempt, whose refusals are younger than the window — at the fourth, which is older');
  });

  it('the window starts over after any other outcome: a refusal, a network failure and a long wait later do not add up', async () => {
    const sleeps: number[] = [];
    const abort = new AbortController();
    const outcomes: Array<'auth' | 'network'> = ['auth', 'auth', 'network', 'auth', 'auth'];
    let stops = 0;
    const loop = createLoopFixture(async () => {
      const outcome = outcomes.shift() ?? 'auth';
      throw new HubConnectionError(outcome, outcome);
    }, sleeps, abort, 5, { stopJobs: async () => { stops += 1; }, unconfirmedRemovalStopAfterMs: removedRetryMs + removalConfirmMs + 1 });
    await loop.run(abort.signal);
    assert.equal(stops, 0, 'two refusals, a network failure in between, two more: the clock restarted at the network failure');
  });

  it('ONE refusal of the key is not a removal: the jobs are left running and the runner says it is checking again', async () => {
    const sleeps: number[] = [];
    const abort = new AbortController();
    let stops = 0;
    const loop = createLoopFixture(async () => { throw new HubConnectionError('auth', 'refused'); }, sleeps, abort, 1, { stopJobs: async () => { stops += 1; } });
    await loop.run(abort.signal);
    assert.deepEqual(sleeps, [removalConfirmMs]);
    assert.equal(stops, 0);
    assert.equal(readRunnerStatus(paths)?.state, 'error');
    assert.match(readRunnerStatus(paths)?.lastError ?? '', /asking once more/);
  });

  it('a refusal, a network failure and a refusal are not «twice in a row»: the failure in between forgets the first refusal', async () => {
    const abort = new AbortController();
    const sleeps: number[] = [];
    const outcomes: Array<'auth' | 'network'> = ['auth', 'network', 'auth'];
    let stops = 0;
    const loop = createLoopFixture(async () => {
      const outcome = outcomes.shift() ?? 'auth';
      throw new HubConnectionError(outcome, outcome);
    }, sleeps, abort, 3, { stopJobs: async () => { stops += 1; } });
    await loop.run(abort.signal);
    assert.equal(stops, 0, 'refusal, a network failure, refusal: the two refusals are not "twice in a row"');
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
  it('checks a downloaded archive against the announced id; anything else is a mismatch', () => {
    const tar = createTarArchive([{ path: 'package.json', content: Buffer.from('{}'), mode: 0o644 }]);
    const archivePath = path.join(home, 'package.tgz');
    fs.writeFileSync(archivePath, gzipSync(tar));
    const id = createHash('sha256').update(tar).digest('hex').slice(0, 16);
    assert.equal(checkArchiveHasId(archivePath, id), true);
    assert.equal(checkArchiveHasId(archivePath, 'f'.repeat(16)), false);
    assert.equal(checkArchiveHasId(archivePath, 'not-an-id'), false);
    assert.equal(checkArchiveHasId(path.join(home, 'missing.tgz'), id), false);
    fs.writeFileSync(archivePath, 'not gzip at all');
    assert.equal(checkArchiveHasId(archivePath, id), false);
    assert.equal(checkIsPackageId(id), true);
    assert.equal(checkIsPackageId('0123456789ABCDEF'), false);
  });

  it('is the first 16 hex digits of the sha256 of the tar before compression — what the hub computes', () => {
    const tar = createTarArchive([{ path: 'package.json', content: Buffer.from('{}'), mode: 0o644 }]);
    assert.equal(getPackageIdOfArchive(gzipSync(tar)), createHash('sha256').update(tar).digest('hex').slice(0, 16));
  });
});

/** The hub's side of a link, as far as the runner can tell: an ssh server that answers `link` with a marker and keeps the channel open, and `version` with the current package. */
interface HubStandIn {
  port: number;
  hostKey: ReturnType<typeof generateEd25519KeyPair>;
  currentPackageId: { value: string };
  linkChannels: ServerChannel[];
  connections: { opened: number; closed: number };
  versionRequests: { count: number };
  /** When set, `link` is refused (no marker, as a gate does for a runner it does not know) and `identity` answers with this. */
  refuseLinkWith: { reply: string | null };
  /** While `until` is set the hub takes a `link` request and answers it (the link, or the refusal) only when that promise settles — a runner caught between «asked» and «linked». */
  holdLinkAnswer: { until: Promise<void> | null; requestCount: number };
  close: () => void;
}

async function startHubStandIn(runnerClientPublicKey: string, initialPackageId: string): Promise<HubStandIn> {
  const hostKey = generateEd25519KeyPair('hub-host');
  const authenticate = createHubAuthenticator(runnerClientPublicKey);
  const currentPackageId = { value: initialPackageId };
  const linkChannels: ServerChannel[] = [];
  const connections = { opened: 0, closed: 0 };
  const versionRequests = { count: 0 };
  const refuseLinkWith: { reply: string | null } = { reply: null };
  const holdLinkAnswer: { until: Promise<void> | null; requestCount: number } = { until: null, requestCount: 0 };
  const server = new Server({ hostKeys: [hostKey.privateKey] }, (connection) => {
    connections.opened += 1;
    connection.on('error', () => undefined);
    connection.on('close', () => { connections.closed += 1; });
    connection.on('authentication', authenticate);
    connection.on('ready', () => {
      connection.on('session', (acceptSession) => {
        const session = acceptSession();
        session.on('exec', (accept, reject, info) => {
          if (info.command === 'link' && refuseLinkWith.reply !== null) {
            holdLinkAnswer.requestCount += 1;
            const channel = accept();
            const refuseLink = (): void => {
              channel.stderr.write('charness-gate: refused: this runner is not paired here\n');
              channel.exit(2);
              channel.end();
            };
            if (holdLinkAnswer.until === null) refuseLink();
            else void holdLinkAnswer.until.then(refuseLink);
          } else if (info.command === 'identity' && refuseLinkWith.reply !== null) {
            const channel = accept();
            channel.write(formatGateAnswerHead('identity'));
            channel.write(`${refuseLinkWith.reply}\n`);
            channel.exit(1);
            channel.end();
          } else if (info.command === 'link') {
            holdLinkAnswer.requestCount += 1;
            const channel = accept();
            const answerLink = (): void => {
              channel.write(formatGateAnswerHead('link', { package: currentPackageId.value }));
              linkChannels.push(channel);
            };
            if (holdLinkAnswer.until === null) answerLink();
            else void holdLinkAnswer.until.then(answerLink);
          } else if (info.command === 'version') {
            versionRequests.count += 1;
            const channel = accept();
            channel.write(formatGateAnswerHead('version', { package: currentPackageId.value }));
            channel.exit(0);
            channel.end();
          } else {
            reject();
          }
        });
      });
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the stand-in has no port');
  return { port: address.port, hostKey, currentPackageId, linkChannels, connections, versionRequests, refuseLinkWith, holdLinkAnswer, close: () => { server.close(); } };
}

const installedPackageId = '0123456789abcdef';
const newerPackageId = 'fedcba9876543210';

describe('the link loop against a hub (an ssh server that speaks the gate\'s words)', () => {
  const clientKey = generateEd25519KeyPair('runner-client');
  let hub: HubStandIn;
  const aborts: AbortController[] = [];
  const running: Array<Promise<number>> = [];

  function createFakeServers(state: { busy: number }): RunnerServers {
    return { acceptLinkStream: () => undefined, getActiveExecCount: () => state.busy };
  }

  function startLoop(options: { servers: RunnerServers; update?: Parameters<typeof createLinkLoop>[0]['update']; versionPollMs?: number; now?: () => number; stopJobs?: () => Promise<void> }) {
    const config = createConfig();
    const abort = new AbortController();
    aborts.push(abort);
    const loop = createLinkLoop({
      paths,
      config: { ...config, packageId: installedPackageId, hub: { ...config.hub, host: '127.0.0.1', port: hub.port, hostKey: hub.hostKey.publicKey } },
      keys: { client: clientKey, server: generateEd25519KeyPair('s') },
      servers: options.servers,
      update: options.update,
      stopJobs: options.stopJobs,
      versionPollMs: options.versionPollMs ?? 60_000,
      now: options.now,
      sleep: () => new Promise((resolve) => { setTimeout(resolve, 20); }),
    });
    const finished = loop.run(abort.signal);
    running.push(finished);
    return { loop, finished, abort };
  }

  beforeEach(async () => {
    hub = await startHubStandIn(clientKey.publicKey, installedPackageId);
  });
  afterEach(async () => {
    for (const abort of aborts.splice(0)) abort.abort();
    await Promise.race([Promise.all(running.splice(0)), new Promise((resolve) => { setTimeout(resolve, 3000); })]);
    hub.close();
  });

  it('when the link channel ends but the connection stays up (the gate died, the link was cut), the runner notices and links again', async () => {
    startLoop({ servers: createFakeServers({ busy: 0 }) });
    await waitUntil(() => hub.linkChannels.length === 1 && readRunnerStatus(paths)?.state === 'linked', 'the first link', 15_000);
    hub.linkChannels[0].close();
    await waitUntil(() => hub.linkChannels.length === 2, 'a second link after the channel closed', 15_000);
    assert.equal(hub.connections.opened, 2, 'the runner left the old connection and made a new one');
    await waitUntil(() => hub.connections.closed >= 1, 'the old connection to be closed by the runner');
  });

  it('a gate that refuses the link because the registry no longer holds this runner is a removal at once — confirmed by the hub\'s own answer — and the jobs are stopped', async () => {
    hub.refuseLinkWith.reply = JSON.stringify({ ok: false, reason: 'this runner is not paired here' });
    let stops = 0;
    startLoop({ servers: createFakeServers({ busy: 0 }), stopJobs: async () => { stops += 1; } });
    await waitUntil(() => stops >= 1, 'the jobs to be stopped', 15_000);
    assert.equal(readRunnerStatus(paths)?.state, 'removed');
    assert.equal(hub.linkChannels.length, 0, 'no link was ever up');
  });

  it('a refused link that the hub does not call a removal is just a failure to retry', async () => {
    hub.refuseLinkWith.reply = JSON.stringify({ ok: true, runnerId: 'abcdef012345', name: 'mac', hubPublicKey: generateEd25519KeyPair('k').publicKey, label: '@ExampleBot', host: 'host.example', port: 22, packageId: null });
    let stops = 0;
    startLoop({ servers: createFakeServers({ busy: 0 }), stopJobs: async () => { stops += 1; } });
    await waitUntil(() => readRunnerStatus(paths)?.state === 'error', 'the failure to be recorded', 15_000);
    assert.equal(stops, 0);
  });

  for (const hubPackage of [
    { description: 'the package the runner has', packageId: installedPackageId },
    { description: 'a newer package — and no update is started for a runner that is leaving', packageId: newerPackageId },
  ]) {
    it(`a stop that comes while the hub has not yet answered the link request still ends the run and closes the connection — it is not lost to the handshake (the answer names ${hubPackage.description})`, async () => {
      hub.currentPackageId.value = hubPackage.packageId;
      let answerLink: () => void = () => undefined;
      hub.holdLinkAnswer.until = new Promise<void>((resolve) => { answerLink = resolve; });
      let updateCalls = 0;
      const { finished, abort } = startLoop({ servers: createFakeServers({ busy: 0 }), update: async () => { updateCalls += 1; return { ok: true, packageId: newerPackageId }; } });
      await waitUntil(() => hub.holdLinkAnswer.requestCount === 1, 'the link request to reach the hub', 15_000);
      abort.abort();
      answerLink();
      const outcome = await Promise.race([finished, new Promise<string>((resolve) => { setTimeout(() => resolve('still running'), 5000); })]);
      assert.equal(outcome, 0, 'the run ended with the stop');
      await waitUntil(() => hub.connections.closed === 1, 'the runner to close its connection to the hub', 5_000);
      assert.equal(updateCalls, 0, 'nothing was downloaded or installed after the stop');
    });
  }

  it('a stop that comes while the hub has not yet answered a link request it will refuse ends the run without asking who the runner is — a stop is not a removal, and no job is killed for it', async () => {
    hub.refuseLinkWith.reply = JSON.stringify({ ok: false, reason: 'this runner is not paired here' });
    let answerLink: () => void = () => undefined;
    hub.holdLinkAnswer.until = new Promise<void>((resolve) => { answerLink = resolve; });
    let stops = 0;
    const { finished, abort } = startLoop({ servers: createFakeServers({ busy: 0 }), stopJobs: async () => { stops += 1; } });
    await waitUntil(() => hub.holdLinkAnswer.requestCount === 1, 'the link request to reach the hub', 15_000);
    abort.abort();
    answerLink();
    const outcome = await Promise.race([finished, new Promise<string>((resolve) => { setTimeout(() => resolve('still running'), 5000); })]);
    assert.equal(outcome, 0, 'the run ended with the stop');
    await waitUntil(() => hub.connections.closed === 1, 'the runner to close its connection to the hub', 5_000);
    assert.equal(stops, 0, 'the jobs were left alone');
    assert.notEqual(readRunnerStatus(paths)?.state, 'removed');
  });

  it('a busy runner that becomes idle installs the update once, and does not reconnect while it installs', async () => {
    hub.currentPackageId.value = newerPackageId;
    const state = { busy: 1 };
    let updateCalls = 0;
    const updateGate: { release: (() => void) | null } = { release: null };
    const { loop, finished } = startLoop({
      servers: createFakeServers(state),
      update: () => new Promise((resolve) => {
        updateCalls += 1;
        updateGate.release = () => resolve({ ok: true, packageId: newerPackageId });
      }),
    });
    await waitUntil(() => hub.linkChannels.length === 1, 'the link', 15_000);
    assert.equal(updateCalls, 0, 'busy: the update waits');

    state.busy = 0;
    loop.notifyActiveCountChange();
    await waitUntil(() => updateCalls === 1, 'the update to start once the runner is idle');
    await new Promise((resolve) => { setTimeout(resolve, 600); });
    assert.equal(updateCalls, 1, 'one install, not two');
    assert.equal(hub.connections.opened, 1, 'no new link while the install is running');
    assert.equal(hub.linkChannels.length, 1);

    if (updateGate.release === null) throw new Error('the update never started');
    updateGate.release();
    assert.equal(await finished, 75, 'the runner asks the launcher for a restart once the update is installed');
  });

  it('a link that stays healthy learns of a new package by asking, and updates when idle', async () => {
    let updateCalls = 0;
    const { finished } = startLoop({
      servers: createFakeServers({ busy: 0 }),
      versionPollMs: 100,
      update: async () => { updateCalls += 1; return { ok: true, packageId: newerPackageId }; },
    });
    await waitUntil(() => hub.linkChannels.length === 1, 'the link', 15_000);
    await waitUntil(() => hub.versionRequests.count >= 2, 'the runner to ask the hub for its package');
    assert.equal(updateCalls, 0, 'the package has not changed');
    hub.currentPackageId.value = newerPackageId;
    assert.equal(await finished, 75);
    assert.equal(updateCalls, 1);
    assert.equal(hub.connections.opened, 1, 'the connection was never disrupted to find out');
  });

  it('a failed update is tried again after its cooldown, while the connection stays healthy', async () => {
    hub.currentPackageId.value = newerPackageId;
    let nowMs = 1_000_000;
    let updateCalls = 0;
    const { finished } = startLoop({
      servers: createFakeServers({ busy: 0 }),
      versionPollMs: 100,
      now: () => nowMs,
      update: async () => {
        updateCalls += 1;
        return updateCalls === 1 ? { ok: false, reason: 'the registry was unreachable' } : { ok: true, packageId: newerPackageId };
      },
    });
    await waitUntil(() => updateCalls === 1, 'the first (failing) update', 15_000);
    await new Promise((resolve) => { setTimeout(resolve, 700); });
    assert.equal(updateCalls, 1, 'not again inside the cooldown');
    nowMs += updateRetryDelayMs;
    assert.equal(await finished, 75);
    assert.equal(updateCalls, 2);
  });
});

describe('the version poll interval', () => {
  it('is five minutes, and a test seam may only shorten it, within bounds', () => {
    assert.equal(runnerVersionPollMs, 5 * 60 * 1000);
    assert.equal(readRunnerVersionPollMs({}), runnerVersionPollMs);
    assert.equal(readRunnerVersionPollMs({ CHARNESS_TEST_TIMINGS: JSON.stringify({ runnerVersionPollMs: 2000 }) }), 2000);
    assert.equal(readRunnerVersionPollMs({ CHARNESS_TEST_TIMINGS: JSON.stringify({ runnerVersionPollMs: runnerVersionPollMinMs }) }), runnerVersionPollMinMs);
    for (const bad of [runnerVersionPollMinMs - 1, runnerVersionPollMs + 1, 1.5, 'soon']) {
      assert.equal(readRunnerVersionPollMs({ CHARNESS_TEST_TIMINGS: JSON.stringify({ runnerVersionPollMs: bad }) }), runnerVersionPollMs, String(bad));
    }
    assert.equal(readRunnerVersionPollMs({ CHARNESS_TEST_TIMINGS: 'not json' }), runnerVersionPollMs);
  });
});
