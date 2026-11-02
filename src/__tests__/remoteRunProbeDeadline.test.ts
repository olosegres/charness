/**
 * @description The deadline of the `runners` view (`remoteRun/runners.ts probeRunners`, `ssh.ts runSshCommand`): all runners are probed at
 * once under ONE deadline; a runner that has not answered by then is reported offline WITH the snapshot taken when it was last seen (it
 * once came out as «never seen»), the ssh calls still in flight are killed (they once lived on for their own 60 s, keeping the CLI alive
 * after it had printed), the others are not held back, and a runner that fails by itself before the deadline keeps its own reason.
 * The abort is proven on a real `ssh` process whose connection never completes.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { RunnerUnreachableError } from '../remoteRun/remoteRunError';
import type { RunnerClient } from '../remoteRun/runnerClient';
import { probeRunners } from '../remoteRun/runners';
import { runSshCommand } from '../remoteRun/ssh';

const probeText = 'os=Linux\nos_name=Ubuntu\nos_version=24.04\narch=x86_64\nkernel=6.8.0\ncpu_cores=4\ncpu_threads=8\npueue=4.0.4\ncap_android=no\ncap_ios=no\ncap_docker=no\ncap_playwright=no\n';
const lastSeenAtMs = Date.UTC(2026, 9, 30, 14, 2);
const deadlineMs = 1000;
const testBoundMs = 15_000;

let cacheDir = '';

interface FakeClientOptions {
  name: string;
  ensureScript?: (signal?: AbortSignal) => Promise<void>;
  probe?: (signal?: AbortSignal) => Promise<{ exitCode: number | null; stdout: string; stderr: string; isTimedOut: boolean }>;
}

/** Hangs until the signal fires, then ends the way a killed ssh call does. */
function hangUntilAborted(signal?: AbortSignal): Promise<{ exitCode: number | null; stdout: string; stderr: string; isTimedOut: boolean }> {
  return new Promise((resolve) => {
    signal?.addEventListener('abort', () => resolve({ exitCode: null, stdout: '', stderr: '', isTimedOut: true }), { once: true });
  });
}

function createFakeClient(options: FakeClientOptions): RunnerClient {
  const refuse = (): never => {
    throw new Error('not used by the probe');
  };
  return {
    runner: { name: options.name, ssh: `u@${options.name}.example`, workDir: '/w' },
    cacheDir,
    rsyncSshCommand: 'ssh',
    ensureScript: options.ensureScript ?? (async () => {}),
    getAbsoluteWorkDir: refuse,
    call: async (_subcommand, _args, callOptions) => (options.probe ?? (async () => ({ exitCode: 0, stdout: probeText, stderr: '', isTimedOut: false })))(callOptions?.signal),
    callOrThrow: refuse,
    stream: refuse,
  };
}

function storeSnapshot(runnerName: string): void {
  fs.writeFileSync(path.join(cacheDir, `${runnerName}.probe.json`), JSON.stringify({ seenAtMs: lastSeenAtMs, text: probeText }));
}

/** The test fails (not hangs) when the view does not end. */
function withinBound<T>(work: Promise<T>): Promise<T> {
  return Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`the view did not end within ${testBoundMs} ms`)), testBoundMs).unref())]);
}

