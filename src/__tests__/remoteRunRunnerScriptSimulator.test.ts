/**
 * @description `remoteRun/runner.sh`, a job that needs iOS on a Mac runner: its project copy's OWN Simulator device. `ios-device` (a step of the job, after the dependencies) makes `charness-<slug>` of the
 * device type and runtime the runner's last passing iOS check booted, or keeps the device recorded in `p/<slug>/ios-simulator` while `simctl` still lists it as available, and boots it; the command gets
 * its id as REMOTE_RUN_IOS_SIMULATOR_UDID; at the job's end — also after a kill or a timeout — the device is shut down (never erased, never `all`). The devices of copies that were removed (the retired list)
 * are deleted by the next step, and only those whose name starts `charness-`. Anything that goes wrong costs the job its device, not its run: a line in the log and no variable. Every `simctl` call
 * is bounded. The Simulator is a stand-in (`remoteRunRunnerJobKit.ts`) that keeps devices as files, so a test reads their state and the calls made.
 *
 * rsync is needed for the jobs (the apply step): a local run without it is SKIPPED with the reason, CI installs it and fails without.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  addFakeDevice,
  checkIsRsyncAvailable,
  createFakeSimulators,
  createRunnerState,
  deviceTypeId,
  getRunEnvironment,
  passingIosCheck,
  readFakeCalls,
  readFakeDevices,
  runJob,
  runtimeId,
  startJob,
  waitForJobExit,
  waitUntil,
  type FakeSimulators,
  type JobSpec,
  type RunnerState,
} from './remoteRunRunnerJobKit';
import { scriptPath, startRunnerStandIn, stopRunnerStandIns, writeFile, removeTestRoot } from './remoteRunRunnerScriptKit';

const isCi = process.env.CI === 'true' || process.env.CI === '1';
const rsyncSkip = !checkIsRsyncAvailable() && !isCi ? 'rsync is not installed here (CI installs it)' : false;
const slugA = 'app-aaaaaaaaaa';
const slugB = 'app-bbbbbbbbbb';
const udidOne = '00000000-0000-0000-0000-000000000001';
const udidTwo = '00000000-0000-0000-0000-000000000002';

let root = '';
let state: RunnerState;
let sims: FakeSimulators;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'simdev-')));
  state = createRunnerState(root, passingIosCheck);
  sims = createFakeSimulators(root);
});
afterEach(() => {
  stopRunnerStandIns();
  removeTestRoot(root);
});

const seenFile = (): string => path.join(root, 'seen');
const iosJob = (slugName: string, jobId: string, extra: Partial<JobSpec> = {}): JobSpec => ({
  slug: slugName,
  jobId,
  needsIos: true,
  command: `printf '%s\\n' "UDID=\${REMOTE_RUN_IOS_SIMULATOR_UDID-unset}" > '${seenFile()}'`,
  ...extra,
});
const readSeenUdid = (): string => fs.readFileSync(seenFile(), 'utf8').trim().replace(/^UDID=/, '');
const readRecordedUdid = (slugName: string): string | null => {
  const file = path.join(state.workDir, 'p', slugName, 'ios-simulator');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null;
};
const readRetired = (): string[] => {
  const file = path.join(state.workDir, 'ios-devices-retired');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter((line) => line !== '') : [];
};
/** The calls of the stand-in that change something (what a test must keep from happening): everything but listing. */
const readChangingCalls = (): string[] => readFakeCalls(sims).filter((call) => !call.startsWith('simctl list'));

