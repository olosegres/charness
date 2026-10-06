import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'fs';
import * as fs from 'fs';
import * as path from 'path';
import type { SessionKey } from '../sessionKey';
import {
  resolveThreadFilesDir,
  resolveFilesRoot,
  ensureThreadFilesDir,
  purgeThreadFiles,
  sweepExpiredThreadFiles,
  fileRetentionMs,
} from '../botFileStorage';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';

// Temp dirs live under the project-local ./agent/tmp (never /tmp — no access).
const tmpBase = path.join(process.cwd(), 'agent', 'tmp', 'botFileStorage-test');

const key: SessionKey = makeTelegramKey(-100123, 4242);

async function makeDataDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(tmpBase, 'data-'));
  return dir;
}

/** Write a file then backdate its mtime by `ageMs` relative to `now`. */
async function writeAgedFile(dir: string, name: string, now: number, ageMs: number): Promise<string> {
  const filePath = path.join(dir, name);
  await fsp.writeFile(filePath, 'x');
  const mtime = new Date(now - ageMs);
  await fsp.utimes(filePath, mtime, mtime);
  return filePath;
}

describe('botFileStorage', () => {
  before(async () => {
    await fsp.mkdir(tmpBase, { recursive: true });
  });
  after(async () => {
    await fsp.rm(tmpBase, { recursive: true, force: true });
  });

  it('resolveThreadFilesDir is under <dataDir>/files and never contains a colon', () => {
    const dir = resolveThreadFilesDir('/data', key);
    assert.equal(dir, path.join('/data', 'files', '-100123_4242'));
    assert.ok(!dir.includes(':'));
  });

  it('ensureThreadFilesDir creates the dir', async () => {
    const dataDir = await makeDataDir();
    const dir = await ensureThreadFilesDir(dataDir, key);
    assert.ok(fs.existsSync(dir));
    assert.equal(dir, resolveThreadFilesDir(dataDir, key));
  });

  it('purgeThreadFiles removes the thread dir and all contents', async () => {
    const dataDir = await makeDataDir();
    const dir = await ensureThreadFilesDir(dataDir, key);
    await fsp.writeFile(path.join(dir, 'a.txt'), '1');
    await fsp.writeFile(path.join(dir, 'b.txt'), '2');
    assert.ok(fs.existsSync(dir));

    await purgeThreadFiles(dataDir, key);
    assert.ok(!fs.existsSync(dir), 'thread dir should be gone after purge');
  });

  it('purgeThreadFiles is a no-op when the dir never existed', async () => {
    const dataDir = await makeDataDir();
    // Must not throw.
    await purgeThreadFiles(dataDir, key);
    assert.ok(!fs.existsSync(resolveThreadFilesDir(dataDir, key)));
  });

  it('sweep deletes old files, keeps fresh ones, removes the now-empty dir', async () => {
    const dataDir = await makeDataDir();
    const now = Date.now();

    // Thread A: only old files → dir should be removed.
    const dirA = await ensureThreadFilesDir(dataDir, makeTelegramKey(-1, 1));
    await writeAgedFile(dirA, 'old1.bin', now, fileRetentionMs + 60_000);
    await writeAgedFile(dirA, 'old2.bin', now, fileRetentionMs * 2);

    // Thread B: one old, one fresh → old removed, dir KEPT.
    const dirB = await ensureThreadFilesDir(dataDir, makeTelegramKey(-1, 2));
    const oldB = await writeAgedFile(dirB, 'old.bin', now, fileRetentionMs + 1_000);
    const freshB = await writeAgedFile(dirB, 'fresh.bin', now, 60_000);

    const result = await sweepExpiredThreadFiles(resolveFilesRoot(dataDir), fileRetentionMs, now);

    assert.equal(result.removedFiles, 3, 'three aged files removed');
    assert.equal(result.removedDirs, 1, 'one empty dir removed');
    assert.ok(!fs.existsSync(dirA), 'all-old thread dir removed');
    assert.ok(fs.existsSync(dirB), 'mixed thread dir kept');
    assert.ok(!fs.existsSync(oldB), 'old file in mixed dir removed');
    assert.ok(fs.existsSync(freshB), 'fresh file kept');
  });

  it('sweep keeps a file exactly at the retention boundary', async () => {
    const dataDir = await makeDataDir();
    // Whole-second `now` so `utimes` (second-granularity on some FSes) can't
    // shift the mtime under the cutoff and turn an equal into a `<`.
    const now = Math.floor(Date.now() / 1000) * 1000;
    const dir = await ensureThreadFilesDir(dataDir, makeTelegramKey(-1, 3));
    // mtime == cutoff → NOT older-than (strict <), so kept.
    const atBoundary = await writeAgedFile(dir, 'edge.bin', now, fileRetentionMs);

    const result = await sweepExpiredThreadFiles(resolveFilesRoot(dataDir), fileRetentionMs, now);
    assert.equal(result.removedFiles, 0);
    assert.ok(fs.existsSync(atBoundary), 'file exactly at cutoff is kept');
  });

  it('sweep reaches the folders nested in a thread dir: old files go, emptied folders and the thread dir are pruned', async () => {
    const dataDir = await makeDataDir();
    const now = Date.now();
    const dir = await ensureThreadFilesDir(dataDir, makeTelegramKey(-1, 5));
    const nestedDir = path.join(dir, 'tracker', 'text');
    await fsp.mkdir(nestedDir, { recursive: true });
    await writeAgedFile(nestedDir, 'old-spill.txt', now, fileRetentionMs + 60_000);
    await writeAgedFile(path.join(dir, 'tracker'), 'old-download.bin', now, fileRetentionMs * 2);

    const result = await sweepExpiredThreadFiles(resolveFilesRoot(dataDir), fileRetentionMs, now);

    assert.equal(result.removedFiles, 2);
    assert.equal(result.removedDirs, 3, 'the text folder, its parent and the thread dir');
    assert.ok(!fs.existsSync(dir), 'nothing left, so the thread dir went');
  });

  it('sweep keeps every folder above a fresh nested file, and removes only the old ones beside it', async () => {
    const dataDir = await makeDataDir();
    const now = Date.now();
    const dir = await ensureThreadFilesDir(dataDir, makeTelegramKey(-1, 6));
    const nestedDir = path.join(dir, 'tracker', 'text');
    await fsp.mkdir(nestedDir, { recursive: true });
    const old = await writeAgedFile(nestedDir, 'old.txt', now, fileRetentionMs + 1_000);
    const fresh = await writeAgedFile(nestedDir, 'fresh.txt', now, 60_000);

    const result = await sweepExpiredThreadFiles(resolveFilesRoot(dataDir), fileRetentionMs, now);

    assert.deepEqual(result, { removedFiles: 1, removedDirs: 0 });
    assert.ok(!fs.existsSync(old) && fs.existsSync(fresh) && fs.existsSync(nestedDir));
  });

  it('sweep does not follow a symlink out of the files tree, and keeps it', async () => {
    const dataDir = await makeDataDir();
    const now = Date.now();
    const outside = await makeDataDir();
    const outsideFile = await writeAgedFile(outside, 'not-ours.txt', now, fileRetentionMs * 3);
    const dir = await ensureThreadFilesDir(dataDir, makeTelegramKey(-1, 7));
    const link = path.join(dir, 'link-out');
    await fsp.symlink(outside, link);

    const result = await sweepExpiredThreadFiles(resolveFilesRoot(dataDir), fileRetentionMs, now);

    assert.deepEqual(result, { removedFiles: 0, removedDirs: 0 });
    assert.ok(fs.existsSync(outsideFile), 'what the link points at was not touched');
    assert.ok(fs.existsSync(link) && fs.existsSync(dir), 'the link and its thread dir stay');
  });

  it('sweep on a missing files root returns zeroes and does not throw', async () => {
    const dataDir = await makeDataDir();
    const result = await sweepExpiredThreadFiles(resolveFilesRoot(dataDir), fileRetentionMs, Date.now());
    assert.deepEqual(result, { removedFiles: 0, removedDirs: 0 });
  });

  it('sweep on an empty thread dir removes it', async () => {
    const dataDir = await makeDataDir();
    const dir = await ensureThreadFilesDir(dataDir, makeTelegramKey(-1, 4));
    const result = await sweepExpiredThreadFiles(resolveFilesRoot(dataDir), fileRetentionMs, Date.now());
    assert.equal(result.removedDirs, 1);
    assert.ok(!fs.existsSync(dir));
  });
});
