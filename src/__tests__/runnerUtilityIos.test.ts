/**
 * @description `runnerUtility/iosCheck.ts`: the bounded boot check of the iOS Simulator (create → boot → bootstatus → delete), the choice
 * of runtime and device type out of `simctl`'s JSON, the one-line result file, and when the check runs again (Xcode changed). A
 * LaunchDaemon cannot use the Simulator, so a runner there must report «no» from a real attempt, not from «Xcode is installed».
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { CommandResult, CommandRunner } from '../selfUpdate/commandRunner';
import {
  checkShouldRunIosCheck,
  chooseSimulator,
  parseXcodeVersion,
  readIosCheck,
  refreshIosCheck,
  runIosBootCheck,
  writeIosCheck,
  type IosCheckDeps,
  type IosCheckRecord,
} from '../runnerUtility/iosCheck';
import { getRunnerHomePaths, type RunnerHomePaths } from '../runnerUtility/runnerHome';

const runtimesJson = JSON.stringify({
  runtimes: [
    { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-17-5', version: '17.5', platform: 'iOS', isAvailable: true },
    { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-2', version: '18.2', platform: 'iOS', isAvailable: true },
    { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-4', version: '18.4', platform: 'iOS', isAvailable: false },
    { identifier: 'com.apple.CoreSimulator.SimRuntime.watchOS-11-2', version: '11.2', platform: 'watchOS', isAvailable: true },
  ],
});
const deviceTypesJson = JSON.stringify({
  devicetypes: [
    { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15', productFamily: 'iPhone' },
    { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro', productFamily: 'iPad' },
    { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16', productFamily: 'iPhone' },
  ],
});
const xcodeText = 'Xcode 16.2\nBuild version 16C5032a\n';

let calls: string[] = [];

/** A runner that answers `xcrun simctl <step>` from `steps` (default: success with `udid-1` for create). */
function createRunner(steps: Record<string, Partial<CommandResult>> = {}): CommandRunner {
  return async (file, args) => {
    const line = `${file} ${args.join(' ')}`;
    calls.push(line);
    if (file === 'xcodebuild') return { ok: true, exitCode: 0, stdout: xcodeText, stderr: '', isTimedOut: false };
    const step = args[1] === 'list' ? `list ${args[2]}` : args[1];
    const defaults: Record<string, Partial<CommandResult>> = { 'list runtimes': { stdout: runtimesJson }, 'list devicetypes': { stdout: deviceTypesJson }, create: { stdout: 'udid-1\n' } };
    return { ok: true, exitCode: 0, stdout: '', stderr: '', isTimedOut: false, ...defaults[step], ...steps[step] };
  };
}

function createDeps(overrides: Partial<IosCheckDeps> = {}): IosCheckDeps {
  return { runner: createRunner(), platform: 'darwin', now: () => 1_000, ...overrides };
}

beforeEach(() => {
  calls = [];
});

