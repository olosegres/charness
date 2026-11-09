/**
 * @description What the stash cases of `remoteRun/runner.sh` share (`remoteRunRunnerScriptStash.test.ts`, `remoteRunRunnerScriptStashWaiting.test.ts`: one file ran past 70 s alone and a loaded box cut it at the
 * 2-minute cap of a unit file): a stand-in for Pueue that keeps its task list in files and records every call, the per-test root, and the helpers that run the script, submit a job and read what it left.
 * Matches no test glob.
 */

import { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { scriptPath, startRunnerStandIn, stopDetachedRuns, stopRunnerStandIns, writeFile, removeTestRoot } from './remoteRunRunnerScriptKit';

export const slug = 'app-aaaaaaaaaa';
export const otherSlug = 'app-bbbbbbbbbb';

/** A task list in files: `add` numbers a task (stashed with `--stashed`), `enqueue` queues it, `remove` takes it away, `status --json label=…` lists the matching task; every call is a line of calls.log. */
const fakePueue = `#!/bin/bash
dir=\${FAKE_PQ:?}
printf '%s\\n' "$*" >> "$dir/calls.log"
mkdir -p "$dir/tasks"
case $1 in
  status)
    # FAKE_PQ_STATUS_SLOW_SEC: Pueue answers, but only after that long (a daemon starved of CPU on a machine with load 129).
    [ -z "\${FAKE_PQ_STATUS_SLOW_SEC:-}" ] || sleep "$FAKE_PQ_STATUS_SLOW_SEC"
    [ -z "\${FAKE_PQ_DOWN:-}" ] || exit 1
    # FAKE_PQ_DOWN_FILE: Pueue does not answer for as long as that file exists (a daemon that restarts, then is back).
    [ ! -e "\${FAKE_PQ_DOWN_FILE:-/nonexistent}" ] || exit 1
    # A label query that fails while the plain status answers: Pueue busy, a socket hiccup.
    if [ "$2" = --json ] && [ -n "$3" ] && [ -n "\${FAKE_PQ_LABEL_DOWN:-}" ]; then exit 1; fi
    if [ "$2" = --json ]; then
      printf '{"tasks":{'
      first=1
      for file in "$dir"/tasks/*; do
        [ -e "$file" ] || continue
        id=$(basename "$file")
        label=$(sed -n 1p "$file")
        state=$(sed -n 2p "$file")
        case $3 in label=*) [ "label=$label" = "$3" ] || continue ;; esac
        [ $first -eq 1 ] || printf ','
        first=0
        printf '"%s": {"id": %s, "label": "%s", "status": {"%s": {}}}' "$id" "$id" "$label" "$state"
      done
      printf '}}\\n'
    fi
    ;;
  wait)
    # Blocks while the task is stashed, like the real one (bounded, so a test that forgets cannot hang); with FAKE_PQ_WAIT_BLOCKS, while the task exists at all (a queued job that waits for a slot).
    waited=0
    while { [ "$(sed -n 2p "$dir/tasks/$2" 2> /dev/null)" = Stashed ] || { [ -n "\${FAKE_PQ_WAIT_BLOCKS:-}" ] && [ -f "$dir/tasks/$2" ]; }; } && [ $waited -lt 300 ]; do sleep 0.1; waited=$((waited+1)); done
    ;;
  add)
    shift
    state=Queued
    label=
    while [ $# -gt 0 ]; do
      case $1 in
        --stashed) state=Stashed ;;
        -l) label=$2; shift ;;
        -g | -w) shift ;;
        --) break ;;
      esac
      shift
    done
    id=$(( $(cat "$dir/counter" 2> /dev/null || echo 0) + 1 ))
    echo "$id" > "$dir/counter"
    printf '%s\\n%s\\n' "$label" "$state" > "$dir/tasks/$id"
    echo "$id"
    ;;
  enqueue)
    [ -f "$dir/tasks/$2" ] || exit 1
    printf '%s\\nQueued\\n' "$(sed -n 1p "$dir/tasks/$2")" > "$dir/tasks/$2"
    ;;
  remove)
    [ -f "$dir/tasks/$2" ] || exit 1
    rm -f "$dir/tasks/$2"
    ;;
esac
exit 0
`;

export let root = '';
export let workDir = '';
export let pueueDir = '';

/**
 * The per-test state of the stash cases: a fresh root with a work dir, the stand-in for Pueue and its task folder — registered by each file that uses the kit (`useStashHarness()` at its top). `root`, `workDir` and `pueueDir`
 * are live bindings: the importing file reads the current test's.
 */
export function useStashHarness(): void {
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stash-')));
  workDir = path.join(root, 'work');
  pueueDir = path.join(root, 'pq');
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(pueueDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'pueue'), fakePueue, { mode: 0o755 });
});
afterEach(() => {
  stopRunnerStandIns();
  removeTestRoot(root);
});
}

