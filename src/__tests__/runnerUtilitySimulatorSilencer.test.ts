/**
 * @description `runnerUtility/simulatorSilencer.ts`: silent jobs. Every booted Simulator gets its OWN volume state set to 0 once its boot has finished
 * (never the Mac's output, volume or mute), a device that boots again is new, a device whose volume does not read back as 0 gets it again a few
 * times and then a warning, a failing command is retried later and not in a loop, and the only commands ever run are the four of the allowlist.
 * What this cannot prove — that a real Simulator then plays nothing — is for the first real run on a Mac (docs/remote-run.md, «Silent jobs»).
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CommandOptions, CommandResult, CommandRunner } from '../selfUpdate/commandRunner';
import {
  createSimulatorSilencer,
  maxAttempts,
  parseBootedSimulators,
  parseSimulatorVolume,
  retryAfterMs,
  verifyAfterMs,
  volumeStateNotification,
  type SilencerDeps,
} from '../runnerUtility/simulatorSilencer';

const phoneA = 'AAAAAAAA-1111-2222-3333-444444444444';
const phoneB = 'BBBBBBBB-1111-2222-3333-444444444444';

function listJson(devices: Array<{ udid: string; state?: string; dataPath?: string }>): string {
  return JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-5': devices.map((device) => ({ state: 'Booted', dataPath: `/data/${device.udid}`, name: 'iPhone', ...device })) } });
}

interface Harness {
  deps: SilencerDeps;
  commands: string[];
  logs: string[];
  setBooted: (udids: string[]) => void;
  setNow: (nowMs: number) => void;
  setHandler: (handler: (command: string) => Partial<CommandResult> | null) => void;
}

function createHarness(): Harness {
  let nowMs = 1_000_000;
  let booted: string[] = [];
  let handler: (command: string) => Partial<CommandResult> | null = () => null;
  const commands: string[] = [];
  const logs: string[] = [];
  const runner: CommandRunner = async (file: string, args: readonly string[], _options: CommandOptions) => {
    const command = [file, ...args].join(' ');
    commands.push(command);
    const answered = handler(command);
    if (answered !== null) return { ok: true, exitCode: 0, stdout: '', stderr: '', isTimedOut: false, ...answered };
    if (command === 'xcrun simctl list devices booted -j') return { ok: true, exitCode: 0, stdout: listJson(booted.map((udid) => ({ udid }))), stderr: '', isTimedOut: false };
    if (file === 'plutil') return { ok: true, exitCode: 0, stdout: '60\n', stderr: '', isTimedOut: false };
    return { ok: true, exitCode: 0, stdout: '', stderr: '', isTimedOut: false };
  };
  return {
    deps: { runner, now: () => nowMs, log: (line) => logs.push(line) },
    commands,
    logs,
    setBooted: (udids) => { booted = udids; },
    setNow: (value) => { nowMs = value; },
    setHandler: (value) => { handler = value; },
  };
}

const setCommand = (udid: string): string => `xcrun simctl spawn ${udid} notifyutil -s ${volumeStateNotification} 0`;
const postCommand = (udid: string): string => `xcrun simctl spawn ${udid} notifyutil -p ${volumeStateNotification}`;
const bootStatusCommand = (udid: string): string => `xcrun simctl bootstatus ${udid} -b`;

describe('parsing what simctl says', () => {
  it('lists the booted devices with their data folder; a device that is not booted, or has no UUID for an id, is left out', () => {
    const json = listJson([{ udid: phoneA }, { udid: phoneB, state: 'Shutdown' }, { udid: 'not-a-uuid; rm -rf /' }, { udid: 'CCCCCCCC-1111-2222-3333-444444444444', dataPath: undefined }]);
    assert.deepEqual(parseBootedSimulators(json), [{ udid: phoneA, dataPath: `/data/${phoneA}` }, { udid: 'CCCCCCCC-1111-2222-3333-444444444444', dataPath: null }]);
    assert.deepEqual(parseBootedSimulators('{not json'), []);
    assert.deepEqual(parseBootedSimulators('{}'), []);
  });

  it('reads sim_volume as a number, anything else as nothing', () => {
    assert.equal(parseSimulatorVolume('0\n'), 0);
    assert.equal(parseSimulatorVolume('0.0'), 0);
    assert.equal(parseSimulatorVolume('60'), 60);
    assert.equal(parseSimulatorVolume(''), null);
    assert.equal(parseSimulatorVolume('error: no such key'), null);
  });
});

describe('the silencer', () => {
  it('a booted device gets its boot awaited, then its volume state set to 0 and posted — once, however many looks follow', async () => {
    const harness = createHarness();
    const silencer = createSimulatorSilencer(harness.deps);
    harness.setBooted([phoneA]);
    await silencer.tick();
    assert.deepEqual(harness.commands.filter((command) => command.includes(phoneA)), [bootStatusCommand(phoneA), setCommand(phoneA), postCommand(phoneA)]);
    harness.setNow(1_000_000 + 5_000);
    await silencer.tick();
    await silencer.tick();
    assert.equal(harness.commands.filter((command) => command === setCommand(phoneA)).length, 1);
  });

  it('only the four allowed commands and the list are ever run — nothing of the Mac\'s own audio, volume or mute, no shell', async () => {
    const harness = createHarness();
    const silencer = createSimulatorSilencer(harness.deps);
    harness.setBooted([phoneA, phoneB]);
    await silencer.tick();
    harness.setNow(1_000_000 + verifyAfterMs);
    await silencer.tick();
    const allowed = [
      /^xcrun simctl list devices booted -j$/,
      /^xcrun simctl bootstatus [0-9A-F-]{36} -b$/,
      new RegExp(`^xcrun simctl spawn [0-9A-F-]{36} notifyutil -s ${volumeStateNotification.replace(/\./g, '\\.')} 0$`),
      new RegExp(`^xcrun simctl spawn [0-9A-F-]{36} notifyutil -p ${volumeStateNotification.replace(/\./g, '\\.')}$`),
      /^plutil -extract sim_volume raw -o - \/data\/[0-9A-F-]{36}\/var\/run\/simulatoraudio\/audiosettings\.plist$/,
    ];
    for (const command of harness.commands) assert.ok(allowed.some((pattern) => pattern.test(command)), `not on the allowlist: ${command}`);
    assert.ok(harness.commands.length >= 8);
  });

  it('every booted device is silenced on its own; a device that boots later is silenced when it appears', async () => {
    const harness = createHarness();
    const silencer = createSimulatorSilencer(harness.deps);
    harness.setBooted([phoneA]);
    await silencer.tick();
    harness.setBooted([phoneA, phoneB]);
    await silencer.tick();
    assert.ok(harness.commands.includes(setCommand(phoneA)) && harness.commands.includes(setCommand(phoneB)));
    assert.equal(harness.commands.filter((command) => command === setCommand(phoneA)).length, 1);
  });

  it('a device that was shut down and booted again is new (its volume is 60 again): silenced again', async () => {
    const harness = createHarness();
    const silencer = createSimulatorSilencer(harness.deps);
    harness.setBooted([phoneA]);
    await silencer.tick();
    harness.setBooted([]);
    await silencer.tick();
    assert.equal(silencer.getKnownDeviceCount(), 0);
    harness.setBooted([phoneA]);
    await silencer.tick();
    assert.equal(harness.commands.filter((command) => command === setCommand(phoneA)).length, 2);
  });

  it('a volume that reads back as 0 is done; one that reads something else is set again after the check time — a few times, then a warning and no more', async () => {
    const harness = createHarness();
    const silencer = createSimulatorSilencer(harness.deps);
    harness.setBooted([phoneA]);
    harness.setHandler((command) => (command.startsWith('plutil') ? { stdout: '60\n' } : null));
    await silencer.tick();
    for (let attempt = 1; attempt < maxAttempts + 2; attempt += 1) {
      harness.setNow(1_000_000 + attempt * (verifyAfterMs + 1));
      await silencer.tick();
    }
    assert.equal(harness.commands.filter((command) => command === setCommand(phoneA)).length, maxAttempts);
    assert.equal(harness.logs.length, 1);
    assert.match(harness.logs[0], new RegExp(`the Simulator ${phoneA} is still not silent after ${maxAttempts} tries \\(its volume reads 60\\); no more tries for this boot`));

    const quiet = createHarness();
    const quietSilencer = createSimulatorSilencer(quiet.deps);
    quiet.setBooted([phoneB]);
    quiet.setHandler((command) => (command.startsWith('plutil') ? { stdout: '0\n' } : null));
    await quietSilencer.tick();
    quiet.setNow(1_000_000 + verifyAfterMs + 1);
    await quietSilencer.tick();
    quiet.setNow(1_000_000 + 10 * verifyAfterMs);
    await quietSilencer.tick();
    assert.equal(quiet.commands.filter((command) => command === setCommand(phoneB)).length, 1, 'read back as 0: nothing more is done');
    assert.deepEqual(quiet.logs, []);
  });

  it('a command that fails is told in the log and tried again later, not at every look — and given up after the last try', async () => {
    const harness = createHarness();
    const silencer = createSimulatorSilencer(harness.deps);
    harness.setBooted([phoneA]);
    harness.setHandler((command) => (command === setCommand(phoneA) ? { ok: false, exitCode: 1, stderr: 'Unable to find service\n' } : null));
    await silencer.tick();
    assert.equal(harness.logs.length, 1);
    assert.match(harness.logs[0], /could not silence the Simulator AAAAAAAA.*notifyutil -s failed \(Unable to find service\)/);
    await silencer.tick();
    assert.equal(harness.commands.filter((command) => command === setCommand(phoneA)).length, 1, 'no new try before the wait is over');
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      harness.setNow(1_000_000 + attempt * (retryAfterMs + 1));
      await silencer.tick();
    }
    assert.equal(harness.commands.filter((command) => command === setCommand(phoneA)).length, maxAttempts);
    assert.match(harness.logs.at(-1) ?? '', /no more tries for this boot/);
  });

  it('a boot that does not finish (bootstatus fails) is told, and the volume is not set before it', async () => {
    const harness = createHarness();
    const silencer = createSimulatorSilencer(harness.deps);
    harness.setBooted([phoneA]);
    harness.setHandler((command) => (command === bootStatusCommand(phoneA) ? { ok: false, isTimedOut: true, exitCode: null } : null));
    await silencer.tick();
    assert.ok(!harness.commands.includes(setCommand(phoneA)));
    assert.match(harness.logs[0], /its boot did not finish \(no answer in time\)/);
  });

  it('a simctl that cannot list is told once, not at every look, and the next good look carries on', async () => {
    const harness = createHarness();
    const silencer = createSimulatorSilencer(harness.deps);
    harness.setHandler((command) => (command.startsWith('xcrun simctl list') ? { ok: false, exitCode: 1, stderr: 'CoreSimulatorService connection became invalid\n' } : null));
    await silencer.tick();
    await silencer.tick();
    assert.deepEqual(harness.logs, ['the booted Simulators could not be listed: CoreSimulatorService connection became invalid']);
    harness.setHandler(() => null);
    harness.setBooted([phoneA]);
    await silencer.tick();
    assert.ok(harness.commands.includes(setCommand(phoneA)));
  });

  it('a device without a data folder is silenced and not read back', async () => {
    const harness = createHarness();
    const silencer = createSimulatorSilencer(harness.deps);
    harness.setHandler((command) => (command.startsWith('xcrun simctl list') ? { stdout: JSON.stringify({ devices: { runtime: [{ udid: phoneA, state: 'Booted' }] } }) } : null));
    await silencer.tick();
    harness.setNow(1_000_000 + verifyAfterMs + 1);
    await silencer.tick();
    assert.ok(harness.commands.includes(setCommand(phoneA)));
    assert.ok(!harness.commands.some((command) => command.startsWith('plutil')));
  });
});
