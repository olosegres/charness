/**
 * @description `remoteRun/runners.ts pickRunner` and the pieces around it: which runner a command goes to — the named one, or the first
 * in `runners.json` that answers, has Pueue and (with `--needs`) the capability — and, when none fits, a message that says why with the
 * `runners` view and the exit code (125; 2 for a name that is not in the file). Plus the last-probe cache an offline runner shows.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseProbeOutput, type RunnerReport } from '../remoteRun/probe';
import { chooseExecRunnerName, findRunnerOfJob, pickRunner, readLastProbe } from '../remoteRun/runners';
import type { RunnersConfig } from '../remoteRun/runnersConfig';
import { RemoteRunError } from '../remoteRun/remoteRunError';

const config: RunnersConfig = {
  runners: [
    { name: 'mac', ssh: 'u@mac.example', workDir: '/w' },
    { name: 'box1', ssh: 'u@box1.example', workDir: '/w' },
    { name: 'box2', ssh: 'u@box2.example', workDir: '/w' },
  ],
};

const linuxWithAndroid = 'os=Linux\nos_name=Ubuntu\npueue=4.0.4\ncap_android=yes\ncap_android_detail=KVM, emulator\ncap_ios=no\ncap_ios_detail=Linux\ncap_docker=no\ncap_playwright=no\n';
const macWithIos = 'os=Darwin\nos_name=macOS\npueue=4.0.4\ncap_ios=yes\ncap_ios_detail=Xcode 16.2, 5 simulators\ncap_android=no\ncap_docker=no\ncap_playwright=no\n';
const noPueue = 'os=Linux\nos_name=Ubuntu\npueue=missing\ncap_android=yes\ncap_ios=no\ncap_docker=no\ncap_playwright=no\n';

function online(name: string, probeText: string): RunnerReport {
  return { name, status: 'online', probe: parseProbeOutput(probeText), groupLimits: {} };
}

function offline(name: string, reason = 'ssh: connection timed out'): RunnerReport {
  return { name, status: 'offline', reason, lastSeenAtMs: null, lastProbe: null, groupLimits: {} };
}

describe('pickRunner — no name given', () => {
  it('the first runner in the file that answers and has Pueue', () => {
    assert.deepEqual(pickRunner(config, [offline('mac'), online('box1', linuxWithAndroid), online('box2', linuxWithAndroid)], { runner: null, needs: null }), { ok: true, runnerName: 'box1' });
  });

  it('with --needs: the first one that also has the capability, whatever its place in the file', () => {
    const reports = [online('mac', macWithIos), online('box1', linuxWithAndroid), online('box2', linuxWithAndroid)];
    assert.deepEqual(pickRunner(config, reports, { runner: null, needs: 'android' }), { ok: true, runnerName: 'box1' });
    assert.deepEqual(pickRunner(config, reports, { runner: null, needs: 'ios' }), { ok: true, runnerName: 'mac' });
  });

  it('a runner without Pueue is not usable, however capable', () => {
    assert.deepEqual(pickRunner(config, [online('mac', noPueue), online('box1', linuxWithAndroid), online('box2', noPueue)], { runner: null, needs: null }), { ok: true, runnerName: 'box1' });
  });

  it('nobody online: exit 125 and the view of every runner', () => {
    const pick = pickRunner(config, [offline('mac'), offline('box1', 'ssh: no route'), offline('box2')], { runner: null, needs: null });
    assert.equal(pick.ok, false);
    assert.ok(!pick.ok && pick.exitCode === 125 && pick.message.startsWith('no runner is online\n'));
    assert.ok(!pick.ok && pick.message.includes('box1 — offline (ssh: no route)'));
  });

  it('no runner with the capability: says which one was needed and shows what each can do', () => {
    const pick = pickRunner(config, [online('mac', macWithIos), online('box1', linuxWithAndroid), online('box2', linuxWithAndroid)], { runner: null, needs: 'docker' });
    assert.ok(!pick.ok && pick.exitCode === 125 && pick.message.startsWith('no online runner can do "docker"\n'));
    assert.ok(!pick.ok && pick.message.includes('mac — online') && pick.message.includes('docker: no'));
  });
});

describe('pickRunner — a runner named', () => {
  const reports = [online('mac', macWithIos), online('box1', linuxWithAndroid), offline('box2'), online('box3', noPueue)];

  it('the named one when it answers, has Pueue and the capability', () => {
    assert.deepEqual(pickRunner(config, reports, { runner: 'box1', needs: 'android' }), { ok: true, runnerName: 'box1' });
  });

  it('a name that is not in the file is a usage mistake (2) listing the configured ones', () => {
    const pick = pickRunner(config, reports, { runner: 'nope', needs: null });
    assert.ok(!pick.ok && pick.exitCode === 2 && pick.message === 'no runner named "nope" in runners.json (configured: mac, box1, box2)');
  });

  it('offline: 125 with why', () => {
    const pick = pickRunner(config, reports, { runner: 'box2', needs: null });
    assert.ok(!pick.ok && pick.exitCode === 125 && pick.message.startsWith('runner "box2" is offline (ssh: connection timed out)'));
  });

  it('no Pueue: 125 saying to install it', () => {
    const pick = pickRunner(config, reports, { runner: 'box3', needs: null });
    assert.ok(!pick.ok && pick.exitCode === 125 && pick.message.startsWith('runner "box3" has no Pueue'));
  });

  it('without the capability: 125 naming it', () => {
    const pick = pickRunner(config, reports, { runner: 'box1', needs: 'ios' });
    assert.ok(!pick.ok && pick.exitCode === 125 && pick.message.startsWith('runner "box1" cannot do "ios"'));
  });
});

describe('chooseExecRunnerName', () => {
  it('without --runner, exec goes where this project\'s last job ran — not to the first runner of the file, which may hold no copy', () => {
    assert.deepEqual(chooseExecRunnerName(config, null, 'box2'), { runnerName: 'box2', note: null });
  });

  it('a named runner is used as it is, whatever the last job did', () => {
    assert.deepEqual(chooseExecRunnerName(config, 'box1', 'box2'), { runnerName: 'box1', note: null });
  });

  it('no job yet from this project: no preference (the first online runner is picked later)', () => {
    assert.deepEqual(chooseExecRunnerName(config, null, null), { runnerName: null, note: null });
  });

  it('the last job\'s runner has left runners.json: no preference, and the note says why exec went elsewhere', () => {
    const chosen = chooseExecRunnerName(config, null, 'retired');
    assert.equal(chosen.runnerName, null);
    assert.match(chosen.note ?? '', /"retired", is not in runners\.json any more — using the first online runner/);
  });
});

describe('findRunnerOfJob', () => {
  it('the runner a job id names, or an error saying it left the file', () => {
    assert.equal(findRunnerOfJob(config, 'box2').ssh, 'u@box2.example');
    assert.throws(() => findRunnerOfJob(config, 'gone'), (error: Error) => error instanceof RemoteRunError && /"gone", which is not in runners\.json any more/.test(error.message));
  });
});

describe('readLastProbe', () => {
  let cacheDir = '';
  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'last-probe-'));
  });
  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('reads back what was stored — the runner\'s own text, parsed again by the one parser', () => {
    fs.writeFileSync(path.join(cacheDir, 'box1.probe.json'), JSON.stringify({ seenAtMs: 1234, text: linuxWithAndroid }));
    const last = readLastProbe(cacheDir, 'box1');
    assert.equal(last?.seenAtMs, 1234);
    assert.equal(last?.probe.osName, 'Ubuntu');
    assert.equal(last?.probe.capabilities.android.isAvailable, true);
  });

  it('nothing stored, a damaged file and a file of the wrong shape are all "never seen"', () => {
    assert.equal(readLastProbe(cacheDir, 'box1'), null);
    fs.writeFileSync(path.join(cacheDir, 'box1.probe.json'), '{oops');
    assert.equal(readLastProbe(cacheDir, 'box1'), null);
    fs.writeFileSync(path.join(cacheDir, 'box1.probe.json'), JSON.stringify({ seenAtMs: 'yesterday' }));
    assert.equal(readLastProbe(cacheDir, 'box1'), null);
  });
});
