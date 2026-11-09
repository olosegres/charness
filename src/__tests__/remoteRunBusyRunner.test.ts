/**
 * @description A runner that is THERE but whose probe does not finish in time is BUSY, never offline (`remoteRun/runners.ts probeRunner`): a Mac with load 129 under a job once read «offline (no answer within
 * 20 s)» — and a runner that reads offline is waited for or refused by the next submit. A paired runner whose link is up, or a runner whose ssh answered the check of its script, that runs out of time in
 * its probe is `busy` with its last snapshot shown as old; a hand-made runner that does not even answer ssh, a link that is down and a connection that drops are still offline. A busy runner is picked
 * as its last snapshot allows (Pueue, not paused, the capability) and never waited for; the bot's `/runners` keeps it online. A flow with the real link, ssh and a shortened deadline is
 * `remoteRunPairedE2e.test.ts`.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { formatRunnerBlock, parseProbeOutput, type RunnerReport } from '../remoteRun/probe';
import { RemoteRunError, RunnerUnreachableError } from '../remoteRun/remoteRunError';
import type { RunnerClient } from '../remoteRun/runnerClient';
import { planRunnerWait } from '../remoteRun/runnerWait';
import { pickRunner, probeRunner, probeRunners, readLastProbe, readProbeFailure } from '../remoteRun/runners';
import type { RunnerConfig, RunnersConfig } from '../remoteRun/runnersConfig';
import { getRunnerLinkPaths } from '../runners/hubPaths';
import { writePairedFile } from '../runners/hubRegistry';
import { writeLinkState } from '../runners/linkControl';
import { probeRunnersOverview, readRunnersOverview, refreshStaleSnapshots } from '../runners/runnersOverview';
import { createPairedRunnerFixture } from './remoteRunPairedKit';
import { createHubFixture, type HubFixture } from './runnersTestKit';

const macProbeText = 'os=Darwin\nos_name=macOS\nos_version=26.1\narch=arm64\ncpu_cores=10\ncpu_threads=10\nload=33.1\npueue=4.0.4\njobs_running=1\ncap_ios=yes\ncap_ios_detail=Xcode 27.2, 16 simulators\ncap_android=no\ncap_docker=no\ncap_playwright=no\n';
const noPueueText = 'os=Linux\nos_name=Ubuntu\npueue=missing\ncap_android=yes\ncap_ios=no\ncap_docker=no\ncap_playwright=no\n';
const seenAtMs = Date.UTC(2026, 10, 9, 7, 0, 0);
const deadlineMs = 1000;
const testBoundMs = 15_000;

type CallResult = { exitCode: number | null; stdout: string; stderr: string; isTimedOut: boolean };

let root = '';
let cacheDir = '';
const servers: net.Server[] = [];

/** Hangs until the signal fires, then ends the way a killed ssh call does. */
function hangUntilAborted(signal?: AbortSignal): Promise<CallResult> {
  return new Promise((resolve) => {
    signal?.addEventListener('abort', () => resolve({ exitCode: null, stdout: '', stderr: '', isTimedOut: true }), { once: true });
  });
}

interface ClientOptions {
  runner: RunnerConfig;
  ensureScript?: (signal?: AbortSignal) => Promise<void>;
  probe?: (signal?: AbortSignal) => Promise<CallResult>;
}

function createClient(options: ClientOptions): RunnerClient {
  const refuse = (): never => {
    throw new Error('not used by the probe');
  };
  return {
    runner: options.runner,
    cacheDir,
    rsyncSshCommand: 'ssh',
    ensureScript: options.ensureScript ?? (async () => undefined),
    getAbsoluteWorkDir: refuse,
    call: async (_subcommand, _args, callOptions) => (options.probe ?? (async () => ({ exitCode: 0, stdout: macProbeText, stderr: '', isTimedOut: false })))(callOptions?.signal),
    callOrThrow: refuse,
    stream: refuse,
  };
}

const handMade: RunnerConfig = { name: 'mac', ssh: 'user@mac.example', workDir: '/w' };
const pairedRunnerId = 'a1b2c3d4e5f6';

function createPaired(name = 'mac'): RunnerConfig {
  return { name, ssh: `charness-runner-${pairedRunnerId}`, workDir: '/w', paired: { runnerId: pairedRunnerId, hubDir: path.join(root, 'hub'), isPausedByHub: false, os: 'macOS 26.1', pairedAtMs: 0 } };
}

