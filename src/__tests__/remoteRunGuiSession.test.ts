/**
 * @description The job script's side of the login session's agent (`remoteRun/runner.sh`, «the login session»): on an always-on Mac a job that needs
 * iOS (`needs-ios`) is refused with «ios build: needs a login of <account>» when no agent beats, `probe` says the same of `ios`, and with an agent its
 * steps go through the request folders — exit code, output in the job's log, a kill, an agent that stops or restarts under a running step. The agent
 * is the REAL one (`guiAgent.ts`, real bash steps) ticked in this process; the script's functions are the real ones, run by `bash` in their own process.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkIsProcessAlive, createGuiAgent, createGuiAgentDeps, writeGuiAgentStatus, type GuiAgent } from '../runnerUtility/guiAgent';
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
function runSourced(body: string, options: { signalAfterMs?: number } = {}): Promise<SourcedRun> {
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
    if (options.signalAfterMs !== undefined) setTimeout(() => child.kill('SIGTERM'), options.signalAfterMs);
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

async function readGroupPids(pidFile: string): Promise<number[]> {
  const deadline = Date.now() + waitBoundMs;
  while (!(fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim().includes(' ')) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
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

  it('a job that does not need iOS runs its steps where it is, with no agent involved', async () => {
    const run = await runSourced(`run_step ${workDir} 'echo local'; echo "code=$step_code"`);
    assert.equal(run.stdout.trim(), 'local\ncode=0', run.stderr);
    assert.equal(fs.existsSync(paths.guiRequestsDir), false);
  });

  it('SIGTERM to the job script (a kill) reaches the step through the agent: it ends with 143 and the script goes on', async () => {
    markNeedsIos();
    startAgent();
    const marker = path.join(root, 'long.started');
    const run = await runSourced(`run_step ${workDir} 'touch ${marker}; exec sleep 300'; echo "code=$step_code"`, { signalAfterMs: 1500 });
    assert.ok(fs.existsSync(marker), 'the step started before the signal');
    assert.equal(run.stdout.trim(), 'code=143', run.stderr);
  });

  it('an agent that is gone under a running step (the process died: no exit file will ever come) cuts it with 125, says so — and the step\'s whole process group is GONE before the job goes on', async () => {
    markNeedsIos();
    startAgent();
    const pidFile = path.join(root, 'cut.pids');
    // The agent process dying: nothing looks at the folder any more and its heartbeat is gone. Its step, a process group of its own, is still running.
    setTimeout(() => { if (ticker !== null) clearInterval(ticker); fs.rmSync(paths.guiAgentStatus, { force: true }); }, 1500);
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
    setTimeout(() => { if (ticker !== null) clearInterval(ticker); fs.rmSync(paths.guiAgentStatus, { force: true }); }, 1500);
    const cutAt = Date.now() + 1500;
    const run = await runSourced(`kill_grace_sec=1; run_step ${workDir} '${createGroupRecordingStep(pidFile, { isStubborn: true })}'; echo "code=$step_code"`);
    assert.equal(run.stdout.trim().split('\n').at(-1), 'code=125', run.stderr);
    assert.ok(Date.now() - cutAt >= 900, 'the grace was given before the kill');
    for (const pid of await readGroupPids(pidFile)) assert.equal(checkIsProcessAlive(pid), false, `pid ${pid}`);
  });

  it('an agent that came back as ANOTHER instance (a restart) has lost the step: it is cut with 125, never waited for — and its group is ended', async () => {
    markNeedsIos();
    const first = startAgent();
    const pidFile = path.join(root, 'restarted.pids');
    setTimeout(() => {
      writeGuiAgentStatus(paths, { pid: process.pid, uid: os.userInfo().uid, account: accountName, startedAtMs: first.getStartedAtMs() + 123_456, beatAtMs: Date.now() });
    }, 1500);
    const run = await runSourced(`run_step ${workDir} '${createGroupRecordingStep(pidFile)}'; echo "code=$step_code"`);
    assert.equal(run.stdout.trim().split('\n').at(-1), 'code=125', run.stderr);
    assert.match(run.stdout, /the login session's agent stopped while this step ran/);
    await waitForProcessesGone(await readGroupPids(pidFile));
  });

  it('a step the agent cannot start (its folder is gone) comes back as 126', async () => {
    markNeedsIos();
    startAgent();
    const run = await runSourced(`run_step ${path.join(root, 'gone')} 'echo never'; echo "code=$step_code"`);
    assert.equal(run.stdout.trim(), 'code=126', run.stderr);
  });
});