export function getEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, PUEUE_BIN: path.join(root, 'bin', 'pueue'), FAKE_PQ: pueueDir, ...extra };
}

export interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function runScript(args: string[], extra: NodeJS.ProcessEnv = {}): Run {
  const result = spawnSync('bash', [scriptPath, ...args], { encoding: 'utf8', env: getEnvironment(extra), timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The script's functions `source`d in a process of their own, with the globals of one job set the way the script has them. */
export function runSourced(body: string, jobId: string, extra: NodeJS.ProcessEnv = {}): Run {
  const program = [`source ${scriptPath}`, `work=${workDir}; slug=${slug}; job=${jobId}; proj="$work/p/$slug"; jobs_dir="$proj/jobs"; jd="$jobs_dir/$job"; killed=0`, body].join('\n');
  const result = spawnSync('bash', ['-c', program], { encoding: 'utf8', env: getEnvironment(extra), timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * A `probe` as a runner is asked it, and what it started: the scheduling safety net runs DETACHED (`settle-queue`, so the answer never waits for the scheduling mutex or Pueue), so a case that is about what the net
 * DID waits for that run to end before it looks.
 */
export function probeAndSettle(extra: NodeJS.ProcessEnv = {}): Run {
  const answered = runScript(['probe', workDir], extra);
  stopDetachedRuns(root);
  return answered;
}

export const jobFolder = (jobId: string, slugName = slug): string => path.join(workDir, 'p', slugName, 'jobs', jobId);

export function createJobFolder(jobId: string, slugName = slug): string {
  const folder = jobFolder(jobId, slugName);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'log'), '');
  return folder;
}

/** Submit a job as `prepare` leaves it: through the script's own `submit`. */
export function submit(jobId: string, slugName = slug): Run {
  createJobFolder(jobId, slugName);
  const submitted = runScript(['submit', workDir, slugName, jobId, 'default']);
  assert.equal(submitted.status, 0, submitted.stderr);
  return submitted;
}

export async function waitUntil(check: () => boolean, what: string, limitMs = 15_000): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export const isStashed = (jobId: string, slugName = slug): boolean => fs.existsSync(path.join(jobFolder(jobId, slugName), 'stashed'));
export const readTaskId = (jobId: string, slugName = slug): string => fs.readFileSync(path.join(jobFolder(jobId, slugName), 'task-id'), 'utf8').trim();
export const readCalls = (): string[] => (fs.existsSync(path.join(pueueDir, 'calls.log')) ? fs.readFileSync(path.join(pueueDir, 'calls.log'), 'utf8').split('\n').filter((line) => line !== '') : []);
export const readTaskState = (taskId: string): string | null => {
  const file = path.join(pueueDir, 'tasks', taskId);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n')[1] : null;
};
/** The job has ended: a result is written, as `record_job_end` does. */
export const endJob = (jobId: string, slugName = slug): void => writeFile(jobFolder(jobId, slugName), 'exit', '0\n');
/** The job runs: it has recorded a live process. */
export function markRunning(jobId: string, slugName = slug): void {
  writeFile(jobFolder(jobId, slugName), 'pid', `${startRunnerStandIn()}\n`);
}

