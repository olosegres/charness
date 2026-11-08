/**
 * @description `remoteRun/runner.sh` on a Mac with Xcode (the platform is faked, with a fake `xcrun`): the Simulator runtimes the runner reports as OLDER than the newest one of the same platform and major (information
 * only — `sim_older_runtimes=` of the probe), and `xcrun simctl delete unavailable`, the only thing the runner ever deletes among the simulators: tried at most once a day, only by the probe of a VIEW of the runners
 * (`probe <work> prune`, never the probe a run or an `exec` makes first), detached so that probe stays fast, bounded in time, and never asking `simctl` for anything else (no erase, no runtime, no device of an
 * installed runtime).
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseProbeOutput } from '../remoteRun/probe';
import { scriptPath, writeFile } from './remoteRunRunnerScriptKit';

/** What `xcrun simctl list devices available` prints: iOS 26.4 is older than iOS 26.5 (same major), iOS 27.1 is another major, a lone runtime is the newest of its major. */
const deviceListWithOlderRuntimes = `== Devices ==
-- iOS 26.4 --
    iPhone 16 (11111111-1111-1111-1111-111111111111) (Shutdown)
    iPhone 16 Pro (22222222-2222-2222-2222-222222222222) (Booted)
-- iOS 26.5 --
    iPhone 17 (33333333-3333-3333-3333-333333333333) (Shutdown)
-- iOS 27.1 --
    iPhone 18 (44444444-4444-4444-4444-444444444444) (Shutdown)
-- watchOS 11.0 --
    Apple Watch Series 10 (55555555-5555-5555-5555-555555555555) (Shutdown)
-- iOS 18.2 --
    iPhone 15 (66666666-6666-6666-6666-666666666666) (Shutdown)
`;
const deviceListWithoutOlderRuntimes = `== Devices ==
-- iOS 26.5 --
    iPhone 17 (33333333-3333-3333-3333-333333333333) (Shutdown)
-- watchOS 11.0 --
    Apple Watch Series 10 (55555555-5555-5555-5555-555555555555) (Shutdown)
`;
const cleanupWaitMs = 20_000;
const dayHours = 24;

let workRoot = '';
let workDir = '';
let fakeBin = '';
let xcrunLog = '';
let deviceListFile = '';
let releaseFile = '';

