/**
 * @description The job script's side of the login session's agent (`remoteRun/runner.sh`, «the login session»): on an always-on Mac a job that needs
 * iOS (`needs-ios`) is refused with «ios build: needs a login of <account>» when no agent beats, `probe` says the same of `ios`, and with an agent its
 * steps go through the request folders — exit code, output in the job's log, a kill, an agent that stops or restarts under a running step. When the
 * link tried to put the agent in place itself and could not (`gui/install-failure`), the refusal and `probe` say to paste a fresh admin line instead of
 * «needs a login». The agent is the REAL one (`guiAgent.ts`, real bash steps) ticked in this process; the script's functions are the real ones, run by `bash` in their own process.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkIsProcessAlive, createGuiAgent, createGuiAgentDeps, readProcessStart, writeGuiAgentStatus, type GuiAgent } from '../runnerUtility/guiAgent';
import { writeGuiAgentInstallFailure } from '../runnerUtility/guiAgentHeal';
import { getRunnerHomePaths } from '../runnerUtility/runnerHome';
import { jobId, scriptPath, slug } from './remoteRunRunnerScriptKit';

let root = '';
let stateDir = '';
let workDir = '';
let jobDir = '';
const paths0 = getRunnerHomePaths('/nonexistent');
let paths = paths0;
let agent: GuiAgent | null = null;
let ticker: NodeJS.Timeout | null = null;
const accountName = os.userInfo().username;
const waitBoundMs = 60_000;
/** How long a step that has recorded its pids is left running before the test cuts it: long enough for the test to read the pids first. */
const stepSettleMs = 200;
/** How often the test's new agent instance beats: well inside the 20 s after which the script calls a heartbeat stale. */
const newInstanceBeatEveryMs = 1000;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gui-session-')));
  paths = getRunnerHomePaths(path.join(root, 'home'));
  stateDir = paths.root;
  workDir = paths.workDir;
  fs.mkdirSync(path.join(stateDir, 'keys'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  fs.writeFileSync(path.join(stateDir, 'service'), 'system-service\n');
  jobDir = path.join(workDir, 'p', slug, 'jobs', jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  fs.mkdirSync(path.join(workDir, 'p', slug, 'tree'), { recursive: true });
  fs.writeFileSync(path.join(jobDir, 'log'), '');
  agent = null;
  ticker = null;
});
afterEach(() => {
  if (ticker !== null) clearInterval(ticker);
  agent?.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

function markNeedsIos(): void {
  fs.writeFileSync(path.join(jobDir, 'needs-ios'), '');
}

/** Run a real agent in this process, looking every 50 ms. */
function startAgent(): GuiAgent {
  const started = createGuiAgent(paths, { ...createGuiAgentDeps(() => ({ PATH: process.env.PATH, HOME: paths.homeDir })), killGraceMs: 300 });
  agent = started;
  fs.mkdirSync(paths.guiRequestsDir, { recursive: true });
  started.tick();
  ticker = setInterval(() => { started.tick(); }, 50);
  return started;
}

interface SourcedRun {
  stdout: string;
  stderr: string;
  status: number | null;
}

/** The job script's functions, `source`d in a process of their own with the job's globals set the way `cmd_job` has them. */
function runSourced(body: string, options: { signalOnceStepWrote?: string } = {}): Promise<SourcedRun> {
  const program = [
    `source ${scriptPath}`,
    `work=${workDir}; slug=${slug}; job=${jobId}; jd=${jobDir}; killed=0; job_locale=C.UTF-8`,
    "trap 'killed=1' TERM",
    body,
  ].join('\n');
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', program], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    if (options.signalOnceStepWrote !== undefined) afterStepWroteInBackground(options.signalOnceStepWrote, () => child.kill('SIGTERM'));
    const bound = setTimeout(() => child.kill('SIGKILL'), waitBoundMs);
    child.on('close', (status) => {
      clearTimeout(bound);
      resolve({ stdout, stderr, status });
    });
  });
}

function runScriptCommand(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync('bash', [scriptPath, ...args], { encoding: 'utf8', env: { ...process.env, PUEUE_BIN: path.join(root, 'no-pueue') }, timeout: 30_000 });
}

describe('a job that needs iOS on an always-on Mac, without a login session', () => {
  it('`submit` and `lease` refuse it with the reason before anything is queued', () => {
    markNeedsIos();
    for (const args of [['submit', workDir, slug, jobId, 'default'], ['lease', workDir, slug, jobId, 'default', '3000']]) {
      const result = runScriptCommand(args);
      assert.equal(result.status, 125, args[0]);
      assert.equal(String(result.stderr).trim(), `remote-run-runner: ios build: needs a login of ${accountName}`, args[0]);
    }
  });

  it('with an agent that beats the refusal is gone (what follows is the queue: no Pueue in this test)', () => {
    markNeedsIos();
    writeGuiAgentStatus(paths, { pid: process.pid, uid: os.userInfo().uid, account: accountName, startedAtMs: Date.now() - 1000, beatAtMs: Date.now() });
    const result = runScriptCommand(['submit', workDir, slug, jobId, 'default']);
    assert.match(String(result.stderr), /pueue add failed/);
    assert.ok(!String(result.stderr).includes('needs a login'));
  });

  it('an agent that stopped beating (stale), or whose process is gone, is no agent', () => {
    markNeedsIos();
    const dead = spawnSync('true');
    writeGuiAgentStatus(paths, { pid: dead.pid ?? 1, uid: 0, account: accountName, startedAtMs: 1, beatAtMs: Date.now() });
    assert.match(String(runScriptCommand(['submit', workDir, slug, jobId, 'default']).stderr), /needs a login of/, 'its process is gone');
    writeGuiAgentStatus(paths, { pid: process.pid, uid: 0, account: accountName, startedAtMs: 1, beatAtMs: Date.now() - 25_000 });
    assert.match(String(runScriptCommand(['submit', workDir, slug, jobId, 'default']).stderr), /needs a login of/, 'its beat is stale');
  });

  describe('when the link could not put the agent in place itself (gui/install-failure)', () => {
    const reason = 'launchctl bootstrap gui/501 failed (Bootstrap failed: 5: Input/output error)';
    const adminText = `ios build: the login session's agent could not be installed (${reason}) - paste a fresh admin line from /runners in an admin account's terminal`;
    const loginText = `ios build: the login session's agent could not be loaded (${reason}) - log out and back in as ${accountName}, or paste a fresh admin line from /runners in an admin account's terminal`;

    it('a definition that could not be written: the refusal of `submit` and `lease` says to paste a fresh admin line, with the reason, instead of «needs a login»', () => {
      markNeedsIos();
      writeGuiAgentInstallFailure(paths, { cure: 'admin', reason });
      for (const args of [['submit', workDir, slug, jobId, 'default'], ['lease', workDir, slug, jobId, 'default', '3000']]) {
        const result = runScriptCommand(args);
        assert.equal(result.status, 125, args[0]);
        assert.equal(String(result.stderr).trim(), `remote-run-runner: ${adminText}`, args[0]);
      }
    });

    it('a definition in place that could not be loaded: logging out and in as the account is the first way out, the admin line the second', () => {
      markNeedsIos();
      writeGuiAgentInstallFailure(paths, { cure: 'login', reason });
      assert.equal(String(runScriptCommand(['submit', workDir, slug, jobId, 'default']).stderr).trim(), `remote-run-runner: ${loginText}`);
    });

    it('the words go with the record: once it is removed (the agent is up, or the account has no session to blame) the refusal is «needs a login» again', () => {
      markNeedsIos();
      writeGuiAgentInstallFailure(paths, { cure: 'login', reason });
      writeGuiAgentInstallFailure(paths, null);
      assert.equal(String(runScriptCommand(['submit', workDir, slug, jobId, 'default']).stderr).trim(), `remote-run-runner: ios build: needs a login of ${accountName}`);
    });

    it('a record with control characters (the account writes it) is printed without them, on one line; a record without a cure word is the admin line\'s', () => {
      markNeedsIos();
      fs.mkdirSync(path.dirname(paths.guiInstallFailure), { recursive: true });
      fs.writeFileSync(paths.guiInstallFailure, `admin bad \u001b[31mred\u001b[0m\u0007 reason\nsecond line\n`);
      const stderr = String(runScriptCommand(['submit', workDir, slug, jobId, 'default']).stderr).trim();
      assert.ok(!/[\u0000-\u0008\u000b-\u001f]/.test(stderr), JSON.stringify(stderr));
      assert.ok(stderr.includes('(bad [31mred[0m reason)'), stderr);
      assert.ok(!stderr.includes('second line'));
      fs.writeFileSync(paths.guiInstallFailure, 'a text with no cure word\n');
      assert.ok(String(runScriptCommand(['submit', workDir, slug, jobId, 'default']).stderr).includes('could not be installed (a text with no cure word) - paste a fresh admin line'));
    });
  });

  it('a job that does not need iOS, and a runner that is not an always-on service, never ask for a session', () => {
    const plain = runScriptCommand(['submit', workDir, slug, jobId, 'default']);
    assert.match(String(plain.stderr), /pueue add failed/);
    markNeedsIos();
    fs.writeFileSync(path.join(stateDir, 'service'), 'user-service\n');
    assert.match(String(runScriptCommand(['submit', workDir, slug, jobId, 'default']).stderr), /pueue add failed/, 'a user service already lives in the session');
    fs.rmSync(path.join(stateDir, 'service'));
    assert.match(String(runScriptCommand(['submit', workDir, slug, jobId, 'default']).stderr), /pueue add failed/, 'run by hand: the terminal is the session');
  });
});

describe('the probe of an always-on Mac', () => {
  /** `probe_slow` of a Mac with Xcode, as a sourced function (the way the probe tests do it). */
  function probeIos(): Record<string, string> {
    const fakeBin = path.join(root, 'fake-bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, 'xcodebuild'), '#!/bin/sh\necho "Xcode 16.2"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(fakeBin, 'xcrun'), '#!/bin/sh\nprintf "    iPhone 16 (AAAA) (Shutdown)\\n"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(fakeBin, 'pueue'), '#!/bin/sh\necho "pueue 4.0.4"\n', { mode: 0o755 });
    const result = spawnSync('bash', ['-c', `source ${scriptPath}; uname() { echo Darwin; }; work=${workDir}; read_runner_state; probe_slow`], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, PUEUE_BIN: path.join(fakeBin, 'pueue') },
      timeout: 60_000,
    });
    const lines: Record<string, string> = {};
    for (const line of result.stdout.split('\n')) {
      const separator = line.indexOf('=');
      if (separator > 0) lines[line.slice(0, separator)] = line.slice(separator + 1);
    }
    return lines;
  }

  it('says «ios build: needs a login of <account>» without an agent — also when the boot check says it passed — and the ordinary answer with one', () => {
    fs.writeFileSync(paths.iosCheck, '{"status":"pass","checkedAtMs":1,"xcode":"16.2","reason":null}\n');
    const without = probeIos();
    assert.equal(without.cap_ios, 'no');
    assert.equal(without.cap_ios_detail, `ios build: needs a login of ${accountName}`);
    writeGuiAgentStatus(paths, { pid: process.pid, uid: 0, account: accountName, startedAtMs: 1, beatAtMs: Date.now() });
    const withAgent = probeIos();
    assert.equal(withAgent.cap_ios, 'yes');
    assert.match(withAgent.cap_ios_detail, /^Xcode 16\.2/);
  });

  it('says what to do, with the reason, when the link could not put the agent in place — log out and in as the account when its definition is there, the admin line when it is not — and not once the agent beats', () => {
    fs.writeFileSync(paths.iosCheck, '{"status":"pass","checkedAtMs":1,"xcode":"16.2","reason":null}\n');
    writeGuiAgentInstallFailure(paths, { cure: 'admin', reason: 'the file could not be written (ENOTDIR)' });
    const withoutDefinition = probeIos();
    assert.equal(withoutDefinition.cap_ios, 'no');
    assert.equal(withoutDefinition.cap_ios_detail, "ios build: the login session's agent could not be installed (the file could not be written (ENOTDIR)) - paste a fresh admin line from /runners in an admin account's terminal");
    writeGuiAgentInstallFailure(paths, { cure: 'login', reason: 'launchctl bootstrap gui/501 failed (Bootstrap failed: 5)' });
    assert.equal(probeIos().cap_ios_detail, `ios build: the login session's agent could not be loaded (launchctl bootstrap gui/501 failed (Bootstrap failed: 5)) - log out and back in as ${accountName}, or paste a fresh admin line from /runners in an admin account's terminal`);
    writeGuiAgentStatus(paths, { pid: process.pid, uid: 0, account: accountName, startedAtMs: 1, beatAtMs: Date.now() });
    assert.equal(probeIos().cap_ios, 'yes', 'an agent that beats is the answer, whatever an old record says');
  });

  it('a runner kept running as a user service (or by hand) gets the old answer: it is in the session already', () => {
    fs.writeFileSync(path.join(stateDir, 'service'), 'user-service\n');
    fs.writeFileSync(paths.iosCheck, '{"status":"pass","checkedAtMs":1,"xcode":"16.2","reason":null}\n');
    assert.equal(probeIos().cap_ios, 'yes');
  });
});