/** The paired runner's link is up: its socket accepts, its status file says since when. */
async function putLinkUp(): Promise<void> {
  const paths = getRunnerLinkPaths(path.join(root, 'hub'), pairedRunnerId);
  fs.mkdirSync(path.dirname(paths.socket), { recursive: true });
  const server = net.createServer((connection) => connection.destroy());
  servers.push(server);
  await new Promise<void>((resolve) => { server.listen(paths.socket, resolve); });
  writeLinkState(path.join(root, 'hub'), pairedRunnerId, { pid: process.pid, sinceMs: seenAtMs - 1000, lastBeatMs: seenAtMs, endedAtMs: null });
}

function storeSnapshot(name: string, text: string = macProbeText): void {
  fs.writeFileSync(path.join(cacheDir, `${name}.probe.json`), JSON.stringify({ seenAtMs, text }));
}

/** The test fails (not hangs) when the view does not end. */
function withinBound<T>(work: Promise<T>): Promise<T> {
  return Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`the view did not end within ${testBoundMs} ms`)), testBoundMs).unref())]);
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-run-busy-')));
  cacheDir = path.join(root, 'cache');
  fs.mkdirSync(cacheDir);
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); })));
  fs.rmSync(root, { recursive: true, force: true });
});

describe('probeRunner: busy or offline', () => {
  it('a runner whose ssh answered the check of its script but whose probe ran out of time is BUSY — with its last snapshot — not offline', async () => {
    storeSnapshot('mac');
    const [report] = await withinBound(probeRunners([createClient({ runner: handMade, probe: (signal) => hangUntilAborted(signal) })], Date.now(), deadlineMs));
    assert.ok(report.status === 'busy', JSON.stringify(report));
    assert.equal(report.reason, 'no answer within 1 s (its probe did not finish)');
    assert.equal(report.evidence, 'ssh', 'a hand-made runner has no link: its ssh answered');
    assert.equal(report.lastSeenAtMs, seenAtMs);
    assert.equal(report.lastProbe?.osName, 'macOS');
  });

  it('a paired runner whose LINK IS UP but whose ssh got no answer to the check of its script before the deadline is busy too — the link is the proof it is there', async () => {
    await putLinkUp();
    storeSnapshot('mac');
    const stuck = createClient({
      runner: createPaired(),
      ensureScript: async (signal) => {
        await hangUntilAborted(signal);
        throw new RunnerUnreachableError('mac', 'ssh: the command ran past its deadline');
      },
    });
    const [report] = await withinBound(probeRunners([stuck], Date.now(), deadlineMs));
    assert.ok(report.status === 'busy', JSON.stringify(report));
    assert.equal(report.reason, 'no answer within 1 s (its first call, the check of its script, was not answered)');
    assert.equal(report.evidence, 'link');
    assert.equal(report.lastProbe?.osName, 'macOS');
  });

  it('what stays OFFLINE: a hand-made runner that does not answer ssh at all (nothing says it is there), a paired runner whose link is down, and a call that fails by itself before the deadline', async () => {
    storeSnapshot('mac');
    const silent = createClient({ runner: handMade, ensureScript: async (signal) => { await hangUntilAborted(signal); throw new RunnerUnreachableError('mac', 'ssh: the command ran past its deadline'); } });
    const [silentReport] = await withinBound(probeRunners([silent], Date.now(), deadlineMs));
    assert.ok(silentReport.status === 'offline' && silentReport.reason === 'no answer within 1 s' && silentReport.lastProbe !== null, JSON.stringify(silentReport));

    const linkDown = await probeRunner(createClient({ runner: createPaired() }));
    assert.ok(linkDown.status === 'offline' && linkDown.reason === 'the runner is not connected', JSON.stringify(linkDown));

    await putLinkUp();
    const refused = createClient({ runner: createPaired(), ensureScript: async () => { throw new RunnerUnreachableError('mac', 'ssh: Connection closed by remote host'); } });
    const refusedReport = await probeRunner(refused, Date.now(), undefined, 60_000);
    assert.ok(refusedReport.status === 'offline' && refusedReport.reason === 'ssh: Connection closed by remote host', 'the link was up but the call failed at once: not a slow runner');

    const dropped = createClient({ runner: handMade, probe: async () => ({ exitCode: 255, stdout: '', stderr: 'Connection to mac.example closed by remote host.\n', isTimedOut: false }) });
    const droppedReport = await probeRunner(dropped, Date.now(), undefined, 60_000);
    assert.ok(droppedReport.status === 'offline', 'a connection that dropped (a Mac that fell asleep) is the runner gone, not busy');
  });

  it('a paired runner whose link is up and whose ssh gives up on its own BEFORE the deadline (its 15 s connect/banner timeout is shorter than the 20 s one: on a loaded Mac the link\'s Node is slow to finish a handshake) is busy, not offline', async () => {
    await putLinkUp();
    storeSnapshot('mac');
    for (const reason of ['ssh: Connection timed out during banner exchange', 'ssh: Operation timed out']) {
      const slow = createClient({ runner: createPaired(), ensureScript: async () => { throw new RunnerUnreachableError('mac', reason); } });
      const report = await probeRunner(slow, Date.now(), undefined, 60_000);
      assert.ok(report.status === 'busy' && report.evidence === 'link' && report.lastProbe !== null, `${reason}: ${JSON.stringify(report)}`);
    }
    // The second call: the script was found, then the probe's own ssh timed out in its handshake.
    const slowProbe = createClient({ runner: createPaired(), probe: async () => ({ exitCode: 255, stdout: '', stderr: 'Connection timed out during banner exchange\n', isTimedOut: false }) });
    const slowProbeReport = await probeRunner(slowProbe, Date.now(), undefined, 60_000);
    assert.ok(slowProbeReport.status === 'busy' && slowProbeReport.reason.endsWith('(its probe did not finish)'), JSON.stringify(slowProbeReport));
  });

  it('what ssh says when it is NOT a timeout stays offline even with the link up — refused, closed, reset, a host key — and so does a timeout of a hand-made runner whose script check did not answer (nothing says it is there)', async () => {
    await putLinkUp();
    for (const reason of ['ssh: Connection closed by remote host', 'ssh: Connection reset by peer', 'ssh: the host key is not trusted yet — connect once by hand (ssh to this runner) so it is known']) {
      const dropped = createClient({ runner: createPaired(), ensureScript: async () => { throw new RunnerUnreachableError('mac', reason); } });
      assert.equal((await probeRunner(dropped, Date.now(), undefined, 60_000)).status, 'offline', reason);
    }
    const handMadeTimeout = createClient({ runner: handMade, ensureScript: async () => { throw new RunnerUnreachableError('mac', 'ssh: connect to host mac.example port 22: Connection timed out'); } });
    assert.equal((await probeRunner(handMadeTimeout, Date.now(), undefined, 60_000)).status, 'offline', 'a TCP connect that timed out proves nothing');
  });

  it('a probe that FAILS BY ITSELF with a «timed out» line of a tool it calls (pueue, xcrun) is a failed probe, offline — only ssh\'s own failure (its exit 255) counts as ssh giving up, for a paired and for a hand-made runner', async () => {
    await putLinkUp();
    storeSnapshot('mac');
    for (const runner of [createPaired(), handMade]) {
      const failing = createClient({ runner, probe: async () => ({ exitCode: 1, stdout: '', stderr: 'pueue: connection to the daemon timed out\n', isTimedOut: false }) });
      const report = await probeRunner(failing, Date.now(), undefined, 60_000);
      assert.equal(report.status, 'offline', `${runner.name}: ${JSON.stringify(report)}`);
    }
  });

  it('the script of the runner was missing and its UPLOAD was cut off by the deadline (every first probe after an update uploads the new script): busy — ssh answered the check — not «offline» with the upload\'s own reason; without the deadline it is the upload\'s failure', async () => {
    storeSnapshot('mac');
    const cutOff = createClient({
      runner: handMade,
      ensureScript: async (signal) => {
        await hangUntilAborted(signal);
        throw new RemoteRunError('could not put the runner script on "mac" (/w/bin) — ssh: the command ran past its deadline');
      },
    });
    const [report] = await withinBound(probeRunners([cutOff], Date.now(), deadlineMs));
    assert.ok(report.status === 'busy' && report.reason === 'no answer within 1 s (the upload of its script did not finish)' && report.evidence === 'ssh' && report.lastProbe !== null, JSON.stringify(report));
    const refused = createClient({ runner: handMade, ensureScript: async () => { throw new RemoteRunError('could not put the runner script on "mac" (/w/bin) — Permission denied'); } });
    const refusedReport = await probeRunner(refused, Date.now(), undefined, 60_000);
    assert.ok(refusedReport.status === 'offline' && refusedReport.reason.includes('Permission denied'), 'an upload that failed by itself is the runner broken, as before');
  });

  it('only the DEADLINE makes a runner busy: a stop from the user (Ctrl-C) ends the calls in flight and the report stays offline — an interrupted view has no use for «busy»', async () => {
    await putLinkUp();
    const stuck = createClient({
      runner: createPaired(),
      ensureScript: async (signal) => {
        await hangUntilAborted(signal);
        throw new RunnerUnreachableError('mac', 'ssh: cut off');
      },
    });
    const stop = new AbortController();
    const probing = probeRunners([stuck], Date.now(), 60_000, stop.signal);
    setTimeout(() => stop.abort(), 50).unref();
    const [report] = await withinBound(probing);
    assert.equal(report.status, 'offline');
  });

  it('a runner that was never probed is busy with nothing to show: never seen, no snapshot — and a busy answer writes no snapshot of its own', async () => {
    const [report] = await withinBound(probeRunners([createClient({ runner: handMade, probe: (signal) => hangUntilAborted(signal) })], Date.now(), deadlineMs));
    assert.ok(report.status === 'busy' && report.lastSeenAtMs === null && report.lastProbe === null, JSON.stringify(report));
    assert.equal(readLastProbe(cacheDir, 'mac'), null, 'nothing was stored as if the runner had answered');
  });

  it('a probe that finishes in time is online, as before', async () => {
    const report = await probeRunner(createClient({ runner: handMade }), seenAtMs, undefined, deadlineMs);
    assert.equal(report.status, 'online');
    assert.equal(readLastProbe(cacheDir, 'mac')?.seenAtMs, seenAtMs);
  });
});

