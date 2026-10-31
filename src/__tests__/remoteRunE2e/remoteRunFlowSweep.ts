/**
 * @description Ending everything a runner-flow layout started, by the layout's folder: the one definition shared by the test's own
 * teardown, the detached reaper and the reap of dead layouts at the next start. A process belongs to the layout when its command line
 * names the folder (sshd, Pueue's daemon, the runner script, an ssh client or master) or when its working directory is inside it (the
 * CLI children, which run in a project of the layout, and every decoy a job started in the runner's copy). Found by `ps` and `/proc`
 * and ended by pid — never by name.
 *
 * A SIGKILL of the test's process group runs no `exit` handler at all, and the daemons are sessions of their own: the owner file
 * (`owner.json`: the test process's pid and start time) is what lets a detached reaper, or the next run, tell a layout whose owner is
 * gone from one that is in use.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getProcessStartTicks } from '../e2e/isolatedCharness';

export const flowLayoutPrefix = '/tmp/crr-';
export const flowOwnerFileName = 'owner.json';
/** A folder without an owner file is only a layout in the instant between its creation and its owner file: older than this, it is a leftover. */
export const ownerlessLayoutGraceMs = 60 * 1000;
const psDeadlineMs = 10_000;

export interface FlowLayoutOwner {
  pid: number;
  startTicks: number | null;
}

export function writeFlowLayoutOwner(root: string): void {
  const owner: FlowLayoutOwner = { pid: process.pid, startTicks: getProcessStartTicks(process.pid) };
  fs.writeFileSync(path.join(root, flowOwnerFileName), JSON.stringify(owner));
}

export function readFlowLayoutOwner(root: string): FlowLayoutOwner | null {
  try {
    const owner: FlowLayoutOwner = JSON.parse(fs.readFileSync(path.join(root, flowOwnerFileName), 'utf8'));
    return Number.isInteger(owner.pid) ? owner : null;
  } catch {
    return null;
  }
}

/** The same process, not another one under a reused pid. */
export function checkIsFlowLayoutOwnerAlive(owner: FlowLayoutOwner): boolean {
  const startTicks = getProcessStartTicks(owner.pid);
  if (startTicks === null) return false;
  return owner.startTicks === null || owner.startTicks === startTicks;
}

export interface LayoutProcess {
  pid: number;
  args: string;
}

function readCwd(pid: number): string {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return '';
  }
}

/** @description The processes of this user that belong to the layout at `root` (see the module comment); never the caller's own. */
export function listLayoutProcesses(root: string): LayoutProcess[] {
  const listing = spawnSync('ps', ['-u', `${os.userInfo().uid}`, '-o', 'pid=,args='], { encoding: 'utf8', timeout: psDeadlineMs }).stdout ?? '';
  const found: LayoutProcess[] = [];
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    if (pid === process.pid) continue;
    const cwd = readCwd(pid);
    if (match[2].includes(root) || cwd === root || cwd.startsWith(`${root}/`)) found.push({ pid, args: match[2] });
  }
  return found;
}

/** @description SIGKILL every process of the layout, then remove its folder. Safe to call twice and on a half-built layout. */
export function sweepFlowLayout(root: string, options: { removeFiles?: boolean } = {}): void {
  // A few rounds: a killed supervisor (Pueue's daemon, a job script) can have started one more child.
  for (let round = 0; round < 3; round += 1) {
    const processes = listLayoutProcesses(root);
    if (processes.length === 0) break;
    for (const { pid } of processes) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
  if (options.removeFiles !== false) fs.rmSync(root, { recursive: true, force: true });
}

/**
 * @description Sweep every layout of an earlier run whose owner is gone; returns the folders reaped. `parentDirectory` and `prefix`
 * are the layouts' home (injectable for the test).
 */
export function reapDeadFlowLayouts(parentDirectory: string = path.dirname(flowLayoutPrefix), prefix: string = path.basename(flowLayoutPrefix)): string[] {
  const reaped: string[] = [];
  for (const entry of fs.readdirSync(parentDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const root = path.join(parentDirectory, entry.name);
    const owner = readFlowLayoutOwner(root);
    if (owner !== null && checkIsFlowLayoutOwnerAlive(owner)) continue;
    if (owner === null && Date.now() - fs.statSync(root).mtimeMs < ownerlessLayoutGraceMs) continue;
    sweepFlowLayout(root);
    reaped.push(root);
  }
  return reaped;
}
