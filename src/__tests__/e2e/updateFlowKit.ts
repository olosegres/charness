/**
 * @description What the update flows share: packing a version of charness from the BUILT dist (its version, `engines`, CHANGELOG
 * and — for a "does not start" version — a corrupted `bot.js` patched in), and driving the real `npm` against the fake registry
 * (a global install into a temp prefix, with the instance's own HOME and cache, so what the bot installs later finds its dependencies
 * in the cache this warmed).
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PackageManifest } from './fakeNpmRegistry';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const npmBinary = path.join(path.dirname(process.execPath), 'npm');
const packTimeoutMs = 3 * 60 * 1000;
const installTimeoutMs = 10 * 60 * 1000;
/** Appended to `dist/bot.js` of a version that must fail its self-check: `node --check` refuses it. */
const syntaxErrorSource = '\n;;(((\n';

export interface PackedVersionOptions {
  version: string;
  /** The CHANGELOG.md the package carries (the what's-new list is read from it). */
  changelog: string;
  /** `engines.node` of the package, when the test wants the version to demand another Node. */
  engines?: { node: string };
  /** Corrupt `dist/bot.js`, so the new install cannot start. */
  isBroken?: boolean;
}

export interface PackedVersion {
  version: string;
  tarballPath: string;
  /** The `package.json` the tarball carries. */
  manifest: PackageManifest;
}

/** @description The package.json of this checkout, as an object. */
function readRepoManifest(): PackageManifest {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
}

/**
 * @description Pack `options.version` of charness into `outputDir`: the built dist, the package files and the given CHANGELOG, under a
 * package.json with that version (and no scripts: nothing runs at install except what npm itself runs for node-pty).
 */
export function packCharnessVersion(workDir: string, outputDir: string, options: PackedVersionOptions): PackedVersion {
  const packageDir = path.join(workDir, `charness-${options.version}`);
  fs.rmSync(packageDir, { recursive: true, force: true });
  fs.mkdirSync(packageDir, { recursive: true });
  fs.cpSync(path.join(repoRoot, 'dist'), path.join(packageDir, 'dist'), { recursive: true });
  for (const file of ['LICENSE', 'README.md', 'DEVELOPMENT.md', 'SETUP.md', 'MIGRATION_1_TO_2.md', 'MIGRATION_RENAME_TO_CHARNESS.md', '.env.example']) {
    if (fs.existsSync(path.join(repoRoot, file))) fs.copyFileSync(path.join(repoRoot, file), path.join(packageDir, file));
  }
  fs.mkdirSync(path.join(packageDir, 'stt'), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'stt', 'gigaam_sidecar.py'), path.join(packageDir, 'stt', 'gigaam_sidecar.py'));
  fs.writeFileSync(path.join(packageDir, 'CHANGELOG.md'), options.changelog);
  if (options.isBroken) fs.appendFileSync(path.join(packageDir, 'dist', 'bot.js'), syntaxErrorSource);

  const manifest = readRepoManifest();
  manifest.version = options.version;
  delete manifest.scripts;
  delete manifest.devDependencies;
  manifest.engines = options.engines ?? manifest.engines;
  fs.writeFileSync(path.join(packageDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  fs.mkdirSync(outputDir, { recursive: true });
  const result = spawnSync(npmBinary, ['pack', '--pack-destination', outputDir, '--ignore-scripts', '--silent'], {
    cwd: packageDir,
    encoding: 'utf8',
    timeout: packTimeoutMs,
    env: { PATH: process.env.PATH, HOME: workDir },
  });
  if (result.status !== 0) throw new Error(`npm pack of ${options.version} failed: ${result.stderr}`);
  return { version: options.version, tarballPath: path.join(outputDir, result.stdout.trim().split('\n').at(-1) ?? ''), manifest };
}

export interface NpmEnvironment {
  /** The instance's own HOME: npm's cache lives in it, so a later install by the bot finds its dependencies there. */
  home: string;
  registryUrl: string;
  /** A PATH that holds `node` and the system tools. */
  path: string;
}

/** @description The environment the flow's own npm calls run with (and the instance's env file mirrors for the bot's). */
export function getNpmEnvironment(environment: NpmEnvironment): NodeJS.ProcessEnv {
  return { PATH: environment.path, HOME: environment.home, NPM_CONFIG_REGISTRY: environment.registryUrl, NPM_CONFIG_UPDATE_NOTIFIER: 'false' };
}

/**
 * @description `npm install -g --prefix <prefix> charness@<version>` — what an operator does by hand, against the fake registry.
 * Asynchronous on purpose: the registry lives in THIS process, so a blocking call would leave npm's own requests unanswered.
 */
export async function installCharnessGlobally(prefix: string, version: string, environment: NpmEnvironment): Promise<void> {
  const child = spawn(npmBinary, ['install', '-g', '--prefix', prefix, `charness@${version}`, '--no-fund', '--no-audit', '--loglevel=error'], {
    env: getNpmEnvironment(environment),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const timer = setTimeout(() => child.kill('SIGKILL'), installTimeoutMs);
  const exitCode = await new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  clearTimeout(timer);
  if (exitCode !== 0) throw new Error(`npm install -g charness@${version} failed (${exitCode}):\n${output}`);
}

/** @description Where a global install puts the package. */
export function getInstalledPackageRoot(prefix: string): string {
  return path.join(prefix, 'lib', 'node_modules', 'charness');
}

/** @description The version an install's package.json says right now. */
export function readInstalledVersion(prefix: string): string {
  const manifest: { version: string } = JSON.parse(fs.readFileSync(path.join(getInstalledPackageRoot(prefix), 'package.json'), 'utf8'));
  return manifest.version;
}
