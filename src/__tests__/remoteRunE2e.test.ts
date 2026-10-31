/**
 * @description `charness remote-run` at PROCESS level, end to end, against a runner made of a throwaway loopback `sshd` (no root) and
 * a private Pueue, all in temp dirs (`remoteRunE2e/remoteRunFlowKit.ts`): the built CLI is run as a child process exactly as an agent
 * runs it, with its own HOME, `runners.json` and cache. One flow, in order, each step on the state the one before left:
 *
 *   runners → the stand-in online with its capabilities; an entry on a closed port offline with its last snapshot; an unknown host key
 *     says to connect once by hand
 *   → a passing and a failing command return their exit codes, output streams while the command runs
 *   → deletions are mirrored, the runner's own ignored files are never touched, a `.env` is held back until `send:` names it
 *   → the dependencies step runs once, again when the lockfile changes, again after a failure
 *   → no environment variable of this process reaches the runner, `-e` passes one
 *   → `--bg` + `wait`/`ls`/`status`/`logs`/`fetch`: the job's code, only the files it created or changed come back, nothing stale
 *   → two jobs of one project queue and each runs its OWN tree; one job's result files survive the next job
 *   → SIGINT, SIGTERM, SIGHUP of a foreground run kill the whole remote job (also a command that ignores SIGTERM)
 *   → SIGKILL of a foreground run, and a frozen one (no heartbeat), end the job when the lease runs out
 *   → `--timeout` and `kill <id>` leave nothing; `exec` runs in the copy and is killed like a foreground job
 *   → refusals: not a git project, a capability no runner has, an unknown group
 *
 * "Nothing left" is asserted on real pids: every decoy writes its own pid and its child's.
 *
 * Needs sshd, ssh, rsync, Pueue and the built CLI (`yarn build`): a local run without them is SKIPPED with the reason, CI (`CI` is `true`
 * or `1`) installs them and fails without. Test case: N/A — Charness has no Jira tracker.
 */

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createFlowLayout,
  createProject,
  createRunnerEntry,
  getMissingTools,
  getSshOptions,
  isCi,
  openGate,
  checkIsProcessRunning,
  cleanUpOpenJobs,
  createDecoyCommand,
  createGatedCommand,
  readProjectFile,
  runCli,
  runnerName,
  startCli,
  stopFlowLayout,
  stopFlowLayoutSync,
  waitForLayoutProcess,
  waitForPidFile,
  waitForProcessGone,
  waitUntil,
  writeProjectFile,
  writeRunnersJson,
  type FlowLayout,
  type CliRun,
  type FlowProject,
} from './remoteRunE2e/remoteRunFlowKit';
import { listLayoutProcesses } from './remoteRunE2e/remoteRunFlowSweep';
import { closeSshMaster } from '../remoteRun/ssh';

const missingTools = getMissingTools();
const skipReason = !isCi && missingTools.length > 0 ? `missing here: ${missingTools.join(', ')} (CI has them)` : false;

/** The lease of the flow: the test seam's floor, so a killed run's job is gone in seconds, not in the production 45. */
const flowLeaseMs = 3000;
const flowEnv = { CHARNESS_TEST_TIMINGS: JSON.stringify({ remoteRunLeaseMs: flowLeaseMs }) };
const ordinaryRunTimeoutMs = 120_000;

/** What the project's `.remote-run` says between the steps that edit it; the install step counts its own runs on the runner. */
const countingInstall = "install: sh -c 'n=$(cat ../deps-counter 2>/dev/null || echo 0); echo $((n+1)) > ../deps-counter'";
const baseRemoteRunConfig = `pull: out test-results\n${countingInstall}\n`;
const jobIdPattern = /^box1-[a-z2-7]{6}$/;

let layout: FlowLayout;
let project: FlowProject;

function writeRemoteRunConfig(content: string): void {
  writeProjectFile(project, '.remote-run', content);
}

function readDepsCounter(): number {
  return Number(fs.readFileSync(path.join(project.runnerDirectory, 'deps-counter'), 'utf8').trim());
}

/** The job id `--bg` printed. */
function readJobId(result: { stdout: string }): string {
  const jobId = result.stdout.trim();
  assert.match(jobId, jobIdPattern, `the job id on stdout: ${JSON.stringify(result.stdout)}`);
  return jobId;
}

function run(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): ReturnType<typeof runCli> {
  return runCli(layout, args, { cwd: options.cwd ?? project.root, env: { ...flowEnv, ...options.env }, timeoutMs: options.timeoutMs ?? ordinaryRunTimeoutMs });
}


/** In a suite that starts long-lived jobs: whatever a test left running (it failed halfway) is ended, so it cannot hold the project lock against the tests after it. */
function registerOpenJobCleanup(): void {
  afterEach(async () => {
    await cleanUpOpenJobs(layout, project, flowEnv);
  });
}

/** The time a run may take to end after it was told to: a command that ignores SIGTERM gets the runner's 10 s grace, plus the calls around it. */
const afterInterruptTimeoutMs = 60_000;
/** The lease of the flow plus the runner's poll, the SIGTERM and slack on a loaded machine. */
const afterLeaseLostTimeoutMs = flowLeaseMs + 40_000;