describe('the block `runners` prints for a busy runner', () => {
  const busy = (lastProbe: string | null, overrides: Partial<Extract<RunnerReport, { status: 'busy' }>> = {}): RunnerReport => ({
    name: 'mac',
    status: 'busy',
    evidence: 'link',
    reason: 'no answer within 20 s (its probe did not finish)',
    lastSeenAtMs: lastProbe === null ? null : seenAtMs,
    lastProbe: lastProbe === null ? null : parseProbeOutput(lastProbe),
    groupLimits: {},
    isPausedByHub: false,
    ...overrides,
  });

  it('says «online, busy» — never «offline» — with why and what it is, then the details AS LAST PROBED with their time', () => {
    const block = formatRunnerBlock(busy(macProbeText));
    const [heading, ...details] = block.split('\n');
    assert.equal(heading, 'mac — online, busy · no answer within 20 s (its probe did not finish); it is linked, so it is not offline · details as last probed 2026-11-09 07:00 UTC: macOS 26.1 (Darwin, arm64)');
    assert.ok(!block.includes('offline (') && !block.includes('never seen'));
    assert.match(details.join('\n'), /jobs: 1 running/);
    assert.match(details.join('\n'), /can: ios \(Xcode 27\.2, 16 simulators\)/);
  });

  it('says what makes it busy: a paired runner «is linked», a hand-made one — it has no link — «its ssh answered»', () => {
    assert.match(formatRunnerBlock(busy(macProbeText)).split('\n')[0], /; it is linked, so it is not offline · /);
    const handMadeHeading = formatRunnerBlock(busy(macProbeText, { evidence: 'ssh' })).split('\n')[0];
    assert.match(handMadeHeading, /; its ssh answered, so it is not offline · /);
    assert.doesNotMatch(handMadeHeading, /linked/);
  });

  it('never probed: the heading alone, saying so; the pause tags stay', () => {
    assert.equal(formatRunnerBlock(busy(null)), 'mac — online, busy · no answer within 20 s (its probe did not finish); it is linked, so it is not offline · never probed');
    assert.match(formatRunnerBlock(busy(macProbeText, { isPausedByHub: true })), /^mac — online, busy · paused from the hub · /);
  });
});