describe('the device of a project copy, job after job', { skip: rsyncSkip }, () => {
  it('a first iOS job makes `charness-<slug>` of the pair the iOS check booted, records it, boots it and waits, gives the command its id, and shuts it down at the end — never erasing, never `all`', () => {
    const outcome = runJob(state.workDir, iosJob(slugA, 'box1-aaaaaa'), sims.environment);
    assert.equal(outcome.exit, '0', outcome.log);
    assert.equal(readSeenUdid(), udidOne);
    assert.equal(readRecordedUdid(slugA), udidOne);
    assert.deepEqual(readChangingCalls(), [
      `simctl create charness-${slugA} ${deviceTypeId} ${runtimeId}`,
      `simctl boot ${udidOne}`,
      `simctl bootstatus ${udidOne}`,
      `simctl shutdown ${udidOne}`,
    ]);
    assert.deepEqual(readFakeDevices(sims), { [udidOne]: { name: `charness-${slugA}`, state: 'Shutdown', isAvailable: true } }, 'the device stays, shut down: its installed app is what the next job reuses');
    assert.match(fs.readFileSync(path.join(outcome.jobDir, 'runner-env'), 'utf8'), new RegExp(`^TMPDIR=.*\\nREMOTE_RUN_PORT_BASE=20000\\nREMOTE_RUN_IOS_SIMULATOR_UDID=${udidOne}\\n$`));
    for (const line of [`made the simulator charness-${slugA} (${udidOne}) for this project's copy`, `the simulator charness-${slugA} (${udidOne}) is booted`, `shut the simulator ${udidOne} down`]) {
      assert.ok(outcome.log.includes(`remote-run: ${line}`), `${line}\n${outcome.log}`);
    }
    assert.ok(!readFakeCalls(sims).some((call) => /\b(erase|all)\b/.test(call)), 'nothing erased, no «all»');
  });

  it('the next job of the copy keeps the device (no `create`), whether it was shut down or is still booted — booting a booted device is no failure', () => {
    runJob(state.workDir, iosJob(slugA, 'box1-aaaaaa'), sims.environment);
    const second = runJob(state.workDir, iosJob(slugA, 'box1-bbbbbb'), sims.environment);
    assert.equal(second.exit, '0', second.log);
    assert.equal(readSeenUdid(), udidOne);
    assert.equal(readFakeCalls(sims).filter((call) => call.startsWith('simctl create')).length, 1, 'made once');
    assert.ok(second.log.includes(`remote-run: using the simulator charness-${slugA} (${udidOne}) of this project's copy`), second.log);
    addFakeDevice(sims, udidOne, `charness-${slugA}`, 'Booted');
    const third = runJob(state.workDir, iosJob(slugA, 'box1-cccccc'), sims.environment);
    assert.equal(third.exit, '0', third.log);
    assert.equal(readSeenUdid(), udidOne, 'a device that is booted already still goes to the job');
  });

  it('another project gets a device of its own — and finishing shuts down THAT device only: the first project\'s, booted, stays booted', () => {
    runJob(state.workDir, iosJob(slugA, 'box1-aaaaaa'), sims.environment);
    addFakeDevice(sims, udidOne, `charness-${slugA}`, 'Booted');
    const second = runJob(state.workDir, iosJob(slugB, 'box1-bbbbbb'), sims.environment);
    assert.equal(second.exit, '0', second.log);
    assert.equal(readSeenUdid(), udidTwo);
    assert.deepEqual(readFakeDevices(sims), {
      [udidOne]: { name: `charness-${slugA}`, state: 'Booted', isAvailable: true },
      [udidTwo]: { name: `charness-${slugB}`, state: 'Shutdown', isAvailable: true },
    });
  });

  it('a device whose runtime is gone (no longer listed as available) is replaced by a new one and retired; the NEXT iOS step deletes it', () => {
    runJob(state.workDir, iosJob(slugA, 'box1-aaaaaa'), sims.environment);
    addFakeDevice(sims, udidOne, `charness-${slugA}`, 'Shutdown', false);
    const second = runJob(state.workDir, iosJob(slugA, 'box1-bbbbbb'), sims.environment);
    assert.equal(second.exit, '0', second.log);
    assert.equal(readSeenUdid(), udidTwo);
    assert.equal(readRecordedUdid(slugA), udidTwo);
    assert.deepEqual(readRetired(), [udidOne]);
    assert.ok(second.log.includes(`remote-run: the simulator of this project's copy (${udidOne}) is gone or unavailable: making a new one`), second.log);
    const third = runJob(state.workDir, iosJob(slugA, 'box1-cccccc'), sims.environment);
    assert.equal(third.exit, '0', third.log);
    assert.ok(readFakeCalls(sims).includes(`simctl delete ${udidOne}`));
    assert.deepEqual(Object.keys(readFakeDevices(sims)), [udidTwo]);
    assert.deepEqual(readRetired(), [], 'the line is dropped once the device is gone');
  });
});