/** Start a foreground run of the decoy `name` and wait until it is really running on the runner: its pid and its child's pid. */
async function startDecoyRun(name: string, options: { isIgnoringTerm?: boolean; args?: string[] } = {}): Promise<{ cli: CliRun; decoyPid: number; childPid: number }> {
  const cli = startCli(layout, [...(options.args ?? []), createDecoyCommand(name, options)], { cwd: project.root, env: flowEnv });
  const decoyPid = await waitForPidFile(project, `${name}.pid`);
  const childPid = await waitForPidFile(project, `${name}.child`);
  return { cli, decoyPid, childPid };
}

async function waitForExit(cli: CliRun, timeoutMs: number): Promise<number | null> {
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

async function expectNothingLeft(decoyPid: number, childPid: number, timeoutMs: number): Promise<void> {
  await waitForProcessGone('the decoy to be gone', decoyPid, timeoutMs);
  await waitForProcessGone('the decoy\'s child to be gone', childPid, timeoutMs);
}

/** The state word of the newest job in `ls`. */
async function readNewestJobState(): Promise<string> {
  const listed = await run(['ls']);
  assert.equal(listed.exitCode, 0, listed.stderr);
  return listed.stdout.split('\n')[0];
}

describe('charness remote-run against a loopback runner', { skip: skipReason }, () => {
  before(async () => {
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
  });

  after(async () => {
    if (layout !== undefined) await stopFlowLayout(layout);
  });

  describe('the runners', () => {
    it('`runners` shows the stand-in online, with its hardware, jobs, groups and what it can do', async () => {
      const result = await run(['runners']);
      assert.equal(result.exitCode, 0, result.stderr);
      const lines = result.stdout.split('\n');
      assert.match(lines[0], new RegExp(`^${runnerName} — online · `));
      assert.match(result.stdout, /\n {2}CPU .*cores \/ \d+ threads.* · RAM .* free · disk .* free \(work dir\)\n/);
      assert.match(result.stdout, /\n {2}jobs: 0 running, 0 queued, 0 projects · groups: default 3, emulator 1\n/);
      assert.match(result.stdout, /\n {2}can: .*ios: no \(Linux\)/);
      assert.ok(fs.existsSync(path.join(layout.workDir, 'bin')), 'the runner script was put on the runner by remote-run itself');
    });

    it('an entry on a closed port is offline with its last snapshot, and is skipped when a runner is picked', async () => {
      const closedPort = layout.sshPort + 1;
      writeRunnersJson(layout, [
        createRunnerEntry(layout, { name: 'ghost', sshOptions: getSshOptions(layout, { port: closedPort }) }),
        createRunnerEntry(layout),
      ]);
      // The stand-in was seen online a moment ago: its cached snapshot is what a ghost that was once online would have left.
      const cacheDir = path.join(layout.cacheDir, 'charness', 'remote-run');
      fs.copyFileSync(path.join(cacheDir, `${runnerName}.probe.json`), path.join(cacheDir, 'ghost.probe.json'));
      const result = await run(['runners']);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /^ghost — offline \(ssh: .*\) · last seen \d{4}-\d\d-\d\d \d\d:\d\d UTC — as it was then: /m);
      assert.match(result.stdout, new RegExp(`^${runnerName} — online`, 'm'));
      const echoed = await run(['echo', 'picked']);
      assert.equal(echoed.exitCode, 0, echoed.stderr);
      assert.match(echoed.stdout, /picked/);
      writeRunnersJson(layout, [createRunnerEntry(layout)]);
    });

    it('a runner that accepts the connection and never answers: `runners` ends within its 20 s limit, shows it offline WITH its last snapshot, and leaves no ssh of it running', async () => {
      const cacheDir = path.join(layout.cacheDir, 'charness', 'remote-run');
      // Its snapshot, from when it was healthy: the healthy runner's, taken here so the case needs no other.
      writeRunnersJson(layout, [createRunnerEntry(layout)]);
      assert.equal((await run(['runners'])).exitCode, 0);
      // The second key's sshd entry forces `sleep 600` in place of any command: the connection is made and nothing ever comes back.
      // No shared connection (ControlPath=none), or the entry would ride on the master of the healthy one and never reach sshd.
      const frozen = createRunnerEntry(layout, { name: 'frozen', sshOptions: [...getSshOptions(layout, { keyPath: layout.hangKeyPath }), '-o', 'ControlMaster=no', '-o', 'ControlPath=none'] });
      writeRunnersJson(layout, [frozen, createRunnerEntry(layout)]);
      fs.copyFileSync(path.join(cacheDir, `${runnerName}.probe.json`), path.join(cacheDir, 'frozen.probe.json'));
      const startedAt = Date.now();
      const result = await run(['runners'], { timeoutMs: 120_000 });
      const elapsedMs = Date.now() - startedAt;
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /^frozen — offline \(no answer within 20 s\) · last seen \d{4}-\d\d-\d\d \d\d:\d\d UTC — as it was then: /m);
      assert.match(result.stdout, new RegExp(`^${runnerName} — online`, 'm'), 'the healthy runner is not held back');
      assert.ok(elapsedMs < 45_000, `the process lived ${elapsedMs} ms: its ssh call outlived the view (its own limit is 60 s)`);
      assert.deepEqual(listLayoutProcesses(layout.root).filter((candidate) => candidate.args.includes('hang_key')).map((candidate) => candidate.pid), [], 'no ssh of the frozen runner is left');
      writeRunnersJson(layout, [createRunnerEntry(layout)]);
    });

    it('a host key that is not known yet says to connect once by hand — never a prompt, never a silent trust', async () => {
      const emptyKnownHosts = path.join(layout.root, 'keys', 'empty_known_hosts');
      fs.writeFileSync(emptyKnownHosts, '');
      // The earlier steps left a master connection (ControlPersist) for this host, port and user; it was verified, and a new
      // connection over it would be too — close it so the entry below really connects.
      await closeSshMaster(createRunnerEntry(layout), path.join(layout.cacheDir, 'charness', 'remote-run'));
      writeRunnersJson(layout, [createRunnerEntry(layout, { name: 'strange', sshOptions: getSshOptions(layout, { knownHostsPath: emptyKnownHosts }) })]);
      const result = await run(['runners']);
      assert.match(result.stdout, /^strange — offline \(ssh: the host key is not trusted yet — connect once by hand/m);
      assert.equal(fs.readFileSync(emptyKnownHosts, 'utf8'), '', 'the unknown key was not added behind the operator\'s back');
      writeRunnersJson(layout, [createRunnerEntry(layout)]);
    });
  });

  describe('running a command', () => {
    it('a passing command returns 0 with its output, a failing one its own exit code', async () => {
      const passing = await run(['echo', 'hello from the runner']);
      assert.equal(passing.exitCode, 0, passing.stderr);
      assert.match(passing.stdout, /hello from the runner/);
      const failing = await run(["sh -c 'echo out; echo err >&2; exit 7'"]);
      assert.equal(failing.exitCode, 7, failing.stderr);
      assert.match(failing.stdout, /out/);
      assert.match(failing.stdout, /err/, 'the job\'s stderr is in its output');
    });

    it('output streams while the command runs, not at its end', async () => {
      const result = await run(["sh -c 'echo first; sleep 4; echo second'"]);
      assert.equal(result.exitCode, 0, result.stderr);
      const firstAt = result.chunks.find((chunk) => chunk.stream === 'stdout' && chunk.text.includes('first'))?.atMs;
      const secondAt = result.chunks.find((chunk) => chunk.stream === 'stdout' && chunk.text.includes('second'))?.atMs;
      assert.ok(firstAt !== undefined && secondAt !== undefined, result.stdout);
      assert.ok(secondAt - firstAt >= 3000, `first came ${secondAt - firstAt} ms before second`);
    });
  });

  describe('the files there', () => {
    it('deletions are mirrored, and what the runner keeps of its own (an ignored node_modules) is never touched', async () => {
      writeProjectFile(project, 'src/to-delete.txt', 'delete me\n');
      const first = await run(['cat src/to-delete.txt']);
      assert.equal(first.exitCode, 0, first.stderr);
      assert.match(first.stdout, /delete me/);
      fs.mkdirSync(path.join(project.runnerDirectory, 'tree', 'node_modules'), { recursive: true });
      fs.writeFileSync(path.join(project.runnerDirectory, 'tree', 'node_modules', 'marker'), 'runner-owned\n');
      fs.rmSync(path.join(project.root, 'src/to-delete.txt'));
      const second = await run(["sh -c 'test ! -e src/to-delete.txt && cat node_modules/marker'"]);
      assert.equal(second.exitCode, 0, second.stderr);
      assert.match(second.stdout, /runner-owned/);
      assert.equal(fs.existsSync(path.join(project.runnerDirectory, 'tree', 'src', 'to-delete.txt')), false);
    });

    it('a .env is held back and says so; `send:` brings it', async () => {
      writeProjectFile(project, '.env', 'SECRET=1\n');
      const held = await run(["sh -c 'test ! -e .env && echo env-absent'"]);
      assert.equal(held.exitCode, 0, held.stderr);
      assert.match(held.stdout, /env-absent/);
      assert.match(held.stderr, /remote-run: held back 1 secret-looking file: \.env — opt in with "send: <path>" in \.remote-run/);
      writeRemoteRunConfig(`${baseRemoteRunConfig}send: .env\n`);
      const sent = await run(['cat .env']);
      assert.equal(sent.exitCode, 0, sent.stderr);
      assert.match(sent.stdout, /SECRET=1/);
      assert.ok(!sent.stderr.includes('held back'), sent.stderr);
      writeRemoteRunConfig(baseRemoteRunConfig);
      fs.rmSync(path.join(project.root, '.env'));
    });
  });

  describe('more of the files and groups', () => {

    it('`.git` stays home unless `--with-git` — and a copy that got one for a run does not keep it for the next', async () => {
      const without = await run(["sh -c 'test ! -e .git && echo no-git-there'"]);
      assert.equal(without.exitCode, 0, without.stderr);
      assert.match(without.stdout, /no-git-there/);
      const withGit = await run(['--with-git', 'git log --oneline']);
      assert.equal(withGit.exitCode, 0, withGit.stderr);
      assert.match(withGit.stdout, /init/, 'the history came with it');
      const gone = await run(["sh -c 'test ! -e .git && echo no-git-again'"]);
      assert.equal(gone.exitCode, 0, `the next plain run found a stale .git:\n${gone.stdout}${gone.stderr}`);
      assert.match(gone.stdout, /no-git-again/);
    });

    it('a Pueue group the runner has is accepted', async () => {
      const result = await run(['--group', 'emulator', 'echo', 'in the emulator group']);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /in the emulator group/);
    });
  });

  describe('the dependencies step', () => {
    it('runs once, not again on an unchanged lockfile, again when the lockfile changes', async () => {
      assert.equal(readDepsCounter(), 1, 'every run so far skipped the step after the first');
      writeProjectFile(project, 'yarn.lock', '# lock v2\n');
      const changed = await run(['echo', 'after the lockfile changed']);
      assert.equal(changed.exitCode, 0, changed.stderr);
      assert.match(changed.stderr, /installing dependencies:/);
      assert.equal(readDepsCounter(), 2);
      const unchanged = await run(['echo', 'unchanged again']);
      assert.equal(unchanged.exitCode, 0, unchanged.stderr);
      assert.ok(!unchanged.stderr.includes('installing dependencies'), unchanged.stderr);
      assert.equal(readDepsCounter(), 2);
    });

    it('a failing step is remote-run\'s own failure (125), and runs again next time even on an unchanged key', async () => {
      writeRemoteRunConfig("pull: out test-results\ninstall: sh -c 'if [ -f ../deps-ok ]; then exit 0; fi; echo broken-install; exit 5'\n");
      const failed = await run(['echo', 'never runs']);
      assert.equal(failed.exitCode, 125, failed.stderr);
      assert.match(failed.stdout, /broken-install/, 'the step\'s own output is shown');
      assert.match(failed.stderr, /the dependencies step failed/);
      assert.ok(!failed.stdout.includes('never runs'));
      fs.writeFileSync(path.join(project.runnerDirectory, 'deps-ok'), '');
      const retried = await run(['echo', 'now it runs']);
      assert.equal(retried.exitCode, 0, retried.stderr);
      assert.match(retried.stderr, /installing dependencies:/, 'the key had not changed, but the last install failed: it runs again');
      assert.match(retried.stdout, /now it runs/);
      writeRemoteRunConfig(baseRemoteRunConfig);
    });
  });

  describe('the environment', () => {
    it('no variable of this process reaches the runner; `-e` passes one explicitly', async () => {
      const result = await run(['-e', 'RR_PASSED=yes', `sh -c 'echo "marker=[$RR_MAIN_BOX_MARKER] passed=[$RR_PASSED]"'`], { env: { RR_MAIN_BOX_MARKER: 'leaked' } });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /marker=\[\] passed=\[yes\]/);
    });
  });

  describe('a job in the background', () => {
    let firstJobId = '';
    registerOpenJobCleanup();

    it('`--bg` prints a job id and returns; `wait` gives the job\'s code and brings back only what it created or changed', async () => {
      const gated = createGatedCommand('gate-first', {
        after: `mkdir -p out test-results; echo built > out/result.txt; echo "from runner" > test-results/snap.txt; echo log-line; exit 4`,
      });
      const submitted = await run(['--bg', gated]);
      assert.equal(submitted.exitCode, 0, submitted.stderr);
      firstJobId = readJobId(submitted);
      assert.match(submitted.stderr, new RegExp(`job ${firstJobId} runs on box1`));
      // Edited AFTER the submit: an untouched file of a pull folder must never be overwritten by the job's copy.
      writeProjectFile(project, 'test-results/untouched.txt', 'edited after submit\n');
      const running = await run(['status', firstJobId]);
      assert.equal(running.exitCode, 0, running.stderr);
      assert.match(running.stdout, new RegExp(`^job ${firstJobId} — (queued|running)`), 'the gate is shut: the job cannot have ended');
      openGate(project, 'gate-first');
      const waited = await run(['wait', firstJobId]);
      assert.equal(waited.exitCode, 4, waited.stderr);
      assert.match(waited.stdout, /log-line/, 'wait prints the end of the log');
      assert.match(waited.stderr, /2 result files came back/);
      assert.equal(readProjectFile(project, 'out/result.txt'), 'built\n');
      assert.equal(readProjectFile(project, 'test-results/snap.txt'), 'from runner\n');
      assert.equal(readProjectFile(project, 'test-results/untouched.txt'), 'edited after submit\n', 'the untouched file was not overwritten');
    });

    it('`ls`, `status` and `logs` show the finished job', async () => {
      const listed = await run(['ls']);
      assert.equal(listed.exitCode, 0, listed.stderr);
      assert.match(listed.stdout, new RegExp(`^${firstJobId} +failed +exit 4 .* app +sh -c `, 'm'));
      const status = await run(['status', firstJobId]);
      assert.match(status.stdout, new RegExp(`^job ${firstJobId} — failed \\(exit 4\\)\\n {2}runner: box1\\n {2}project: app\\n {2}command: sh -c `));
      const logs = await run(['logs', firstJobId]);
      assert.equal(logs.exitCode, 0, logs.stderr);
      assert.match(logs.stdout, /log-line/);
      const lastLine = await run(['logs', firstJobId, '--tail', '1']);
      assert.equal(lastLine.stdout, 'log-line\n');
    });

    it('a later job never brings the earlier job\'s files back, and `fetch` brings them again', async () => {
      fs.rmSync(path.join(project.root, 'out/result.txt'));
      const second = await run(['--bg', 'true']);
      const secondJobId = readJobId(second);
      const waited = await run(['wait', secondJobId]);
      assert.equal(waited.exitCode, 0, waited.stderr);
      assert.equal(readProjectFile(project, 'out/result.txt'), null, 'a previous job\'s leftover did not come back');
      const fetched = await run(['fetch', firstJobId]);
      assert.equal(fetched.exitCode, 0, fetched.stderr);
      assert.equal(readProjectFile(project, 'out/result.txt'), 'built\n', 'the first job\'s files were kept per job');
    });
  });

  describe('more of a job in the background', () => {
    let firstJobId = '';
    registerOpenJobCleanup();
    before(async () => {
      firstJobId = readJobId(await run(['--bg', 'echo first-of-this-block']));
      await run(['wait', firstJobId]);
    });

    it('`logs -f` follows a RUNNING job: a line printed after it started arrives after it, and it ends with the job', async () => {
      const gated = createGatedCommand('gate-logs', { before: 'echo line-1', after: 'echo line-2; echo line-3' });
      const jobId = readJobId(await run(['--bg', gated]));
      const follower = startCli(layout, ['logs', jobId, '-f'], { cwd: project.root, env: flowEnv });
      await waitUntil('line-1 to be followed', 60_000, () => follower.stdout().includes('line-1'));
      assert.ok(!follower.stdout().includes('line-2'), 'line-2 is not printed yet: the gate is shut');
      const openedAtMs = openGate(project, 'gate-logs');
      assert.equal(await waitForExit(follower, afterInterruptTimeoutMs), 0, follower.stderr());
      assert.deepEqual(follower.stdout().split('\n').filter((line) => line.startsWith('line-')), ['line-1', 'line-2', 'line-3']);
      const secondAtMs = follower.chunks.find((chunk) => chunk.text.includes('line-2'))?.atMs ?? 0;
      assert.ok(secondAtMs >= openedAtMs, 'line-2 reached the follower only after the job printed it');
      await run(['wait', jobId]);
    });

    it('waiting is not owning: interrupting `wait` leaves the job running', async () => {
      const jobId = readJobId(await run(['--bg', createDecoyCommand('decoy-waited')]));
      const decoyPid = await waitForPidFile(project, 'decoy-waited.pid');
      const childPid = await waitForPidFile(project, 'decoy-waited.child');
      const waiter = startCli(layout, ['wait', jobId], { cwd: project.root, env: flowEnv });
      // Interrupted only once it really waits on the runner: before that the CLI has not installed its handler (nothing is owned yet).
      await waitForLayoutProcess(layout, 'the wait to run on the runner', (commandLine) => /runner-[0-9a-f]+\.sh wait /.test(commandLine) && commandLine.includes(jobId));
      waiter.child.kill('SIGINT');
      assert.equal(await waitForExit(waiter, afterInterruptTimeoutMs), 130, waiter.stderr());
      await new Promise((resolve) => setTimeout(resolve, 3000));
      assert.equal(checkIsProcessRunning(decoyPid) && checkIsProcessRunning(childPid), true, 'the job went on');
      const killed = await run(['kill', jobId]);
      assert.equal(killed.exitCode, 0, killed.stderr);
      await expectNothingLeft(decoyPid, childPid, 20_000);
    });

    it('the runner cannot redirect a job\'s files: a forged meta.json naming another project changes nothing, and without the main box\'s own record nothing is fetched', async () => {
      const victim = createProject(layout, 'victim', { '.remote-run': 'pull: out\n', 'README.md': 'another project of the same user\n' });
      const jobId = readJobId(await run(['--bg', `sh -c 'mkdir -p out; echo payload > out/forged.txt'`]));
      const exitFile = path.join(project.runnerDirectory, 'jobs', jobId, 'exit');
      await waitUntil('the job to finish', 60_000, () => fs.existsSync(exitFile));
      const metaPath = path.join(project.runnerDirectory, 'jobs', jobId, 'meta.json');
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      fs.writeFileSync(metaPath, JSON.stringify({ ...meta, projectRoot: victim.root, subfolder: '' }));
      const waited = await run(['wait', jobId]);
      assert.equal(waited.exitCode, 0, waited.stderr);
      assert.equal(readProjectFile(project, 'out/forged.txt'), 'payload\n', 'the files went to the project the job was submitted from');
      assert.equal(readProjectFile(victim, 'out/forged.txt'), null, 'and not to the folder the runner named');
      fs.rmSync(path.join(project.root, 'out/forged.txt'));
      fs.rmSync(path.join(layout.cacheDir, 'charness', 'remote-run', 'jobs', `${jobId}.json`));
      const fetched = await run(['fetch', jobId]);
      assert.equal(fetched.exitCode, 125);
      assert.match(fetched.stderr, /did not submit the job as this user/);
      assert.equal(readProjectFile(project, 'out/forged.txt'), null);
      assert.equal(readProjectFile(victim, 'out/forged.txt'), null);
    });

    it('`ls` lists the jobs of this project, `ls --all` those of every project of this user', async () => {
      const other = createProject(layout, 'other', { 'README.md': 'another project\n' });
      const otherJob = readJobId(await run(['--bg', 'true'], { cwd: other.root }));
      await run(['wait', otherJob], { cwd: other.root });
      const ofThisProject = await run(['ls']);
      assert.ok(!ofThisProject.stdout.includes(otherJob), ofThisProject.stdout);
      assert.match(ofThisProject.stdout, new RegExp(firstJobId));
      const everything = await run(['ls', '--all']);
      assert.match(everything.stdout, new RegExp(otherJob));
      assert.match(everything.stdout, new RegExp(firstJobId));
      assert.match(everything.stdout, new RegExp(`${otherJob} +passed .* other `));
      const ofOther = await run(['ls'], { cwd: other.root });
      assert.match(ofOther.stdout, new RegExp(otherJob));
      assert.ok(!ofOther.stdout.includes(firstJobId), ofOther.stdout);
    });
  });

  describe('two jobs of one project', () => {
    registerOpenJobCleanup();
    it('queue, and each runs the tree as it was when IT was submitted; one job\'s result files survive the next job', async () => {
      writeProjectFile(project, 'src/a.txt', 'version A\n');
      // A holds the project lock (it has printed and said so) until the gate opens, so B provably queues behind it.
      const gatedA = createGatedCommand('gate-queue', {
        before: 'cat src/a.txt; echo started > ../queue-a-started',
        after: 'cat src/a.txt; mkdir -p test-results; echo A > test-results/a-result.txt',
      });
      const jobA = readJobId(await run(['--bg', gatedA]));
      await waitUntil('A to hold the project lock', 60_000, () => fs.existsSync(path.join(project.runnerDirectory, 'queue-a-started')));
      writeProjectFile(project, 'src/a.txt', 'version B\n');
      const jobB = readJobId(await run(['--bg', `sh -c 'cat src/a.txt; mkdir -p test-results; echo B > test-results/b-result.txt'`]));
      await waitUntil('B to queue behind A', 60_000, () => fs.readFileSync(path.join(project.runnerDirectory, 'jobs', jobB, 'log'), 'utf8').includes(`waiting for job ${jobA}`));
      openGate(project, 'gate-queue');
      const waitedA = await run(['wait', jobA]);
      const waitedB = await run(['wait', jobB]);
      assert.equal(waitedA.exitCode, 0, waitedA.stderr);
      assert.equal(waitedB.exitCode, 0, waitedB.stderr);
      const logA = (await run(['logs', jobA])).stdout;
      const logB = await run(['logs', jobB]);
      assert.equal(logA.split('version A').length - 1, 2, `A saw its own tree before and after B was submitted:\n${logA}`);
      assert.ok(!logA.includes('version B'), logA);
      assert.match(logB.stdout, /version B/);
      assert.match(logB.stderr, new RegExp(`remote-run: waiting for job ${jobA} of this project`), 'B queued behind A (an own line, so on stderr)');
      assert.equal(readProjectFile(project, 'test-results/a-result.txt'), 'A\n');
      assert.equal(readProjectFile(project, 'test-results/b-result.txt'), 'B\n');
      assert.ok(fs.existsSync(path.join(project.runnerDirectory, 'jobs', jobA, 'artifacts', 'test-results', 'a-result.txt')), 'A\'s files are still on the runner after B ran');
      writeProjectFile(project, 'src/a.txt', 'version A\n');
    });
  });

  describe('an interrupted foreground run', () => {
    registerOpenJobCleanup();
    for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
      it(`${signal} kills the whole remote job and ends with ${exitCode}`, async () => {
        const { cli, decoyPid, childPid } = await startDecoyRun(`decoy-${signal.toLowerCase()}`);
        cli.child.kill(signal);
        assert.equal(await waitForExit(cli, afterInterruptTimeoutMs), exitCode, cli.stderr());
        assert.match(cli.stderr(), /interrupted — job box1-[a-z2-7]{6} was stopped on box1/);
        await expectNothingLeft(decoyPid, childPid, 20_000);
        assert.match(await readNewestJobState(), /\bkilled\b/);
      });
    }

    it('a command that ignores SIGTERM is killed after the runner\'s grace time — nothing is left', async () => {
      const { cli, decoyPid, childPid } = await startDecoyRun('decoy-stubborn', { isIgnoringTerm: true });
      const interruptedAt = Date.now();
      cli.child.kill('SIGINT');
      assert.equal(await waitForExit(cli, afterInterruptTimeoutMs), 130, cli.stderr());
      assert.ok(Date.now() - interruptedAt >= 9000, 'the grace time was given before the kill');
      await expectNothingLeft(decoyPid, childPid, 20_000);
    });
  });

  describe('a foreground run that cannot say goodbye', () => {
    registerOpenJobCleanup();
    it('SIGKILL (no handler runs): the runner kills the job when the caller\'s stream ends — nothing is left', async () => {
      const { cli, decoyPid, childPid } = await startDecoyRun('decoy-sigkill');
      cli.child.kill('SIGKILL');
      await waitForExit(cli, 30_000);
      await expectNothingLeft(decoyPid, childPid, afterLeaseLostTimeoutMs);
    });

    it('a frozen run (SIGSTOP: the connection stays open, the heartbeat stops): the lease runs out and the job is killed', async () => {
      const { cli, decoyPid, childPid } = await startDecoyRun('decoy-frozen');
      const frozenAt = Date.now();
      cli.child.kill('SIGSTOP');
      try {
        await expectNothingLeft(decoyPid, childPid, afterLeaseLostTimeoutMs);
        assert.ok(Date.now() - frozenAt >= flowLeaseMs - 1000, `the job died ${Date.now() - frozenAt} ms after the freeze: before its lease of ${flowLeaseMs} ms could have run out`);
      } finally {
        cli.child.kill('SIGKILL');
        await cli.finished;
      }
    });
  });

  describe('time limits and kill', () => {
    registerOpenJobCleanup();
    it('`--timeout` of a foreground run: 124, and nothing is left', async () => {
      const decoy = createDecoyCommand('decoy-timeout');
      const result = await run(['--timeout', '3s', decoy]);
      assert.equal(result.exitCode, 124, result.stderr);
      assert.match(result.stderr, /timed out after 3s/);
      await expectNothingLeft(await waitForPidFile(project, 'decoy-timeout.pid'), await waitForPidFile(project, 'decoy-timeout.child'), 20_000);
    });

    it('`--timeout` of a background job is the runner\'s own watchdog: `wait` gives 124 and nothing is left', async () => {
      const jobId = readJobId(await run(['--bg', '--timeout', '3s', createDecoyCommand('decoy-bgtimeout')]));
      const decoyPid = await waitForPidFile(project, 'decoy-bgtimeout.pid');
      const childPid = await waitForPidFile(project, 'decoy-bgtimeout.child');
      const waited = await run(['wait', jobId]);
      assert.equal(waited.exitCode, 124, waited.stderr);
      assert.match(waited.stderr, /the job timed out and was killed/);
      await expectNothingLeft(decoyPid, childPid, 20_000);
      assert.match(await readNewestJobState(), /timed out/);
    });

    it('the limit counts from the moment a job is queued: a `--bg` job that waited it out behind a busy group is over when it starts, and never runs', async () => {
      const holder = readJobId(await run(['--bg', '--group', 'emulator', createGatedCommand('gate-qlimit', { before: 'echo started > ../qlimit-holder-started', after: 'true' })]));
      await waitUntil('the holder to hold the emulator group', 60_000, () => fs.existsSync(path.join(project.runnerDirectory, 'qlimit-holder-started')));
      const limitSeconds = 6;
      const waiting = readJobId(await run(['--bg', '--group', 'emulator', '--timeout', `${limitSeconds}s`, "sh -c 'touch ../qlimit-waiting-ran'"]));
      // Counted from the moment the runner queued it (staging takes a variable time), not from when this test asked.
      const queuedAtFile = path.join(project.runnerDirectory, 'jobs', waiting, 'queued-at');
      await waitUntil('the limit to run out while the job is still queued', 60_000, () => fs.existsSync(queuedAtFile) && Date.now() / 1000 - Number(fs.readFileSync(queuedAtFile, 'utf8').trim()) > limitSeconds + 2);
      assert.match((await run(['status', waiting])).stdout, /— queued/, 'it is still waiting for the group');
      openGate(project, 'gate-qlimit');
      assert.equal((await run(['wait', holder])).exitCode, 0);
      const waited = await run(['wait', waiting]);
      assert.equal(waited.exitCode, 124, waited.stderr);
      assert.match(waited.stderr, /the job timed out and was killed/);
      assert.equal(fs.existsSync(path.join(project.runnerDirectory, 'qlimit-waiting-ran')), false, 'its command never ran');
      assert.match(await readNewestJobState(), /timed out/);
    });

    it('`kill <id>` of a background job leaves nothing; `wait` then gives 137', async () => {
      const jobId = readJobId(await run(['--bg', createDecoyCommand('decoy-killed')]));
      const decoyPid = await waitForPidFile(project, 'decoy-killed.pid');
      const childPid = await waitForPidFile(project, 'decoy-killed.child');
      const killed = await run(['kill', jobId]);
      assert.equal(killed.exitCode, 0, killed.stderr);
      await expectNothingLeft(decoyPid, childPid, 20_000);
      const waited = await run(['wait', jobId]);
      assert.equal(waited.exitCode, 137, waited.stderr);
      const status = await run(['status', jobId]);
      assert.match(status.stdout, new RegExp(`^job ${jobId} — killed \\(exit 137\\)`));
    });
  });

  describe('exec', () => {
    registerOpenJobCleanup();
    it('runs in the runner\'s copy as the last job left it, and passes the command\'s code', async () => {
      const listed = await run(['exec', 'ls']);
      assert.equal(listed.exitCode, 0, listed.stderr);
      assert.match(listed.stdout, /^src$/m);
      assert.match(listed.stdout, /^node_modules$/m, 'the runner\'s own folder is there');
      const content = await run(['exec', 'cat src/a.txt']);
      assert.match(content.stdout, /version A/);
      const failing = await run(['exec', "sh -c 'echo to-stderr >&2; exit 9'"]);
      assert.equal(failing.exitCode, 9);
      assert.match(failing.stderr, /to-stderr/, 'exec keeps stderr apart');
    });

    it('is killed like a foreground job: SIGINT ends it and the command with everything it started', async () => {
      const cli = startCli(layout, ['exec', createDecoyCommand('decoy-exec')], { cwd: project.root, env: flowEnv });
      const decoyPid = await waitForPidFile(project, 'decoy-exec.pid');
      const childPid = await waitForPidFile(project, 'decoy-exec.child');
      cli.child.kill('SIGINT');
      assert.equal(await waitForExit(cli, afterInterruptTimeoutMs), 130, cli.stderr());
      await expectNothingLeft(decoyPid, childPid, 20_000);
    });

    it('in a subfolder of the project it runs in that subfolder of the copy', async () => {
      writeProjectFile(project, 'packages/lib/marker.txt', 'in a subfolder\n');
      const result = await run(['sh -c pwd'], { cwd: path.join(project.root, 'packages/lib') });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.ok(result.stdout.trim().endsWith('/tree/packages/lib'), result.stdout);
      const viaExec = await run(['exec', 'cat marker.txt'], { cwd: path.join(project.root, 'packages/lib') });
      assert.match(viaExec.stdout, /in a subfolder/);
    });
  });

  describe('refusals', () => {
    it('a folder that is not a git project is refused with what remote-run needs', async () => {
      const result = await run(['echo', 'x'], { cwd: layout.projectsDir });
      assert.equal(result.exitCode, 125);
      assert.match(result.stderr, /remote-run: .* is not inside a git working tree/);
    });

    it('a capability no runner has fails with the runners view that says why', async () => {
      const result = await run(['--needs', 'ios', 'echo', 'x']);
      assert.equal(result.exitCode, 125);
      assert.match(result.stderr, /no online runner can do "ios"/);
      assert.match(result.stderr, /box1 — online/);
      assert.match(result.stderr, /ios: no \(Linux\)/);
    });

    it('a Pueue group the runner does not have, a runner that is not listed, a bad option: refused before anything is sent', async () => {
      const group = await run(['--group', 'nope', 'echo', 'x']);
      assert.equal(group.exitCode, 125);
      assert.match(group.stderr, /runner "box1" has no Pueue group "nope" \(its groups in runners\.json: default, emulator\)/);
      const unknownRunner = await run(['--runner', 'nope', 'echo', 'x']);
      assert.equal(unknownRunner.exitCode, 2);
      assert.match(unknownRunner.stderr, /no runner named "nope" in runners\.json \(configured: box1\)/);
      const badOption = await run(['--nope', 'echo', 'x']);
      assert.equal(badOption.exitCode, 2);
      assert.match(badOption.stderr, /unknown option: --nope/);
    });


    it('`wait` on a job that does not exist — never submitted, or whose submit failed half-way — says so at once, not «lost the connection» after five retries', async () => {
      const neverSubmitted = await run(['wait', 'box1-zzzzz2'], { timeoutMs: 60_000 });
      assert.equal(neverSubmitted.exitCode, 125);
      assert.match(neverSubmitted.stderr, /remote-run: runner "box1": no such job: box1-zzzzz2/);
      assert.ok(!neverSubmitted.stderr.includes('lost the connection'), neverSubmitted.stderr);
      // A job folder with a description and no Pueue task: what a submit that died after staging leaves behind.
      const halfwayId = 'box1-yyyyy3';
      const halfwayDir = path.join(project.runnerDirectory, 'jobs', halfwayId);
      fs.mkdirSync(halfwayDir, { recursive: true });
      fs.writeFileSync(path.join(halfwayDir, 'meta.json'), '{}');
      const startedAt = Date.now();
      const halfway = await run(['wait', halfwayId], { timeoutMs: 60_000 });
      assert.equal(halfway.exitCode, 125);
      assert.match(halfway.stderr, new RegExp(`remote-run: runner "box1": no such job: ${halfwayId}`));
      assert.ok(Date.now() - startedAt < 30_000, 'no retries: five of them would take 12 s of pauses alone');
      fs.rmSync(halfwayDir, { recursive: true, force: true });
    });

    it('a bad .remote-run is refused with the line to fix', async () => {
      writeRemoteRunConfig('pull: out\ncolour: red\n');
      const result = await run(['echo', 'x']);
      assert.equal(result.exitCode, 125);
      assert.match(result.stderr, /remote-run: \.remote-run line 2: unknown key "colour"/);
      writeRemoteRunConfig(baseRemoteRunConfig);
    });

    it('no runners.json at all: the message names where it belongs', async () => {
      const emptyHome = path.join(layout.root, 'empty-home');
      fs.mkdirSync(emptyHome);
      const result = await run(['runners'], { env: { HOME: emptyHome } });
      assert.equal(result.exitCode, 125);
      assert.match(result.stderr, /no runners are set up: .*\.config\/charness\/runners\.json does not exist/);
    });
  });
});