describe('pickRunner and the wait: a busy runner is there', () => {
  const config: RunnersConfig = { runners: [{ name: 'mac', ssh: 'u@mac.example', workDir: '/w' }, { name: 'box', ssh: 'u@box.example', workDir: '/w' }] };
  const busy = (name: string, lastProbe: string | null, overrides: Partial<Extract<RunnerReport, { status: 'busy' }>> = {}): RunnerReport => ({
    name,
    status: 'busy',
    evidence: 'link',
    reason: 'no answer within 20 s (its probe did not finish)',
    lastSeenAtMs: seenAtMs,
    lastProbe: lastProbe === null ? null : parseProbeOutput(lastProbe),
    groupLimits: {},
    isPausedByHub: false,
    ...overrides,
  });
  const online = (name: string, text: string): RunnerReport => ({ name, status: 'online', probe: parseProbeOutput(text), groupLimits: {}, isPausedByHub: false });
  const offline = (name: string): RunnerReport => ({ name, status: 'offline', reason: 'the runner is not connected', lastSeenAtMs: seenAtMs, lastProbe: parseProbeOutput(macProbeText), groupLimits: {}, isPausedByHub: false });

  it('is picked from its last snapshot: Pueue there, not paused, and — with --needs — the capability; named or not', () => {
    assert.deepEqual(pickRunner(config, [busy('mac', macProbeText), offline('box')], { runner: null, needs: 'ios' }), { ok: true, runnerName: 'mac' });
    assert.deepEqual(pickRunner(config, [busy('mac', macProbeText), offline('box')], { runner: 'mac', needs: 'ios' }), { ok: true, runnerName: 'mac' });
    assert.deepEqual(pickRunner(config, [busy('mac', macProbeText), online('box', noPueueText)], { runner: null, needs: null }), { ok: true, runnerName: 'mac' });
    const lacking = pickRunner(config, [busy('mac', macProbeText), offline('box')], { runner: 'mac', needs: 'docker' });
    assert.ok(!lacking.ok && lacking.message.startsWith('runner "mac" cannot do "docker"'), JSON.stringify(lacking));
  });

  it('is picked when its snapshot says its Pueue gave no answer in time (the load that made it busy slowed the version call too) — only a missing Pueue refuses it', () => {
    const slowPueueText = macProbeText.replace('pueue=4.0.4', 'pueue=unknown');
    assert.deepEqual(pickRunner(config, [busy('mac', slowPueueText), offline('box')], { runner: null, needs: 'ios' }), { ok: true, runnerName: 'mac' });
    assert.deepEqual(pickRunner(config, [busy('mac', slowPueueText), offline('box')], { runner: 'mac', needs: 'ios' }), { ok: true, runnerName: 'mac' });
  });

  it('is not picked when its snapshot says no Pueue, or it is paused — and is told so, not called offline', () => {
    const noPueue = pickRunner(config, [busy('mac', noPueueText), offline('box')], { runner: 'mac', needs: null });
    assert.ok(!noPueue.ok && noPueue.message.startsWith('runner "mac" has no Pueue'), JSON.stringify(noPueue));
    const paused = pickRunner(config, [busy('mac', macProbeText, { isPausedByHub: true }), offline('box')], { runner: null, needs: null });
    assert.ok(!paused.ok && paused.message.includes('(paused, so not used: mac)') && !paused.message.includes('is offline'), JSON.stringify(paused));
  });

  it('one never probed is not picked for lack of anything to judge it by — said as «busy and never probed», not «no runner is online» alone — except when it is named and nothing is asked of it', () => {
    const unnamed = pickRunner(config, [busy('mac', null), offline('box')], { runner: null, needs: null });
    assert.ok(!unnamed.ok && unnamed.message.includes('(busy and never probed, so not used: mac)') && unnamed.message.includes('mac — online, busy'), JSON.stringify(unnamed));
    assert.deepEqual(pickRunner(config, [busy('mac', null), offline('box')], { runner: 'mac', needs: null }), { ok: true, runnerName: 'mac' });
    const needing = pickRunner(config, [busy('mac', null), offline('box')], { runner: 'mac', needs: 'ios' });
    assert.ok(!needing.ok && needing.message.startsWith('runner "mac" is busy and was never probed, so it cannot be told to do "ios"'), JSON.stringify(needing));
  });

  it('is never waited for — it is not away: the same data as an OFFLINE runner is', () => {
    const pairedConfig: RunnersConfig = { runners: [{ ...createPaired('mac') }] };
    assert.equal(planRunnerWait(pairedConfig, [busy('mac', macProbeText)], { runner: null, needs: 'ios' }), null);
    assert.deepEqual(planRunnerWait(pairedConfig, [offline('mac')], { runner: null, needs: 'ios' })?.runnerNames, ['mac']);
  });
});

