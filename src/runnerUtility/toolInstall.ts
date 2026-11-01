import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCommand, type CommandRunner } from '../selfUpdate/commandRunner';
import type { RunnerHomePaths } from './runnerHome';

/**
 * @description The two tools phase 1 needs on a runner besides Node, `ssh` and `tar`.
 *
 * PUEUE is installed by the utility from the pinned release binaries of Nukesor/pueue, each checked against a sha256 written here
 * (a download that does not match is thrown away — nothing is ever executed unchecked). The hashes were taken from the release assets
 * of v4.0.4 on 2026-11-01. They go into `~/.charness-runner/bin/`, no admin needed.
 *
 * RSYNC ≥ 3.1 is FOUND (PATH, Homebrew, /usr/local, /usr/bin). macOS 15.4 and later ship `openrsync`, which lacks the options phase 1
 * uses (`--copy-dest`, `--modify-window=-1`), so it does not count. Without a usable one, rsync 3.4.1 is BUILT from its pinned source
 * with the machine's C compiler (Xcode's command line tools on a Mac); without a compiler the check names the one command to run.
 */

export const pueueVersion = '4.0.4';
export const rsyncVersion = '3.4.1';
const pueueBaseUrl = `https://github.com/Nukesor/pueue/releases/download/v${pueueVersion}`;
const rsyncSourceUrl = `https://download.samba.org/pub/rsync/src/rsync-${rsyncVersion}.tar.gz`;
const rsyncSourceSha256 = '2924bcb3a1ed8b551fc101f740b9f0fe0a202b115027647cf69850d65fd88c52';
const downloadTimeoutMs = 3 * 60 * 1000;
const maxDownloadBytes = 64 * 1024 * 1024;
const versionProbeTimeoutMs = 4000;
const buildStepTimeoutMs = 15 * 60 * 1000;
const executableMode = 0o755;
const minRsync = { major: 3, minor: 1 };
const extraRsyncDirs: readonly string[] = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

export interface PueueAsset {
  pueueUrl: string;
  pueueSha256: string;
  pueuedUrl: string;
  pueuedSha256: string;
}

function createPueueAsset(target: string, pueueSha256: string, pueuedSha256: string): PueueAsset {
  return { pueueUrl: `${pueueBaseUrl}/pueue-${target}`, pueueSha256, pueuedUrl: `${pueueBaseUrl}/pueued-${target}`, pueuedSha256 };
}

/** The pinned binaries by `${process.platform}-${process.arch}`. */
export const pueueAssets: Readonly<Record<string, PueueAsset>> = {
  'linux-x64': createPueueAsset('x86_64-unknown-linux-musl', 'c1b10d7e4e62211075ddd0e1dc3e8cbfc5a43d662cb3be7402a28504e23fcb51', '5afeff6adbafb909e8d54e2caff158e6966c2adffa2c09e60fd631cc51b60390'),
  'linux-arm64': createPueueAsset('aarch64-unknown-linux-musl', '759bf5100a51024997111c6913aaf3330a0cdfd893ff552dcf429ae9b5e01e09', '332c5ef74270b64aeaf04894c8c04826f3422eb7d50dbd1a8e0706d74a42f653'),
  'darwin-x64': createPueueAsset('x86_64-apple-darwin', 'c5b89a2f9f9d355b33880735a1f12a8b8d09002f95cc7d2e5f3294e313fb8540', '4de7c4790989198007c6c0789c56606237d0456a2ce3666b5a0b198478c06263'),
  'darwin-arm64': createPueueAsset('aarch64-apple-darwin', '7780dbd21e3a4106e88a57396d6dc2dbcbbae253c7e00d92d994902896b8cb82', 'bf5a1151d70c328dd036fb6d786fba53a68d8574c12391d04db3d08b04079205'),
};

export function getPueueAsset(platform: NodeJS.Platform, arch: string, table: Readonly<Record<string, PueueAsset>> = pueueAssets): PueueAsset | undefined {
  return table[`${platform}-${arch}`];
}

export type FetchFunction = (url: string, init: { signal: AbortSignal; redirect: 'follow' }) => Promise<{ ok: boolean; status: number; arrayBuffer: () => Promise<ArrayBuffer> }>;

/**
 * @description Download `url` to `destinationPath` (mode 755) only if its sha256 is `expectedSha256`: the bytes are checked in memory
 * first, so a wrong file never exists on disk under the final name.
 */
