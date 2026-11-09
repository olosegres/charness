/**
 * @description What the disk-upkeep cases of `remoteRun/runner.sh` share (`remoteRunRunnerScriptDisk.test.ts`, `remoteRunRunnerScriptDiskCopies.test.ts`: one file ran 80–90 s alone and a loaded box cut it at the 2-minute cap of a unit
 * file): the fake disk (`df`, `du`, `rm` on the PATH reading a `fake-kb` file in each copy, so a removal really frees "space" and everything else is real), the per-test work root, and the helpers that make copies and jobs and run the script.
 * Matches no test glob.
 */

import { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { scriptPath, stopRunnerStandIns, writeFile, stopDetachedRuns } from './remoteRunRunnerScriptKit';

export const kibPerGib = 1024 * 1024;
export const dayMs = 24 * 60 * 60 * 1000;
export const hourMs = 60 * 60 * 1000;
export const fakeDiskGib = 100;

export let workRoot = '';
export let workDir = '';
export let fakeBinDir = '';

/** `df -Pk` of a disk whose used space is the sum of the `fake-kb` files of the copies (and of copies being removed); `du -sk` of a copy is its `fake-kb`. */
export const fakeDf = `#!/bin/bash
used=0
for marker in "$FAKE_WORK"/p/*/fake-kb "$FAKE_WORK"/p/.trash-*/fake-kb; do
  [ -f "$marker" ] && used=$((used + $(cat "$marker")))
done
total=$FAKE_DISK_TOTAL_KB
free=$((total - used))
# FAKE_DF_FREE_KB: a disk whose free figure does not follow removals (APFS keeps the space of deleted files while local snapshots hold it).
[ -n "\${FAKE_DF_FREE_KB:-}" ] && free=$FAKE_DF_FREE_KB
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/fake %s %s %s 1%% /\\n' "$total" "$used" "$free"
`;
export const fakeDu = `#!/bin/bash
target=\${@: -1}
[ -n "\${FAKE_DU_LOG:-}" ] && echo "$target" >> "$FAKE_DU_LOG"
if [ -f "$target/fake-kb" ]; then printf '%s\\t%s\\n' "$(cat "$target/fake-kb")" "$target"; else exec /usr/bin/du "$@"; fi
`;
export const fakePueue = '#!/bin/sh\nexit 0\n';
/** `rm` that takes its time when FAKE_RM_DELAY says so: a removal of tens of GB lasts minutes, and the caller may hang up meanwhile. */
export const fakeRm = `#!/bin/bash
[ -n "\${FAKE_RM_DELAY:-}" ] && sleep "$FAKE_RM_DELAY"
exec /bin/rm "$@"
`;

export function writeExecutable(file: string, content: string): void {
  fs.writeFileSync(file, content, { mode: 0o755 });
}

export function removeTree(target: string): void {
  // What the script detached (`measure-copies` of a refused `prepare`, the sweep) may still be writing into a copy.
  stopDetachedRuns(target);
  spawnSync('chmod', ['-R', 'u+rwX', target]);
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

export function getEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
    PUEUE_BIN: path.join(fakeBinDir, 'pueue'),
    FAKE_WORK: workDir,
    FAKE_DISK_TOTAL_KB: `${fakeDiskGib * kibPerGib}`,
    ...extra,
  };
}

export function runScript(args: string[], env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bash', [scriptPath, ...args], { encoding: 'utf8', env: getEnv(env), timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Run a function of the script (sourced) and return its stdout. */
export function runFunction(body: string, env: NodeJS.ProcessEnv = {}): string {
  const result = spawnSync('bash', ['-c', `source ${scriptPath}; ${body}`], { encoding: 'utf8', env: getEnv(env), timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

export function setAge(target: string, ageMs: number): void {
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(target, when, when);
}

/** A project copy of `sizeGib` GiB (as the fake disk counts it), last used `usedAgoMs` ago. */
export function makeCopy(copySlug: string, sizeGib: number, usedAgoMs: number): string {
  const copyDir = path.join(workDir, 'p', copySlug);
  writeFile(copyDir, 'tree/file.txt');
  writeFile(copyDir, 'used', '');
  writeFile(copyDir, 'fake-kb', `${sizeGib * kibPerGib}`);
  setAge(path.join(copyDir, 'used'), usedAgoMs);
  return copyDir;
}

export function writeJob(copyDir: string, id: string, files: Record<string, string>): string {
  const jobDir = path.join(copyDir, 'jobs', id);
  for (const [name, content] of Object.entries(files)) writeFile(jobDir, name, content);
  return jobDir;
}

/** Other children the tests keep (an `exec`, a prune): the hook below ends them with the stand-ins of the kit. */
export const liveProcesses: ChildProcess[] = [];

export function getDeadPid(): number {
  const pid = spawnSync('true').pid;
  assert.ok(pid !== undefined);
  return pid;
}

/** Run `body` in a shell that has the script's functions (and `workDir` as `work`); returns what it printed and its exit status. */
export function runShell(body: string, env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bash', ['-c', `source ${scriptPath}; ${body}`], { encoding: 'utf8', env: getEnv(env), timeout: 60_000 });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr };
}

export function listCopies(): string[] {
  return fs.readdirSync(path.join(workDir, 'p')).filter((name) => !name.startsWith('.')).sort();
}

export function parseRemovals(stdout: string): string[] {
  return stdout.split('\n').filter((line) => line.startsWith('removed=')).map((line) => line.slice('removed='.length).split(' ')[0]);
}

/**
 * The per-test state of the disk cases: a fresh work root with the stand-ins (`df`, `du`, `pueue`, `rm`) on a PATH folder of its own — registered by each file that uses the kit (`useDiskHarness()` at its top).
 * `workRoot`, `workDir` and `fakeBinDir` are live bindings: the importing file reads the current test's.
 */
export function useDiskHarness(): void {
beforeEach(() => {
  workRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-script-disk-')));
  workDir = path.join(workRoot, 'work');
  fakeBinDir = path.join(workRoot, 'fakebin');
  fs.mkdirSync(path.join(workDir, 'p'), { recursive: true });
  fs.mkdirSync(fakeBinDir);
  writeExecutable(path.join(fakeBinDir, 'df'), fakeDf);
  writeExecutable(path.join(fakeBinDir, 'du'), fakeDu);
  writeExecutable(path.join(fakeBinDir, 'pueue'), fakePueue);
  writeExecutable(path.join(fakeBinDir, 'rm'), fakeRm);
});
afterEach(() => {
  stopRunnerStandIns();
  for (const child of liveProcesses.splice(0)) child.kill('SIGKILL');
  removeTree(workRoot);
});
}

