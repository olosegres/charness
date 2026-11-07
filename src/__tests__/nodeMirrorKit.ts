/**
 * @description A local mirror of `nodejs.org/dist` for the tests of the runner's own Node.js (`remoteRun/ensureNode.sh`): the `latest-v22.x/SHASUMS256.txt`
 * that names the newest release and that release's archive for THIS machine, holding a `bin/node` the test chooses — a stand-in script, or a copy of a real
 * Node binary when a flow has to run the runner on it. No network: the script is given the mirror as a `file://` place to download from.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** The newest 22.x of the mirror. */
export const mirrorRelease = 'v22.99.0';
export const platformName = process.platform === 'darwin' ? 'darwin' : 'linux';
export const architectureName = process.arch === 'arm64' ? 'arm64' : 'x64';

/** A stand-in `node`: it answers the version check (`node -e …`) by its exit status, as the real one would. */
export const nodeThatRuns = '#!/bin/sh\nexit 0\n';
export const nodeThatIsTooOld = '#!/bin/sh\nexit 1\n';

export function getArchiveName(version: string): string {
  return `node-${version}-${platformName}-${architectureName}.tar.gz`;
}

export interface MirrorOptions {
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
  const version = options.version ?? mirrorRelease;
  const stage = path.join(stageDir, `node-${version}-${platformName}-${architectureName}`);
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(stage, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(stage, 'lib'), { recursive: true });
  if (options.nodeFrom === undefined) fs.writeFileSync(path.join(stage, 'bin', 'node'), options.nodeScript ?? nodeThatRuns, { mode: 0o755 });
  else fs.copyFileSync(options.nodeFrom, path.join(stage, 'bin', 'node'));
  fs.chmodSync(path.join(stage, 'bin', 'node'), 0o755);
  fs.writeFileSync(path.join(stage, 'lib', 'other.txt'), 'x');
  fs.chmodSync(path.join(stage, 'lib', 'other.txt'), options.isWithOpenFile === true ? 0o666 : 0o644);
  fs.chmodSync(path.join(stage, 'lib'), options.isWithOpenFile === true ? 0o777 : 0o755);
  fs.mkdirSync(path.join(distDir, version), { recursive: true });
  fs.mkdirSync(path.join(distDir, 'latest-v22.x'), { recursive: true });
  const archive = path.join(distDir, version, getArchiveName(version));
  assert.equal(spawnSync('tar', ['-czf', archive, '-C', path.dirname(stage), path.basename(stage)]).status, 0);
  fs.rmSync(stageDir, { recursive: true, force: true });
  const hash = options.isChecksumWrong === true ? '0'.repeat(64) : createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  fs.writeFileSync(path.join(distDir, 'latest-v22.x', 'SHASUMS256.txt'), [
    `${'a'.repeat(64)}  node-${version}-aix-ppc64.tar.gz`,
    `${'b'.repeat(64)}  node-${version}-${platformName}-${architectureName}-musl.tar.gz`,
    ...(options.isPlatformMissing === true ? [] : [`${hash}  ${getArchiveName(version)}`]),
    `${'c'.repeat(64)}  node-${version}-win-x64.zip`,
    '',
  ].join('\n'));
  return distDir;
}
