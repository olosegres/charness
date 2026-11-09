/**
 * @description What the tests of a job run by `remoteRun/runner.sh` share (`remoteRunRunnerScriptCopies.test.ts`, `remoteRunRunnerScriptSimulator.test.ts`): a paired runner's state folder with its work dir, a job
 * folder as `prepare` + `submit` leave it, `runner.sh job` run the way Pueue starts it, and a stand-in for `xcrun` that keeps Simulator devices as files (so what a test reads is the devices' state and the
 * calls made, not a guess). Not a test itself.
 */

import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { scriptPath, writeFile } from './remoteRunRunnerScriptKit';

export const accountPueue = '/nonexistent/pueue';

export interface RunnerState {
  stateDir: string;
  workDir: string;
}

/** A paired runner's state folder (`config.json` and `keys/`, which is what makes `read_runner_state` call it one) with its `work/`, and — when asked — the iOS check's record. */
export function createRunnerState(root: string, iosCheck: string | null): RunnerState {
  const stateDir = path.join(root, 'state');
  const workDir = path.join(stateDir, 'work');
  fs.mkdirSync(path.join(stateDir, 'keys'), { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  if (iosCheck !== null) fs.writeFileSync(path.join(stateDir, 'ios-check.json'), `${iosCheck}\n`);
  return { stateDir, workDir };
}

export const deviceTypeId = 'com.apple.CoreSimulator.SimDeviceType.iPhone-16';
export const runtimeId = 'com.apple.CoreSimulator.SimRuntime.iOS-18-2';
/** The record of a runner whose iOS check passed, with the pair it booted. */
export const passingIosCheck = JSON.stringify({ status: 'pass', checkedAtMs: 1, xcode: '16.2 (16C5032a)', reason: null, deviceTypeId, runtimeId });

export interface JobSpec {
  slug: string;
  jobId: string;
  /** The command of the job (`bash -c`). */
  command: string;
  /** The job's own `-e` lines (`NAME=VALUE`). */
  env?: string[];
  installCommand?: string;
  /** The key the dependencies step runs on (`key` when absent). */
  installKey?: string;
  /** The repository's key (`project-key` of the job: what a new copy is seeded by); no file when absent. */
  projectKey?: string;
  /** Files (paths relative to the project) the job stages besides `a.txt`: the new copy's folders, so that the places a seed fills have a parent. */
  stagedFiles?: string[];
  needsIos?: boolean;
  timeoutSec?: number;
}

export interface JobPaths {
  projectDir: string;
  jobDir: string;
}

export function getJobPaths(workDir: string, slug: string, jobId: string): JobPaths {
  const projectDir = path.join(workDir, 'p', slug);
  return { projectDir, jobDir: path.join(projectDir, 'jobs', jobId) };
}

/** A job folder ready for `runner.sh job` to run directly: a staged file, a manifest, the command, the limits, a task id. */
export function prepareJobFolder(workDir: string, spec: JobSpec): JobPaths {
  const paths = getJobPaths(workDir, spec.slug, spec.jobId);
  const stage = path.join(paths.projectDir, 'stage', spec.jobId);
  fs.mkdirSync(stage, { recursive: true });
  const stagedFiles = ['a.txt', ...(spec.stagedFiles ?? [])];
  for (const stagedFile of stagedFiles) writeFile(stage, stagedFile);
  fs.mkdirSync(paths.jobDir, { recursive: true });
  writeFile(paths.jobDir, 'manifest', `${stagedFiles.join('\n')}\n`);
  writeFile(paths.jobDir, 'subfolder', '');
  writeFile(paths.jobDir, 'cmd', spec.command);
  writeFile(paths.jobDir, 'timeout-sec', `${spec.timeoutSec ?? 120}`);
  writeFile(paths.jobDir, 'task-id', '1\n');
  writeFile(paths.jobDir, 'queued-at', `${Math.floor(Date.now() / 1000)}\n`);
  if (spec.env !== undefined) writeFile(paths.jobDir, 'env', `${spec.env.join('\n')}\n`);
  if (spec.installCommand !== undefined) {
    writeFile(paths.jobDir, 'install-command', spec.installCommand);
    writeFile(paths.jobDir, 'install-key', spec.installKey ?? 'key');
  }
  if (spec.projectKey !== undefined) writeFile(paths.jobDir, 'project-key', `${spec.projectKey}\n`);
  if (spec.needsIos === true) writeFile(paths.jobDir, 'needs-ios', '');
  fs.writeFileSync(path.join(paths.projectDir, 'used'), '');
  return paths;
}

export function getRunEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, PUEUE_BIN: accountPueue, ...extra };
}

