/**
 * @description `remoteRun/runner.sh`, a job that needs iOS on a Mac runner, the other half of the Simulator cases (the first is `remoteRunRunnerScriptSimulator.test.ts`; the two share
 * `remoteRunRunnerScriptSimulatorKit.ts`, split because one file ran past 80 s alone and a loaded box cuts a unit file at the 2-minute cap): the job's device is shut down when the job ends any way — a failing command,
 * a timeout, a kill, a TERM that reaches the job before its command is forked — a `kill` waits for that shutdown past its grace, a second kill and a late TERM never cut it off, and the shutdown step is deaf to TERM.
 * The Simulator is a stand-in (`remoteRunRunnerJobKit.ts`) that keeps devices as files, so a test reads their state and the calls made.
 *
 * rsync is needed for the jobs (the apply step): a local run without it is SKIPPED with the reason, CI installs it and fails without.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { addFakeDevice, getRunEnvironment, readFakeCalls, readFakeDevices, runJob, startJob, waitForJobExit, waitUntil } from './remoteRunRunnerJobKit';
import { scriptPath, writeFile } from './remoteRunRunnerScriptKit';
import { iosJob, root, rsyncSkip, sims, slugA, state, udidOne, useSimulatorHarness } from './remoteRunRunnerScriptSimulatorKit';

useSimulatorHarness();

describe('the device is shut down when the job ends any way', { skip: rsyncSkip }, () => {
  const timeoutLimitSec = 12;
  const runningDevice = (): { state: string } => readFakeDevices(sims)[udidOne];

  it('after a job whose command fails', () => {
    const outcome = runJob(state.workDir, iosJob(slugA, 'box1-aaaaaa', { command: 'exit 3' }), sims.environment);
    assert.equal(outcome.exit, '3');
    assert.equal(runningDevice().state, 'Shutdown');
    assert.ok(readFakeCalls(sims).includes(`simctl shutdown ${udidOne}`));
  });

  it('after a timeout (124): the device is shut down before the job is over', async () => {
    // Started the way Pueue starts a task - a process group of its own - so that the watchdog's group TERM reaches the command (under a plain `spawnSync` the job is no group leader, nothing ends `sleep`, and the run lasts as long as the command).
    // The limit counts from the job's start and so covers the device's preparation: it must be well above what that takes on a loaded box (measured: up to ~5 s with the CPUs of the box taken), or the limit runs out before the
    // device exists and there is none to shut down.
    const spec = iosJob(slugA, 'box1-aaaaaa', { command: `touch '${root}/started'; sleep 120`, timeoutSec: timeoutLimitSec });
    const child = startJob(state.workDir, spec, sims.environment);
    try {
      assert.equal(await waitForJobExit(state.workDir, spec, 40_000), '124');
      await waitUntil('the device to be shut down', () => runningDevice().state === 'Shutdown', 20_000);
      assert.ok(readFakeCalls(sims).includes(`simctl shutdown ${udidOne}`));
    } finally {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }
    }
  });

  it('after a TERM that reached the job after its last check and before its command was forked (a loaded box: up to ~1.5 s): the command is not started, and the device is shut down', async () => {
    // The stand-in `touch` holds the job where it is between its last `killed` check and the fork of the command (`touch start-marker`), ignoring TERM itself; the test sends the group TERM there, then lets it go.
    const fakeTouch = `#!/bin/bash
trap '' TERM
case "$1" in
  */start-marker)
    : > "$FAKE_SIM/touch-held"
    while [ ! -f "$FAKE_SIM/touch-go" ]; do sleep 0.05; done ;;