describe('choosing a simulator', () => {
  it('takes the newest AVAILABLE iOS runtime and an iPhone device type', () => {
    assert.deepEqual(chooseSimulator(runtimesJson, deviceTypesJson), { runtimeId: 'com.apple.CoreSimulator.SimRuntime.iOS-18-2', deviceTypeId: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16' });
  });

  describe('with the device types each runtime supports (the first real run on a Mac)', () => {
    const iphone = (name: string): { identifier: string; name: string; productFamily: string } => ({ identifier: `com.apple.CoreSimulator.SimDeviceType.${name}`, name, productFamily: 'iPhone' });
    const deviceTypesOfTheMac = JSON.stringify({ devicetypes: [iphone('iPhone-17'), iphone('iPhone-Duo'), iphone('iPod-touch--7th-generation-')] });

    it('takes the newest runtime together with a device type IT supports — not the last iPhone of the whole list, an iPod touch iOS 27.1 cannot run', () => {
      const runtimes = JSON.stringify({
        runtimes: [
          { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5', version: '26.5', platform: 'iOS', isAvailable: true, supportedDeviceTypes: [iphone('iPhone-17'), iphone('iPod-touch--7th-generation-')] },
          { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-27-1', version: '27.1', platform: 'iOS', isAvailable: true, supportedDeviceTypes: [iphone('iPhone-Duo')] },
        ],
      });
      assert.deepEqual(chooseSimulator(runtimes, deviceTypesOfTheMac), { runtimeId: 'com.apple.CoreSimulator.SimRuntime.iOS-27-1', deviceTypeId: 'com.apple.CoreSimulator.SimDeviceType.iPhone-Duo' });
    });

    it('passes over a runtime that supports no iPhone, and an unavailable one, for the next', () => {
      const runtimes = JSON.stringify({
        runtimes: [
          { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-28-0', version: '28.0', platform: 'iOS', isAvailable: true, supportedDeviceTypes: [{ identifier: 'ipad', productFamily: 'iPad' }] },
          { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-27-9', version: '27.9', platform: 'iOS', isAvailable: false, supportedDeviceTypes: [iphone('iPhone-18')] },
          { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5', version: '26.5', platform: 'iOS', isAvailable: true, supportedDeviceTypes: [iphone('iPhone-16'), iphone('iPhone-17')] },
        ],
      });
      assert.deepEqual(chooseSimulator(runtimes, deviceTypesOfTheMac), { runtimeId: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5', deviceTypeId: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17' });
    });

    it('is null when no runtime supports an iPhone — the list of device types of the whole machine is no answer for a runtime that names its own', () => {
      const runtimes = JSON.stringify({ runtimes: [{ identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-28-0', version: '28.0', platform: 'iOS', isAvailable: true, supportedDeviceTypes: [] }] });
      assert.equal(chooseSimulator(runtimes, deviceTypesOfTheMac), null);
    });
  });

  it('is null when there is no iOS runtime or no iPhone, or the JSON is not JSON', () => {
    assert.equal(chooseSimulator(JSON.stringify({ runtimes: [] }), deviceTypesJson), null);
    assert.equal(chooseSimulator(runtimesJson, JSON.stringify({ devicetypes: [{ identifier: 'x', productFamily: 'iPad' }] })), null);
    assert.equal(chooseSimulator('nope', 'nope'), null);
  });

  it('reads Xcode\'s version and build', () => {
    assert.equal(parseXcodeVersion(xcodeText), '16.2 (16C5032a)');
    assert.equal(parseXcodeVersion('Xcode 15.0'), '15.0');
    assert.equal(parseXcodeVersion('xcode-select: error'), null);
  });
});

describe('the boot check', () => {
  it('passes when the Simulator boots: create, boot, bootstatus, then shutdown and delete', async () => {
    const record = await runIosBootCheck(createDeps({ runner: createRunner() }));
    assert.deepEqual(record, { status: 'pass', checkedAtMs: 1_000, xcode: '16.2 (16C5032a)', reason: null });
    const steps = calls.filter((line) => line.startsWith('xcrun')).map((line) => line.split(' ').slice(2, 3).join(''));
    assert.deepEqual(steps, ['list', 'list', 'create', 'boot', 'bootstatus', 'shutdown', 'delete']);
    assert.ok(calls.includes('xcrun simctl bootstatus udid-1 -b'));
    assert.ok(calls.includes('xcrun simctl delete udid-1'));
  });

  it('fails — the Simulator needs the user\'s login session — when it cannot boot, and still deletes the device it made', async () => {
    const record = await runIosBootCheck(createDeps({ runner: createRunner({ boot: { ok: false, exitCode: 1, stderr: 'Unable to boot device in current state: Shutdown\nbootstrap failed' } }) }));
    assert.equal(record.status, 'fail');
    assert.match(record.reason ?? '', /did not boot: bootstrap failed/);
    assert.ok(calls.includes('xcrun simctl shutdown udid-1') && calls.includes('xcrun simctl delete udid-1'), 'cleanup runs on a failure');
    assert.ok(!calls.some((line) => line.includes('bootstatus')), 'no bootstatus after a boot that failed');
  });

  it('fails when the boot never finishes, when no device can be made, and when no runtime is installed', async () => {
    const unfinished = await runIosBootCheck(createDeps({ runner: createRunner({ bootstatus: { ok: false, stderr: 'timed out' } }) }));
    assert.equal(unfinished.status, 'fail');
    assert.match(unfinished.reason ?? '', /did not finish booting/);
    calls = [];
    const noDevice = await runIosBootCheck(createDeps({ runner: createRunner({ create: { ok: true, stdout: '' } }) }));
    assert.equal(noDevice.status, 'fail');
    assert.equal(noDevice.reason, 'the Simulator device could not be created');
    assert.ok(!calls.some((line) => line.includes('simctl boot')), 'nothing to boot');
    const noRuntime = await runIosBootCheck(createDeps({ runner: createRunner({ 'list runtimes': { stdout: JSON.stringify({ runtimes: [] }) } }) }));
    assert.equal(noRuntime.status, 'fail');
    assert.match(noRuntime.reason ?? '', /no iOS simulator runtime/);
  });

  it('a simctl that does not work at all says so with its own error — it is not «no runtime installed», which would send the operator to install one', async () => {
    const noCoreSimulator = 'CoreSimulatorService connection became invalid\nUnable to locate device set';
    const listFails = await runIosBootCheck(createDeps({ runner: createRunner({ 'list runtimes': { ok: false, exitCode: 1, stderr: noCoreSimulator } }) }));
    assert.equal(listFails.status, 'fail');
    assert.equal(listFails.reason, 'simctl list runtimes failed: Unable to locate device set');
    const deviceTypesFail = await runIosBootCheck(createDeps({ runner: createRunner({ 'list devicetypes': { ok: false, exitCode: 1, stderr: '', isTimedOut: true } }) }));
    assert.equal(deviceTypesFail.reason, 'simctl list devicetypes failed: no answer in time');
    calls = [];
    const createFails = await runIosBootCheck(createDeps({ runner: createRunner({ create: { ok: false, exitCode: 164, stderr: 'Invalid runtime: com.apple.CoreSimulator.SimRuntime.iOS-18-2' } }) }));
    assert.equal(createFails.reason, 'simctl create failed: Invalid runtime: com.apple.CoreSimulator.SimRuntime.iOS-18-2');
    assert.ok(!calls.some((line) => line.includes('simctl boot')), 'nothing to boot');
    const emptyButWorking = await runIosBootCheck(createDeps({ runner: createRunner({ 'list devicetypes': { stdout: JSON.stringify({ devicetypes: [] }) } }) }));
    assert.match(emptyButWorking.reason ?? '', /no iOS simulator runtime and iPhone device type are installed/, 'a list that worked and came back empty is the «not installed» case');
  });

  it('is skipped — and runs nothing — off macOS and without Xcode', async () => {
    const linux = await runIosBootCheck(createDeps({ platform: 'linux' }));
    assert.deepEqual({ status: linux.status, reason: linux.reason, xcode: linux.xcode }, { status: 'skipped', reason: 'not macOS', xcode: null });
    assert.deepEqual(calls, []);
    const noXcode = await runIosBootCheck(createDeps({ runner: async () => ({ ok: false, exitCode: 1, stdout: '', stderr: 'no xcode', isTimedOut: false }) }));
    assert.deepEqual({ status: noXcode.status, reason: noXcode.reason }, { status: 'skipped', reason: 'no Xcode' });
  });
});

describe('when the check runs again', () => {
  const pass: IosCheckRecord = { status: 'pass', checkedAtMs: 1, xcode: '16.2 (16C5032a)', reason: null };

  it('when there is no result, or Xcode is not the one the result saw (updated, changed, gone)', () => {
    assert.equal(checkShouldRunIosCheck(null, '16.2 (16C5032a)'), true);
    assert.equal(checkShouldRunIosCheck(pass, '16.2 (16C5032a)'), false);
    assert.equal(checkShouldRunIosCheck(pass, '16.3 (16E140)'), true);
    assert.equal(checkShouldRunIosCheck(pass, null), true);
    assert.equal(checkShouldRunIosCheck({ ...pass, status: 'skipped', xcode: null }, null), false);
  });

  describe('against the result file', () => {
    let home = '';
    let paths: RunnerHomePaths;
    beforeEach(() => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-'));
      paths = getRunnerHomePaths(home);
      fs.mkdirSync(paths.root, { recursive: true });
    });
    afterEach(() => {
      fs.rmSync(home, { recursive: true, force: true });
    });

    it('writes one line that `grep` can read, and reads it back; a damaged file reads as none', () => {
      writeIosCheck(paths, pass);
      const text = fs.readFileSync(paths.iosCheck, 'utf8');
      assert.equal(text.trim().split('\n').length, 1);
      assert.match(text, /"status":"pass"/);
      assert.deepEqual(readIosCheck(paths), pass);
      fs.writeFileSync(paths.iosCheck, '{broken');
      assert.equal(readIosCheck(paths), null);
    });

    it('a new start always checks again; within a run only a different Xcode does; off macOS nothing runs', async () => {
      const first = await refreshIosCheck(paths, createDeps(), { isStartup: true });
      assert.equal(first?.status, 'pass');
      assert.deepEqual(readIosCheck(paths), first);
      calls = [];
      assert.equal(await refreshIosCheck(paths, createDeps(), { isStartup: false }), null, 'the hourly look: same Xcode, nothing to do');
      assert.ok(!calls.some((line) => line.includes('simctl')), 'no second boot within the run');
      assert.equal(await refreshIosCheck(paths, createDeps({ platform: 'linux' }), { isStartup: true }), null);
    });

    it('while the start-up check runs the old answer is gone, so the probe cannot offer it — and a failed start-up check leaves the new answer', async () => {
      writeIosCheck(paths, { status: 'pass', checkedAtMs: 1, xcode: '16.2 (16C5032a)', reason: null });
      const seenDuringCheck: Array<IosCheckRecord | null> = [];
      const inner = createRunner();
      const observing: CommandRunner = async (file, args, options) => {
        if (args.includes('boot')) seenDuringCheck.push(readIosCheck(paths));
        return inner(file, args, options);
      };
      const record = await refreshIosCheck(paths, createDeps({ runner: observing }), { isStartup: true });
      assert.deepEqual(seenDuringCheck, [null], 'the boot ran with no record on disk: the earlier «pass» was not offered');
      assert.deepEqual(readIosCheck(paths), record);
    });

    it('a persisted result does not survive a change of who runs the link: the same Xcode, a different boot outcome', async () => {
      // A result from an interactive login ...
      writeIosCheck(paths, { status: 'pass', checkedAtMs: 1, xcode: '16.2 (16C5032a)', reason: null });
      // ... then the link starts as a daemon: the Simulator does not boot there, with the very same Xcode.
      const asDaemon = await refreshIosCheck(paths, createDeps({ runner: createRunner({ boot: { ok: false, stderr: 'no login session' } }) }), { isStartup: true });
      assert.equal(asDaemon?.status, 'fail');
      assert.equal(readIosCheck(paths)?.status, 'fail');
      // ... and back to a login session: the stale «fail» is replaced by a real answer.
      const asLogin = await refreshIosCheck(paths, createDeps(), { isStartup: true });
      assert.equal(asLogin?.status, 'pass');
      assert.equal(readIosCheck(paths)?.status, 'pass');
    });
  });
});
