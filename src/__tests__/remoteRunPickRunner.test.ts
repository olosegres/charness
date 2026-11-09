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
// Pueue is installed, but its `--version` gave no answer within the probe's step limit (a machine under load): not «no Pueue».
const slowPueue = 'os=Linux\nos_name=Ubuntu\npueue=unknown\ncap_android=yes\ncap_ios=no\ncap_docker=no\ncap_playwright=no\n';

function online(name: string, probeText: string): RunnerReport {
  return { name, status: 'online', probe: parseProbeOutput(probeText), groupLimits: {}, isPausedByHub: false };
}

function offline(name: string, reason = 'ssh: connection timed out'): RunnerReport {
  return { name, status: 'offline', reason, lastSeenAtMs: null, lastProbe: null, groupLimits: {}, isPausedByHub: false };
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

  it('a runner whose Pueue did not answer in time is still usable — only a Pueue that is not there refuses it', () => {
    assert.deepEqual(pickRunner(config, [online('mac', slowPueue), online('box1', linuxWithAndroid)], { runner: null, needs: null }), { ok: true, runnerName: 'mac' });
    assert.deepEqual(pickRunner(config, [online('mac', slowPueue), online('box1', linuxWithAndroid)], { runner: null, needs: 'android' }), { ok: true, runnerName: 'mac' });
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
    assert.ok(!pick.ok && pick.exitCode === 2 && pick.message === 'no runner named "nope" (configured: mac, box1, box2)');
  });

  it('offline: 125 with why', () => {
    const pick = pickRunner(config, reports, { runner: 'box2', needs: null });
    assert.ok(!pick.ok && pick.exitCode === 125 && pick.message.startsWith('runner "box2" is offline (ssh: connection timed out)'));
  });

  it('a Pueue that did not answer in time: the named runner is picked', () => {
    assert.deepEqual(pickRunner(config, [online('box3', slowPueue)], { runner: 'box3', needs: 'android' }), { ok: true, runnerName: 'box3' });
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

describe('pickRunner — paused runners are never picked', () => {
  const pausedOnRunner = `${linuxWithAndroid}paused=yes\n`;

  function pausedByHub(name: string, probeText: string): RunnerReport {
    return { ...online(name, probeText), isPausedByHub: true };
  }

  it('one paused from the hub is skipped for the next in the file — also when it is the only one with the capability a later one lacks', () => {
    const reports = [pausedByHub('mac', macWithIos), online('box1', linuxWithAndroid), online('box2', linuxWithAndroid)];
    assert.deepEqual(pickRunner(config, reports, { runner: null, needs: null }), { ok: true, runnerName: 'box1' });
    const pick = pickRunner(config, [pausedByHub('mac', macWithIos), online('box1', linuxWithAndroid), online('box2', linuxWithAndroid)], { runner: null, needs: 'ios' });
    assert.ok(!pick.ok && pick.message.startsWith('no online runner can do "ios" (paused, so not used: mac)\n'));
  });

  it('one paused on the runner itself (what its probe says) is skipped the same way', () => {
    const reports = [online('mac', pausedOnRunner), online('box1', linuxWithAndroid)];
    assert.deepEqual(pickRunner(config, reports, { runner: null, needs: null }), { ok: true, runnerName: 'box1' });
  });

  it('all paused: 125, naming them — and only those that could have done the job', () => {
    const reports = [pausedByHub('mac', macWithIos), online('box1', pausedOnRunner), pausedByHub('box2', linuxWithAndroid)];
    const any = pickRunner(config, reports, { runner: null, needs: null });
    assert.ok(!any.ok && any.exitCode === 125 && any.message.startsWith('no runner is online (paused, so not used: mac, box1, box2)\n'));
    const android = pickRunner(config, reports, { runner: null, needs: 'android' });
    assert.ok(!android.ok && android.message.startsWith('no online runner can do "android" (paused, so not used: box1, box2)\n'));
  });

  it('a runner named while paused is refused (125) with who paused it and how to resume', () => {
    const fromHub = pickRunner(config, [pausedByHub('mac', macWithIos)], { runner: 'mac', needs: null });
    assert.ok(!fromHub.ok && fromHub.exitCode === 125 && fromHub.message.startsWith('runner "mac" is paused from the hub — `charness runners resume mac`\n'));
    const onRunner = pickRunner(config, [online('mac', `${macWithIos}paused=yes\n`)], { runner: 'mac', needs: null });
    assert.ok(!onRunner.ok && onRunner.message.startsWith('runner "mac" is paused on the runner — `charness-runner resume` there\n'));
    const both = pickRunner(config, [{ ...online('mac', `${macWithIos}paused=yes\n`), isPausedByHub: true }], { runner: 'mac', needs: null });
    assert.ok(!both.ok && both.message.includes('from the hub — `charness runners resume mac` and on the runner'));
  });

  it('the view marks a paused runner, so the reason is on the screen', () => {
    const pick = pickRunner(config, [pausedByHub('mac', macWithIos)], { runner: null, needs: null });
    assert.ok(!pick.ok && pick.message.includes('mac — online · paused from the hub · '));
  });
});

describe('pickRunner — a runner whose Mac has its lid closed is never picked (it is about to sleep)', () => {
  /** Linked, but the Mac reports a closed lid with nothing keeping it awake: the hub asked it nothing, so the report holds only the last snapshot. */
  function lidClosed(name: string, probeText: string | null, extra: Partial<Extract<RunnerReport, { status: 'lid-closed' }>> = {}): RunnerReport {
    return { name, status: 'lid-closed', lastSeenAtMs: null, lastProbe: probeText === null ? null : parseProbeOutput(probeText), groupLimits: {}, isPausedByHub: false, ...extra };
  }

  it('is skipped for the next runner in the file, like an offline one — also when it is the first and the only one with the capability a later one lacks', () => {
    assert.deepEqual(pickRunner(config, [lidClosed('mac', macWithIos), online('box1', linuxWithAndroid)], { runner: null, needs: null }), { ok: true, runnerName: 'box1' });
    const pick = pickRunner(config, [lidClosed('mac', macWithIos), online('box1', linuxWithAndroid)], { runner: null, needs: 'ios' });
    assert.ok(!pick.ok && pick.exitCode === 125 && pick.message.startsWith('no online runner can do "ios" (lid closed, so not used: mac)\n'));
  });

  it('nothing else is online: 125 naming the Mac whose lid is shut — and only those that could have done the job', () => {
    const reports = [lidClosed('mac', macWithIos), lidClosed('box1', linuxWithAndroid), offline('box2')];
    const any = pickRunner(config, reports, { runner: null, needs: null });
    assert.ok(!any.ok && any.exitCode === 125 && any.message.startsWith('no runner is online (lid closed, so not used: mac, box1)\n'));
    const ios = pickRunner(config, reports, { runner: null, needs: 'ios' });
    assert.ok(!ios.ok && ios.message.startsWith('no online runner can do "ios" (lid closed, so not used: mac)\n'));
  });

  it('a snapshot that never saw the capability is not blamed for the job it could not have done', () => {
    const pick = pickRunner(config, [lidClosed('mac', null), lidClosed('box1', linuxWithAndroid)], { runner: null, needs: 'ios' });
    assert.ok(!pick.ok && pick.message.startsWith('no online runner can do "ios"\n'), pick.ok ? '' : pick.message);
  });

  it('a runner named while its lid is closed is refused (125) with why, and the view says «lid closed»', () => {
    const pick = pickRunner(config, [lidClosed('mac', macWithIos)], { runner: 'mac', needs: null });
    assert.ok(!pick.ok && pick.exitCode === 125 && pick.message.startsWith('runner "mac" has its lid closed (takes no new jobs until its lid is opened (a job already running there goes on))\n'));
    assert.ok(!pick.ok && pick.message.includes('mac — lid closed · takes no new jobs until its lid is opened'));
  });

  it('a paused Mac with the lid closed is not named as a lid-closed one: the pause is the reason the operator can lift', () => {
    const reports = [lidClosed('mac', `${macWithIos}paused=yes\n`)];
    const pick = pickRunner(config, reports, { runner: null, needs: null });
    assert.ok(!pick.ok && pick.message.startsWith('no runner is online\n'), pick.ok ? '' : pick.message);
  });

  it('the view shows what the snapshot knew, marked as old, under the lid-closed heading', () => {
    const pick = pickRunner(config, [lidClosed('mac', macWithIos)], { runner: null, needs: null });
    assert.ok(!pick.ok && pick.message.includes('mac — lid closed · takes no new jobs until its lid is opened (a job already running there goes on) — as last probed: macOS'));
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
    assert.match(chosen.note ?? '', /"retired", is not a configured runner any more .* using the first online runner/);
  });
});

describe('findRunnerOfJob', () => {
  it('the runner a job id names, or an error saying it left the file', () => {
    assert.equal(findRunnerOfJob(config, 'box2').ssh, 'u@box2.example');
    assert.throws(() => findRunnerOfJob(config, 'gone'), (error: Error) => error instanceof RemoteRunError && /"gone", which is not a configured runner any more/.test(error.message));
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