/** A step command that records the pid of its shell (the leader of its group) and of a `sleep` in the group, then waits: what «the group must be gone» is asserted on. */
function createGroupRecordingStep(pidFile: string, options: { isStubborn?: boolean } = {}): string {
  return `${options.isStubborn === true ? "trap \"\" TERM; " : ''}sleep 300 & echo \"$$ $!\" > ${pidFile}; wait`;
}

/** Whether a pid file holds both pids ({@link createGroupRecordingStep} writes them in one line). */
function checkHasBothPids(content: string): boolean {
  return content.trim().includes(' ');
}

/** The step never wrote the file a test waits for: it did not run, or not the way the test expects. */
class StepFileNeverWrittenError extends Error {
  constructor(file: string) {
    super(`the step never wrote ${path.basename(file)} within ${waitBoundMs / 1000} s`);
    this.name = 'StepFileNeverWrittenError';
  }
}

/**
 * Wait, bounded, until the step has written `file` (and `isReady` accepts what it holds): the step is running only then. A fixed
 * delay from the start of the test is NOT that — a loaded machine can take longer than any such delay to start the step at all.
 * At the deadline it throws {@link StepFileNeverWrittenError}: a waiter that gave up must not go on to act.
 */
async function waitForStepFile(file: string, isReady: (content: string) => boolean = () => true): Promise<void> {
  const deadline = Date.now() + waitBoundMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file) && isReady(fs.readFileSync(file, 'utf8'))) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new StepFileNeverWrittenError(file);
}