export async function downloadVerified(url: string, expectedSha256: string, destinationPath: string, fetchImpl: FetchFunction = fetch): Promise<void> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(downloadTimeoutMs), redirect: 'follow' });
  if (!response.ok) throw new Error(`download failed (HTTP ${response.status}): ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxDownloadBytes) throw new Error(`download is larger than expected: ${url}`);
  const actualSha256 = createHash('sha256').update(bytes).digest('hex');
  if (actualSha256 !== expectedSha256) throw new Error(`checksum mismatch for ${url}: expected ${expectedSha256.slice(0, 12)}…, got ${actualSha256.slice(0, 12)}…`);
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${destinationPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, bytes, { mode: executableMode });
  fs.renameSync(temporaryPath, destinationPath);
}

/** @description The first `x.y.z` in a tool's `--version` output, or `null`. */
export function parseToolVersion(output: string): string | null {
  return /(\d+\.\d+(?:\.\d+)?)/.exec(output)?.[1] ?? null;
}

export interface RsyncInfo {
  /** `openrsync` is Apple's reimplementation; it lacks what phase 1 needs. */
  flavor: 'rsync' | 'openrsync';
  version: string | null;
}

export function parseRsyncVersion(output: string): RsyncInfo | null {
  if (/openrsync/i.test(output)) return { flavor: 'openrsync', version: null };
  const match = /rsync\s+version\s+v?(\d+\.\d+(?:\.\d+)?)/i.exec(output);
  return match === null ? null : { flavor: 'rsync', version: match[1] };
}

export function checkIsRsyncUsable(info: RsyncInfo): boolean {
  if (info.flavor !== 'rsync' || info.version === null) return false;
  const [major, minor] = info.version.split('.').map(Number);
  return major > minRsync.major || (major === minRsync.major && minor >= minRsync.minor);
}

export interface ToolFound {
  path: string;
  version: string;
}

export interface ToolDeps {
  runner: CommandRunner;
  platform: NodeJS.Platform;
  arch: string;
  environment: NodeJS.ProcessEnv;
  fetchImpl: FetchFunction;
  /** The pinned binaries to choose from; a test supplies its own. */
  pueueAssetTable: Readonly<Record<string, PueueAsset>>;
  checkExists: (candidate: string) => boolean;
  cpuCount: number;
}

export function createToolDeps(): ToolDeps {
  return { runner: runCommand, platform: process.platform, arch: process.arch, environment: process.env, fetchImpl: fetch, pueueAssetTable: pueueAssets, checkExists: fs.existsSync, cpuCount: os.cpus().length };
}

/** @description A usable rsync from PATH, Homebrew or the system folders, with the one `<root>/bin/rsync` (built earlier) first. */
export async function findRsync(paths: RunnerHomePaths, deps: ToolDeps): Promise<ToolFound | null> {
  const pathDirs = (deps.environment.PATH ?? '').split(path.delimiter).filter((dir) => dir !== '');
  const candidates = [...new Set([paths.binDir, ...pathDirs, ...extraRsyncDirs])].map((dir) => path.join(dir, 'rsync')).filter(deps.checkExists);
  for (const candidate of candidates) {
    const result = await deps.runner(candidate, ['--version'], { timeoutMs: versionProbeTimeoutMs });
    const info = result.ok ? parseRsyncVersion(result.stdout) : null;
    if (info !== null && checkIsRsyncUsable(info) && info.version !== null) return { path: candidate, version: info.version };
  }
  return null;
}

/** @description Our pueue in `<root>/bin`, when it is there and runs. */
export async function findPueue(paths: RunnerHomePaths, deps: ToolDeps): Promise<ToolFound | null> {
  const candidate = path.join(paths.binDir, 'pueue');
  if (!deps.checkExists(candidate)) return null;
  const result = await deps.runner(candidate, ['--version'], { timeoutMs: versionProbeTimeoutMs });
  const version = result.ok ? parseToolVersion(result.stdout) : null;
  return version === null ? null : { path: candidate, version };
}

export type ToolInstallOutcome = { ok: true; tool: ToolFound; wasInstalled: boolean } | { ok: false; reason: string };

/** @description Make sure `<root>/bin/pueue` and `pueued` are there (downloaded and verified when not). */
export async function ensurePueue(paths: RunnerHomePaths, deps: ToolDeps): Promise<ToolInstallOutcome> {
  const existing = await findPueue(paths, deps);
  if (existing !== null && deps.checkExists(path.join(paths.binDir, 'pueued'))) return { ok: true, tool: existing, wasInstalled: false };
  const asset = getPueueAsset(deps.platform, deps.arch, deps.pueueAssetTable);
  if (asset === undefined) return { ok: false, reason: `no pinned Pueue binary for ${deps.platform}/${deps.arch}; install Pueue ${pueueVersion} by hand into ${paths.binDir}` };
  try {
    await downloadVerified(asset.pueueUrl, asset.pueueSha256, path.join(paths.binDir, 'pueue'), deps.fetchImpl);
    await downloadVerified(asset.pueuedUrl, asset.pueuedSha256, path.join(paths.binDir, 'pueued'), deps.fetchImpl);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'the Pueue download failed' };
  }
  const installed = await findPueue(paths, deps);
  return installed === null ? { ok: false, reason: 'the downloaded pueue does not run on this machine' } : { ok: true, tool: installed, wasInstalled: true };
}

/** @description The one thing to tell the operator when rsync cannot be built here. */
export function describeRsyncRemedy(platform: NodeJS.Platform): string {
  return platform === 'darwin'
    ? 'rsync 3.1 or newer is missing (macOS\'s own is openrsync). Install the compiler tools with `xcode-select --install` and run `charness-runner check` again, or `brew install rsync`.'
    : 'rsync 3.1 or newer is missing. Install it with your package manager (for example `sudo apt install rsync`) and run `charness-runner check` again.';
}

/** @description The build steps of rsync, in order (pure, so a test can read them). */
export function planRsyncBuild(paths: RunnerHomePaths, cpuCount: number): Array<{ file: string; args: string[]; cwd: string }> {
  const sourceDir = path.join(paths.buildDir, `rsync-${rsyncVersion}`);
  const prefix = path.join(paths.root, 'rsync');
  return [
    { file: 'tar', args: ['-xzf', path.join(paths.buildDir, `rsync-${rsyncVersion}.tar.gz`), '-C', paths.buildDir], cwd: paths.buildDir },
    { file: './configure', args: [`--prefix=${prefix}`, '--disable-md2man', '--disable-xxhash', '--disable-zstd', '--disable-lz4', '--disable-openssl', '--with-included-popt', '--with-included-zlib'], cwd: sourceDir },
    { file: 'make', args: [`-j${Math.max(1, cpuCount)}`], cwd: sourceDir },
    { file: 'make', args: ['install'], cwd: sourceDir },
  ];
}

/** @description Build rsync from the pinned source and link it as `<root>/bin/rsync`. */
export async function buildRsync(paths: RunnerHomePaths, deps: ToolDeps): Promise<ToolInstallOutcome> {
  const compiler = await deps.runner('cc', ['--version'], { timeoutMs: versionProbeTimeoutMs });
  const make = await deps.runner('make', ['--version'], { timeoutMs: versionProbeTimeoutMs });
  if (!compiler.ok || !make.ok) return { ok: false, reason: describeRsyncRemedy(deps.platform) };
  fs.mkdirSync(paths.buildDir, { recursive: true, mode: 0o700 });
  try {
    await downloadVerified(rsyncSourceUrl, rsyncSourceSha256, path.join(paths.buildDir, `rsync-${rsyncVersion}.tar.gz`), deps.fetchImpl);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'the rsync download failed' };
  }
  for (const step of planRsyncBuild(paths, deps.cpuCount)) {
    const result = await deps.runner(step.file, step.args, { cwd: step.cwd, timeoutMs: buildStepTimeoutMs });
    if (!result.ok) return { ok: false, reason: `building rsync failed at «${step.file} ${step.args[0] ?? ''}»: ${result.stderr.trim().split('\n').slice(-2).join(' | ')}` };
  }
  const built = path.join(paths.root, 'rsync', 'bin', 'rsync');
  fs.mkdirSync(paths.binDir, { recursive: true, mode: 0o700 });
  fs.rmSync(path.join(paths.binDir, 'rsync'), { force: true });
  fs.symlinkSync(built, path.join(paths.binDir, 'rsync'));
  const found = await findRsync(paths, deps);
  return found === null ? { ok: false, reason: 'the rsync that was built does not run' } : { ok: true, tool: found, wasInstalled: true };
}

/** @description rsync: the usable one that is there, else a built one. */
export async function ensureRsync(paths: RunnerHomePaths, deps: ToolDeps): Promise<ToolInstallOutcome> {
  const found = await findRsync(paths, deps);
  return found !== null ? { ok: true, tool: found, wasInstalled: false } : buildRsync(paths, deps);
}