export interface JobOutcome {
  /** The exit file's content, or `none` when the job left no result. */
  exit: string;
  log: string;
  jobDir: string;
  projectDir: string;
}

export function readJobOutcome(workDir: string, spec: JobSpec): JobOutcome {
  const paths = getJobPaths(workDir, spec.slug, spec.jobId);
  const readOr = (file: string, fallback: string): string => (fs.existsSync(path.join(paths.jobDir, file)) ? fs.readFileSync(path.join(paths.jobDir, file), 'utf8') : fallback);
  return { exit: readOr('exit', 'none').trim(), log: readOr('log', ''), ...paths };
}

/** Prepare and run `runner.sh job` for `spec` to its end (as Pueue starts it), bounded; returns what it left. */
export function runJob(workDir: string, spec: JobSpec, extraEnv: NodeJS.ProcessEnv = {}, timeoutMs = 90_000): JobOutcome {
  prepareJobFolder(workDir, spec);
  spawnSync('bash', [scriptPath, 'job', workDir, spec.slug, spec.jobId], { encoding: 'utf8', env: getRunEnvironment(extraEnv), timeout: timeoutMs });
  return readJobOutcome(workDir, spec);
}

/** Prepare `spec` and start `runner.sh job` in a process group of its own (Pueue's way), without waiting. */
export function startJob(workDir: string, spec: JobSpec, extraEnv: NodeJS.ProcessEnv = {}): ChildProcess {
  prepareJobFolder(workDir, spec);
  return spawn('bash', [scriptPath, 'job', workDir, spec.slug, spec.jobId], { detached: true, stdio: 'ignore', env: getRunEnvironment(extraEnv) });
}

/** Wait, bounded, for the job's exit file. */
export async function waitForJobExit(workDir: string, spec: JobSpec, limitMs = 60_000): Promise<string> {
  const exitFile = path.join(getJobPaths(workDir, spec.slug, spec.jobId).jobDir, 'exit');
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(exitFile)) return fs.readFileSync(exitFile, 'utf8').trim();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return 'still running';
}

/** Wait, bounded, until `check` holds. */
export async function waitUntil(description: string, check: () => boolean, limitMs = 30_000): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The stand-in for `xcrun simctl`: devices are files under `$FAKE_SIM/dev/<udid>` (name, state, availability); every call is one line of `$FAKE_SIM/calls.log`. */
const fakeXcrun = `#!/bin/bash
sim=\${FAKE_SIM:?}
printf '%s\\n' "$*" >> "$sim/calls.log"
[ "$1" = simctl ] || exit 0
shift
command=$1
shift
read_device() { { IFS= read -r name; IFS= read -r state; IFS= read -r availability; } < "$sim/dev/$1"; }
case $command in
  list)
    if [ "$1" = runtimes ]; then
      echo "== Runtimes =="
      [ -n "\${FAKE_NO_RUNTIMES:-}" ] || echo "iOS 18.2 (18.2 - 22C150) - com.apple.CoreSimulator.SimRuntime.iOS-18-2"
      exit 0
    fi
    [ "$1" = devices ] || exit 0
    echo "== Devices =="
    echo "-- iOS 18.2 --"
    for file in "$sim/dev"/*; do
      [ -e "$file" ] || continue
      udid=$(basename "$file")
      read_device "$udid"
      if [ "$2" = available ] && [ "$availability" != yes ]; then continue; fi
      # A CoreSimulator that sees no runtime calls every device unavailable.
      if [ "$2" = available ] && [ -n "\${FAKE_NO_RUNTIMES:-}" ]; then continue; fi
      echo "    $name ($udid) ($state)"
    done
    ;;
  create)
    if [ -n "\${FAKE_CREATE_FAIL:-}" ]; then echo "Invalid device type: $2" >&2; exit 164; fi
    count=$(( $(cat "$sim/counter" 2> /dev/null || echo 0) + 1 ))
    echo "$count" > "$sim/counter"
    udid=$(printf '00000000-0000-0000-0000-%012d' "$count")
    printf '%s\\nShutdown\\nyes\\n' "$1" > "$sim/dev/$udid"
    echo "$udid"
    ;;
  boot)
    [ -f "$sim/dev/$1" ] || { echo "Invalid device: $1" >&2; exit 164; }
    if [ -n "\${FAKE_BOOT_FAIL:-}" ]; then echo "Unable to boot device because no login session" >&2; exit 1; fi
    read_device "$1"
    if [ "$state" = Booted ]; then
      printf 'An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=405):\\nUnable to boot device in current state: Booted\\n' >&2
      exit 149
    fi
    printf '%s\\nBooted\\n%s\\n' "$name" "$availability" > "$sim/dev/$1"
    ;;
  bootstatus)
    [ -z "\${FAKE_BOOTSTATUS_SLEEP:-}" ] || exec sleep "$FAKE_BOOTSTATUS_SLEEP"
    [ -z "\${FAKE_BOOTSTATUS_FAIL:-}" ] || exit 1
    ;;
  shutdown)
    set_state() { read_device "$1"; printf '%s\\nShutdown\\n%s\\n' "$name" "$availability" > "$sim/dev/$1"; }
    if [ "$1" = all ]; then
      for file in "$sim/dev"/*; do [ -e "$file" ] && set_state "$(basename "$file")"; done
      exit 0
    fi
    [ -f "$sim/dev/$1" ] || { echo "Invalid device: $1" >&2; exit 164; }
    # FAKE_SHUTDOWN_STARTED_FILE: made the moment the shutdown begins, so a test can send its signal at that instant.
    [ -z "\${FAKE_SHUTDOWN_STARTED_FILE:-}" ] || : > "$FAKE_SHUTDOWN_STARTED_FILE"
    [ -z "\${FAKE_SHUTDOWN_SLEEP:-}" ] || sleep "$FAKE_SHUTDOWN_SLEEP"
    read_device "$1"
    if [ "$state" = Shutdown ]; then
      printf 'An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=405):\\nUnable to shutdown device in current state: Shutdown\\n' >&2
      exit 149
    fi
    set_state "$1"
    ;;
  delete)
    case $1 in
      all) rm -f "$sim/dev"/* ;;
      unavailable)
        for file in "$sim/dev"/*; do
          [ -e "$file" ] || continue
          read_device "$(basename "$file")"
          [ "$availability" = yes ] || rm -f "$file"
        done
        ;;
      *) [ -f "$sim/dev/$1" ] || { echo "Invalid device: $1" >&2; exit 164; }; rm -f "$sim/dev/$1" ;;
    esac
    ;;
esac
`;

