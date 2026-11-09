/**
 * @description What the Simulator cases of `remoteRun/runner.sh` share (`remoteRunRunnerScriptSimulator.test.ts`, `remoteRunRunnerScriptSimulatorEnd.test.ts`: one file ran past 80 s alone, and a loaded box cuts a unit file
 * at the 2-minute cap): the per-test root, the runner state, the stand-in for `xcrun simctl`, and a job that needs iOS. `root`, `state` and `sims` are live bindings: `useSimulatorHarness()` assigns them before every test.
 * Matches no test glob.
 */

import { afterEach, beforeEach } from 'node:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { checkIsRsyncAvailable, createFakeSimulators, createRunnerState, passingIosCheck, type FakeSimulators, type JobSpec, type RunnerState } from './remoteRunRunnerJobKit';
import { stopRunnerStandIns, removeTestRoot } from './remoteRunRunnerScriptKit';

const isCi = process.env.CI === 'true' || process.env.CI === '1';
export const rsyncSkip = !checkIsRsyncAvailable() && !isCi ? 'rsync is not installed here (CI installs it)' : false;
export const slugA = 'app-aaaaaaaaaa';
export const slugB = 'app-bbbbbbbbbb';
export const udidOne = '00000000-0000-0000-0000-000000000001';
export const udidTwo = '00000000-0000-0000-0000-000000000002';

export let root = '';
export let state: RunnerState;
export let sims: FakeSimulators;

/** Registers the per-test setup and teardown of the file that calls it. */
export function useSimulatorHarness(): void {
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'simdev-')));
    state = createRunnerState(root, passingIosCheck);
    sims = createFakeSimulators(root);
  });
  afterEach(() => {
    stopRunnerStandIns();
    removeTestRoot(root);
  });
}

export const getSeenFile = (): string => path.join(root, 'seen');
export const iosJob = (slugName: string, jobId: string, extra: Partial<JobSpec> = {}): JobSpec => ({
  slug: slugName,
  jobId,
  needsIos: true,
  command: `printf '%s\\n' "UDID=\${REMOTE_RUN_IOS_SIMULATOR_UDID-unset}" > '${getSeenFile()}'`,
  ...extra,
});
