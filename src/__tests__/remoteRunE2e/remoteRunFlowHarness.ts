/**
 * @description What the two `charness remote-run` flows (`remoteRunE2e.test.ts`, `remoteRunLifecycleE2e.test.ts`) share: the runner built
 * for a flow (`setUpFlow` / `tearDownFlow`), the helpers that run the built CLI in the flow's project, and the decoy / job-cleanup helpers.
 * Each flow file builds a runner of its own (own sshd, Pueue, ports and project), so the two run side by side — one flow was close to the
 * 20 minutes a flow file may take.
 */

import { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  cleanUpOpenJobs,
  createDecoyCommand,
  createFlowLayout,
  createProject,
  createRunnerEntry,
  getMissingTools,
  isCi,
  runCli,
  startCli,
  stopFlowLayout,
  stopFlowLayoutSync,
  waitForPidFile,
  waitForProcessGone,
  writeProjectFile,
  writeRunnersJson,
  type CliRun,
  type FlowLayout,
  type FlowProject,
} from './remoteRunFlowKit';

export const missingTools = getMissingTools();
export const skipReason = !isCi && missingTools.length > 0 ? `missing here: ${missingTools.join(', ')} (CI has them)` : false;

/** The lease of the flow: the test seam's floor, so a killed run's job is gone in seconds, not in the production 45. */
export const flowLeaseMs = 3000;
export const flowEnv = { CHARNESS_TEST_TIMINGS: JSON.stringify({ remoteRunLeaseMs: flowLeaseMs }) };
export const ordinaryRunTimeoutMs = 120_000;

/** What the project's `.remote-run` says between the steps that edit it; the install step counts its own runs on the runner. */
export const countingInstall = "install: sh -c 'n=$(cat ../deps-counter 2>/dev/null || echo 0); echo $((n+1)) > ../deps-counter'";
export const baseRemoteRunConfig = `pull: out test-results\n${countingInstall}\n`;
export const jobIdPattern = /^box1-[a-z2-7]{6}$/;
export const runnerScriptPath = path.resolve(__dirname, '..', '..', '..', 'remoteRun', 'runner.sh');

/** Set by `setUpFlow`; read through the import by the tests (a live binding). */
export let layout: FlowLayout;
export let project: FlowProject;

export function writeRemoteRunConfig(content: string): void {
  writeProjectFile(project, '.remote-run', content);
}

export function readDepsCounter(): number {
  return Number(fs.readFileSync(path.join(project.runnerDirectory, 'deps-counter'), 'utf8').trim());
}

/** The job id `--bg` printed. */
export function readJobId(result: { stdout: string }): string {
  const jobId = result.stdout.trim();
  assert.match(jobId, jobIdPattern, `the job id on stdout: ${JSON.stringify(result.stdout)}`);
  return jobId;
}

export function run(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): ReturnType<typeof runCli> {
  return runCli(layout, args, { cwd: options.cwd ?? project.root, env: { ...flowEnv, ...options.env }, timeoutMs: options.timeoutMs ?? ordinaryRunTimeoutMs });
}


/** In a suite that starts long-lived jobs: whatever a test left running (it failed halfway) is ended, so it cannot hold the project lock against the tests after it. */
export function registerOpenJobCleanup(): void {
  afterEach(async () => {
    await cleanUpOpenJobs(layout, project, flowEnv);
  });
}

/** The time a run may take to end after it was told to: a command that ignores SIGTERM gets the runner's 10 s grace, plus the calls around it. */
export const afterInterruptTimeoutMs = 60_000;
/** The lease of the flow plus the runner's poll, the SIGTERM and slack on a loaded machine. */
export const afterLeaseLostTimeoutMs = flowLeaseMs + 40_000;

/** Start a foreground run of the decoy `name` and wait until it is really running on the runner: its pid and its child's pid. */
export async function startDecoyRun(name: string, options: { isIgnoringTerm?: boolean; args?: string[] } = {}): Promise<{ cli: CliRun; decoyPid: number; childPid: number }> {
  const cli = startCli(layout, [...(options.args ?? []), createDecoyCommand(name, options)], { cwd: project.root, env: flowEnv });
  const decoyPid = await waitForPidFile(project, `${name}.pid`);
  const childPid = await waitForPidFile(project, `${name}.child`);
  return { cli, decoyPid, childPid };
}

export async function waitForExit(cli: CliRun, timeoutMs: number): Promise<number | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`remote-run did not end within ${timeoutMs} ms\nstdout: ${cli.stdout()}\nstderr: ${cli.stderr()}`)), timeoutMs);
  });
  try {
    return (await Promise.race([cli.finished, timeout])).exitCode;
  } finally {
    clearTimeout(timer);
  }
}

export async function expectNothingLeft(decoyPid: number, childPid: number, timeoutMs: number): Promise<void> {
  await waitForProcessGone('the decoy to be gone', decoyPid, timeoutMs);
  await waitForProcessGone('the decoy\'s child to be gone', childPid, timeoutMs);
}

/** The state word of the newest job in `ls`. */
export async function readNewestJobState(): Promise<string> {
  const listed = await run(['ls']);
  assert.equal(listed.exitCode, 0, listed.stderr);
  return listed.stdout.split('\n')[0];
}


/** Build the flow's runner and project: the `before` of a flow file. */
export async function setUpFlow(): Promise<void> {
  if (missingTools.length > 0) throw new Error(`the flow needs: ${missingTools.join(', ')}`);
  layout = await createFlowLayout();
  process.on('exit', () => stopFlowLayoutSync(layout));
  writeRunnersJson(layout, [createRunnerEntry(layout)]);
  project = createProject(layout, 'app', {
    '.gitignore': 'node_modules/\nout/\n',
    'package.json': '{ "name": "app" }\n',
    'yarn.lock': '# lock v1\n',
    'src/a.txt': 'version A\n',
    'test-results/snap.txt': 'original snapshot\n',
    'test-results/untouched.txt': 'original untouched\n',
    '.remote-run': baseRemoteRunConfig,
  });
}

/** Stop everything of the flow's runner: the `after` of a flow file. */
export async function tearDownFlow(): Promise<void> {
  if (layout !== undefined) await stopFlowLayout(layout);
}
