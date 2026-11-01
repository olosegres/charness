import * as fs from 'fs';
import { hostLockStaleMs } from './constants';

/**
 * A host-wide lock for an npm install that several instances may share: one of them installs, the others find the
 * new version on disk and restart onto it. The file holds the owner's pid and start time; it is taken over when that
 * pid is gone, or when it is older than {@link hostLockStaleMs} (an install that hung).
 */

interface LockRecord {
  pid: number;
  startedAt: number;
}

export interface HostLockDeps {
  now: () => number;
  /** Whether a process with this pid exists (`kill(pid, 0)`). */
  checkIsProcessAlive: (pid: number) => boolean;
  pid: number;
}

export interface HostLock {
  release: () => void;
}

function getErrorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

export function createDefaultHostLockDeps(): HostLockDeps {
  return {
    now: () => Date.now(),
    pid: process.pid,
    checkIsProcessAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        // EPERM: it exists but is another user's.
        return getErrorCode(error) === 'EPERM';
      }
    },
  };
}

function readLockRecord(lockPath: string): LockRecord | null {
  try {
    const record: LockRecord = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return Number.isInteger(record.pid) && Number.isFinite(record.startedAt) ? record : null;
  } catch {
    return null;
  }
}

function checkIsLockStale(record: LockRecord | null, deps: HostLockDeps): boolean {
  if (record === null) return true;
  return !deps.checkIsProcessAlive(record.pid) || deps.now() - record.startedAt > hostLockStaleMs;
}

/**
 * @description Take the lock at `lockPath`, or `null` when another live process holds it. A stale or unreadable lock
 * is taken over; the file is created exclusively, so two takers can never both win.
 */
export function acquireHostLock(lockPath: string, deps: HostLockDeps = createDefaultHostLockDeps()): HostLock | null {
  const record: LockRecord = { pid: deps.pid, startedAt: deps.now() };
  const maxAttempts = 2;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify(record), { flag: 'wx' });
      return {
        release: () => {
          // Only the owner's own file: a lock taken over meanwhile is not ours to remove.
          if (readLockRecord(lockPath)?.pid === deps.pid) fs.rmSync(lockPath, { force: true });
        },
      };
    } catch (error) {
      if (getErrorCode(error) !== 'EEXIST') throw error;
      if (!checkIsLockStale(readLockRecord(lockPath), deps)) return null;
      fs.rmSync(lockPath, { force: true });
    }
  }
  return null;
}
