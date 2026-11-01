import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCommand, type CommandRunner } from '../selfUpdate/commandRunner';
import { findAndroidSdk } from './execEnv';

/**
 * @description What `charness-runner check` (and the pairing) tells the operator about the machine: the OS, the hardware, and which of
 * the four things agents send to a runner it can do — Android emulator runs, iOS, Playwright, Docker. A first look from the account that
 * will run the jobs, not a promise: iOS is shown as «checked when the service starts» (the boot check of a LaunchDaemon is S3's), and a
 * capability that cannot be told cheaply is reported as it is found. Commands are bounded (4 s).
 */

const probeTimeoutMs = 4000;
const bytesPerGib = 1024 ** 3;
const maxDiskPathDepth = 8;

export interface CapabilityReport {
  name: 'android' | 'ios' | 'playwright' | 'docker';
  isAvailable: boolean;
  detail: string;
}

export interface MachineReport {
  osName: string;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  ramBytes: number;
  diskFreeBytes: number | null;
  capabilities: CapabilityReport[];
}

export interface MachineProbe {
  runner: CommandRunner;
  platform: NodeJS.Platform;
  nodeArch: string;
  homeDir: string;
  environment: NodeJS.ProcessEnv;
  checkExists: (candidate: string) => boolean;
  readTextFile: (filePath: string) => string | null;
  cpus: () => Array<{ model: string }>;
  totalMemoryBytes: () => number;
  freeDiskBytes: (directory: string) => number | null;
}

function readTextFileOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function readFreeDiskBytes(directory: string): number | null {
  let probe = directory;
  for (let depth = 0; depth < maxDiskPathDepth; depth += 1) {
    try {
      const stats = fs.statfsSync(probe);
      return stats.bavail * stats.bsize;
    } catch {
      probe = path.dirname(probe);
    }
  }
  return null;
}

export function createMachineProbe(homeDir: string = os.homedir()): MachineProbe {
  return {
    runner: runCommand,
    platform: process.platform,
    nodeArch: process.arch,
    homeDir,
    environment: process.env,
    checkExists: fs.existsSync,
    readTextFile: readTextFileOrNull,
    cpus: os.cpus,
    totalMemoryBytes: os.totalmem,
    freeDiskBytes: readFreeDiskBytes,
  };
}

/** @description `x86_64`/`arm64` for what Node calls `x64`/`arm64`. */
export function getArchName(nodeArch: string): string {
  return nodeArch === 'x64' ? 'x86_64' : nodeArch;
}

/** @description `Ubuntu 24.04` from `/etc/os-release`'s PRETTY_NAME, or the kernel's name. */
export function parseOsRelease(text: string | null): string | null {
  const match = text === null ? null : /^PRETTY_NAME="?([^"\n]+)"?$/m.exec(text);
  return match === null ? null : match[1].trim();
}

async function readOsName(probe: MachineProbe): Promise<string> {
  if (probe.platform === 'darwin') {
    const version = await probe.runner('sw_vers', ['-productVersion'], { timeoutMs: probeTimeoutMs });
    return version.ok ? `macOS ${version.stdout.trim()}` : 'macOS';
  }
  return parseOsRelease(probe.readTextFile('/etc/os-release')) ?? os.type();
}

async function detectAndroid(probe: MachineProbe): Promise<CapabilityReport> {
  const sdk = findAndroidSdk(probe.homeDir, probe.environment, probe.checkExists);
  if (sdk === null) return { name: 'android', isAvailable: false, detail: 'no Android SDK found' };
  const hasEmulator = probe.checkExists(path.join(sdk, 'emulator', 'emulator'));
  if (!hasEmulator) return { name: 'android', isAvailable: false, detail: 'the SDK has no emulator' };
  const acceleration = probe.platform === 'darwin' ? 'HVF' : probe.checkExists('/dev/kvm') ? 'KVM' : 'no KVM';
  return { name: 'android', isAvailable: true, detail: `${acceleration}, emulator found` };
}

async function detectIos(probe: MachineProbe): Promise<CapabilityReport> {
  if (probe.platform !== 'darwin') return { name: 'ios', isAvailable: false, detail: 'needs macOS' };
  const xcode = await probe.runner('xcodebuild', ['-version'], { timeoutMs: probeTimeoutMs });
  const version = /Xcode\s+(\S+)/.exec(xcode.stdout)?.[1];
  return xcode.ok && version !== undefined
    ? { name: 'ios', isAvailable: true, detail: `Xcode ${version}, checked when the service starts` }
    : { name: 'ios', isAvailable: false, detail: 'no Xcode' };
}

function detectPlaywright(probe: MachineProbe): CapabilityReport {
  const browsersPath = probe.environment.PLAYWRIGHT_BROWSERS_PATH
    ?? path.join(probe.homeDir, probe.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright');
  return probe.checkExists(browsersPath)
    ? { name: 'playwright', isAvailable: true, detail: 'browsers installed' }
    : { name: 'playwright', isAvailable: false, detail: 'no browsers installed' };
}

async function detectDocker(probe: MachineProbe): Promise<CapabilityReport> {
  const docker = await probe.runner('docker', ['--version'], { timeoutMs: probeTimeoutMs });
  return docker.ok ? { name: 'docker', isAvailable: true, detail: docker.stdout.trim().replace(/^Docker version\s*/, '').split(',')[0] } : { name: 'docker', isAvailable: false, detail: 'not installed' };
}

/** @description Look at this machine. */
export async function collectMachineReport(probe: MachineProbe, workRoot: string): Promise<MachineReport> {
  const cpus = probe.cpus();
  const [osName, android, ios, docker] = await Promise.all([readOsName(probe), detectAndroid(probe), detectIos(probe), detectDocker(probe)]);
  return {
    osName,
    arch: getArchName(probe.nodeArch),
    cpuModel: cpus[0]?.model.trim() ?? 'unknown CPU',
    cpuCores: cpus.length,
    ramBytes: probe.totalMemoryBytes(),
    diskFreeBytes: probe.freeDiskBytes(workRoot),
    capabilities: [android, ios, detectPlaywright(probe), docker],
  };
}

function formatGib(bytes: number): string {
  return `${Math.round(bytes / bytesPerGib)} GB`;
}

/** @description The lines of the check screen for the machine: system, hardware, what it can do. */
export function formatMachineReport(report: MachineReport): string[] {
  const capabilityText = report.capabilities.map((capability) => (capability.isAvailable ? `${capability.name} (${capability.detail})` : `${capability.name}: no`)).join(' · ');
  return [
    `  ${report.osName} (${report.arch}) · ${report.cpuModel}, ${report.cpuCores} cores · RAM ${formatGib(report.ramBytes)}${report.diskFreeBytes === null ? '' : ` · disk ${formatGib(report.diskFreeBytes)} free`}`,
    `  can: ${capabilityText}`,
  ];
}