/** Run `action` a moment ({@link stepSettleMs}) after the step has written `file`; resolves the instant it ran, rejects (without acting) when the file never came. */
async function afterStepWrote(file: string, action: () => void, isReady?: (content: string) => boolean): Promise<number> {
  await waitForStepFile(file, isReady);
  await new Promise((resolve) => setTimeout(resolve, stepSettleMs));
  action();
  return Date.now();
}

/**
 * {@link afterStepWrote} for an action nobody awaits. A step that never wrote its file is the test's own failure to report — the
 * test waits for the same file and names it (`readGroupPids`) — so the waiter just ends, WITHOUT having acted: a test that
 * failed early must not have its waiter fire up to a minute later inside the next test, on the paths and the ticker that are now
 * that test's. Any other error is loud.
 */
function afterStepWroteInBackground(file: string, action: () => void, isReady?: (content: string) => boolean): void {
  afterStepWrote(file, action, isReady).catch((error: unknown) => {
    if (!(error instanceof StepFileNeverWrittenError)) throw error;
  });
}

/** The agent stops looking and beating, as a process that died does (its steps keep running in their process groups). */
function stopAgentTicks(): void {
  if (ticker !== null) clearInterval(ticker);
  ticker = null;
}

/** The agent's session ends: it stops beating and its status is gone, with the step still running in its process group. */
function endAgentSession(): void {
  stopAgentTicks();
  fs.rmSync(paths.guiAgentStatus, { force: true });
}

