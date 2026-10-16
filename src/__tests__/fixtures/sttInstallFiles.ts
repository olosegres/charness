/**
 * @description Files an install of the local speech engine leaves under `<dataDir>/stt`, written by hand for tests that
 * need an install in a given state without downloading anything: the "installed" marker with its interpreter, a held
 * install lock, and lines of the job's progress file.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getSttPaths, gigaamPinnedRequirements, gigaamScriptVersion, type SttInstallProgress } from '../../stt/sttInstall';

/** What `isGigaamInstalled` checks: the marker of this build's script version and pins, and an executable interpreter. */
export function writeInstalledMarker(dataDir: string): void {
  const paths = getSttPaths(dataDir);
  fs.mkdirSync(path.dirname(paths.venvPython), { recursive: true });
  fs.writeFileSync(paths.venvPython, '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(paths.markerFile, JSON.stringify({ scriptVersion: gigaamScriptVersion, pins: gigaamPinnedRequirements, installedAt: 'now' }));
}

/** The lock of a RUNNING install job: its owner is this (live) process, however old the lock is. */
export function holdInstallLock(dataDir: string): void {
  const paths = getSttPaths(dataDir);
  fs.mkdirSync(paths.lockDir, { recursive: true });
  fs.writeFileSync(path.join(paths.lockDir, 'owner'), `${process.pid}\n`);
}

export function releaseInstallLock(dataDir: string): void {
  fs.rmSync(getSttPaths(dataDir).lockDir, { recursive: true, force: true });
}

/** One more line of the job's progress file; the last line is the job's state. */
export function appendInstallProgress(dataDir: string, progress: SttInstallProgress): void {
  const paths = getSttPaths(dataDir);
  fs.mkdirSync(paths.root, { recursive: true });
  fs.appendFileSync(paths.progressFile, `${JSON.stringify(progress)}\n`);
}
