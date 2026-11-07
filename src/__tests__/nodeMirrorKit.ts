/**
 * @description A local mirror of `nodejs.org/dist` for the tests of the runner's own Node.js (`remoteRun/ensureNode.sh`): an `index.json` in nodejs.org's
 * own format (one release per line, with decoys the install must not pick), and for each release that has an archive its `SHASUMS256.txt` and the archive for
 * THIS machine, holding a `bin/node` the test chooses — a stand-in script, or a copy of a real Node binary when a flow has to run the runner on it. No
 * network: the script is given the mirror as a `file://` place to download from.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** The release the mirror holds by default (an LTS one, inside the range the install accepts). */
export const mirrorRelease = 'v22.99.0';
export const platformName = process.platform === 'darwin' ? 'darwin' : 'linux';
export const architectureName = process.arch === 'arm64' ? 'arm64' : 'x64';

/** A stand-in `node`: it answers the version check (`node -e …`) by its exit status, as the real one would. */
export const nodeThatRuns = '#!/bin/sh\nexit 0\n';
export const nodeThatIsTooOld = '#!/bin/sh\nexit 1\n';

export function getArchiveName(version: string): string {
  return `node-${version}-${platformName}-${architectureName}.tar.gz`;
}

/** One entry of the mirror's `index.json`: `lts` is the line's code name, or `false` for a release that is not an LTS one. */
export interface MirrorRelease {
  version: string;
  lts: string | false;
}

/** The release the mirror holds by default: the newest LTS that fits (22.12 up to 24), with an archive. */
export const defaultMirrorRelease: MirrorRelease = { version: mirrorRelease, lts: 'Jod' };

/**
 * Entries that are in nodejs.org's list and that the install must NOT pick: not an LTS, newer than the last line that ships Corepack, older than 22.12.
 * They have no archive; picking one fails the install, which is how a test sees a wrong choice.
 */
const decoyReleases: readonly MirrorRelease[] = [
  { version: 'v25.9.9', lts: false },
  { version: 'v26.99.0', lts: 'Lithium' },
  { version: 'v22.11.9', lts: 'Jod' },
  { version: 'v21.7.3', lts: 'Iron' },
];
/** What the list names the builds of this machine by; the others are for the machines the test is not on. */
const indexedFileNames = ['linux-x64', 'linux-arm64', 'osx-x64-tar', 'osx-arm64-tar'];

export interface MirrorOptions {
  /** The releases that have an archive (default: {@link defaultMirrorRelease}). A single `version` is the shorthand for one LTS release of that name. */
  releases?: readonly MirrorRelease[];
  version?: string;
  /** The text of the archive's `bin/node` (a stand-in). */
  nodeScript?: string;
  /** A file to copy into the archive as `bin/node` instead (a real Node binary, for a flow that runs on it). */
  nodeFrom?: string;
  /** Lie in `SHASUMS256.txt` about the archive's hash. */
  isChecksumWrong?: boolean;
  /** Leave the machine's build out of the list. */
  isPlatformMissing?: boolean;
  /** A file of the archive with group- and world-write rights, to see them taken away in a root install. */
  isWithOpenFile?: boolean;
}

/** @description Lay the mirror out in `distDir` (built from `stageDir`, a scratch folder); returns `distDir`. */
export function writeNodeMirror(distDir: string, stageDir: string, options: MirrorOptions = {}): string {
  const releases = options.releases ?? [options.version === undefined ? defaultMirrorRelease : { version: options.version, lts: 'Jod' }];
  const [first] = releases;
  const stage = path.join(stageDir, `node-${first.version}-${platformName}-${architectureName}`);
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(stage, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(stage, 'lib'), { recursive: true });
  if (options.nodeFrom === undefined) fs.writeFileSync(path.join(stage, 'bin', 'node'), options.nodeScript ?? nodeThatRuns, { mode: 0o755 });
  else fs.copyFileSync(options.nodeFrom, path.join(stage, 'bin', 'node'));
  fs.chmodSync(path.join(stage, 'bin', 'node'), 0o755);
  fs.writeFileSync(path.join(stage, 'lib', 'other.txt'), 'x');
  fs.chmodSync(path.join(stage, 'lib', 'other.txt'), options.isWithOpenFile === true ? 0o666 : 0o644);
  fs.chmodSync(path.join(stage, 'lib'), options.isWithOpenFile === true ? 0o777 : 0o755);
  // One archive for every release: what is inside is the same, and the install strips the top folder whatever it is called.
  const firstArchive = path.join(distDir, first.version, getArchiveName(first.version));
  fs.mkdirSync(path.dirname(firstArchive), { recursive: true });
  assert.equal(spawnSync('tar', ['-czf', firstArchive, '-C', path.dirname(stage), path.basename(stage)]).status, 0);
  fs.rmSync(stageDir, { recursive: true, force: true });
  const hash = options.isChecksumWrong === true ? '0'.repeat(64) : createHash('sha256').update(fs.readFileSync(firstArchive)).digest('hex');
  for (const release of releases) {
    const archive = path.join(distDir, release.version, getArchiveName(release.version));
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    if (archive !== firstArchive) fs.copyFileSync(firstArchive, archive);
    fs.writeFileSync(path.join(distDir, release.version, 'SHASUMS256.txt'), [
      `${'a'.repeat(64)}  node-${release.version}-aix-ppc64.tar.gz`,
      `${'b'.repeat(64)}  node-${release.version}-${platformName}-${architectureName}-musl.tar.gz`,
      `${hash}  ${getArchiveName(release.version)}`,
      `${'c'.repeat(64)}  node-${release.version}-win-x64.zip`,
      '',
    ].join('\n'));
  }
  const files = options.isPlatformMissing === true ? ['aix-ppc64', 'src'] : indexedFileNames;
  const entries = [...decoyReleases, ...releases].map((release) => `{"version":"${release.version}","date":"2026-10-27","files":${JSON.stringify(files)},"npm":"11.0.0","lts":${JSON.stringify(release.lts)},"security":false}`);
  fs.writeFileSync(path.join(distDir, 'index.json'), `[\n${entries.join(',\n')}\n]\n`);
  return distDir;
}
