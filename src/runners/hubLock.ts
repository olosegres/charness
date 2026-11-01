import * as fs from 'fs';
import { acquireHostLock, createDefaultHostLockDeps } from '../selfUpdate/hostLock';
import { getHubFilePaths } from './hubPaths';

/**
 * @description The ONE lock of the runner registry: the gate processes sshd starts (a redeem, an unpair), the bot and the CLI all change
 * `paired.json`, `pending.json`, `known_hosts` and the managed `authorized_keys` block, and a change reads what the others wrote
 * first. The lock is the updater's host lock (a file created exclusively that names its holder's pid; taken over when that process is
 * gone), waited for with a short poll — a critical section is a few file writes.
 */

const lockPollMs = 25;
const lockWaitLimitMs = 15 * 1000;
const registryDirMode = 0o700;

/** @description Make the registry folder (0700) if it is missing. */
export function ensureHubDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: registryDirMode });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** @description Run `action` while holding the registry lock; waits up to 15 s for it, then throws. */
export async function withHubLock<TResult>(dir: string, action: () => TResult | Promise<TResult>): Promise<TResult> {
  ensureHubDir(dir);
  const lockPath = getHubFilePaths(dir).lock;
  const deps = createDefaultHostLockDeps();
  const deadline = Date.now() + lockWaitLimitMs;
  for (;;) {
    const lock = acquireHostLock(lockPath, deps);
    if (lock !== null) {
      try {
        return await action();
      } finally {
        lock.release();
      }
    }
    if (Date.now() >= deadline) throw new Error('the runner registry is locked by another process (waited 15 s)');
    await sleep(lockPollMs);
  }
}
