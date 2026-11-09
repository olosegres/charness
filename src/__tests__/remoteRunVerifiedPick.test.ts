/**
 * @description `commands.ts pickVerifiedRunner` and the way `chooseClient` uses it: a runner read as BUSY (its probe did not finish, so nobody looked at its script) is picked from its last snapshot, and the run path
 * never looks for the script again — `prepare` just runs it. So the script is looked for after the pick: found or uploaded, the runner is used (a runner whose script check was cut off by the deadline, with the script
 * of a NEW version not there yet, must still run the job); unreachable, it is offline from then on — the pick is made again without it and a paired runner that could have done the job is waited for (a Mac that was
 * linked a second ago has fallen asleep: the submit waits for it as it always did, instead of failing after ssh's own timeouts); a script that cannot be put there fails the command with that reason. A runner that answered
 * its probe is not asked again. Proven in-process with fake clients, and through `chooseClient` with a real client over a fake `ssh` on the PATH and a real link socket. The flow with the real link is
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
import { chooseClient, pickVerifiedRunner, type CommandContext } from '../remoteRun/commands';
import { parseProbeOutput, type RunnerReport } from '../remoteRun/probe';
import { RemoteRunError, RunnerUnreachableError } from '../remoteRun/remoteRunError';
import type { RunnerClient } from '../remoteRun/runnerClient';
import type { RunnerConfig, RunnersConfig } from '../remoteRun/runnersConfig';
import { getRunnerLinkPaths } from '../runners/hubPaths';
import { writeLinkState } from '../runners/linkControl';

const snapshotText = 'os=Linux\nos_name=Ubuntu\npueue=4.0.4\ncap_android=no\ncap_ios=no\ncap_docker=no\ncap_playwright=yes\ncap_playwright_detail=chromium\n';
const seenAtMs = Date.UTC(2026, 10, 9, 7, 0, 0);
const runnerId = 'a1b2c3d4e5f6';
const noSignal = new AbortController().signal;

let root = '';
const servers: net.Server[] = [];

function createPaired(name: string): RunnerConfig {
  return { name, ssh: `charness-runner-${runnerId}`, workDir: '/w', paired: { runnerId, hubDir: path.join(root, 'hub'), isPausedByHub: false, os: 'Ubuntu 24.04', pairedAtMs: 0 } };
}

function createHandMade(name: string): RunnerConfig {
  return { name, ssh: `user@${name}.example`, workDir: '/w' };
}

function createFakeClient(runner: RunnerConfig, ensureScript: (signal?: AbortSignal) => Promise<void>): RunnerClient & { checks: () => number } {
  let checks = 0;
  const refuse = (): never => { throw new Error('not used'); };
  return {
    runner,
    cacheDir: root,
    rsyncSshCommand: 'ssh',
    ensureScript: async (signal) => { checks += 1; await ensureScript(signal); },
    getAbsoluteWorkDir: refuse,
    call: refuse,
    callOrThrow: refuse,
    stream: refuse,
    checks: () => checks,
  };
}

const busy = (name: string): RunnerReport => ({ name, status: 'busy', evidence: 'link', reason: 'no answer within 20 s (its probe did not finish)', lastSeenAtMs: seenAtMs, lastProbe: parseProbeOutput(snapshotText), groupLimits: {}, isPausedByHub: false });
const online = (name: string): RunnerReport => ({ name, status: 'online', probe: parseProbeOutput(snapshotText), groupLimits: {}, isPausedByHub: false });

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'verified-pick-')));
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); })));
  fs.rmSync(root, { recursive: true, force: true });
});

describe('pickVerifiedRunner', () => {
  const config: RunnersConfig = { runners: [createPaired('mac'), createHandMade('box')] };

  it('a busy runner is picked from its snapshot and its script is looked for BEFORE it is handed over — one check, under the signal given', async () => {
    let seenSignal: AbortSignal | undefined;
    const mac = createFakeClient(createPaired('mac'), async (signal) => { seenSignal = signal; });
    const attempt = await pickVerifiedRunner(config, [mac], [busy('mac')], { runner: null, needs: 'playwright' }, noSignal);
    assert.ok(attempt.ok && attempt.choice === mac);
    assert.equal(mac.checks(), 1);
    assert.equal(seenSignal, noSignal);
  });

  it('a runner that answered its probe is NOT asked again: its script was looked for by the gate before the probe', async () => {
    const mac = createFakeClient(createPaired('mac'), async () => { throw new Error('not to be called'); });
    const attempt = await pickVerifiedRunner(config, [mac], [online('mac')], { runner: null, needs: null }, noSignal);
    assert.ok(attempt.ok);
    assert.equal(mac.checks(), 0);
  });

  it('a busy runner that is unreachable is offline from then on: the pick is made AGAIN and the next runner that can do the job is used', async () => {
    const mac = createFakeClient(createPaired('mac'), async () => { throw new RunnerUnreachableError('mac', 'ssh: Connection timed out during banner exchange'); });
    const box = createFakeClient(createHandMade('box'), async () => undefined);
    const attempt = await pickVerifiedRunner(config, [mac, box], [busy('mac'), online('box')], { runner: null, needs: 'playwright' }, noSignal);
    assert.ok(attempt.ok && attempt.choice === box, JSON.stringify(attempt));
    assert.equal(mac.checks(), 1);
    assert.equal(box.checks(), 0, 'it answered its probe');
  });

  it('the only runner that could do it is busy and unreachable: nothing is picked, the failure names it OFFLINE with ssh\'s reason — and a paired one that had the capability is WAITED for, like any offline one', async () => {
    const mac = createFakeClient(createPaired('mac'), async () => { throw new RunnerUnreachableError('mac', 'ssh: Connection timed out during banner exchange'); });
    const attempt = await pickVerifiedRunner(config, [mac], [busy('mac')], { runner: null, needs: 'playwright' }, noSignal);
    assert.ok(!attempt.ok);
    assert.match(attempt.failure.message, /^no online runner can do "playwright"\n/);
    assert.match(attempt.failure.message, /mac — offline \(ssh: Connection timed out during banner exchange\) · last seen 2026-11-09 07:00 UTC/);
    assert.deepEqual(attempt.wait?.runnerNames, ['mac'], 'worth waiting for: it is paired and had the capability');
    // No capability asked: nothing is waited for (as for an offline runner), the failure says so.
    const plain = await pickVerifiedRunner(config, [mac], [busy('mac')], { runner: null, needs: null }, noSignal);
    assert.ok(!plain.ok && plain.wait === null);
  });

  it('a runner NAMED by the user that turns out unreachable is refused as offline, with the reason — not waited for', async () => {
    const mac = createFakeClient(createPaired('mac'), async () => { throw new RunnerUnreachableError('mac', 'ssh: Connection timed out during banner exchange'); });
    const attempt = await pickVerifiedRunner(config, [mac], [busy('mac')], { runner: 'mac', needs: null }, noSignal);
    assert.ok(!attempt.ok && attempt.failure.message.startsWith('runner "mac" is offline (ssh: Connection timed out during banner exchange)') && attempt.wait === null, JSON.stringify(attempt));
  });

  it('a script that cannot be put on a reachable runner fails the command with that reason — it is not an offline runner and not a job that dies in `prepare` with exit 127', async () => {
    const mac = createFakeClient(createPaired('mac'), async () => { throw new RemoteRunError('could not put the runner script on "mac" (/w/bin) — Permission denied'); });
    await assert.rejects(pickVerifiedRunner(config, [mac], [busy('mac')], { runner: null, needs: null }, noSignal), /could not put the runner script on "mac" .* Permission denied/);
  });
});

describe('chooseClient with a real client over a fake ssh: the check after the pick', () => {
  let binDir = '';
  let previousPath: string | undefined;
  let nowMs = 0;
  let sleeps: number[] = [];
  let stderr: string[] = [];

  /**
   * An `ssh` that answers by the number of its call: the script check (`test -f …`) and the upload (`cat > …`) and the probe come as the script says. `plan` is one line per call of that kind, in order:
   * `hang` (never answers: the view's deadline cuts it), `missing` / `present` (the check's answer), `slow` (ssh's own timeout, status 255), `ok` (the upload took it).
   */
  function installFakeSsh(plan: { check: string[]; upload: string[] }): void {
    binDir = path.join(root, 'bin');
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(root, 'check.plan'), `${plan.check.join('\n')}\n`);
    fs.writeFileSync(path.join(root, 'upload.plan'), `${plan.upload.join('\n')}\n`);
    fs.writeFileSync(path.join(root, 'probe.txt'), snapshotText);
    const script = `#!/bin/bash
last="\${@: -1}"
next() { local n; n=$(cat "${root}/$1.n" 2>/dev/null || echo 0); n=$((n + 1)); echo $n > "${root}/$1.n"; sed -n "\${n}p" "${root}/$1.plan"; }
case "$last" in
  "test -f "*) echo "check" >> "${root}/calls.log"; answer=$(next check)
    case "$answer" in hang) exec sleep 60 ;; missing) exit 1 ;; slow) echo "Connection timed out during banner exchange" >&2; exit 255 ;; *) exit 0 ;; esac ;;
  *"cat >"*|*"cat > "*) echo "upload" >> "${root}/calls.log"; cat > /dev/null; answer=$(next upload); [ "$answer" = ok ] && exit 0; exit 1 ;;
  *" probe "*) echo "probe" >> "${root}/calls.log"; cat "${root}/probe.txt"; exit 0 ;;
esac
exit 0
`;
    fs.writeFileSync(path.join(binDir, 'ssh'), script, { mode: 0o755 });
    previousPath = process.env.PATH;
    process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
  }

  function readCalls(): string[] {
    const file = path.join(root, 'calls.log');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter((line) => line !== '') : [];
  }

  async function putLinkUp(): Promise<void> {
    const paths = getRunnerLinkPaths(path.join(root, 'hub'), runnerId);
    fs.mkdirSync(path.dirname(paths.socket), { recursive: true });
    const server = net.createServer((connection) => connection.destroy());
    servers.push(server);
    await new Promise<void>((resolve) => { server.listen(paths.socket, resolve); });
    writeLinkState(path.join(root, 'hub'), runnerId, { pid: process.pid, sinceMs: seenAtMs - 1000, lastBeatMs: seenAtMs, endedAtMs: null });
  }

  function createContext(): CommandContext {
    return {
      io: { stdout: () => undefined, stderr: (text) => { stderr.push(text); }, cwd: root, env: {}, homeDir: root },
      config: { runners: [] },
      cacheDir: path.join(root, 'cache'),
      script: { name: 'runner-test.sh', text: '#!/bin/bash\n' },
      leaseMs: 3000,
      now: () => nowMs,
      loadRunners: () => ({ runners: [createPaired('mac')] }),
      runnerPollMs: 10_000,
      probeDeadlineMs: 1000,
      sleep: async (ms) => { sleeps.push(ms); nowMs += ms; },
      watchInterrupts: () => () => undefined,
    };
  }

  beforeEach(() => {
    nowMs = 1_000_000;
    sleeps = [];
    stderr = [];
    fs.mkdirSync(path.join(root, 'cache'));
    fs.writeFileSync(path.join(root, 'cache', 'mac.probe.json'), JSON.stringify({ seenAtMs, text: snapshotText }));
  });
  afterEach(() => {
    process.env.PATH = previousPath;
  });

  it('the check of the script hangs past the deadline and the NEW script is not on the runner (an update changed its name): the runner reads busy, is picked, and the script is checked and UPLOADED before the job is staged', async () => {
    await putLinkUp();
    installFakeSsh({ check: ['hang', 'missing'], upload: ['ok'] });
    const client = await chooseClient(createContext(), { runner: null, needs: 'playwright', waitSeconds: 0 });
    assert.equal(client.runner.name, 'mac');
    assert.deepEqual(readCalls(), ['check', 'check', 'upload'], 'the view\'s check was cut off; after the pick the script was looked for again, found missing and put there');
  });

  it('the Mac fell asleep with its link still up: the check after the pick times out in ssh itself — the submit goes back into the WAIT (announced once) and takes the runner when it answers, instead of failing', async () => {
    await putLinkUp();
    installFakeSsh({ check: ['hang', 'slow', 'present'], upload: [] });
    const client = await chooseClient(createContext(), { runner: null, needs: 'playwright', waitSeconds: 600 });
    assert.equal(client.runner.name, 'mac');
    assert.deepEqual(sleeps, [10_000], 'one look later it was there');
    assert.equal(stderr.filter((line) => line.includes('waiting for a runner with playwright')).length, 1);
    assert.match(stderr.join(''), /waiting for a runner with playwright \(mac offline since /);
    assert.deepEqual(readCalls(), ['check', 'check', 'check', 'probe']);
  });

  it('without a wait (`--runner-wait 0`) the same Mac fails the command AT ONCE as offline, with the reason — not after the job was staged', async () => {
    await putLinkUp();
    installFakeSsh({ check: ['hang', 'slow'], upload: [] });
    await assert.rejects(chooseClient(createContext(), { runner: null, needs: 'playwright', waitSeconds: 0 }), (error: Error) => error instanceof RemoteRunError && error.exitCode === 125 && /mac — offline \(Connection timed out during banner exchange\)/.test(error.message));
    assert.deepEqual(readCalls(), ['check', 'check'], 'no upload, no probe: nothing was staged');
  });
});