describe('probeRunners under one deadline', () => {
  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-deadline-'));
  });
  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('a runner that hangs while its script is checked is offline at the deadline WITH its last snapshot, and the healthy one is not held back', async () => {
    storeSnapshot('frozen');
    let abortedCalls = 0;
    const frozen = createFakeClient({
      name: 'frozen',
      ensureScript: async (signal) => {
        const result = await hangUntilAborted(signal);
        abortedCalls += 1;
        throw new RunnerUnreachableError('frozen', result.isTimedOut ? 'ssh: the command ran past its deadline' : 'x');
      },
    });
    const startedAt = Date.now();
    const [frozenReport, healthyReport] = await withinBound(probeRunners([frozen, createFakeClient({ name: 'healthy' })], Date.now(), deadlineMs));
    assert.ok(Date.now() - startedAt < testBoundMs, 'the view ended');
    assert.equal(frozenReport.status, 'offline');
    assert.ok(frozenReport.status === 'offline' && frozenReport.reason === 'no answer within 1 s', JSON.stringify(frozenReport));
    assert.ok(frozenReport.status === 'offline' && frozenReport.lastSeenAtMs === lastSeenAtMs && frozenReport.lastProbe?.osName === 'Ubuntu', 'the snapshot taken when it was last seen is shown');
    assert.equal(abortedCalls, 1, 'the call in flight was ended from outside');
    assert.equal(healthyReport.status, 'online');
  });

  it('a runner that hangs in the probe itself (its script answered) gets the same: offline at the deadline with its snapshot', async () => {
    storeSnapshot('slow');
    const slow = createFakeClient({ name: 'slow', probe: (signal) => hangUntilAborted(signal) });
    const [report] = await withinBound(probeRunners([slow], Date.now(), deadlineMs));
    assert.ok(report.status === 'offline' && report.reason === 'no answer within 1 s' && report.lastSeenAtMs === lastSeenAtMs && report.lastProbe !== null, JSON.stringify(report));
  });

  it('a runner never seen before is "never seen", not an invented snapshot', async () => {
    const [report] = await withinBound(probeRunners([createFakeClient({ name: 'new', probe: (signal) => hangUntilAborted(signal) })], Date.now(), deadlineMs));
    assert.ok(report.status === 'offline' && report.lastSeenAtMs === null && report.lastProbe === null);
  });

  it('a runner that fails by itself before the deadline keeps its own reason and its snapshot — the deadline did not fire', async () => {
    storeSnapshot('refused');
    const refused = createFakeClient({
      name: 'refused',
      ensureScript: async () => {
        throw new RunnerUnreachableError('refused', 'ssh: connect to host refused.example port 22: Connection refused');
      },
    });
    const [report] = await probeRunners([refused], Date.now(), 60_000);
    assert.ok(report.status === 'offline' && report.reason === 'ssh: connect to host refused.example port 22: Connection refused' && report.lastSeenAtMs === lastSeenAtMs, JSON.stringify(report));
  });

  it('a stop from outside (the user interrupted the command) ends the calls in flight at once, long before the deadline', async () => {
    let abortedScriptChecks = 0;
    let abortedProbes = 0;
    const stuckInScript = createFakeClient({
      name: 'stuck-in-script',
      ensureScript: async (signal) => {
        await hangUntilAborted(signal);
        abortedScriptChecks += 1;
        throw new RunnerUnreachableError('stuck-in-script', 'ssh: cut off');
      },
    });
    const stuckInProbe = createFakeClient({ name: 'stuck-in-probe', probe: async (signal) => { const result = await hangUntilAborted(signal); abortedProbes += 1; return result; } });
    const stop = new AbortController();
    const startedAt = Date.now();
    const probing = probeRunners([stuckInScript, stuckInProbe], Date.now(), 60_000, stop.signal);
    setTimeout(() => stop.abort(), 100).unref();
    const reports = await withinBound(probing);
    assert.ok(Date.now() - startedAt < testBoundMs / 3, `ended with the stop (${Date.now() - startedAt} ms), not with the 60 s deadline`);
    assert.deepEqual(reports.map((report) => report.status), ['offline', 'offline']);
    assert.deepEqual([abortedScriptChecks, abortedProbes], [1, 1], 'both calls in flight were ended from outside');
  });

  it('the deadline timer is cleared when everyone answered first: nothing keeps the process alive after the view', async () => {
    const timeoutsBefore = process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;
    const reports = await probeRunners([createFakeClient({ name: 'a' }), createFakeClient({ name: 'b' })], Date.now(), 60_000);
    assert.deepEqual(reports.map((report) => report.status), ['online', 'online']);
    assert.equal(process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length, timeoutsBefore);
  });
});

describe('runSshCommand with an outside deadline', () => {
  const hasSsh = spawnSync('ssh', ['-V'], { stdio: 'ignore' }).status === 0;
  const isCi = process.env.CI === 'true' || process.env.CI === '1';
  const sshSkip = !hasSsh && !isCi ? 'ssh is not installed here (CI has it)' : false;
  let stopFile = '';
  /** An ssh whose connection never completes: its "proxy" waits for the stop file the test creates when it is done — a plain `sleep` would outlive a killed ssh. */
  const createHungRunner = (): { ssh: string; sshOptions: string[] } => ({
    ssh: 'u@hung.example',
    sshOptions: ['-F', '/dev/null', '-o', `ProxyCommand=sh -c 'until [ -e ${stopFile} ]; do sleep 0.2; done'`],
  });
  /** Let the proxy end, and check that nothing of it is left. */
  async function releaseProxyAndExpectNothingLeft(): Promise<void> {
    fs.writeFileSync(stopFile, '');
    const deadline = Date.now() + 5000;
    const isProxyRunning = (): boolean => (spawnSync('pgrep', ['-f', stopFile], { encoding: 'utf8' }).stdout ?? '').trim() !== '';
    while (isProxyRunning() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(isProxyRunning(), false, 'no proxy process of the killed ssh is left');
  }

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-abort-'));
    stopFile = path.join(cacheDir, 'stop-proxy');
  });
  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('the signal kills the ssh process at once and the result says it was cut off; its own long timer does not outlive it', { skip: sshSkip }, async () => {
    const controller = new AbortController();
    const timeoutsBefore = process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;
    const startedAt = Date.now();
    const pending = runSshCommand({ runner: createHungRunner(), cacheDir, remoteCommand: 'true', timeoutMs: 120_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 500);
    const result = await withinBound(pending);
    await releaseProxyAndExpectNothingLeft();
    assert.equal(result.isTimedOut, true);
    assert.equal(result.exitCode, null, 'killed, not exited');
    assert.ok(Date.now() - startedAt < 10_000, `${Date.now() - startedAt} ms`);
    assert.equal(process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length, timeoutsBefore, 'the 120 s timer is gone with the process');
  });

  it('a signal that has already fired kills the process before it can do anything', { skip: sshSkip }, async () => {
    const result = await withinBound(runSshCommand({ runner: createHungRunner(), cacheDir, remoteCommand: 'true', timeoutMs: 120_000, signal: AbortSignal.abort() }));
    assert.equal(result.isTimedOut, true);
    await releaseProxyAndExpectNothingLeft();
  });
});
