import * as fs from 'fs';
import { z } from 'zod';
import { writeTextFileAtomically } from '../configDirFile';
import { runCommand, type CommandRunner } from '../selfUpdate/commandRunner';
import type { RunnerHomePaths } from './runnerHome';

/**
 * @description Can this runner drive the iOS Simulator? Apple: the Simulator is not available to a LaunchDaemon or a process started as
 * another user — it needs the account's own login session. So the runner does not guess from «Xcode is installed»: it really boots one.
 * A bounded check (create a device → boot it → wait for the boot to finish → delete it) runs when the link starts and whenever Xcode
 * changes, and its result is written to `ios-check.json`, one line, for `runner.sh probe` to turn into the `ios` capability:
 *
 *   pass     the Simulator boots here → `ios`
 *   fail     it does not → «ios: no — needs the runner user's login session» (a helper in that user's GUI session is a follow-up)
 *   skipped  not macOS, or no Xcode → nothing to say
 *
 * Whatever happens, the simulator device the check made is deleted again.
 */

const stepTimeoutMs = 60 * 1000;
export const iosCheckBudgetMs = 180 * 1000;
const checkDeviceName = 'charness-runner-boot-check';

const iosCheckSchema = z.strictObject({
  status: z.enum(['pass', 'fail', 'skipped']),
  checkedAtMs: z.number().int().nonnegative(),
  /** `16.2 (16C5032a)`: what Xcode was when this was checked; a different one means check again. */
  xcode: z.string().nullable(),
  reason: z.string().nullable(),
});

/** @name IosCheckRecord @description `ios-check.json`. */
export type IosCheckRecord = z.infer<typeof iosCheckSchema>;

export interface SimulatorChoice {
  deviceTypeId: string;
  runtimeId: string;
}

interface SimctlRuntime {
  identifier: string;
  version: string;
  platform?: string;
  isAvailable?: boolean;
}

interface SimctlDeviceType {
  identifier: string;
  productFamily?: string;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function parseJsonObject<TValue>(text: string): TValue | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** @description The newest available iOS runtime and an iPhone device type (the newest the list names), out of `simctl list runtimes -j` and `list devicetypes -j`. */
export function chooseSimulator(runtimesJson: string, deviceTypesJson: string): SimulatorChoice | null {
  const runtimes = parseJsonObject<{ runtimes?: SimctlRuntime[] }>(runtimesJson)?.runtimes ?? [];
  const deviceTypes = parseJsonObject<{ devicetypes?: SimctlDeviceType[] }>(deviceTypesJson)?.devicetypes ?? [];
  const ios = runtimes.filter((runtime) => runtime.platform === 'iOS' && runtime.isAvailable !== false).sort((left, right) => compareVersions(right.version, left.version));
  const iphones = deviceTypes.filter((deviceType) => deviceType.productFamily === 'iPhone');
  const iphone = iphones.at(-1);
  return ios.length === 0 || iphone === undefined ? null : { runtimeId: ios[0].identifier, deviceTypeId: iphone.identifier };
}

/** @description `16.2 (16C5032a)` out of `xcodebuild -version`, or `null`. */
export function parseXcodeVersion(output: string): string | null {
  const version = /Xcode\s+(\S+)/.exec(output)?.[1];
  const build = /Build version\s+(\S+)/.exec(output)?.[1];
  return version === undefined ? null : build === undefined ? version : `${version} (${build})`;
}

export interface IosCheckDeps {
  runner: CommandRunner;
  platform: NodeJS.Platform;
  now: () => number;
}

export function createIosCheckDeps(): IosCheckDeps {
  return { runner: runCommand, platform: process.platform, now: Date.now };
}

export async function readXcodeVersion(deps: IosCheckDeps): Promise<string | null> {
  if (deps.platform !== 'darwin') return null;
  const result = await deps.runner('xcodebuild', ['-version'], { timeoutMs: stepTimeoutMs });
  return result.ok ? parseXcodeVersion(result.stdout) : null;
}

/** @description Run the boot check: create → boot → bootstatus → delete. Never throws; the device is deleted whatever happened. */
export async function runIosBootCheck(deps: IosCheckDeps): Promise<IosCheckRecord> {
  const xcode = await readXcodeVersion(deps);
  const record = (status: IosCheckRecord['status'], reason: string | null): IosCheckRecord => ({ status, checkedAtMs: deps.now(), xcode, reason });
  if (deps.platform !== 'darwin') return record('skipped', 'not macOS');
  if (xcode === null) return record('skipped', 'no Xcode');
  const deadline = deps.now() + iosCheckBudgetMs;
  const step = (args: string[]): ReturnType<CommandRunner> => deps.runner('xcrun', ['simctl', ...args], { timeoutMs: Math.max(1000, Math.min(stepTimeoutMs, deadline - deps.now())) });
  const runtimes = await step(['list', 'runtimes', '-j']);
  const deviceTypes = await step(['list', 'devicetypes', '-j']);
  const choice = runtimes.ok && deviceTypes.ok ? chooseSimulator(runtimes.stdout, deviceTypes.stdout) : null;
  if (choice === null) return record('fail', 'no iOS simulator runtime and iPhone device type are installed');
  const created = await step(['create', checkDeviceName, choice.deviceTypeId, choice.runtimeId]);
  const udid = created.ok ? created.stdout.trim() : '';
  if (udid === '') return record('fail', 'the Simulator device could not be created');
  try {
    const boot = await step(['boot', udid]);
    if (!boot.ok) return record('fail', `the Simulator did not boot: ${boot.stderr.trim().split('\n').slice(-1)[0]}`);
    const status = await step(['bootstatus', udid, '-b']);
    return status.ok ? record('pass', null) : record('fail', `the Simulator did not finish booting: ${status.stderr.trim().split('\n').slice(-1)[0]}`);
  } finally {
    await step(['shutdown', udid]);
    await step(['delete', udid]);
  }
}

export function readIosCheck(paths: RunnerHomePaths): IosCheckRecord | null {
  try {
    const parsed = iosCheckSchema.safeParse(JSON.parse(fs.readFileSync(paths.iosCheck, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** @description One line, so `runner.sh probe` can read it with `grep`. */
export function writeIosCheck(paths: RunnerHomePaths, record: IosCheckRecord): void {
  writeTextFileAtomically(paths.iosCheck, `${JSON.stringify(iosCheckSchema.parse(record))}\n`, 0o644);
}

/** @description Check again when there is no result yet or Xcode is another one than the last result saw (a version, a build, gone). */
export function checkShouldRunIosCheck(last: IosCheckRecord | null, currentXcode: string | null): boolean {
  if (currentXcode === null) return last === null || last.status !== 'skipped' || last.xcode !== null;
  return last === null || last.xcode !== currentXcode;
}

/** @description At the link's start and then once an hour: run the check if Xcode is not what the last result saw. */
export async function refreshIosCheck(paths: RunnerHomePaths, deps: IosCheckDeps): Promise<IosCheckRecord | null> {
  if (deps.platform !== 'darwin') return null;
  const current = await readXcodeVersion(deps);
  if (!checkShouldRunIosCheck(readIosCheck(paths), current)) return null;
  const record = await runIosBootCheck(deps);
  writeIosCheck(paths, record);
  return record;
}
