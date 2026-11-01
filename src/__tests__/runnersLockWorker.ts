/**
 * Child process of `runnersLock.test.ts` (not a test): contends for the registry lock with other processes and checks, with a marker
 * file that only the holder may create, that no two of them are ever inside a critical section together.
 *
 *   node --import tsx runnersLockWorker.ts contend <registryDir> <sharedDir> <workerIndex> <iterations>
 *   node --import tsx runnersLockWorker.ts die-holding <registryDir> <sharedDir>
 *   node --import tsx runnersLockWorker.ts hold-stopped <registryDir> <sharedDir>
 *
 * `contend` signals `ready.<index>` in <sharedDir>, waits for the file `go`, then enters the section <iterations> times. A section
 * takes the marker `inside` (exclusively; an existing one is a violation, appended to `violations.log`), adds one to `counter`
 * (read, wait a moment, write — a lost update shows as a smaller total) and gives the marker back.
 */

import fs from 'fs';
import path from 'path';
import { withHubLock } from '../runners/hubLock';

const [mode, registryDir, sharedDir, indexText, iterationsText] = process.argv.slice(2);
const waitMs = 2;
const pollMs = 5;

function pause(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function enterSection(): void {
  const insidePath = path.join(sharedDir, 'inside');
  try {
    fs.writeFileSync(insidePath, process.pid.toString(), { flag: 'wx' });
  } catch {
    fs.appendFileSync(path.join(sharedDir, 'violations.log'), `${process.pid} entered while ${fs.readFileSync(insidePath, 'utf8')} was inside\n`);
  }
  const counterPath = path.join(sharedDir, 'counter');
  const before = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) : 0;
  pause(waitMs);
  fs.writeFileSync(counterPath, (before + 1).toString());
  fs.rmSync(insidePath, { force: true });
}

async function main(): Promise<void> {
  if (mode === 'die-holding') {
    await withHubLock(registryDir, () => {
      fs.writeFileSync(path.join(sharedDir, 'holding'), '');
      process.kill(process.pid, 'SIGKILL');
    });
    return;
  }
  if (mode === 'hold-stopped') {
    // Takes the lock, enters the section, and suspends ITSELF inside it (a stopped job, a sleeping laptop); finishes the section when continued.
    await withHubLock(registryDir, () => {
      const insidePath = path.join(sharedDir, 'inside');
      fs.writeFileSync(insidePath, process.pid.toString(), { flag: 'wx' });
      fs.writeFileSync(path.join(sharedDir, 'holding'), '');
      process.kill(process.pid, 'SIGSTOP');
      fs.writeFileSync(path.join(sharedDir, 'resumed'), '');
      const counterPath = path.join(sharedDir, 'counter');
      fs.writeFileSync(counterPath, (Number(fs.existsSync(counterPath) ? fs.readFileSync(counterPath, 'utf8') : 0) + 1).toString());
      fs.rmSync(insidePath, { force: true });
    });
    return;
  }
  fs.writeFileSync(path.join(sharedDir, `ready.${indexText}`), '');
  while (!fs.existsSync(path.join(sharedDir, 'go'))) pause(pollMs);
  for (let iteration = 0; iteration < Number(iterationsText); iteration += 1) await withHubLock(registryDir, enterSection);
}

main().catch((error) => {
  process.stderr.write(`worker failed: ${error instanceof Error ? error.message : 'unknown'}\n`);
  process.exit(1);
});
