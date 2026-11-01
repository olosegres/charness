import { spawnSync } from 'child_process';
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
 *   - the top file is free when its holder released it (the record says so) or is dead (its pid is gone, or belongs to a process that
 *     started at another time — pid reuse); otherwise the contender waits. A holder that is ALIVE is never overtaken, however long it
 *     has held: a process that is suspended inside its critical section (a stopped job, a laptop asleep) resumes where it was, and
 *     overtaking it would let both write the registry. A holder that hangs for good blocks the registry loudly (the waiting caller
 *     fails after 15 s naming the lock) instead of silently risking two writers;
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
/** A temp file of a process that died between writing it and linking it is swept after this long. */
const abandonedTempAgeMs = 60 * 1000;
const registryDirMode = 0o700;
const tokenBytes = 8;

const lockRecordSchema = z.strictObject({
  pid: z.number().int().positive(),
  /** Tells this holder's file from another's with the same number. */
  token: z.string(),
  startedAtMs: z.number(),
  /** Identifies the holder's process beyond its pid (its start time), so a reused pid is not taken for the holder; `null` where it cannot be read. */
  startKey: z.string().nullable(),
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

/** @description What tells one process from another that has the same pid: the start time (`/proc` on Linux, `ps` elsewhere), or `null`. */
export function getProcessStartKey(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Field 22 counts from the state field that follows the command name's closing parenthesis.
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    const listing = spawnSync('ps', ['-p', pid.toString(), '-o', 'lstart='], { encoding: 'utf8', timeout: 5000 });
    return listing.status === 0 && listing.stdout.trim() !== '' ? listing.stdout.trim() : null;
  }
}

function checkIsProcessAlive(record: LockRecord): boolean {
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    // EPERM: the process exists but is another account's.
    if (!(error instanceof Error && 'code' in error && error.code === 'EPERM')) return false;
  }
  if (record.startKey === null) return true;
  const currentKey = getProcessStartKey(record.pid);
  return currentKey === null || currentKey === record.startKey;
}

/** A record that does not read counts as a dead holder: a file nobody finished writing is never left by a live one (it is linked whole). */
function checkIsHeld(record: LockRecord | null): boolean {
  return record !== null && record.releasedAtMs === null && checkIsProcessAlive(record);
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
      if (nowMs - fs.statSync(filePath).mtimeMs > abandonedTempAgeMs) fs.rmSync(filePath, { force: true });
    } catch {
      // Gone already: another contender swept it.
    }
  }
}

/** Try once. `null`: somebody holds the lock, or this attempt lost a race — the caller waits and tries again. */
function tryAcquire(dir: string, nowMs: number): HeldLock | null {
  const generations = listGenerations(dir);
  const top = generations.at(-1) ?? 0;
  if (top > 0 && checkIsHeld(readRecord(getLockFilePath(dir, top)))) return null;
  const generation = top + 1;
  const record: LockRecord = { pid: process.pid, token: randomBytes(tokenBytes).toString('hex'), startedAtMs: nowMs, startKey: getProcessStartKey(process.pid), releasedAtMs: null };
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