esac
exec /usr/bin/touch "$@"
`;
    fs.writeFileSync(path.join(sims.binDir, 'touch'), fakeTouch, { mode: 0o755 });
    const spec = iosJob(slugA, 'box1-aaaaaa', { command: `touch '${root}/started'; sleep 120` });
    const child = startJob(state.workDir, spec, sims.environment);
    try {
      await waitUntil('the job to be held before its command', () => fs.existsSync(path.join(sims.simDir, 'touch-held')), 60_000);
      assert.equal(runningDevice().state, 'Booted', 'booted while the job is held');
      process.kill(-(child.pid ?? 0), 'SIGTERM');
      fs.writeFileSync(path.join(sims.simDir, 'touch-go'), '');
      assert.equal(await waitForJobExit(state.workDir, spec, 20_000), '137', 'the command ran on past the TERM');
      assert.equal(fs.existsSync(path.join(root, 'started')), false, 'the command was started after the TERM');
      assert.equal(runningDevice().state, 'Shutdown');
      assert.ok(readFakeCalls(sims).includes(`simctl shutdown ${udidOne}`));
    } finally {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }
    }
  });

  it('after a kill (137): the group gets TERM, the job ends its way, and the device is shut down', async () => {
    const spec = iosJob(slugA, 'box1-aaaaaa', { command: `touch '${root}/started'; sleep 120` });
    const child = startJob(state.workDir, spec, sims.environment);
    try {
      await waitUntil('the command to start', () => fs.existsSync(path.join(root, 'started')), 60_000);
      assert.equal(runningDevice().state, 'Booted', 'booted while the job runs');
      process.kill(-(child.pid ?? 0), 'SIGTERM');
      assert.equal(await waitForJobExit(state.workDir, spec), '137');
      await waitUntil('the device to be shut down', () => runningDevice().state === 'Shutdown');
    } finally {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }
    }
  });
});

describe('a `kill` of a job that has a device', { skip: rsyncSkip }, () => {
  const killGraceSec = 10;

  it('waits for the device to be shut down past the grace after which the group is SIGKILLed: a command that is slow to die and a shutdown that takes longer than the grace still end with a shut-down device and 137', async () => {
    const spec = iosJob(slugA, 'box1-aaaaaa', { command: `touch '${root}/started'; trap '' TERM; sleep 4` });
    const child = startJob(state.workDir, spec, { ...sims.environment, FAKE_SHUTDOWN_SLEEP: `${killGraceSec + 3}` });
    try {
      await waitUntil('the command to start', () => fs.existsSync(path.join(root, 'started')), 60_000);
      assert.equal(readFakeDevices(sims)[udidOne].state, 'Booted');
      const killed = spawnSync('bash', [scriptPath, 'kill', state.workDir, slugA, spec.jobId], { encoding: 'utf8', env: getRunEnvironment(sims.environment), timeout: 120_000 });
      assert.equal(killed.stdout.trim(), 'killed', killed.stderr);
      assert.equal(await waitForJobExit(state.workDir, spec, 90_000), '137');
      assert.equal(readFakeDevices(sims)[udidOne].state, 'Shutdown', 'the shutdown was not cut off by the hard kill');
      assert.ok(readFakeCalls(sims).includes(`simctl shutdown ${udidOne}`));
    } finally {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }
    }
  });
});

describe('a second `kill` while the device is being shut down', () => {
  it('does not TERM the shutdown step: it waits like the first (a lease watcher\'s kill, an agent\'s retry) - the device is shut down and the job ends with 137', async () => {
    const spec = iosJob(slugA, 'box1-aaaaaa', { command: `touch '${root}/started'; sleep 120` });
    const child = startJob(state.workDir, spec, { ...sims.environment, FAKE_SHUTDOWN_SLEEP: '6' });
    const running: Array<ReturnType<typeof spawn>> = [];
    try {
      await waitUntil('the command to start', () => fs.existsSync(path.join(root, 'started')), 60_000);
      const killCall = (): Promise<string> => new Promise((resolve) => {
        const call = spawn('bash', [scriptPath, 'kill', state.workDir, slugA, spec.jobId], { env: getRunEnvironment(sims.environment), stdio: ['ignore', 'pipe', 'ignore'] });
        running.push(call);
        let output = '';
        call.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        call.on('close', () => resolve(output.trim()));
      });
      const first = killCall();
      await waitUntil('the job to be shutting its device down', () => fs.readFileSync(path.join(state.workDir, 'p', slugA, 'jobs', spec.jobId, 'phase'), 'utf8').trim() === 'simulator-off', 60_000);
      const second = await killCall();
      assert.equal(second, 'killed');
      assert.equal(await first, 'killed');
      assert.equal(await waitForJobExit(state.workDir, spec, 60_000), '137');
      assert.equal(readFakeDevices(sims)[udidOne].state, 'Shutdown', 'the shutdown was not cut off by the second kill');
    } finally {
      for (const call of running) call.kill('SIGKILL');
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }
    }
  });
});

describe('a TERM that reaches the job at the first instant of the shutdown step', () => {
  // The phase a `kill` reads (`running`) and the group TERM it sends are two steps: the job can enter `simulator-off` in between (a foreground run reaching its limit: the job's watchdog and the hub's own timer fire
  // within milliseconds of each other). The step must not depend on that read.
  it('does not end the step: the device is shut down all the same and the job ends with 137', async () => {
    const startedFile = path.join(root, 'shutdown-started');
    const spec = iosJob(slugA, 'box1-aaaaaa', { command: `touch '${root}/started'; sleep 120` });
    const child = startJob(state.workDir, spec, { ...sims.environment, FAKE_SHUTDOWN_SLEEP: '4', FAKE_SHUTDOWN_STARTED_FILE: startedFile });
    try {
      await waitUntil('the command to start', () => fs.existsSync(path.join(root, 'started')), 60_000);
      process.kill(-(child.pid ?? 0), 'SIGTERM');
      await waitUntil('the shutdown step to begin', () => fs.existsSync(startedFile), 60_000);
      process.kill(-(child.pid ?? 0), 'SIGTERM');
      assert.equal(await waitForJobExit(state.workDir, spec, 60_000), '137');
      assert.equal(readFakeDevices(sims)[udidOne].state, 'Shutdown', 'the late TERM did not cut the shutdown off');
    } finally {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }
    }
  });

  it('`shutdown_job_simulator` ignores a TERM while its step runs - on the agent path `killed` would make the job write `kill` to the step - and listens again afterwards', () => {
    writeFile(state.workDir, `p/${slugA}/ios-simulator`, `${udidOne}\n`);
    const program = [
      `source ${scriptPath}`,
      `work=${state.workDir}; slug=${slugA}; job=box1-aaaaaa; proj="$work/p/$slug"; jd="$proj/jobs/$job"; tree="$proj/tree"; mkdir -p "$jd" "$tree"; killed=0; ios_device_step_started=1`,
      "trap 'killed=1' TERM INT HUP",
      'run_step() { kill -TERM $$; sleep 0.3; echo "killed-during-step=$killed"; step_code=0; }',
      'shutdown_job_simulator',
      'echo "killed-after=$killed"',
      'kill -TERM $$; sleep 0.3; echo "killed-after-restore=$killed"',
    ].join('\n');
    const run = spawnSync('bash', ['-c', program], { encoding: 'utf8', env: getRunEnvironment(sims.environment), timeout: 30_000 });
    assert.match(run.stdout, /^killed-during-step=0$/m, run.stderr);
    assert.match(run.stdout, /^killed-after=0$/m);
    assert.match(run.stdout, /^killed-after-restore=1$/m, 'a TERM after the step is the job\'s again');
  });

  it('the step itself is deaf to TERM (it runs where nothing can set that flag): `ios-device-shutdown` shuts the device down although it is sent TERM at once', async () => {
    addFakeDevice(sims, udidOne, 'charness-app', 'Booted');
    const startedFile = path.join(root, 'step-started');
    const step = spawn('bash', [scriptPath, 'ios-device-shutdown', state.workDir, slugA, udidOne], { env: getRunEnvironment({ ...sims.environment, FAKE_SHUTDOWN_SLEEP: '2', FAKE_SHUTDOWN_STARTED_FILE: startedFile }), stdio: 'ignore' });
    try {
      await waitUntil('the shutdown to begin', () => fs.existsSync(startedFile), 30_000);
      step.kill('SIGTERM');
      await new Promise((resolve) => step.on('close', resolve));
      assert.equal(readFakeDevices(sims)[udidOne].state, 'Shutdown');
    } finally {
      step.kill('SIGKILL');
    }
  });
});

