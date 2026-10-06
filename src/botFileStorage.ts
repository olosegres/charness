/**
 * @description Disk layout + lifecycle for bot-owned per-thread file intake.
 *
 * Files sent to a topic are downloaded into `DATA_DIR/files/<chatId>_<threadId>/`
 * — bot-owned, deliberately OUTSIDE the bound project folder so user code dirs
 * stay clean. Two cleanup mechanisms keep the tree bounded:
 *
 *   1. {@link purgeThreadFiles} — called when a bare `/clear` is forwarded to
 *      the agent (its context is wiped, so referenced files are useless).
 *   2. {@link sweepExpiredThreadFiles} — a logrotate-style age sweep run at
 *      boot and once a day: files older than the retention window are removed
 *      and now-empty dirs pruned — a connector's own folders inside a thread
 *      dir (the Jira connector's `jira/`) are swept the same way.
 *
 * The path helpers and the sweep are pure / injectable (`now` is a parameter)
 * so they can be unit-tested against a temp dir without a clock or a bot.
 */

import { promises as fsp, type Dirent } from 'fs';
import * as path from 'path';
import { keyToSlug, type SessionKey } from './sessionKey';

/** Subdirectory of `DATA_DIR` that holds every thread's intake folder. */
export const filesRootDirName = 'files';

/** Retention window for the age sweep: files older than this are deleted. */
export const fileRetentionDays = 30;

/** Same window in ms — the injectable sweep takes a `retentionMs`. */
export const fileRetentionMs = fileRetentionDays * 24 * 60 * 60 * 1000;

/** How often the boot-armed sweep timer fires (once a day). */
export const fileSweepIntervalMs = 24 * 60 * 60 * 1000;

/**
 * @description Separator standing in for the serialized key's `:` inside a
 * directory name — `:` is illegal on some filesystems.
 */
const threadDirSeparator = '_';

/**
 * @description The per-thread intake dir name — `<chatId>_<threadId>`. The
 * components are internal ids (not user input), but we still join via
 * `path.join` so the result can never escape `filesRoot`.
 */
function threadDirName(key: SessionKey): string {
  return keyToSlug(key, threadDirSeparator);
}

/** Absolute path of the `files/` root under a given data dir. */
export function resolveFilesRoot(dataDir: string): string {
  return path.join(dataDir, filesRootDirName);
}

/** Absolute path of one thread's intake dir under a given data dir. */
export function resolveThreadFilesDir(dataDir: string, key: SessionKey): string {
  return path.join(resolveFilesRoot(dataDir), threadDirName(key));
}

/**
 * @description Ensure a thread's intake dir exists and return its path.
 * Created `0700` — these files can carry private user content and the dir is
 * bot-owned, so it should not be world-readable on a shared host.
 */
export async function ensureThreadFilesDir(dataDir: string, key: SessionKey): Promise<string> {
  const dir = resolveThreadFilesDir(dataDir, key);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * @description Delete a thread's intake dir and everything in it. Used by the
 * forwarded `/clear` path. No-op (and no throw) when the dir doesn't exist —
 * a thread that never received a file has nothing to purge.
 */
export async function purgeThreadFiles(dataDir: string, key: SessionKey): Promise<void> {
  const dir = resolveThreadFilesDir(dataDir, key);
  await fsp.rm(dir, { recursive: true, force: true });
}

/** Outcome of one sweep pass — handy for logging and assertions. */
export interface SweepResult {
  /** Number of files unlinked because they were older than the retention window, in any nested folder. */
  removedFiles: number;
  /** Number of dirs removed because they ended up empty: thread dirs and the folders nested in them. */
  removedDirs: number;
}

/**
 * Sweep one dir and the folders nested in it (a connector keeps its own files in a subfolder of the thread
 * dir): unlink what is older than `cutoff`, remove each dir left empty. Resolves how many entries remain —
 * a fresh file, a folder that still holds something, a symlink (never followed) or an entry that could not be
 * processed — so the caller knows whether its own dir may go.
 */
async function sweepDirectory(dir: string, cutoff: number, result: SweepResult): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    console.warn(`[fileSweep] cannot read dir ${dir}:`, e);
    return 1;
  }
  let remaining = 0;
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (await sweepDirectory(entryPath, cutoff, result) === 0) {
        try {
          await fsp.rmdir(entryPath);
          result.removedDirs += 1;
        } catch (e) {
          console.warn(`[fileSweep] cannot remove empty dir ${entryPath}:`, e);
          remaining += 1;
        }
      } else {
        remaining += 1;
      }
    } else if (entry.isFile()) {
      try {
        const stat = await fsp.stat(entryPath);
        if (stat.mtimeMs < cutoff) {
          await fsp.unlink(entryPath);
          result.removedFiles += 1;
        } else {
          remaining += 1;
        }
      } catch (e) {
        // Couldn't stat/unlink — leave it and treat as remaining so the dir
        // isn't pruned out from under a file we failed to remove.
        console.warn(`[fileSweep] cannot process ${entryPath}:`, e);
        remaining += 1;
      }
    } else {
      remaining += 1;
    }
  }
  return remaining;
}

/**
 * @description Age-sweep the `files/` tree under `filesRoot`. Walks every
 * thread dir and the folders nested in it, unlinks files whose mtime is older
 * than `retentionMs` relative to `now`, then removes any dir left empty. `now`
 * is injected so the sweep is deterministic in tests.
 *
 * Robust to a missing root (returns zeroes) and to per-entry errors (logged,
 * skipped) so one unreadable file can't abort the whole sweep.
 */
export async function sweepExpiredThreadFiles(
  filesRoot: string,
  retentionMs: number,
  now: number,
): Promise<SweepResult> {
  const result: SweepResult = { removedFiles: 0, removedDirs: 0 };

  let threadDirs: string[];
  try {
    const entries = await fsp.readdir(filesRoot, { withFileTypes: true });
    threadDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (e) {
    // Missing root (no files ever received) is the common case — not an error.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[fileSweep] cannot read files root ${filesRoot}:`, e);
    }
    return result;
  }

  const cutoff = now - retentionMs;

  for (const dirName of threadDirs) {
    const dir = path.join(filesRoot, dirName);
    if (await sweepDirectory(dir, cutoff, result) === 0) {
      try {
        await fsp.rmdir(dir);
        result.removedDirs += 1;
      } catch (e) {
        console.warn(`[fileSweep] cannot remove empty dir ${dir}:`, e);
      }
    }
  }

  return result;
}
