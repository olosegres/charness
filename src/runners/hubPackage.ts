import { createHash } from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { gzipSync } from 'zlib';
import { z } from 'zod';
import { getCaughtErrnoCode, writeJsonFileAtomically } from '../configDirFile';
import { ensureHubDir } from './hubLock';
import { getHubFilePaths, type HubContext } from './hubPaths';
import { createTarArchive, type TarEntry } from './tarArchive';

/**
 * @description The charness package a runner installs: the hub's OWN `dist/`, `package.json` and `remoteRun/runner.sh`, packed into a
 * gzip tar, so a runner and its hub never run different code and no npm release is needed. Its id is the sha256 of the tar before
 * compression (stable — gzip's bytes depend on the zlib build), 16 hex digits. The packed file is cached in `package/`; whether the
 * cache is current is decided by a stamp of the source files (path, size, mtime), so asking for the id costs a walk of `stat`s.
 *
 * Several gates and packers run at once, none of them coordinated, so nothing is deleted on a packer's word: an archive is published
 * whole by a rename (named by its id, so two packers of one source write the same bytes), `current.json` is only a pointer that heals
 * (a packer that is late writes an older pointer; the next call sees the stamp differ and packs again), an archive that is no longer
 * current is removed only after {@link supersededArchiveGraceMs}, and a reader {@link openHubPackage OPENS} the archive at once — a file
 * that is deleted afterwards stays readable through the open handle.
 */

const packageIdLength = 16;
const gzipLevel = 9;
const cacheFileMode = 0o600;
const executableBits = 0o111;
const executableMode = 0o755;
const plainFileMode = 0o644;
const currentFileName = 'current.json';
/** An archive that is no longer the current one is kept this long: a gate that was handed its path a moment ago must still find it. */
export const supersededArchiveGraceMs = 10 * 60 * 1000;
const archiveSuffix = '.tgz';
const temporarySuffix = '.tmp';
const maxOpenAttempts = 3;
/** `dist/` entries a runner never needs: tests, type declarations and source maps. */
const skippedFilePattern = /(?:\.d\.ts|\.d\.ts\.map|\.js\.map)$/;
const skippedFolderName = '__tests__';
const runnerScriptRelativePath = 'remoteRun/runner.sh';
const packageJsonRelativePath = 'package.json';
const distRelativePath = 'dist';

const currentSchema = z.strictObject({ stamp: z.string(), id: z.string(), fileName: z.string() });

/** @description The packed package: where the gzip file is, and its id. */
export interface HubPackage {
  id: string;
  filePath: string;
}

interface SourceFile {
  relativePath: string;
  absolutePath: string;
  size: number;
  mtimeMs: number;
  mode: number;
}

function listDistFiles(distRoot: string, relativeFolder: string): SourceFile[] {
  const files: SourceFile[] = [];
  const entries = fs.readdirSync(path.join(distRoot, relativeFolder), { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : 1));
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeFolder, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== skippedFolderName) files.push(...listDistFiles(distRoot, relativePath));
    } else if (entry.isFile() && !skippedFilePattern.test(entry.name)) {
      files.push(statSourceFile(distRoot, relativePath));
    }
  }
  return files;
}

function statSourceFile(root: string, relativePath: string): SourceFile {
  const absolutePath = path.join(root, relativePath);
  const stat = fs.statSync(absolutePath);
  return { relativePath, absolutePath, size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode };
}

/** The files in archive order: `package.json`, the runner script, then everything under `dist/` sorted by path. */
function listPackageFiles(packageRoot: string): SourceFile[] {
  const distFiles = listDistFiles(packageRoot, distRelativePath);
  return [statSourceFile(packageRoot, packageJsonRelativePath), statSourceFile(packageRoot, runnerScriptRelativePath), ...distFiles];
}

function createSourceStamp(files: readonly SourceFile[]): string {
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${file.relativePath}:${file.size}:${file.mtimeMs}\n`);
  return hash.digest('hex');
}

function readCurrent(packageDir: string): z.infer<typeof currentSchema> | null {
  try {
    const parsed = currentSchema.safeParse(JSON.parse(fs.readFileSync(path.join(packageDir, currentFileName), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function packFiles(files: readonly SourceFile[]): { id: string; gzip: Buffer } {
  const entries: TarEntry[] = files.map((file) => ({
    path: file.relativePath,
    content: fs.readFileSync(file.absolutePath),
    mode: (file.mode & executableBits) === 0 ? plainFileMode : executableMode,
  }));
  const tar = createTarArchive(entries);
  return { id: createHash('sha256').update(tar).digest('hex').slice(0, packageIdLength), gzip: gzipSync(tar, { level: gzipLevel }) };
}

/**
 * @description The current package of this hub, packed now unless the cache already holds this exact source. Throws when the source
 * (`dist/`, `package.json`, `remoteRun/runner.sh` under `ctx.packageRoot`) is missing. Safe without the registry lock: a cache file
 * is written whole and named by its id, and two packers of one source write identical bytes.
 */
export function getHubPackage(ctx: HubContext): HubPackage {
  const packageDir = getHubFilePaths(ctx.dir).packageDir;
  const files = listPackageFiles(ctx.packageRoot);
  const stamp = createSourceStamp(files);
  const current = readCurrent(packageDir);
  if (current !== null && current.stamp === stamp && fs.existsSync(path.join(packageDir, current.fileName))) {
    removeSupersededArchives(packageDir, current.fileName, Date.now());
    return { id: current.id, filePath: path.join(packageDir, current.fileName) };
  }
  ensureHubDir(ctx.dir);
  const packed = packFiles(files);
  const fileName = `${packed.id}${archiveSuffix}`;
  const filePath = path.join(packageDir, fileName);
  fs.mkdirSync(packageDir, { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}${temporarySuffix}`;
  fs.writeFileSync(temporaryPath, packed.gzip, { mode: cacheFileMode });
  fs.renameSync(temporaryPath, filePath);
  writeJsonFileAtomically(path.join(packageDir, currentFileName), { stamp, id: packed.id, fileName }, cacheFileMode);
  removeSupersededArchives(packageDir, fileName, Date.now());
  return { id: packed.id, filePath };
}

/** Remove archives (and temp files of a packer that died) that are not `currentFileName` and have not been touched for the grace period. */
function removeSupersededArchives(packageDir: string, currentFileName: string, nowMs: number): void {
  for (const name of fs.readdirSync(packageDir)) {
    const isArchive = name.endsWith(archiveSuffix) && name !== currentFileName;
    if (!isArchive && !name.endsWith(temporarySuffix)) continue;
    const filePath = path.join(packageDir, name);
    try {
      if (nowMs - fs.statSync(filePath).mtimeMs > supersededArchiveGraceMs) fs.rmSync(filePath, { force: true });
    } catch {
      // Already gone: another gate swept it.
    }
  }
}

export interface OpenedHubPackage {
  id: string;
  /** The archive, open for reading; the caller closes it (a read stream made from it does). */
  handle: fsp.FileHandle;
}

/** @description The current package, opened. Retries when a file vanishes between the lookup and the open (a sweep, a packer of a newer source). */
export async function openHubPackage(ctx: HubContext): Promise<OpenedHubPackage> {
  for (let attempt = 1; ; attempt += 1) {
    const hubPackage = getHubPackage(ctx);
    try {
      return { id: hubPackage.id, handle: await fsp.open(hubPackage.filePath, 'r') };
    } catch (error) {
      if (getCaughtErrnoCode(error) !== 'ENOENT' || attempt >= maxOpenAttempts) throw error;
    }
  }
}
