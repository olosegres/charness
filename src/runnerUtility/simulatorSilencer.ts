import * as path from 'path';
import { runCommand, type CommandRunner } from '../selfUpdate/commandRunner';

/**
 * @description Silent jobs: the iOS Simulators of a runner never play to the Mac's speakers. On the first real run the owner, in a call in another
 * account of the same Mac, heard an app's voice preview: a Simulator plays through the HOST's audio output (the Mac's default one, whatever the
 * account that runs it), so the account's own session is no wall. The mechanism is the SIMULATOR's own volume, per device — nothing of the Mac's
 * output, volume or mute, and nothing of the owner's account:
 *
 *   xcrun simctl spawn <udid> notifyutil -s com.apple.springboard.volumestate 0     the simulated iPhone's volume state → 0
 *   xcrun simctl spawn <udid> notifyutil -p com.apple.springboard.volumestate       … and posted, so SpringBoard takes it
 *
 * The device's volume goes back to 60 on every boot (also after `erase` and `clone`) and the change reads back (`sim_volume` in
 * `<device data>/var/run/simulatoraudio/audiosettings.plist`) only 4–13 s after the command on iOS 26.4 / 27.0 — so every device that is booted gets
 * the command once its boot has finished (`bootstatus -b`), a device that boots again is treated as new, and a device whose plist still reads
 * something else {@link verifyAfterMs} later gets it again (up to {@link maxAttempts} times, then a warning in the log and no more). The source of this
 * mechanism is a third-party measurement (the Simlock project's spike, iOS 26.4 and 27.0, Xcode 27.0), not Apple documentation — Apple's Device
 * Hub has the same control as a menu (Device > Sound), with no command line — so the first seconds after a boot are not covered and the effect on
 * this Mac's Xcode has to be looked at once, not assumed (`docs/remote-run.md`, «Silent jobs»).
 */

export const volumeStateNotification = 'com.apple.springboard.volumestate';
const commandDeadlineMs = 30 * 1000;
const bootStatusDeadlineMs = 120 * 1000;
export const verifyAfterMs = 30 * 1000;
export const maxAttempts = 3;
/** After a command that failed (SpringBoard not up yet, the device busy) the next try waits this long. */
export const retryAfterMs = 10 * 1000;
/** How often the agent's silencer looks at the booted devices. */
export const silencerPollMs = 2 * 1000;
const udidPattern = /^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/;
const audioSettingsRelativePath = path.join('var', 'run', 'simulatoraudio', 'audiosettings.plist');

export interface BootedSimulator {
  udid: string;
  /** The device's data folder (`dataPath` of `simctl list`), where its audio settings are read back from. */
  dataPath: string | null;
}

/** @description The booted devices of `xcrun simctl list devices booted -j`; one whose id is not a UUID is dropped (it would be an argument of a command). */
export function parseBootedSimulators(json: string): BootedSimulator[] {
  let parsed: { devices?: Record<string, Array<{ udid?: string; state?: string; dataPath?: string }>> };
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const booted: BootedSimulator[] = [];
  for (const devices of Object.values(parsed.devices ?? {})) {
    for (const device of devices) {
      if (device.state === 'Booted' && device.udid !== undefined && udidPattern.test(device.udid)) booted.push({ udid: device.udid, dataPath: device.dataPath ?? null });
    }
  }
  return booted;
}

/** @description `sim_volume` of a device out of `plutil -extract sim_volume raw`: the number, or `null` when it is not one. */
export function parseSimulatorVolume(output: string): number | null {
  const text = output.trim();
  return text !== '' && Number.isFinite(Number(text)) ? Number(text) : null;
}

export interface SilencerDeps {
  runner: CommandRunner;
  now: () => number;
  /** One line of the agent's log. */
  log: (line: string) => void;
}

export function createSilencerDeps(log: (line: string) => void): SilencerDeps {
  return { runner: runCommand, now: Date.now, log };
}

interface DeviceState {
  attempts: number;
  lastAttemptAtMs: number;
  /** When the last command succeeded; `null` while none has (a first attempt in flight, or one that failed). */
  appliedAtMs: number | null;
  isVerified: boolean;
  isInFlight: boolean;
  isGivenUp: boolean;
}

export interface SimulatorSilencer {
  /** One look at the booted devices: silence the new ones, check the old ones; resolves when every command it started has ended. */
  tick: () => Promise<void>;
  /** The devices it knows (booted, silenced or being silenced), for a test. */
  getKnownDeviceCount: () => number;
}