function writeFake(name: string, body: string): void {
  fs.writeFileSync(path.join(fakeBin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

/** A `xcrun` that writes down every call; `simctl delete unavailable` waits for the `release` file when `XCRUN_HOLD_DELETE` is set (a hung simctl, until the test lets it go). */
function installFakeMac(): void {
  writeFake('uname', 'case "$1" in -s) echo Darwin ;; -m) echo arm64 ;; -r) echo 24.0.0 ;; *) echo Darwin ;; esac');
  writeFake('xcodebuild', 'echo "Xcode 16.2"');
  writeFake('pueue', 'echo "pueue 4.0.4"');
  writeFake(
    'xcrun',
    `echo "$*" >> "$XCRUN_LOG"
case "$*" in
  "simctl list devices available") cat "$SIM_LIST_FILE" ;;
  "simctl delete unavailable")
    waited=0
    while [ -n "$XCRUN_HOLD_DELETE" ] && [ ! -e "$XCRUN_RELEASE_FILE" ] && [ "$waited" -lt 200 ]; do sleep 0.1; waited=$((waited + 1)); done
    echo "Deleting unavailable devices"
    ;;
esac`,
  );
}

function getEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    PUEUE_BIN: path.join(fakeBin, 'pueue'),
    XCRUN_LOG: xcrunLog,
    SIM_LIST_FILE: deviceListFile,
    XCRUN_RELEASE_FILE: releaseFile,
    ...extra,
  };
}

/** `runner.sh probe <work> [prune]` as a real call (the detached run needs the script's own path), on the fake Mac. */
function probe(args: string[] = [], extra: NodeJS.ProcessEnv = {}): { stdout: string; elapsedMs: number } {
  const startedAt = Date.now();
  const result = spawnSync('bash', [scriptPath, 'probe', workDir, ...args], { encoding: 'utf8', env: getEnvironment(extra), stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  return { stdout: result.stdout, elapsedMs: Date.now() - startedAt };
}

function readXcrunCalls(): string[] {
  return fs.existsSync(xcrunLog) ? fs.readFileSync(xcrunLog, 'utf8').split('\n').filter((line) => line !== '') : [];
}

function countDeleteCalls(): number {
  return readXcrunCalls().filter((call) => call === 'simctl delete unavailable').length;
}

function getStampPath(): string {
  return path.join(workDir, 'simctl-cleanup.at');
}

function getCleanupPidPath(): string {
  return path.join(workDir, 'tmp', 'simctl-cleanup.pid');
}

function readCleanupLog(): string {
  const logPath = path.join(workDir, 'simctl-cleanup.log');
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
}

async function waitForCleanupToEnd(): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < cleanupWaitMs) {
    if (/^exit \d+$/m.test(readCleanupLog())) return readCleanupLog();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`the cleanup did not end: ${readCleanupLog()}`);
}

beforeEach(() => {
  workRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-script-sim-')));
  workDir = path.join(workRoot, 'work');
  fs.mkdirSync(workDir);
  fakeBin = path.join(workRoot, 'fake-bin');
  fs.mkdirSync(fakeBin);
  xcrunLog = path.join(workRoot, 'xcrun.log');
  deviceListFile = path.join(workRoot, 'devices.txt');
  releaseFile = path.join(workRoot, 'release');
  fs.writeFileSync(deviceListFile, deviceListWithOlderRuntimes);
  installFakeMac();
});
afterEach(() => {
  // A held `simctl` must not outlive the test.
  fs.writeFileSync(releaseFile, '');
  fs.rmSync(workRoot, { recursive: true, force: true });
});

describe('the older Simulator runtimes (list_older_simulator_runtimes)', () => {
  function listOlder(text: string): string {
    const result = spawnSync('bash', ['--norc', '--noprofile', '-c', `source ${scriptPath}; list_older_simulator_runtimes`], { encoding: 'utf8', input: text, timeout: 60_000 });
    return result.stdout.trim();
  }

  it('names the runtimes that have a newer one of the same platform AND major, with their devices — another major, another platform and a lone runtime are not older', () => {
    assert.equal(listOlder(deviceListWithOlderRuntimes), 'iOS 26.4:2');
  });

  it('says every older one, in the order Xcode lists them, and compares versions as numbers (26.10 is newer than 26.9)', () => {
    const text = '-- iOS 26.2 --\n    A (1) (Shutdown)\n-- iOS 26.9 --\n    B (2) (Shutdown)\n    C (3) (Shutdown)\n-- iOS 26.10 --\n    D (4) (Shutdown)\n';
    assert.equal(listOlder(text), 'iOS 26.2:1,iOS 26.9:2');
  });

  it('says nothing when there is none — no older runtime, a runtime without devices, runtimes Xcode lists as unavailable, or no text at all', () => {
    assert.equal(listOlder(deviceListWithoutOlderRuntimes), '');
    assert.equal(listOlder('-- iOS 26.4 --\n-- iOS 26.5 --\n    iPhone 17 (1) (Shutdown)\n'), '', 'an older runtime with no device is nothing to report');
    assert.equal(listOlder('-- Unavailable: com.apple.CoreSimulator.SimRuntime.iOS-17-5 --\n    iPhone 15 (1) (Shutdown)\n-- iOS 26.5 --\n    iPhone 17 (2) (Shutdown)\n'), '');
    assert.equal(listOlder(''), '');
  });
});

describe('what the probe says of them', () => {
  it('a Mac with older runtimes: `sim_older_runtimes=` for the probe parser, next to the simulator count the line always had', () => {
    const answer = probe();
    const parsed = parseProbeOutput(answer.stdout);
    assert.deepEqual(parsed.olderSimulators, [{ runtime: 'iOS 26.4', deviceCount: 2 }]);
    assert.match(answer.stdout, /^cap_ios_detail=Xcode 16\.2, 6 simulators$/m);
  });

  it('a Mac without any says nothing of them', () => {
    fs.writeFileSync(deviceListFile, deviceListWithoutOlderRuntimes);
    const answer = probe();
    assert.ok(!answer.stdout.includes('sim_older_runtimes'));
    assert.deepEqual(parseProbeOutput(answer.stdout).olderSimulators, []);
  });
});

describe('xcrun simctl delete unavailable', () => {
  it('the probe of a view of the runners starts it, detached: the one thing asked of simctl besides the list, and what it said is kept in the log', async () => {
    const answer = probe(['prune']);
    assert.ok(fs.existsSync(getCleanupPidPath()), 'the run was started (its pid is written down before the probe returns)');
    const log = await waitForCleanupToEnd();
    assert.match(log, /xcrun simctl delete unavailable\nDeleting unavailable devices\nexit 0\n$/);
    assert.deepEqual(readXcrunCalls(), ['simctl list devices available', 'simctl delete unavailable'], 'no erase, no runtime, no other device command');
    assert.ok(fs.existsSync(getStampPath()), 'and the day is written down');
    assert.equal(parseProbeOutput(answer.stdout).os, 'Darwin');
  });

  it('the probe a run or an `exec` makes (no `prune`) never starts it', () => {
    probe();
    assert.equal(fs.existsSync(getCleanupPidPath()), false);
    assert.equal(fs.existsSync(getStampPath()), false);
    assert.equal(countDeleteCalls(), 0);
  });

  it('at most once a day: a second probe of a view within the day starts nothing; after the day it does', async () => {
    probe(['prune']);
    await waitForCleanupToEnd();
    const firstPid = fs.readFileSync(getCleanupPidPath(), 'utf8');
    probe(['prune']);
    assert.equal(fs.readFileSync(getCleanupPidPath(), 'utf8'), firstPid, 'no new run');
    assert.equal(countDeleteCalls(), 1);
    const dayAgo = new Date(Date.now() - (dayHours + 1) * 3_600_000);
    fs.utimesSync(getStampPath(), dayAgo, dayAgo);
    fs.rmSync(path.join(workDir, 'simctl-cleanup.log'));
    probe(['prune']);
    await waitForCleanupToEnd();
    assert.equal(countDeleteCalls(), 2);
  });

  it('the probe does not wait for it: a simctl that hangs leaves the probe as fast as without, and the run ends when simctl is let go', async () => {
    const withoutHang = probe();
    const answer = probe(['prune'], { XCRUN_HOLD_DELETE: '1' });
    assert.ok(parseProbeOutput(answer.stdout).os === 'Darwin', 'the probe answered');
    assert.ok(answer.elapsedMs < withoutHang.elapsedMs + 5_000, `${answer.elapsedMs} ms against ${withoutHang.elapsedMs} ms without the cleanup`);
    assert.ok(!/^exit \d+$/m.test(readCleanupLog()), 'the cleanup is still waiting for simctl');
    fs.writeFileSync(releaseFile, '');
    assert.match(await waitForCleanupToEnd(), /^exit 0$/m);
  });

  it('a Mac without Xcode, and a machine that is not a Mac, never start it', () => {
    writeFake('xcodebuild', 'exit 1');
    probe(['prune']);
    assert.equal(fs.existsSync(getCleanupPidPath()), false, 'no Xcode');
    if (process.platform === 'darwin') return;
    fs.rmSync(path.join(fakeBin, 'uname'));
    probe(['prune']);
    assert.equal(fs.existsSync(getCleanupPidPath()), false, 'not a Mac');
    assert.equal(countDeleteCalls(), 0);
  });

  it('is bounded: a simctl that does not answer is cut off after the time limit — the stamp is still written, so the next probe does not start it again at once', () => {
    const result = spawnSync('bash', ['--norc', '--noprofile', '-c', `source ${scriptPath}; simctl_cleanup_sec=2; start=$SECONDS; cmd_simctl_cleanup ${workDir}; echo "took=$((SECONDS - start))"`], {
      encoding: 'utf8',
      env: getEnvironment({ XCRUN_HOLD_DELETE: '1' }),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const took = Number(/^took=(\d+)$/m.exec(result.stdout)?.[1]);
    assert.ok(took >= 2 && took <= 8, `${took} s`);
    assert.match(readCleanupLog(), /^exit 137$/m, 'killed by the watchdog');
    assert.ok(fs.existsSync(getStampPath()));
  });

  it('on a machine without xcrun the subcommand does nothing but write the stamp', { skip: process.platform === 'darwin' ? 'this Mac has a real xcrun' : false }, () => {
    writeFile(workRoot, 'empty/.keep');
    const result = spawnSync('bash', [scriptPath, 'simctl-cleanup', workDir], { encoding: 'utf8', env: { ...process.env, PATH: `${path.join(workRoot, 'empty')}:/usr/bin:/bin` }, timeout: 60_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(workDir, 'simctl-cleanup.log')), false);
    assert.ok(fs.existsSync(getStampPath()));
  });
});
