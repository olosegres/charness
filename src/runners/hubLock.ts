import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

/**
 * @description The ONE lock of the runner registry: the gate processes sshd starts (a redeem, an unpair), the bot and the CLI all change
 * `paired.json`, `pending.json`, `known_hosts` and the managed `authorized_keys` block, and a change reads what the others wrote first.
 *
 * A lock that is taken over by DELETING a dead holder's file cannot be made safe: two processes that judged the same holder dead can
 * each delete «the» file, the second one deleting the lock the first has just taken. So nothing here is ever deleted on someone else's
 * word. The lock is a numbered file, `lock.<n>`, and the holder is whoever created the HIGHEST number:
 *
 *   - to take the lock, create `lock.<top + 1>` exclusively (a hard link of a finished temp file, so it never shows half written;
 *     `link` fails with EEXIST like `O_EXCL`) — of any number of contenders exactly one creates a given number, which is the whole
 *     arbitration, also when they all found the same dead holder;
 *   - the top file is free when its holder released it (the record says so), is dead (its pid is gone) or has held for over
 *     {@link holderStaleAfterMs}; otherwise the contender waits;
 *   - after creating its file the contender lists the folder again: if a higher number exists, its judgement was out of date (it saw
 *     an old listing) — it removes its own file and starts over;
 *   - a released lock stays as a marker (the next number is made after it, so numbers never repeat while a stale observer could still
 *     be acting on them); the new holder removes the lower files.
 */

const lockFilePattern = /^lock\.(\d+)$/;
const lockFilePrefix = 'lock.';
const lockTempPrefix = 'lock-temp.';
const lockPollMs = 25;
const lockWaitLimitMs = 15 * 1000;
/** A holder that has held this long is taken to be hung (a critical section is a few file writes). */
export const holderStaleAfterMs = 30 * 1000;
const registryDirMode = 0o700;
const tokenBytes = 8;

const lockRecordSchema = z.strictObject({
  pid: z.number().int().positive(),
  /** Tells this holder's file from another's with the same number. */
  token: z.string(),
  startedAtMs: z.number(),
  /** Set when the holder gives the lock back; the file then stays as the marker of the number. */
  releasedAtMs: z.number().nullable(),
});

type LockRecord = z.infer<typeof lockRecordSchema>;

interface HeldLock {
  release: () => void;
}

/** @description Make the registry folder (0700) if it is missing. */
export function ensureHubDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: registryDirMode });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function getLockFilePath(dir: string, generation: number): string {
  return path.join(dir, `${lockFilePrefix}${generation}`);
}

function listGenerations(dir: string): number[] {
  return fs.readdirSync(dir)
    .flatMap((name) => {
      const match = lockFilePattern.exec(name);
      return match === null ? [] : [Number(match[1])];
    })
    .sort((left, right) => left - right);
}

function readRecord(filePath: string): LockRecord | null {
  try {
    const parsed = lockRecordSchema.safeParse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function checkIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but is another account's.
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

/** A record that does not read counts as a dead holder: a file nobody finished writing is never left by a live one (it is linked whole). */
function checkIsHeld(record: LockRecord | null, nowMs: number): boolean {
  return record !== null && record.releasedAtMs === null && checkIsProcessAlive(record.pid) && nowMs - record.startedAtMs <= holderStaleAfterMs;
}

function writeTempRecord(dir: string, record: LockRecord): string {
  const temporaryPath = path.join(dir, `${lockTempPrefix}${process.pid}.${randomBytes(tokenBytes).toString('hex')}`);
  fs.writeFileSync(temporaryPath, JSON.stringify(record));
  return temporaryPath;
}

/** Create `lock.<generation>` holding `record`, whole, only if no such file exists. */
function createGenerationFile(dir: string, generation: number, record: LockRecord): boolean {
  const temporaryPath = writeTempRecord(dir, record);
  try {
    fs.linkSync(temporaryPath, getLockFilePath(dir, generation));
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return false;
    throw error;
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function removeGenerationFileIfOwned(dir: string, generation: number, token: string): void {
  const filePath = getLockFilePath(dir, generation);
  if (readRecord(filePath)?.token === token) fs.rmSync(filePath, { force: true });
}

function createRelease(dir: string, generation: number, record: LockRecord): () => void {
  return () => {
    const filePath = getLockFilePath(dir, generation);
    if (readRecord(filePath)?.token !== record.token) return;
    const temporaryPath = writeTempRecord(dir, { ...record, releasedAtMs: Date.now() });
    fs.renameSync(temporaryPath, filePath);
  };
}

/** A process killed between writing its temp file and linking it leaves the temp file behind. */
function removeAbandonedTempFiles(dir: string, nowMs: number): void {
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(lockTempPrefix)) continue;
    const filePath = path.join(dir, name);
    try {
      if (nowMs - fs.statSync(filePath).mtimeMs > holderStaleAfterMs) fs.rmSync(filePath, { force: true });
    } catch {
      // Gone already: another contender swept it.
    }
  }
}

/** Try once. `null`: somebody holds the lock, or this attempt lost a race — the caller waits and tries again. */
function tryAcquire(dir: string, nowMs: number): HeldLock | null {
  const generations = listGenerations(dir);
  const top = generations.at(-1) ?? 0;
  if (top > 0 && checkIsHeld(readRecord(getLockFilePath(dir, top)), nowMs)) return null;
  const generation = top + 1;
  const record: LockRecord = { pid: process.pid, token: randomBytes(tokenBytes).toString('hex'), startedAtMs: nowMs, releasedAtMs: null };
  if (!createGenerationFile(dir, generation, record)) return null;
  const after = listGenerations(dir);
  if (after.some((other) => other > generation)) {
    removeGenerationFileIfOwned(dir, generation, record.token);
    return null;
  }
  for (const lower of after.filter((other) => other < generation)) fs.rmSync(getLockFilePath(dir, lower), { force: true });
  removeAbandonedTempFiles(dir, nowMs);
  return { release: createRelease(dir, generation, record) };
}

/** @description Run `action` while holding the registry lock; waits up to 15 s for it, then throws. */
export async function withHubLock<TResult>(dir: string, action: () => TResult | Promise<TResult>): Promise<TResult> {
  ensureHubDir(dir);
  const deadline = Date.now() + lockWaitLimitMs;
  for (;;) {
    const lock = tryAcquire(dir, Date.now());
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