describe('the retired list', { skip: rsyncSkip }, () => {
  it('deletes the devices this runner made, and only those: a device that is not named charness-… is never deleted, whatever the list says; lines of devices that are gone or not ids are dropped', () => {
    const ours = '00000000-0000-0000-0000-0000000000a1';
    const operators = '00000000-0000-0000-0000-0000000000b2';
    const goneUdid = '00000000-0000-0000-0000-0000000000ff';
    addFakeDevice(sims, ours, 'charness-app-old0000000');
    addFakeDevice(sims, operators, 'iPhone 15 Pro (my own)');
    writeFile(state.workDir, 'ios-devices-retired', `${ours}\n${operators}\n${goneUdid}\nnot a udid; rm -rf /\n`);
    const outcome = runJob(state.workDir, iosJob(slugA, 'box1-aaaaaa'), sims.environment);
    assert.equal(outcome.exit, '0', outcome.log);
    assert.deepEqual(Object.keys(readFakeDevices(sims)).sort(), [operators, udidOne].sort(), 'the operator\'s own device stays, ours is gone, and the job\'s new device is there');
    assert.ok(readFakeCalls(sims).includes(`simctl delete ${ours}`));
    assert.ok(!readFakeCalls(sims).includes(`simctl delete ${operators}`));
    assert.ok(!readFakeCalls(sims).includes(`simctl delete ${goneUdid}`));
    assert.deepEqual(readRetired(), []);
  });

  it('a deletion that failed leaves its line for the next time, with a line in the log', () => {
    addFakeDevice(sims, udidOne, 'charness-app-old0000000');
    writeFile(state.workDir, 'ios-devices-retired', `${udidOne}\n`);
    // A stand-in whose delete fails: the device file cannot be removed (its folder is read-only).
    const deviceFile = path.join(sims.simDir, 'dev', udidOne);
    fs.chmodSync(path.dirname(deviceFile), 0o555);
    try {
      if (spawnSync('sh', ['-c', `rm -f '${deviceFile}.probe' 2>/dev/null; touch '${deviceFile}.probe' 2>/dev/null`]).status === 0) {
        fs.rmSync(`${deviceFile}.probe`, { force: true });
        return; // a user who can write into a read-only folder (root): the failure cannot be staged here
      }
      const outcome = runJob(state.workDir, iosJob(slugA, 'box1-aaaaaa'), { ...sims.environment, FAKE_CREATE_FAIL: '1' });
      assert.equal(outcome.exit, '0', outcome.log);
      assert.deepEqual(readRetired(), [udidOne]);
      assert.ok(outcome.log.includes(`could not be deleted now; it is tried again at the next job that needs iOS`), outcome.log);
    } finally {
      fs.chmodSync(path.dirname(deviceFile), 0o755);
    }
  });
});

