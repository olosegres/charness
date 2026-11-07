/**
 * @description `remoteRun/probe.ts`: what a runner reports (`runner.sh probe`, parsed — unknown keys ignored, a missing one is
 * "unknown", never a guess) and the short block `remote-run runners` prints for it: an online one in the shape the plan fixed, an
 * offline one with why and its last snapshot, and the capabilities in plain words.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkHasCapability, checkIsRunnerPaused, describeKeepAwakeMethod, formatRunnerBlock, parseProbeOutput, type RunnerReport } from '../remoteRun/probe';

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

describe('the tools a job runs with', () => {
  it('job_node and job_yarn are read as they came: a version, `none` (not on the PATH) or `unknown` (there, no answer); an older script says neither — never a guess', () => {
    assert.deepEqual(parseProbeOutput(`${linuxProbeText}\njob_node=v24.22.2\njob_yarn=1.22.22`).jobTools, { node: 'v24.22.2', yarn: '1.22.22' });
    assert.deepEqual(parseProbeOutput('job_node=v22.11.0\njob_yarn=none').jobTools, { node: 'v22.11.0', yarn: 'none' });
    assert.deepEqual(parseProbeOutput('job_node=unknown\njob_yarn=4.5.0').jobTools, { node: 'unknown', yarn: '4.5.0' });
    assert.equal(parseProbeOutput(linuxProbeText).jobTools, null);
    assert.equal(parseProbeOutput('job_node=v22.11.0\n').jobTools, null);
    assert.equal(parseProbeOutput('job_node=\njob_yarn=\n').jobTools, null);
  });

  it('`runners` shows them on a line of their own, a missing yarn loudly as what makes a job end with exit 127', () => {
    const block = (tools: string): string => formatRunnerBlock({ name: 'mac', status: 'online', probe: parseProbeOutput(`${linuxProbeText}\n${tools}`), groupLimits: {}, isPausedByHub: false });
    assert.match(block('job_node=v24.22.2\njob_yarn=1.22.22'), /\n {2}jobs run with: Node v24\.22\.2 · yarn 1\.22\.22$/m);
    assert.match(block('job_node=v24.22.2\njob_yarn=none'), /jobs run with: Node v24\.22\.2 · yarn: NONE \(a job that calls it ends with exit 127 — see docs\/remote-run\.md\)/);
    assert.match(block('job_node=none\njob_yarn=unknown'), /jobs run with: Node: NONE \(.*\) · yarn: present, no answer in time/);
    assert.ok(!block('').includes('jobs run with'));
  });
});

describe('how a runner keeps its machine awake', () => {
  it('one description of a method serves the link\'s own start line and `runners`: the command, and that a closed lid still sleeps it', () => {
    assert.equal(describeKeepAwakeMethod('caffeinate'), 'caffeinate -i; a closed lid still sleeps it');
    assert.equal(describeKeepAwakeMethod('systemd-inhibit'), 'systemd-inhibit --what=idle; a closed lid still sleeps it');
    for (const method of ['caffeinate', 'systemd-inhibit'] as const) {
      const runnersLine = formatRunnerBlock({ name: 'mac', status: 'online', probe: parseProbeOutput(`${linuxProbeText}\nawake=${method}`), groupLimits: {}, isPausedByHub: false });
      assert.ok(runnersLine.includes(`keeps awake: yes (${describeKeepAwakeMethod(method)})`), method);
    }
  });

  it('awake= and awake_detail= are read as they came: a method, or «no» with why; an older script says neither — never a guess', () => {
    assert.deepEqual(parseProbeOutput(`${linuxProbeText}\nawake=caffeinate`).keepsAwake, { method: 'caffeinate' });
    assert.deepEqual(parseProbeOutput('awake=systemd-inhibit').keepsAwake, { method: 'systemd-inhibit' });
    assert.deepEqual(parseProbeOutput('awake=no\nawake_detail=systemd-inhibit was not found').keepsAwake, { method: null, reason: 'systemd-inhibit was not found' });
    assert.deepEqual(parseProbeOutput('awake=no').keepsAwake, { method: null, reason: '' });
    assert.equal(parseProbeOutput(linuxProbeText).keepsAwake, null);
    assert.equal(parseProbeOutput('awake=maybe').keepsAwake, null);
  });

  it('`runners` says «keeps awake: yes (…; a closed lid still sleeps it)» or «NO — why (the machine may sleep when idle)», on a line of its own, and nothing when the runner did not say', () => {
    const block = (text: string): string => formatRunnerBlock({ name: 'mac', status: 'online', probe: parseProbeOutput(`${linuxProbeText}\n${text}`), groupLimits: {}, isPausedByHub: false });
    assert.match(block('awake=caffeinate'), /\n {2}keeps awake: yes \(caffeinate -i; a closed lid still sleeps it\)/);
    assert.match(block('awake=systemd-inhibit'), /\n {2}keeps awake: yes \(systemd-inhibit --what=idle; a closed lid still sleeps it\)/);
    assert.match(block('awake=no\nawake_detail=caffeinate was not found on this Mac'), /\n {2}keeps awake: NO — caffeinate was not found on this Mac \(the machine may sleep when idle\)/);
    assert.match(block('awake=no'), /\n {2}keeps awake: NO \(the machine may sleep when idle\)/);
    assert.ok(!block('').includes('keeps awake'));
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

describe('formatRunnerBlock: a runner whose Mac has its lid closed', () => {
  const lidClosedReport = (lastProbe: string | null, isPausedByHub = false): RunnerReport => ({ name: 'mac', status: 'lid-closed', lastSeenAtMs: Date.UTC(2026, 10, 1, 14, 2), lastProbe: lastProbe === null ? null : parseProbeOutput(lastProbe), groupLimits: {}, isPausedByHub });

  it('says «lid closed» where an online runner says «online», what that means for new jobs and for running ones — and shows the snapshot it holds, marked as the last one', () => {
    const block = formatRunnerBlock(lidClosedReport(linuxProbeText));
    assert.match(block, /^mac — lid closed · takes no new jobs until its lid is opened \(a job already running there goes on\) — as last probed: Ubuntu 24\.04/);
    assert.ok(!/^mac — online/m.test(block));
    assert.ok(block.split('\n').length > 1, 'the snapshot\'s details follow');
  });

  it('with no snapshot there is only the heading; a pause is still shown beside it', () => {
    assert.equal(formatRunnerBlock(lidClosedReport(null)), 'mac — lid closed · takes no new jobs until its lid is opened (a job already running there goes on)');
    assert.match(formatRunnerBlock(lidClosedReport(linuxProbeText, true)), /^mac — lid closed · paused from the hub · takes no new jobs/);
  });

  it('a pause the runner itself reported in its snapshot counts, as for an offline runner', () => {
    assert.equal(checkIsRunnerPaused(lidClosedReport(`${linuxProbeText}\npaused=yes`)), true);
    assert.equal(checkIsRunnerPaused(lidClosedReport(linuxProbeText)), false);
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

describe('the disk upkeep in the probe: what the runner wants kept free and its project copies', () => {
  const lowDiskText = `${linuxProbeText}\ndisk_total_mb=460000\ndisk_min_free_mb=61440\ncopies_count=16\ncopies_size_mb=296960\ncopies_unmeasured=0`.replace('disk_free_mb=184320', 'disk_free_mb=10035');
  const blockOf = (text: string): string => formatRunnerBlock({ name: 'box1', status: 'online', probe: parseProbeOutput(text), groupLimits: {}, isPausedByHub: false });

  it('are parsed; a probe from a script that does not say has none (null, never a guess)', () => {
    const probe = parseProbeOutput(lowDiskText);
    assert.equal(probe.diskMinFreeMb, 61440);
    assert.deepEqual(probe.copies, { count: 16, sizeMb: 296960, unmeasuredCount: 0 });
    const silent = parseProbeOutput(linuxProbeText);
    assert.equal(silent.diskMinFreeMb, null);
    assert.equal(silent.copies, null);
  });

  it('`runners` shows the number and total size of the copies next to the free disk — and says LOW when the disk is under what the runner wants kept free', () => {
    const lines = blockOf(lowDiskText).split('\n');
    assert.match(lines[1], /disk 9\.8 GB free \(work dir\) — LOW, the runner wants 60 GB kept free · 16 project copies, 290 GB$/);
  });

  it('a disk at its target is not LOW; a target of 0 is none; one copy reads «copy»; a figure still being measured says so', () => {
    const fine = blockOf(`${linuxProbeText}\ndisk_min_free_mb=61440\ncopies_count=1\ncopies_size_mb=2048\ncopies_unmeasured=1`).split('\n')[1];
    assert.match(fine, /disk 180 GB free \(work dir\) · 1 project copy, 2 GB so far \(measuring\)$/);
    assert.doesNotMatch(blockOf(`${linuxProbeText}\ndisk_min_free_mb=0`), /LOW/);
    assert.doesNotMatch(blockOf(`${linuxProbeText}\ndisk_min_free_mb=0`).split('\n')[1], /project cop/);
    assert.doesNotMatch(blockOf(`${linuxProbeText}\ncopies_count=0\ncopies_size_mb=0\ncopies_unmeasured=0`).split('\n')[1], /project cop/, 'no copy, nothing to say about copies');
  });
});