export function createSimulatorSilencer(deps: SilencerDeps): SimulatorSilencer {
  const devices = new Map<string, DeviceState>();
  let isListFailureLogged = false;

  const runSimctl = (args: string[], timeoutMs: number): ReturnType<CommandRunner> => deps.runner('xcrun', ['simctl', ...args], { timeoutMs });

  const applyVolume = async (udid: string): Promise<string | null> => {
    const boot = await runSimctl(['bootstatus', udid, '-b'], bootStatusDeadlineMs);
    if (!boot.ok) return `its boot did not finish (${boot.isTimedOut ? 'no answer in time' : boot.stderr.trim().split('\n').pop() ?? 'unknown'})`;
    const set = await runSimctl(['spawn', udid, 'notifyutil', '-s', volumeStateNotification, '0'], commandDeadlineMs);
    if (!set.ok) return `notifyutil -s failed (${set.isTimedOut ? 'no answer in time' : set.stderr.trim().split('\n').pop() ?? 'unknown'})`;
    const post = await runSimctl(['spawn', udid, 'notifyutil', '-p', volumeStateNotification], commandDeadlineMs);
    return post.ok ? null : `notifyutil -p failed (${post.isTimedOut ? 'no answer in time' : post.stderr.trim().split('\n').pop() ?? 'unknown'})`;
  };

  const silence = async (device: BootedSimulator, state: DeviceState): Promise<void> => {
    state.isInFlight = true;
    state.attempts += 1;
    state.lastAttemptAtMs = deps.now();
    try {
      const problem = await applyVolume(device.udid);
      if (problem === null) {
        state.appliedAtMs = deps.now();
      } else {
        state.appliedAtMs = null;
        deps.log(`could not silence the Simulator ${device.udid}: ${problem}${state.attempts >= maxAttempts ? '; no more tries for this boot' : ''}`);
      }
    } finally {
      state.isInFlight = false;
    }
    if (state.appliedAtMs === null && state.attempts >= maxAttempts) state.isGivenUp = true;
  };

  const verify = async (device: BootedSimulator, state: DeviceState): Promise<void> => {
    if (device.dataPath === null) {
      state.isVerified = true;
      return;
    }
    const read = await deps.runner('plutil', ['-extract', 'sim_volume', 'raw', '-o', '-', path.join(device.dataPath, audioSettingsRelativePath)], { timeoutMs: commandDeadlineMs });
    if (read.ok && parseSimulatorVolume(read.stdout) === 0) {
      state.isVerified = true;
      return;
    }
    if (state.attempts >= maxAttempts) {
      state.isGivenUp = true;
      deps.log(`the Simulator ${device.udid} is still not silent after ${state.attempts} tries (its volume reads ${read.ok ? read.stdout.trim() || 'nothing' : 'unreadable'}); no more tries for this boot`);
      return;
    }
    await silence(device, state);
  };

  return {
    tick: async () => {
      const listed = await runSimctl(['list', 'devices', 'booted', '-j'], commandDeadlineMs);
      if (!listed.ok) {
        if (!isListFailureLogged) deps.log(`the booted Simulators could not be listed: ${listed.isTimedOut ? 'no answer in time' : listed.stderr.trim().split('\n').pop() ?? 'unknown'}`);
        isListFailureLogged = true;
        return;
      }
      isListFailureLogged = false;
      const booted = parseBootedSimulators(listed.stdout);
      const bootedIds = new Set(booted.map((device) => device.udid));
      // A device that is not booted any more is forgotten: its next boot starts at volume 60 again and is silenced as a new one.
      for (const udid of [...devices.keys()]) if (!bootedIds.has(udid)) devices.delete(udid);
      const work: Array<Promise<void>> = [];
      for (const device of booted) {
        let state = devices.get(device.udid);
        if (state === undefined) {
          state = { attempts: 0, lastAttemptAtMs: 0, appliedAtMs: null, isVerified: false, isInFlight: false, isGivenUp: false };
          devices.set(device.udid, state);
        }
        if (state.isInFlight || state.isGivenUp || state.isVerified) continue;
        if (state.appliedAtMs === null) {
          if (state.attempts === 0 || deps.now() - state.lastAttemptAtMs >= retryAfterMs) work.push(silence(device, state));
        } else if (deps.now() - state.appliedAtMs >= verifyAfterMs) work.push(verify(device, state));
      }
      await Promise.all(work);
    },
    getKnownDeviceCount: () => devices.size,
  };
}