export interface FakeSimulators {
  /** The folder the stand-in keeps its devices and its call log in (`FAKE_SIM`). */
  simDir: string;
  /** The folder to put first on the PATH. */
  binDir: string;
  /** The environment a run needs for the stand-in to be the `xcrun` of the PATH. */
  environment: NodeJS.ProcessEnv;
}

export function createFakeSimulators(root: string): FakeSimulators {
  const simDir = path.join(root, 'sim');
  const binDir = path.join(root, 'sim-bin');
  fs.mkdirSync(path.join(simDir, 'dev'), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'xcrun'), fakeXcrun, { mode: 0o755 });
  return { simDir, binDir, environment: { FAKE_SIM: simDir, PATH: `${binDir}:${process.env.PATH ?? ''}` } };
}

export type FakeDeviceState = 'Shutdown' | 'Booted';

/** Put a device into the stand-in's world. */
export function addFakeDevice(simulators: FakeSimulators, udid: string, name: string, state: FakeDeviceState = 'Shutdown', isAvailable = true): void {
  fs.writeFileSync(path.join(simulators.simDir, 'dev', udid), `${name}\n${state}\n${isAvailable ? 'yes' : 'no'}\n`);
}

/** The devices as the stand-in holds them now: udid → { name, state }. */
export function readFakeDevices(simulators: FakeSimulators): Record<string, { name: string; state: string; isAvailable: boolean }> {
  const devices: Record<string, { name: string; state: string; isAvailable: boolean }> = {};
  const deviceDir = path.join(simulators.simDir, 'dev');
  for (const udid of fs.readdirSync(deviceDir)) {
    const [name, state, availability] = fs.readFileSync(path.join(deviceDir, udid), 'utf8').split('\n');
    devices[udid] = { name, state, isAvailable: availability === 'yes' };
  }
  return devices;
}

/** Every call the stand-in got, in order, as `simctl create name type runtime`. */
export function readFakeCalls(simulators: FakeSimulators): string[] {
  const logFile = path.join(simulators.simDir, 'calls.log');
  return fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter((line) => line !== '') : [];
}

export function checkIsRsyncAvailable(): boolean {
  return spawnSync('rsync', ['--version'], { stdio: 'ignore' }).status === 0;
}