describe('a job that cannot have a device of its own still runs', { skip: rsyncSkip }, () => {
  const noDeviceWords = 'REMOTE_RUN_IOS_SIMULATOR_UDID is not set';

  it('a runner with no passing iOS check that names a device type (a hand-made runner, a failed check, a check of an older utility) runs the job on the simulators that are there — said, with no simctl call', () => {
    const handMade = path.join(root, 'hand-made-work');
    fs.mkdirSync(handMade, { recursive: true });
    const cases: Array<[string, string]> = [['hand-made', handMade], ['failed check', state.workDir], ['pass without a pair', state.workDir]];
    cases.forEach(([title, workDir], index) => {
      if (title === 'failed check') fs.writeFileSync(path.join(state.stateDir, 'ios-check.json'), `${JSON.stringify({ status: 'fail', checkedAtMs: 1, xcode: '16.2', reason: 'the Simulator did not boot' })}\n`);
      if (title === 'pass without a pair') fs.writeFileSync(path.join(state.stateDir, 'ios-check.json'), `${JSON.stringify({ status: 'pass', checkedAtMs: 1, xcode: '16.2', reason: null })}\n`);
      const outcome = runJob(workDir, iosJob(slugA, `box1-aaaaa${index}`), sims.environment);
      assert.equal(outcome.exit, '0', `${title}: ${outcome.log}`);
      assert.equal(readSeenUdid(), 'unset', title);
      assert.ok(outcome.log.includes('remote-run: no simulator of its own for this job: this runner has no passing iOS check that names a device type'), `${title}\n${outcome.log}`);
      assert.equal(fs.readFileSync(path.join(outcome.jobDir, 'runner-env'), 'utf8').includes('REMOTE_RUN_IOS_SIMULATOR_UDID'), false, title);
    });
    assert.deepEqual(readFakeCalls(sims), [], 'no simctl call at all');
  });

  it('a job that does not need iOS never touches the Simulator', () => {
    const outcome = runJob(state.workDir, iosJob(slugA, 'box1-aaaaaa', { needsIos: false }), sims.environment);
    assert.equal(outcome.exit, '0', outcome.log);
    assert.equal(readSeenUdid(), 'unset');
    assert.deepEqual(readFakeCalls(sims), []);
  });

  const failures: Array<[string, NodeJS.ProcessEnv, RegExp]> = [
    ['simctl create fails', { FAKE_CREATE_FAIL: '1' }, /no simulator of its own: simctl create charness-app-aaaaaaaaaa failed \(Invalid device type/],
    ['simctl boot fails', { FAKE_BOOT_FAIL: '1' }, /no simulator of its own: simctl boot 00000000-0000-0000-0000-000000000001 failed \(Unable to boot device because no login session\)/],
    ['the device never finishes booting', { FAKE_BOOTSTATUS_FAIL: '1' }, /no simulator of its own: 00000000-0000-0000-0000-000000000001 did not finish booting in 180s/],
  ];
  for (const [title, environment, expected] of failures) {
    it(`${title}: the job runs, exits 0, has no variable, and says why (and the step\'s failure is in its log)`, () => {
      const outcome = runJob(state.workDir, iosJob(slugA, 'box1-aaaaaa'), { ...sims.environment, ...environment });
      assert.equal(outcome.exit, '0', outcome.log);
      assert.equal(readSeenUdid(), 'unset');
      assert.match(outcome.log, expected);
      assert.ok(outcome.log.includes(`could not be prepared (exit 1, see above): ${noDeviceWords} for this job`), outcome.log);
      assert.equal(fs.readFileSync(path.join(outcome.jobDir, 'runner-env'), 'utf8').includes('REMOTE_RUN_IOS_SIMULATOR_UDID'), false);
    });
  }

  it('a device that was made but did not boot is shut down at the end all the same — it is not left booting', () => {
    runJob(state.workDir, iosJob(slugA, 'box1-aaaaaa'), { ...sims.environment, FAKE_BOOT_FAIL: '1' });
    assert.ok(readFakeCalls(sims).includes(`simctl shutdown ${udidOne}`));
  });
});

describe('the device is shut down when the job ends any way', { skip: rsyncSkip }, () => {
  const runningDevice = (): { state: string } => readFakeDevices(sims)[udidOne];

  it('after a job whose command fails', () => {
    const outcome = runJob(state.workDir, iosJob(slugA, 'box1-aaaaaa', { command: 'exit 3' }), sims.environment);
    assert.equal(outcome.exit, '3');
    assert.equal(runningDevice().state, 'Shutdown');
    assert.ok(readFakeCalls(sims).includes(`simctl shutdown ${udidOne}`));
  });

  it('after a timeout (124): the device is shut down before the job is over', async () => {
    // Started the way Pueue starts a task - a process group of its own - so that the watchdog's group TERM reaches the command (under a plain `spawnSync` the job is no group leader, nothing ends `sleep`, and the run lasts as long as the command).
    const spec = iosJob(slugA, 'box1-aaaaaa', { command: `touch '${root}/started'; sleep 120`, timeoutSec: 3 });
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

describe('a job that was given no number for its copy still knows its own device', { skip: rsyncSkip }, () => {
  it('with every number taken there is no TMPDIR and no port block, but REMOTE_RUN_IOS_SIMULATOR_UDID is set - the guard and the tests would otherwise fall back to whichever device is booted', () => {
    for (let number = 0; number < 100; number += 1) writeFile(state.workDir, `p/app-${number.toString().padStart(10, '0')}/index`, `${number}\n`);
    const spec = iosJob(slugA, 'box1-aaaaaa', {
      command: `printf '%s\\n' "UDID=\${REMOTE_RUN_IOS_SIMULATOR_UDID-unset}" "PORTS=\${REMOTE_RUN_PORT_BASE-unset}" > '${seenFile()}'`,
    });
    const outcome = runJob(state.workDir, spec, sims.environment);
    assert.equal(outcome.exit, '0', outcome.log);
    const seen = fs.readFileSync(seenFile(), 'utf8');
    assert.match(seen, new RegExp(`^UDID=${udidOne}$`, 'm'));
    assert.match(seen, /^PORTS=unset$/m);
    assert.match(outcome.log, /all 100 numbers of project copies are taken/);
  });
});

describe('the retired list is appended to under the lock that rewrites it', () => {
  it('a device is put on the list only once nobody holds the index lock: a rewrite in progress cannot drop the line', async () => {
    writeFile(state.workDir, `p/${slugA}/ios-simulator`, `${udidOne}\n`);
    const holderPid = startRunnerStandIn();
    writeFile(state.workDir, 'tmp/index.lock', `${holderPid}\nsome-job\n`);
    const retiring = new Promise<string>((resolve) => {
      const child = spawn('bash', ['-c', `source ${scriptPath}; index_lock_wait_sec=30; retire_copy_simulator ${state.workDir} ${state.workDir}/p/${slugA}; echo retired`], { env: getRunEnvironment(), stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      child.on('close', () => resolve(output));
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.deepEqual(readRetired(), [], 'the lock is held: nothing is appended behind the holder\'s back');
    fs.rmSync(path.join(state.workDir, 'tmp', 'index.lock'));
    assert.match(await retiring, /^retired$/m);
    assert.deepEqual(readRetired(), [udidOne]);
    assert.equal(fs.existsSync(path.join(state.workDir, 'tmp', 'index.lock')), false, 'the lock is given back');
  });

  it('a caller that already holds the lock (the removal of a copy) is not made to wait for it a second time: a `clean` that retires a device is quick', () => {
    const outcome = runJob(state.workDir, iosJob(slugA, 'box1-aaaaaa', { needsIos: false, command: 'true' }), sims.environment);
    assert.equal(outcome.exit, '0', outcome.log);
    writeFile(state.workDir, `p/${slugA}/ios-simulator`, `${udidOne}\n`);
    fs.utimesSync(path.join(outcome.jobDir, 'exit'), new Date(0), new Date(0));
    const startedAt = Date.now();
    const cleaned = spawnSync('bash', [scriptPath, 'clean', state.workDir, slugA], { encoding: 'utf8', env: getRunEnvironment(sims.environment), timeout: 60_000 });
    assert.match(cleaned.stdout, /^removed=/m, cleaned.stdout);
    assert.deepEqual(readRetired(), [udidOne]);
    assert.ok(Date.now() - startedAt < 10_000, `${Date.now() - startedAt} ms`);
  });
});

describe('a CoreSimulator that sees no runtime', { skip: rsyncSkip }, () => {
  it('does not make a job\'s device "gone": the recorded device is neither retired nor replaced, the job runs without one, and says why', () => {
    runJob(state.workDir, iosJob(slugA, 'box1-aaaaaa'), sims.environment);
    const callsBefore = readFakeCalls(sims).length;
    const outcome = runJob(state.workDir, iosJob(slugA, 'box1-bbbbbb'), { ...sims.environment, FAKE_NO_RUNTIMES: '1' });
    assert.equal(outcome.exit, '0', outcome.log);
    assert.equal(readSeenUdid(), 'unset');
    assert.equal(readRecordedUdid(slugA), udidOne, 'the record stays');
    assert.deepEqual(readRetired(), [], 'nothing is retired, so nothing is deleted later');
    assert.deepEqual(Object.keys(readFakeDevices(sims)), [udidOne], 'no second device was made');
    assert.ok(readFakeCalls(sims).slice(callsBefore).every((call) => !/^simctl (create|delete)\b/.test(call)));
    assert.ok(outcome.log.includes('remote-run: no simulator of its own: this session sees no Simulator runtime, so no device can be told gone or made'), outcome.log);
  });

  it('a session that sees its runtimes judges the device as before (the earlier case of an unavailable device is the test above)', () => {
    runJob(state.workDir, iosJob(slugA, 'box1-aaaaaa'), sims.environment);
    addFakeDevice(sims, udidOne, `charness-${slugA}`, 'Shutdown', false);
    const outcome = runJob(state.workDir, iosJob(slugA, 'box1-bbbbbb'), sims.environment);
    assert.equal(readSeenUdid(), udidTwo, outcome.log);
    assert.deepEqual(readRetired(), [udidOne]);
  });
});

describe('`ios-device` and `ios-device-shutdown` as steps', () => {
  /** A subcommand run on its own, the way a job runs it as a step. */
  function runSubcommand(args: string[], extraEnv: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string } {
    const result = spawnSync('bash', [scriptPath, ...args], { encoding: 'utf8', env: getRunEnvironment({ ...sims.environment, ...extraEnv }), timeout: 60_000 });
    return { status: result.status, stdout: result.stdout };
  }

  it('shutdown takes a device id and nothing else: a word that is not one is refused before any simctl call', () => {
    const refused = runSubcommand(['ios-device-shutdown', state.workDir, slugA, 'all']);
    assert.equal(refused.status, 1);
    assert.match(refused.stdout, /not shutting a simulator down: all is no device id/);
    assert.equal(runSubcommand(['ios-device-shutdown', state.workDir, slugA, "x; echo 'oops'"]).status, 1);
    assert.deepEqual(readFakeCalls(sims), []);
  });

  it('shutting down a device that is shut down is no failure', () => {
    addFakeDevice(sims, udidOne, `charness-${slugA}`, 'Shutdown');
    const done = runSubcommand(['ios-device-shutdown', state.workDir, slugA, udidOne]);
    assert.equal(done.status, 0, done.stdout);
  });

  it('the step leaves nothing behind that holds its output: the watchdog of the bounded `simctl` call is ended although the step ignores TERM - a caller that reads the step\'s pipe is not kept waiting for the limit (60 s)', () => {
    addFakeDevice(sims, udidOne, `charness-${slugA}`, 'Booted');
    const startedAt = Date.now();
    const done = runSubcommand(['ios-device-shutdown', state.workDir, slugA, udidOne]);
    assert.equal(done.status, 0, done.stdout);
    assert.ok(Date.now() - startedAt < 15_000, `it took ${(Date.now() - startedAt) / 1000} s: something still held the pipe`);
  });

  it('every simctl call is bounded: a boot that never finishes is cut at its limit and told, not waited for', () => {
    fs.mkdirSync(path.join(state.workDir, 'p', slugA), { recursive: true });
    const program = [`source ${scriptPath}`, 'ios_device_bootstatus_sec=1', `cmd_ios_device ${state.workDir} ${slugA}`, 'echo "code=$?"'].join('\n');
    const startedAt = Date.now();
    const result = spawnSync('bash', ['-c', program], { encoding: 'utf8', env: getRunEnvironment({ ...sims.environment, FAKE_BOOTSTATUS_SLEEP: '30' }), timeout: 60_000 });
    assert.match(result.stdout, /no simulator of its own: 00000000-0000-0000-0000-000000000001 did not finish booting in 1s/);
    assert.match(result.stdout, /code=1/);
    assert.ok(Date.now() - startedAt < 20_000, `${Date.now() - startedAt} ms`);
  });
});