/** End the agent's session once the step has recorded its pids; resolves the instant of the cut. */
function endAgentSessionOnceStepRuns(pidFile: string): Promise<number> {
  return afterStepWrote(pidFile, endAgentSession, checkHasBothPids);
}

/** {@link endAgentSessionOnceStepRuns} for a test that does not need the instant of the cut. */
function endAgentSessionInBackground(pidFile: string): void {
  afterStepWroteInBackground(pidFile, endAgentSession, checkHasBothPids);
}

async function readGroupPids(pidFile: string): Promise<number[]> {
  await waitForStepFile(pidFile, checkHasBothPids);
  return fs.readFileSync(pidFile, 'utf8').trim().split(' ').map(Number);
}

async function waitForProcessesGone(pids: number[]): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (pids.some((pid) => checkIsProcessAlive(pid)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(pids.filter((pid) => checkIsProcessAlive(pid)), [], 'the step\'s process group is gone');
}

describe('a step of a job that needs iOS, run through the agent', () => {
  it('runs in the agent: its exit code comes back, its output is in the job\'s log, and nothing is left in the request folders', async () => {
    markNeedsIos();
    startAgent();
    const treeDir = path.join(workDir, 'p', slug, 'tree');
    const run = await runSourced(`run_step ${treeDir} 'echo "step in $(basename "$PWD") as $LC_ALL"; exit 5'; echo "code=$step_code"`);
    assert.equal(run.stdout.trim(), 'code=5', run.stderr);
    assert.equal(fs.readFileSync(path.join(jobDir, 'log'), 'utf8'), 'step in tree as C.UTF-8\n');
    assert.deepEqual(fs.readdirSync(paths.guiRequestsDir), []);
  });

  it('the job\'s -e lines reach the step', async () => {
    markNeedsIos();
    startAgent();
    fs.writeFileSync(path.join(jobDir, 'env'), 'GREETING=hello world\n');
    const run = await runSourced(`run_step ${workDir} 'echo "$GREETING"'; echo "code=$step_code"`);
    assert.equal(run.stdout.trim(), 'code=0', run.stderr);
    assert.equal(fs.readFileSync(path.join(jobDir, 'log'), 'utf8'), 'hello world\n');
  });

  it('EVERY job of an always-on Mac runs its steps through the agent while the login session exists — a build that was not marked `--needs ios` included (it would crash in the System session)', async () => {
    startAgent();
    const treeDir = path.join(workDir, 'p', slug, 'tree');
    const run = await runSourced(`run_step ${treeDir} 'echo "in $(basename "$PWD") through the agent"; exit 3'; echo "code=$step_code"`);
    assert.equal(run.stdout.trim(), 'code=3', run.stderr);
    assert.equal(fs.readFileSync(path.join(jobDir, 'log'), 'utf8'), 'in tree through the agent\n', 'the agent wrote it: the script ran nothing itself');
    assert.deepEqual(fs.readdirSync(paths.guiRequestsDir), [], 'and left nothing behind');
  });

  it('with no session a job that does not need iOS still runs in the daemon, as it always did — only `--needs ios` is refused', async () => {
    const run = await runSourced(`run_step ${workDir} 'echo local'; echo "code=$step_code"`);
    assert.equal(run.stdout.trim(), 'local\ncode=0', run.stderr);
    assert.equal(fs.existsSync(paths.guiRequestsDir), false);
    const stale = os.userInfo().uid;
    writeGuiAgentStatus(paths, { pid: process.pid, uid: stale, account: accountName, startedAtMs: 1, beatAtMs: Date.now() - 25_000 });
    const staleRun = await runSourced(`run_step ${workDir} 'echo still local'; echo "code=$step_code"`);
    assert.equal(staleRun.stdout.trim(), 'still local\ncode=0', 'an agent whose beat is stale is no session');
  });

  it('a job that is not an always-on Mac\'s (a user service, run by hand) runs where it is even with an agent heartbeat lying about: it is already in a session', async () => {
    startAgent();
    fs.writeFileSync(path.join(stateDir, 'service'), 'user-service\n');
    const run = await runSourced(`run_step ${workDir} 'echo local'; echo "code=$step_code"`);
    assert.equal(run.stdout.trim(), 'local\ncode=0', run.stderr);
    assert.deepEqual(fs.readdirSync(paths.guiRequestsDir), []);
  });

  it('SIGTERM to the job script (a kill) reaches the step through the agent: it ends with 143 and the script goes on', async () => {
    markNeedsIos();
    startAgent();
    const marker = path.join(root, 'long.started');
    const run = await runSourced(`run_step ${workDir} 'touch ${marker}; exec sleep 300'; echo "code=$step_code"`, { signalOnceStepWrote: marker });
    assert.ok(fs.existsSync(marker), 'the step started before the signal');
    assert.equal(run.stdout.trim(), 'code=143', run.stderr);
  });

  it('an agent that is gone under a running step (the process died: no exit file will ever come) cuts it with 125, says so — and the step\'s whole process group is GONE before the job goes on', async () => {
    markNeedsIos();
    startAgent();
    const pidFile = path.join(root, 'cut.pids');
    // The agent process dying: nothing looks at the folder any more and its heartbeat is gone. Its step, a process group of its own, is still running.
    endAgentSessionInBackground(pidFile);
    const running = runSourced(`run_step ${workDir} '${createGroupRecordingStep(pidFile)}'; echo "code=$step_code"`);
    const pids = await readGroupPids(pidFile);
    assert.ok(pids.every((pid) => checkIsProcessAlive(pid)), 'the step is running');
    const run = await running;
    assert.deepEqual(run.stdout.trim().split('\n'), ["remote-run: the login session's agent stopped while this step ran: the step was cut", 'code=125'], run.stderr);
    for (const pid of pids) assert.equal(checkIsProcessAlive(pid), false, `pid ${pid} is gone by the time the script goes on (the lock is released next)`);
  });

  it('a step that ignores TERM is killed after the grace — the script never goes on with an orphan running in the tree', async () => {
    markNeedsIos();
    startAgent();
    const pidFile = path.join(root, 'stubborn.pids');
    const cutAt = endAgentSessionOnceStepRuns(pidFile);
    cutAt.catch(() => {}); // a step that never wrote its file fails where `cutAt` and the pids are awaited, below, by name
    const run = await runSourced(`kill_grace_sec=1; run_step ${workDir} '${createGroupRecordingStep(pidFile, { isStubborn: true })}'; echo "code=$step_code"`);
    assert.equal(run.stdout.trim().split('\n').at(-1), 'code=125', run.stderr);
    assert.ok(Date.now() - (await cutAt) >= 900, 'the grace was given before the kill');
    for (const pid of await readGroupPids(pidFile)) assert.equal(checkIsProcessAlive(pid), false, `pid ${pid}`);
  });

  it('a SIGKILL that takes its time to land (a loaded machine delivers it when the process is next scheduled) is waited for: the script goes on only when the whole group is gone, never beside a member that is still dying', async () => {
    markNeedsIos();
    startAgent();
    const pidFile = path.join(root, 'slow-kill.pids');
    endAgentSessionInBackground(pidFile);
    // `kill -KILL` returns at once and the signal lands 0.8 s later, as a machine that is busy elsewhere delivers it; every other signal is the shell's own.
    const slowKill = 'kill() { case "$1" in -KILL) ( sleep 0.8; builtin kill "$@" ) > /dev/null 2>&1 & ;; *) builtin kill "$@" ;; esac; }';
    const run = await runSourced(`${slowKill}; kill_grace_sec=1; run_step ${workDir} '${createGroupRecordingStep(pidFile, { isStubborn: true })}'; echo "code=$step_code"`);
    assert.equal(run.stdout.trim().split('\n').at(-1), 'code=125', run.stderr);
    for (const pid of await readGroupPids(pidFile)) assert.equal(checkIsProcessAlive(pid), false, `pid ${pid} is gone by the time the script goes on (the lock is released next)`);
    assert.ok(!run.stdout.includes('still alive after SIGKILL'), 'a group that did die says nothing');
  });

  it('a group that is STILL there after SIGKILL and the bounded wait does not hold the script for ever — and the job\'s output says so, instead of the lock being released in silence', async () => {
    markNeedsIos();
    startAgent();
    const pidFile = path.join(root, 'survivor.pids');
    endAgentSessionInBackground(pidFile);
    // A SIGKILL that never lands: `kill -KILL` succeeds and does nothing, every other signal is the shell's own. Two looks (0.4 s) of waiting instead of ten.
    const lostKill = 'kill() { case "$1" in -KILL) return 0 ;; *) builtin kill "$@" ;; esac; }';
    let pids: number[] = [];
    try {
      const run = await runSourced(`${lostKill}; kill_grace_sec=1; kill_settle_polls=2; run_step ${workDir} '${createGroupRecordingStep(pidFile, { isStubborn: true })}'; echo "code=$step_code"`);
      pids = await readGroupPids(pidFile);
      const lines = run.stdout.trim().split('\n');
      assert.equal(lines.at(-1), 'code=125', run.stderr);
      assert.ok(lines.some((line) => /^remote-run: the step's process group \(\d+\) is still alive after SIGKILL: the job goes on, and its lock is released, beside it$/.test(line)), run.stdout);
      assert.ok(pids.some((pid) => checkIsProcessAlive(pid)), 'the survivors are really there — this is the branch the line is for');
    } finally {
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
  });

  it('an agent that came back as ANOTHER instance (a restart) has lost the step: it is cut with 125, never waited for — and its group is ended', async () => {
    markNeedsIos();
    const first = startAgent();
    const pidFile = path.join(root, 'restarted.pids');
    const beatAsNewInstance = (): void => {
      writeGuiAgentStatus(paths, { pid: process.pid, uid: os.userInfo().uid, account: accountName, startedAtMs: first.getStartedAtMs() + 123_456, beatAtMs: Date.now() });
    };
    afterStepWroteInBackground(pidFile, () => {
      // The first instance is gone for good, as in a real restart: were it to keep beating, its next beat (every 5 s) would write its own
      // start time back over the new instance's, and the script — it looks about once a second, far less often on a loaded machine —
      // could miss the other instance altogether and wait for a step nobody answers. The NEW instance, on the other hand, is alive and
      // keeps beating: the agent is never «gone» (`gui_agent_alive` stays true), so the ONLY thing that can cut the step is that it
      // started at another time. Without this beat the step would be cut anyway ~20 s later, by the stale heartbeat, and the test
      // would pass without the restart check it is named for.
      stopAgentTicks();
      beatAsNewInstance();
      ticker = setInterval(beatAsNewInstance, newInstanceBeatEveryMs);
    }, checkHasBothPids);
    const run = await runSourced(`run_step ${workDir} '${createGroupRecordingStep(pidFile)}'; echo "code=$step_code"`);
    assert.equal(run.stdout.trim().split('\n').at(-1), 'code=125', run.stderr);
    assert.match(run.stdout, /the login session's agent stopped while this step ran/);
    await waitForProcessesGone(await readGroupPids(pidFile));
  });

  it('a job that needs iOS, with no agent beating, is refused AT THE STEP with the reason: code 125, no request written (an agent that appears a moment later must not start a step nobody waits for)', async () => {
    markNeedsIos();
    const run = await runSourced(`run_step ${workDir} 'echo never'; echo "code=$step_code"`);
    assert.deepEqual(run.stdout.trim().split('\n'), [`remote-run: ios build: needs a login of ${accountName}`, 'code=125'], run.stderr);
    assert.equal(fs.existsSync(paths.guiRequestsDir), false, 'no request folder was written');
  });

  it('the script records its own pid AND its start time in the request, in the very form the agent compares (`ps -o lstart=`, whitespace squeezed) — a reused pid is told from the script by it', async () => {
    markNeedsIos();
    startAgent();
    const running = runSourced(`run_step ${workDir} 'sleep 2'; echo "code=$step_code"`);
    const requestDir = path.join(paths.guiRequestsDir, `${jobId}.1`);
    const deadline = Date.now() + waitBoundMs;
    // The shell creates the file before `ps` has said what goes in it: wait for the content, not the file.
    while (!(fs.existsSync(path.join(requestDir, 'owner-start')) && fs.readFileSync(path.join(requestDir, 'owner-start'), 'utf8').trim() !== '') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    const ownerPid = Number(fs.readFileSync(path.join(requestDir, 'owner'), 'utf8'));
    const recorded = fs.readFileSync(path.join(requestDir, 'owner-start'), 'utf8').trim();
    const known = readProcessStart(ownerPid);
    assert.equal(known.kind, 'known');
    assert.equal(recorded, known.kind === 'known' ? known.text : '', 'the script and the agent read the same start for the same process');
    assert.equal((await running).stdout.trim(), 'code=0');
  });

  it('a restarted agent that answered 125 and ended the group only with TERM: a step that ignores TERM is ended by the SCRIPT before it goes on — the lock is not released beside a live group', async () => {
    markNeedsIos();
    startAgent();
    const pidFile = path.join(root, 'cut-answer.pids');
    const running = runSourced(`kill_grace_sec=1; run_step ${workDir} '${createGroupRecordingStep(pidFile, { isStubborn: true })}'; echo "code=$step_code"`);
    const pids = await readGroupPids(pidFile);
    // The next instance: it finds the step, TERMs its group (ignored), answers 125 with `cut`, and — its own grace being a minute — would KILL it long after the script went on.
    if (ticker !== null) clearInterval(ticker);
    createGuiAgent(paths, { ...createGuiAgentDeps(() => ({ PATH: process.env.PATH, HOME: paths.homeDir })), killGraceMs: 60_000 });
    const run = await running;
    assert.equal(run.stdout.trim().split('\n').at(-1), 'code=125', run.stderr);
    for (const pid of pids) assert.equal(checkIsProcessAlive(pid), false, `pid ${pid} is gone by the time the script goes on`);
  });

  describe('gui_end_step_group signals only the group that was recorded', () => {
    function startDecoy(): Promise<{ pgid: number; sleepPid: number; start: string }> {
      const pidFile = path.join(root, `decoy-${Math.random().toString(36).slice(2)}.pid`);
      const child = spawn('sh', ['-c', `sleep 300 & echo $! > "${pidFile}"; wait`], { detached: true, stdio: 'ignore' });
      child.unref();
      return (async () => {
        const deadline = Date.now() + waitBoundMs;
        while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
        const start = readProcessStart(child.pid ?? 0);
        assert.equal(start.kind, 'known');
        return { pgid: child.pid ?? 0, sleepPid: Number(fs.readFileSync(pidFile, 'utf8').trim()), start: start.kind === 'known' ? start.text : '' };
      })();
    }

    it('a group whose leader has the recorded start is ended; one whose pid now has ANOTHER start (a reused pid) is left alone — and so is a request with no start recorded', async () => {
      const decoy = await startDecoy();
      const folder = path.join(root, 'request-folder');
      fs.mkdirSync(folder);
      fs.writeFileSync(path.join(folder, 'pgid'), `${decoy.pgid}\n`);
      const withoutStart = await runSourced(`kill_grace_sec=1; gui_end_step_group ${folder}`);
      assert.equal(checkIsProcessAlive(decoy.sleepPid), true, 'no start recorded: nothing is signalled');
      assert.equal(withoutStart.stderr, '', 'and nothing is said into the job\'s output about the file that is not there');
      const emptyFolder = path.join(root, 'empty-request-folder');
      fs.mkdirSync(emptyFolder);
      const nothingRecorded = await runSourced(`kill_grace_sec=1; gui_end_step_group ${emptyFolder}`);
      assert.equal(nothingRecorded.stderr, '', 'a step the agent never picked up has neither file');
      fs.writeFileSync(path.join(folder, 'pgid-start'), 'Mon Jan  1 00:00:00 2001\n');
      await runSourced(`kill_grace_sec=1; gui_end_step_group ${folder}`);
      assert.equal(checkIsProcessAlive(decoy.sleepPid), true, 'another start: the pid is somebody else\'s now');
      fs.writeFileSync(path.join(folder, 'pgid-start'), `${decoy.start}\n`);
      await runSourced(`kill_grace_sec=1; gui_end_step_group ${folder}`);
      const deadline = Date.now() + 15_000;
      while (checkIsProcessAlive(decoy.sleepPid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(checkIsProcessAlive(decoy.sleepPid), false, 'the recorded group is ended');
    });

    it('a damaged id (empty, text, 0, 1) is never signalled', async () => {
      const decoy = await startDecoy();
      const folder = path.join(root, 'damaged-folder');
      fs.mkdirSync(folder);
      for (const text of ['', 'abc', '0', '1', '-7']) {
        fs.writeFileSync(path.join(folder, 'pgid'), text);
        fs.writeFileSync(path.join(folder, 'pgid-start'), `${decoy.start}\n`);
        const run = await runSourced(`kill_grace_sec=1; gui_end_step_group ${folder}; echo done`);
        assert.equal(run.stdout.trim(), 'done', text);
      }
      assert.equal(checkIsProcessAlive(decoy.sleepPid), true);
      process.kill(-decoy.pgid, 'SIGKILL');
    });
  });

  it('a step the agent cannot start (its folder is gone) comes back as 126', async () => {
    markNeedsIos();
    startAgent();
    const run = await runSourced(`run_step ${path.join(root, 'gone')} 'echo never'; echo "code=$step_code"`);
    assert.equal(run.stdout.trim(), 'code=126', run.stderr);
  });
});
