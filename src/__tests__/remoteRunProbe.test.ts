/**
 * @description `remoteRun/probe.ts`: what a runner reports (`runner.sh probe`, parsed — unknown keys ignored, a missing one is
 * "unknown", never a guess) and the short block `remote-run runners` prints for it: an online one in the shape the plan fixed, an
 * offline one with why and its last snapshot, and the capabilities in plain words.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkHasCapability, checkIsRunnerPaused, formatRunnerBlock, parseProbeOutput, type RunnerReport } from '../remoteRun/probe';

const linuxProbeText = [
  'os=Linux', 'arch=x86_64', 'kernel=6.8.0-45-generic', 'os_name=Ubuntu', 'os_version=24.04',
  'cpu_model=AMD Ryzen 7 9700X 8-Core Processor', 'cpu_cores=8', 'cpu_threads=16', 'load=2.1',
  'ram_total_mb=64000', 'ram_free_mb=41000', 'disk_free_mb=184320', 'pueue=4.0.4',
  'jobs_running=1', 'jobs_queued=2', 'jobs_projects=2',
  'cap_android=yes', 'cap_android_detail=KVM, emulator',
  'cap_ios=no', 'cap_ios_detail=Linux',
  'cap_docker=yes', 'cap_docker_detail=',
  'cap_playwright=yes', 'cap_playwright_detail=chromium',
  'future_key=ignored',
].join('\n');

describe('parseProbeOutput', () => {
  it('reads every field and the capabilities', () => {
    const probe = parseProbeOutput(linuxProbeText);
    assert.equal(probe.osName, 'Ubuntu');
    assert.equal(probe.cpuCores, 8);
    assert.equal(probe.cpuThreads, 16);
    assert.equal(probe.load, 2.1);
    assert.equal(probe.ramFreeMb, 41000);
    assert.equal(probe.pueueVersion, '4.0.4');
    assert.deepEqual([probe.jobsRunning, probe.jobsQueued, probe.jobsProjects], [1, 2, 2]);
    assert.equal(checkHasCapability(probe, 'android'), true);
    assert.equal(checkHasCapability(probe, 'ios'), false);
    assert.equal(probe.capabilities.ios.detail, 'Linux');
  });

  it('a missing key is unknown, never a guess; "pueue=missing" is no Pueue', () => {
    const probe = parseProbeOutput('os=Linux\npueue=missing\n');
    assert.equal(probe.cpuCores, null);
    assert.equal(probe.ramTotalMb, null);
    assert.equal(probe.pueueVersion, null);
    assert.equal(checkHasCapability(probe, 'docker'), false);
    assert.equal(probe.jobsRunning, 0);
  });
});

describe('what a paired runner adds to the probe', () => {
  const pairedProbeText = `${linuxProbeText}\npaused=no\nservice=system-service\nrunner_version=3.8.0\nios_boot=failed\nios_boot_detail=no login session`;

  it('reads paused, how it is kept running, its charness version and the iOS boot check', () => {
    const probe = parseProbeOutput(pairedProbeText);
    assert.equal(probe.isPaused, false);
    assert.equal(probe.serviceKind, 'system-service');
    assert.equal(probe.runnerVersion, '3.8.0');
    assert.deepEqual(probe.iosBoot, { status: 'failed', detail: 'no login session' });
    assert.equal(parseProbeOutput('paused=yes\n').isPaused, true);
  });

  it('a hand-made runner (or an older script) says none of it: not paused, no service, no version, no boot check — never a guess', () => {
    const probe = parseProbeOutput(linuxProbeText);
    assert.deepEqual([probe.isPaused, probe.serviceKind, probe.runnerVersion, probe.iosBoot], [false, null, null, null]);
  });

  it('a service or boot-check word the main box does not know is ignored, not trusted', () => {
    const probe = parseProbeOutput('service=weird\nios_boot=maybe\nrunner_version=\n');
    assert.deepEqual([probe.serviceKind, probe.iosBoot, probe.runnerVersion], [null, null, null]);
  });

  it('`runners` shows the program and how it is kept running under the capabilities — and nothing extra for a hand-made runner', () => {
    const paired = formatRunnerBlock({ name: 'mac', status: 'online', probe: parseProbeOutput(pairedProbeText), groupLimits: {}, isPausedByHub: false });
    assert.equal(paired.split('\n').at(-1), '  charness-runner 3.8.0 · system service');
    const handMade = formatRunnerBlock({ name: 'box1', status: 'online', probe: parseProbeOutput(linuxProbeText), groupLimits: {}, isPausedByHub: false });
    assert.equal(handMade.split('\n').length, 4);
  });

  it('the heading says who paused it — the hub, the runner itself, or both — online or as it was when last seen', () => {
    const probeOf = (text: string) => parseProbeOutput(`${linuxProbeText}\n${text}`);
    const onlinePausedBoth: RunnerReport = { name: 'mac', status: 'online', probe: probeOf('paused=yes'), groupLimits: {}, isPausedByHub: true };
    assert.match(formatRunnerBlock(onlinePausedBoth), /^mac — online · paused from the hub · paused on the runner · Ubuntu 24\.04/);
    const hubOnly: RunnerReport = { name: 'mac', status: 'online', probe: probeOf('paused=no'), groupLimits: {}, isPausedByHub: true };
    assert.match(formatRunnerBlock(hubOnly), /^mac — online · paused from the hub · Ubuntu/);
    const offlinePaused: RunnerReport = { name: 'mac', status: 'offline', reason: 'the runner is not connected', lastSeenAtMs: Date.UTC(2026, 10, 1, 14, 2), lastProbe: probeOf('paused=yes'), groupLimits: {}, isPausedByHub: false };
    assert.match(formatRunnerBlock(offlinePaused), /^mac — offline \(the runner is not connected\) · paused on the runner · last seen 2026-11-01 14:02 UTC — as it was then: Ubuntu/);
    assert.deepEqual([onlinePausedBoth, hubOnly, offlinePaused].map(checkIsRunnerPaused), [true, true, true]);
    assert.equal(checkIsRunnerPaused({ name: 'mac', status: 'online', probe: probeOf('paused=no'), groupLimits: {}, isPausedByHub: false }), false);
    assert.equal(checkIsRunnerPaused({ name: 'mac', status: 'offline', reason: 'x', lastSeenAtMs: null, lastProbe: null, groupLimits: {}, isPausedByHub: false }), false);
  });
});

describe('formatRunnerBlock', () => {
  const groupLimits = { default: 2, emulator: 1 };

  it('an online runner: system, hardware and load, jobs and groups, what it can and cannot do', () => {
    const block = formatRunnerBlock({ name: 'box1', status: 'online', probe: parseProbeOutput(linuxProbeText), groupLimits, isPausedByHub: false });
    assert.equal(block, [
      'box1 — online · Ubuntu 24.04 (Linux 6.8, x86_64)',
      '  CPU AMD Ryzen 7 9700X 8-Core Processor, 8 cores / 16 threads, load 2.1 · RAM 63 GB, 40 GB free · disk 180 GB free (work dir)',
      '  jobs: 1 running, 2 queued, 2 projects · groups: default 2, emulator 1',
      '  can: android (KVM, emulator) · docker · playwright (chromium) · ios: no (Linux)',
    ].join('\n'));
  });

  it('says so when Pueue is missing', () => {
    const block = formatRunnerBlock({ name: 'bare', status: 'online', probe: parseProbeOutput('os=Linux\npueue=missing\n'), groupLimits: {}, isPausedByHub: false });
    assert.match(block, /Pueue: MISSING/);
  });

  it('one project reads "1 project"; unknown numbers show as ?', () => {
    const block = formatRunnerBlock({ name: 'x', status: 'online', probe: parseProbeOutput('os=Linux\npueue=4.0.4\njobs_projects=1'), groupLimits: {}, isPausedByHub: false });
    assert.match(block, /1 project(?!s)/);
    assert.match(block, /RAM \?, \? free · disk \? free/);
    assert.match(block.split('\n')[0], /^x — online · Linux$/, 'no doubled system name when the runner reports no distribution');
  });

  it('an offline runner: why, when it was last seen, and what it was then', () => {
    const lastProbe = parseProbeOutput('os=Darwin\nos_name=macOS\nos_version=15.1\narch=arm64\nkernel=24.1.0\ncpu_model=Apple M3\ncpu_cores=8\ncpu_threads=8\nload=0.5\nram_total_mb=24576\nram_free_mb=9000\ndisk_free_mb=400000\npueue=4.0.4\ncap_ios=yes\ncap_ios_detail=Xcode 16.2, 5 simulators\ncap_android=yes\ncap_android_detail=HVF, emulator\ncap_docker=no\ncap_docker_detail=docker not installed\ncap_playwright=no\ncap_playwright_detail=no browsers installed');
    const block = formatRunnerBlock({ name: 'mac', status: 'offline', reason: 'ssh: connection timed out', lastSeenAtMs: Date.UTC(2026, 9, 30, 14, 2), lastProbe, groupLimits: {}, isPausedByHub: false });
    const lines = block.split('\n');
    assert.equal(lines[0], 'mac — offline (ssh: connection timed out) · last seen 2026-10-30 14:02 UTC — as it was then: macOS 15.1 (Darwin 24.1, arm64)');
    assert.match(lines[3], /can: android \(HVF, emulator\) · ios \(Xcode 16\.2, 5 simulators\) · docker: no \(docker not installed\) · playwright: no \(no browsers installed\)/);
  });

  it('an offline runner never seen is one line', () => {
    assert.equal(formatRunnerBlock({ name: 'new', status: 'offline', reason: 'ssh: no route', lastSeenAtMs: null, lastProbe: null, groupLimits: {}, isPausedByHub: false }), 'new — offline (ssh: no route) · never seen');
  });
});