describe('the bot\'s /runners and the listing: a busy machine stays online', () => {
  let hub: HubFixture;
  let binDir = '';
  let previousPath: string | undefined;
  const linkStartMs = Date.UTC(2026, 10, 9, 6, 0, 0);

  /** `ssh` that finds the script at once and then hangs on the probe — what a machine under load 129 looks like from here. */
  function installHangingProbeSsh(): void {
    binDir = path.join(root, 'bin');
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, 'ssh'), '#!/bin/bash\nlast="${@: -1}"\ncase "$last" in *" probe "*) exec sleep 60 ;; esac\nexit 0\n', { mode: 0o755 });
    previousPath = process.env.PATH;
    process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
  }

  async function pairOneAndPutLinkUp(): Promise<void> {
    const runner = createPairedRunnerFixture({ name: 'mac', serviceKind: 'foreground' });
    writePairedFile(hub.ctx.dir, { rev: 1, runners: [runner] });
    const paths = getRunnerLinkPaths(hub.ctx.dir, runner.id);
    fs.mkdirSync(path.dirname(paths.socket), { recursive: true });
    const server = net.createServer((connection) => connection.destroy());
    servers.push(server);
    await new Promise<void>((resolve) => { server.listen(paths.socket, resolve); });
    writeLinkState(hub.ctx.dir, runner.id, { pid: process.pid, sinceMs: linkStartMs, lastBeatMs: seenAtMs, endedAtMs: null });
  }

  beforeEach(() => {
    hub = createHubFixture();
    installHangingProbeSsh();
  });
  afterEach(() => {
    process.env.PATH = previousPath;
    hub.cleanup();
  });

  it('the screen\'s own probe that ran out of time leaves the machine ONLINE and busy, with the snapshot it held — it used to turn it «offline»', async () => {
    await pairOneAndPutLinkUp();
    fs.writeFileSync(path.join(cacheDir, 'mac.probe.json'), JSON.stringify({ seenAtMs: linkStartMs + 1, text: macProbeText }));
    const overview = await readRunnersOverview(hub.ctx, cacheDir, seenAtMs);
    const probed = await withinBound(probeRunnersOverview(hub.ctx, overview, cacheDir, seenAtMs, deadlineMs));
    assert.equal(probed.entries[0].isOnline, true, 'its link is up');
    assert.equal(probed.entries[0].isBusy, true);
    assert.equal(probed.entries[0].probe, overview.entries[0].probe, 'the snapshot the entry held');
    assert.equal(probed.entries[0].probe?.osName, 'macOS');
  });

  it('a listing\'s refresh that gets no answer from a busy machine remembers the silence (so the next listing does not wait for it again) and leaves its report doubtful — and the machine online', async () => {
    await pairOneAndPutLinkUp();
    fs.writeFileSync(path.join(cacheDir, 'mac.probe.json'), JSON.stringify({ seenAtMs: linkStartMs - 1000, text: macProbeText }));
    const overview = await readRunnersOverview(hub.ctx, cacheDir, seenAtMs);
    assert.equal(overview.entries[0].isSnapshotStale, true);
    const refreshed = await withinBound(refreshStaleSnapshots(hub.ctx, overview, cacheDir, seenAtMs, (ctx, entries, dir, now) => probeRunnersOverview(ctx, entries, dir, now, deadlineMs)));
    assert.equal(refreshed.entries[0].isOnline, true);
    assert.equal(refreshed.entries[0].isReportDoubtful, true, 'nothing answered');
    assert.notEqual(readProbeFailure(cacheDir, 'mac'), null, 'the silence is remembered');
  });
});
