/**
 * @description `runnerUtility/guiAgent.ts`: the login session's agent of an always-on Mac, with real `bash` steps on a real folder. The request
 * protocol `runner.sh` speaks (cwd / command / locale / log / env / owner, then `go`): a step runs in the folder with the job's environment and its
 * own `-e` lines, its output lands in the job's log, its exit code in `exit`; a `kill` file ends it (TERM, KILL after the grace), a vanished job
 * script ends it too; a request is never started twice; a stopped agent leaves no heartbeat; an update restarts an idle agent.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  checkIsGuiAgentAlive,
  checkIsProcessAlive,
  createGuiAgent,
  createGuiAgentDeps,
  guiAgentBeatIntervalMs,
  guiAgentStaleAfterMs,
  parseJobEnvLines,
  readGuiAgentStatus,
  readProcessStart,
  runGuiAgent,
  writeGuiAgentStatus,
  type GuiAgent,
  type GuiAgentDeps,
} from '../runnerUtility/guiAgent';
import { restartExitCode } from '../runnerUtility/appInstall';
import { planSimulatorWork, runGuiAgentCommand } from '../runnerUtility/runnerCommands';
import { writeRunnerConfig } from '../runnerUtility/runnerConfig';
import { getRunnerHomePaths } from '../runnerUtility/runnerHome';
import { getGuiAgentFile } from '../runnerUtility/serviceCommon';
import { getServiceNames } from '../runnerUtility/serviceUnits';
import { generateEd25519KeyPair } from '../runners/sshKeys';

let root = '';
let paths = getRunnerHomePaths('/nonexistent');
const waitBoundMs = 30_000;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gui-agent-')));
  paths = getRunnerHomePaths(path.join(root, 'home'));
  fs.mkdirSync(paths.guiRequestsDir, { recursive: true });
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function createDeps(overrides: Partial<GuiAgentDeps> = {}): GuiAgentDeps {
  return { ...createGuiAgentDeps(() => ({ PATH: process.env.PATH, HOME: path.join(root, 'home'), BASE_VAR: 'from the link' })), killGraceMs: 300, ...overrides };
}

interface RequestOptions {
  command: string;
  directory?: string;
  jobEnv?: string;
  locale?: string;
  ownerPid?: number;
}

function writeRequest(id: string, options: RequestOptions): { dir: string; log: string } {
  const dir = path.join(paths.guiRequestsDir, id);
  const log = path.join(root, `${id}.log`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'cwd'), options.directory ?? root);
  fs.writeFileSync(path.join(dir, 'command'), options.command);
  fs.writeFileSync(path.join(dir, 'locale'), options.locale ?? 'C.UTF-8');
  fs.writeFileSync(path.join(dir, 'log'), log);
  fs.writeFileSync(path.join(dir, 'env'), options.jobEnv ?? '');
  fs.writeFileSync(path.join(dir, 'owner'), `${options.ownerPid ?? process.pid}`);
  fs.writeFileSync(path.join(dir, 'go'), '');
  return { dir, log };
}

async function tickUntil(agent: GuiAgent, description: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + waitBoundMs;
  while (!check() && Date.now() < deadline) {
    agent.tick();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(check(), `${description} did not happen within ${waitBoundMs} ms`);
}

function readExit(dir: string): string | null {
  try {
    return fs.readFileSync(path.join(dir, 'exit'), 'utf8').trim();
  } catch {
    return null;
  }
}

describe('the heartbeat file', () => {
  it('is one JSON line the job script can read, and reads back what was written', () => {
    writeGuiAgentStatus(paths, { pid: 4242, uid: 501, account: 'runner', startedAtMs: 1_000, beatAtMs: 2_000 });
    assert.equal(fs.readFileSync(paths.guiAgentStatus, 'utf8'), '{"pid":4242,"uid":501,"account":"runner","startedAtMs":1000,"beatAtMs":2000}\n');
    assert.deepEqual(readGuiAgentStatus(paths), { pid: 4242, uid: 501, account: 'runner', startedAtMs: 1_000, beatAtMs: 2_000 });
  });

  it('a missing or damaged file is no status', () => {
    assert.equal(readGuiAgentStatus(paths), null);
    fs.writeFileSync(paths.guiAgentStatus, '{not json');
    assert.equal(readGuiAgentStatus(paths), null);
  });

  it('the agent is alive while its beat is fresh AND its process is there — the same rule as `gui_agent_alive` of runner.sh', () => {
    const status = { pid: 4242, uid: 501, account: 'runner', startedAtMs: 0, beatAtMs: 100_000 };
    const alive = (): boolean => true;
    assert.equal(checkIsGuiAgentAlive(status, 100_000 + guiAgentStaleAfterMs, alive), true);
    assert.equal(checkIsGuiAgentAlive(status, 100_000 + guiAgentStaleAfterMs + 1, alive), false);
    assert.equal(checkIsGuiAgentAlive(status, 100_000, () => false), false);
    assert.equal(checkIsGuiAgentAlive(null, 100_000, alive), false);
    assert.ok(guiAgentBeatIntervalMs * 2 < guiAgentStaleAfterMs, 'a missed beat or two is not «gone»');
  });

  it('`runner.sh` carries the same staleness: gui_agent_stale_sec is the agent\'s', () => {
    const script = fs.readFileSync(path.join(__dirname, '..', '..', 'remoteRun', 'runner.sh'), 'utf8');
    assert.match(script, new RegExp(`^gui_agent_stale_sec=${guiAgentStaleAfterMs / 1000}$`, 'm'));
  });
});

describe('parseJobEnvLines', () => {
  it('takes NAME=VALUE lines as runner.sh exports them: everything after the first = is the value, quotes included; bad lines are skipped', () => {
    assert.deepEqual(parseJobEnvLines('A=1\nB=x=y\nC="q"\nD=\n1BAD=x\nno pair\n\n'), { A: '1', B: 'x=y', C: '"q"', D: '' });
  });
});

describe('a step of a job', () => {
  it('runs in its folder with the link\'s environment, the locale and the job\'s own -e lines (which win); its output goes to the job\'s log and its code to `exit`', async () => {
    const agent = createGuiAgent(paths, createDeps());
    const workDir = path.join(root, 'tree');
    fs.mkdirSync(workDir);
    const { dir, log } = writeRequest('job1.1', { command: 'echo "in $(basename "$PWD")"; echo "$BASE_VAR|$LC_ALL|$FOO"; echo oops >&2; exit 7', directory: workDir, jobEnv: 'FOO=bar\nLC_ALL=en_US.UTF-8\n' });
    fs.writeFileSync(log, 'remote-run: the job script wrote this first\n');
    await tickUntil(agent, 'the exit code', () => readExit(dir) !== null);
    assert.equal(readExit(dir), '7');
    assert.equal(fs.readFileSync(log, 'utf8'), 'remote-run: the job script wrote this first\nin tree\nfrom the link|en_US.UTF-8|bar\noops\n');
    assert.equal(agent.getRunningCount(), 0);
  });

  it('is started once: a request already started, by this agent or an earlier one, is not started again', async () => {
    const agent = createGuiAgent(paths, createDeps());
    const marker = path.join(root, 'ran');
    const { dir } = writeRequest('job2.1', { command: `echo run >> "${marker}"` });
    await tickUntil(agent, 'the exit code', () => readExit(dir) !== null);
    for (let look = 0; look < 5; look += 1) agent.tick();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(fs.readFileSync(marker, 'utf8'), 'run\n');
    const earlier = writeRequest('job3.1', { command: `echo run >> "${marker}"` });
    fs.writeFileSync(path.join(earlier.dir, 'started'), `${Date.now()}\n`);
    for (let look = 0; look < 5; look += 1) agent.tick();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(fs.readFileSync(marker, 'utf8'), 'run\n', 'the step an earlier agent started is not run again');
    assert.equal(readExit(earlier.dir), null);
  });

  it('a request that is not whole (no `go` yet) waits', async () => {
    const agent = createGuiAgent(paths, createDeps());
    const { dir } = writeRequest('job4.1', { command: 'exit 3' });
    fs.rmSync(path.join(dir, 'go'));
    for (let look = 0; look < 5; look += 1) agent.tick();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(readExit(dir), null);
    fs.writeFileSync(path.join(dir, 'go'), '');
    await tickUntil(agent, 'the exit code', () => readExit(dir) !== null);
    assert.equal(readExit(dir), '3');
  });

  it('a folder that is gone ends the step with 126, as `cd` failing does in the job script', async () => {
    const agent = createGuiAgent(paths, createDeps());
    const { dir } = writeRequest('job5.1', { command: 'echo never', directory: path.join(root, 'no-such-folder') });
    await tickUntil(agent, 'the exit code', () => readExit(dir) !== null);
    assert.equal(readExit(dir), '126');
  });

  it('a script that removed the request folder while its step ran (it cut the step) is no crash of the agent when the step\'s end is noticed — nobody is left to read the code', async () => {
    const agent = createGuiAgent(paths, createDeps());
    const started = path.join(root, 'cut-away.started');
    const { dir } = writeRequest('job12.1', { command: `touch "${started}"; exec sleep 300` });
    await tickUntil(agent, 'the step to start', () => fs.existsSync(started) && fs.existsSync(path.join(dir, 'pgid')));
    const pgid = Number(fs.readFileSync(path.join(dir, 'pgid'), 'utf8').trim());
    const failures: Error[] = [];
    const onUncaught = (error: Error): void => { failures.push(error); };
    process.on('uncaughtException', onUncaught);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      process.kill(-pgid, 'SIGKILL');
      await tickUntil(agent, 'the step to be noticed as ended', () => agent.getRunningCount() === 0);
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      process.off('uncaughtException', onUncaught);
    }
    assert.deepEqual(failures.map((failure) => failure.message), [], 'no uncaught exception');
    assert.equal(fs.existsSync(dir), false, 'and the folder is not made again for an answer nobody will read');
  });

  it('a `kill` file ends the step\'s whole process group with TERM; one that ignores TERM is killed after the grace — nothing is left', async () => {
    const agent = createGuiAgent(paths, createDeps());
    const pidFile = path.join(root, 'stubborn.pids');
    const { dir } = writeRequest('job6.1', { command: `trap '' TERM; sleep 300 & echo "$$ $!" > "${pidFile}"; wait` });
    await tickUntil(agent, 'the step to start', () => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim().includes(' '));
    const [shellPid, sleepPid] = fs.readFileSync(pidFile, 'utf8').trim().split(' ').map(Number);
    const killedAt = Date.now();
    fs.writeFileSync(path.join(dir, 'kill'), '');
    await tickUntil(agent, 'the exit code', () => readExit(dir) !== null);
    assert.equal(readExit(dir), '137', 'SIGKILL after the grace: 128 + 9');
    assert.ok(Date.now() - killedAt >= 250, 'the grace time was given before the kill');
    await tickUntil(agent, 'the processes to be gone', () => !checkIsProcessAlive(shellPid) && !checkIsProcessAlive(sleepPid));
  });

  it('a step that obeys TERM ends at once with 143', async () => {
    const agent = createGuiAgent(paths, createDeps());
    const started = path.join(root, 'obedient.started');
    const { dir } = writeRequest('job7.1', { command: `touch "${started}"; exec sleep 300` });
    await tickUntil(agent, 'the step to start', () => fs.existsSync(started));
    fs.writeFileSync(path.join(dir, 'kill'), '');
    await tickUntil(agent, 'the exit code', () => readExit(dir) !== null);
    assert.equal(readExit(dir), '143');
  });

  it('a job script that is gone ends its step — the dead owner\'s request folder is removed too, one that never started included', async () => {
    const agent = createGuiAgent(paths, createDeps());
    const dead = spawnSync('true');
    assert.ok(dead.pid !== undefined);
    const started = path.join(root, 'orphan.started');
    const running = writeRequest('job8.1', { command: `touch "${started}"; exec sleep 300` });
    await tickUntil(agent, 'the step to start', () => fs.existsSync(started));
    fs.writeFileSync(path.join(running.dir, 'owner'), `${dead.pid}`);
    await tickUntil(agent, 'the exit code', () => readExit(running.dir) !== null);
    assert.equal(readExit(running.dir), '143');
    const never = writeRequest('job9.1', { command: 'echo never', ownerPid: dead.pid });
    await tickUntil(agent, 'its folder to go', () => !fs.existsSync(never.dir));
    assert.equal(fs.existsSync(never.log), false, 'nothing ran for a script that is gone');
  });
});

/** A process group an agent never saw die: a shell that is the leader of its group and a `sleep` in it (`isStubborn`: both ignore TERM). Returns the group's id and the sleeper's pid. */
async function startOrphanGroup(name: string, isStubborn = false): Promise<{ pgid: number; sleepPid: number; start: string }> {
  const pidFile = path.join(root, `${name}.pids`);
  const child = spawn('sh', ['-c', `${isStubborn ? "trap '' TERM; " : ''}sleep 300 & echo $! > "${pidFile}"; wait`], { detached: true, stdio: 'ignore' });
  child.unref();
  const deadline = Date.now() + waitBoundMs;
  while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(child.pid !== undefined && fs.existsSync(pidFile), 'the orphan group started');
  const start = readProcessStart(child.pid ?? 0);
  assert.equal(start.kind, 'known', 'the leader of the orphan group is there');
  return { pgid: child.pid ?? 0, sleepPid: Number(fs.readFileSync(pidFile, 'utf8').trim()), start: start.kind === 'known' ? start.text : '' };
}

/** What an agent that died under a step left in the request folder: the group's id and the start time of its leader (written start first, as the agent does). */
function recordGroup(dir: string, group: { pgid: number; start: string }): void {
  fs.writeFileSync(path.join(dir, 'pgid-start'), `${group.start}\n`);
  fs.writeFileSync(path.join(dir, 'pgid'), `${group.pgid}\n`);
}

describe('a step is a process group of its own, and a cut ends the group', () => {
  it('the request folder carries the group id: the step\'s own pid, the leader of its group', async () => {
    const agent = createGuiAgent(paths, createDeps());
    const pidFile = path.join(root, 'leader.pid');
    const { dir } = writeRequest('job20.1', { command: `echo $$ > "${pidFile}"; exec sleep 300` });
    await tickUntil(agent, 'the step to start', () => fs.existsSync(pidFile) && fs.existsSync(path.join(dir, 'pgid')));
    const leader = fs.readFileSync(pidFile, 'utf8').trim();
    assert.equal(fs.readFileSync(path.join(dir, 'pgid'), 'utf8').trim(), leader);
    assert.equal(spawnSync('ps', ['-o', 'pgid=', '-p', leader], { encoding: 'utf8' }).stdout.trim(), leader, 'a group of its own: its pgid is its pid');
    fs.writeFileSync(path.join(dir, 'kill'), '');
    await tickUntil(agent, 'the exit code', () => readExit(dir) !== null);
  });

  it('an agent that starts ends the groups of the one before it — a stubborn one after the grace — and answers a script that still waits with 125', async () => {
    const polite = await startOrphanGroup('polite');
    const stubborn = await startOrphanGroup('stubborn', true);
    const waiting = writeRequest('job21.1', { command: 'echo never' });
    const stubbornRequest = writeRequest('job21.2', { command: 'echo never' });
    for (const [request, group] of [[waiting, polite], [stubbornRequest, stubborn]] as const) {
      fs.writeFileSync(path.join(request.dir, 'started'), `${Date.now()}\n`);
      recordGroup(request.dir, group);
    }
    const agent = createGuiAgent(paths, createDeps());
    await tickUntil(agent, 'both groups to be gone', () => !checkIsProcessAlive(polite.sleepPid) && !checkIsProcessAlive(stubborn.sleepPid) && !checkIsProcessAlive(stubborn.pgid));
    assert.equal(readExit(waiting.dir), '125');
    assert.equal(readExit(stubbornRequest.dir), '125');
    assert.equal(fs.existsSync(waiting.log), false, 'the step was not run again');
  });

  it('...and removes the folder of a script that is gone, its group ended too', async () => {
    const orphan = await startOrphanGroup('orphan-of-a-dead-script');
    const dead = spawnSync('true');
    const request = writeRequest('job22.1', { command: 'echo never', ownerPid: dead.pid });
    fs.writeFileSync(path.join(request.dir, 'started'), `${Date.now()}\n`);
    recordGroup(request.dir, orphan);
    const agent = createGuiAgent(paths, createDeps());
    await tickUntil(agent, 'the group to be gone and the folder removed', () => !checkIsProcessAlive(orphan.sleepPid) && !fs.existsSync(request.dir));
  });

  it('a script that is gone while ITS agent is running another instance\'s step: the group of the step this agent does not know is ended too', async () => {
    const agent = createGuiAgent(paths, createDeps());
    const orphan = await startOrphanGroup('orphan-seen-later');
    const dead = spawnSync('true');
    const request = writeRequest('job23.1', { command: 'echo never', ownerPid: dead.pid });
    fs.writeFileSync(path.join(request.dir, 'started'), `${Date.now()}\n`);
    recordGroup(request.dir, orphan);
    await tickUntil(agent, 'the group to be gone and the folder removed', () => !checkIsProcessAlive(orphan.sleepPid) && !fs.existsSync(request.dir));
  });

  it('a damaged or nonsensical pgid (empty, text, 1, 0) never signals anything', async () => {
    const agent = createGuiAgent(paths, createDeps({ signalGroup: () => { throw new Error('nothing may be signalled'); } }));
    const dead = spawnSync('true');
    for (const [index, text] of ['', 'abc', '1', '0', '-5'].entries()) {
      const request = writeRequest(`job24.${index}`, { command: 'echo never', ownerPid: dead.pid });
      fs.writeFileSync(path.join(request.dir, 'started'), `${Date.now()}\n`);
      fs.writeFileSync(path.join(request.dir, 'pgid'), text);
      fs.writeFileSync(path.join(request.dir, 'pgid-start'), 'Mon Jan  1 00:00:00 2001\n');
    }
    await tickUntil(agent, 'the folders to be removed', () => fs.readdirSync(paths.guiRequestsDir).length === 0);
  });
});

describe('a folder on disk is not trusted: an earlier boot, a reused pid', () => {
  const longAgoMs = (): number => Date.now() - 10 * 60 * 1000;
  /** The system booted a second ago, whatever the real one did: what the folders below were written before. */
  const bootedJustNow = (): number => Date.now() - 1000;

  async function stepFolderOf(name: string, group: { pgid: number; start: string }, startedAtMs: number, options: { ownerPid?: number; ownerStart?: string } = {}): Promise<{ dir: string; log: string }> {
    const request = writeRequest(name, { command: 'echo never', ownerPid: options.ownerPid });
    fs.writeFileSync(path.join(request.dir, 'started'), `${startedAtMs}\n`);
    recordGroup(request.dir, group);
    if (options.ownerStart !== undefined) fs.writeFileSync(path.join(request.dir, 'owner-start'), `${options.ownerStart}\n`);
    return request;
  }

  async function lookAtThem(agent: GuiAgent, check: () => boolean, description: string): Promise<void> {
    await tickUntil(agent, description, check);
    for (let look = 0; look < 6; look += 1) {
      agent.tick();
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }

  it('a folder from before the system booted is removed with NOTHING signalled — the group its pgid names is somebody else\'s now (Finder, the Dock, the agent itself): the decoy survives, whether the agent starts after the folder or sees it later', async () => {
    const decoy = await startOrphanGroup('decoy-after-reboot');
    const request = await stepFolderOf('job30.1', decoy, longAgoMs());
    const agent = createGuiAgent(paths, createDeps({ getBootTimeMs: bootedJustNow, signalGroup: () => { throw new Error('nothing may be signalled for a folder of an earlier boot'); } }));
    await lookAtThem(agent, () => !fs.existsSync(request.dir), 'the stale folder to be removed');
    assert.equal(checkIsProcessAlive(decoy.sleepPid), true, 'the decoy group lives');
    assert.equal(checkIsProcessAlive(decoy.pgid), true);

    const later = await stepFolderOf('job30.2', decoy, longAgoMs());
    await lookAtThem(agent, () => !fs.existsSync(later.dir), 'the stale folder written after the agent started to be removed');
    assert.equal(checkIsProcessAlive(decoy.sleepPid), true, 'still alive');
    process.kill(-decoy.pgid, 'SIGKILL');
  });

  it('a request that never started but was written before the boot is not run either — its script died with the boot, and a reused pid must not make it look alive', async () => {
    const marker = path.join(root, 'stale-ran');
    const request = writeRequest('job31.1', { command: `touch "${marker}"` });
    fs.utimesSync(path.join(request.dir, 'go'), new Date(longAgoMs()), new Date(longAgoMs()));
    const agent = createGuiAgent(paths, createDeps({ getBootTimeMs: bootedJustNow }));
    await lookAtThem(agent, () => !fs.existsSync(request.dir), 'the stale request to be removed');
    assert.equal(fs.existsSync(marker), false, 'the step of an earlier boot was not run');
  });

  it('within one boot a recorded group is signalled only while its leader still has the recorded start: a decoy that took the pid over is left alone', async () => {
    const decoy = await startOrphanGroup('decoy-same-boot');
    const dead = spawnSync('true');
    const request = await stepFolderOf('job32.1', { pgid: decoy.pgid, start: 'Mon Jan  1 00:00:00 2001' }, Date.now(), { ownerPid: dead.pid });
    const agent = createGuiAgent(paths, createDeps({ signalGroup: () => { throw new Error('a group with another start must not be signalled'); } }));
    await lookAtThem(agent, () => !fs.existsSync(request.dir), 'the folder of the dead script to be removed');
    assert.equal(checkIsProcessAlive(decoy.sleepPid), true, 'the decoy group lives');
    process.kill(-decoy.pgid, 'SIGKILL');
  });

  it('a recorded start that cannot be checked (no `ps`) signals nothing — and a missing start record signals nothing', async () => {
    const decoy = await startOrphanGroup('decoy-no-ps');
    const dead = spawnSync('true');
    const noStart = writeRequest('job33.1', { command: 'echo never', ownerPid: dead.pid });
    fs.writeFileSync(path.join(noStart.dir, 'started'), `${Date.now()}\n`);
    fs.writeFileSync(path.join(noStart.dir, 'pgid'), `${decoy.pgid}\n`);
    const unknown = await stepFolderOf('job33.2', decoy, Date.now(), { ownerPid: dead.pid });
    const agent = createGuiAgent(paths, createDeps({ readProcessStart: () => ({ kind: 'unknown' }), signalGroup: () => { throw new Error('nothing may be signalled'); } }));
    await lookAtThem(agent, () => !fs.existsSync(noStart.dir) && !fs.existsSync(unknown.dir), 'both folders to be removed');
    assert.equal(checkIsProcessAlive(decoy.sleepPid), true);
    process.kill(-decoy.pgid, 'SIGKILL');
  });

  it('a leader that is gone while its group still has members is still the group (a pid is not handed out while a group carries it): the members are ended', async () => {
    const gate = path.join(root, 'leader-may-go');
    const pidFile = path.join(root, 'leaderless.pids');
    const leader = spawn('sh', ['-c', `sleep 300 & echo $! > "${pidFile}"; while [ ! -f "${gate}" ]; do sleep 0.05; done; exit 0`], { detached: true, stdio: 'ignore' });
    leader.unref();
    const deadline = Date.now() + waitBoundMs;
    while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    const start = readProcessStart(leader.pid ?? 0);
    assert.equal(start.kind, 'known');
    const sleepPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    fs.writeFileSync(gate, '');
    while (checkIsProcessAlive(leader.pid ?? 0) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(checkIsProcessAlive(sleepPid), true, 'the leader is gone, a member of its group is not');
    const dead = spawnSync('true');
    const request = await stepFolderOf('job34.1', { pgid: leader.pid ?? 0, start: start.kind === 'known' ? start.text : '' }, Date.now(), { ownerPid: dead.pid });
    const agent = createGuiAgent(paths, createDeps());
    await tickUntil(agent, 'the leaderless group to be gone', () => !checkIsProcessAlive(sleepPid));
    await tickUntil(agent, 'the folder to be removed', () => !fs.existsSync(request.dir));
  });

  it('the job script\'s pid counts as alive only while it is still that process: a live pid with another start (reused after a boot) is a script that is gone — its request is removed, not started, not answered', async () => {
    const marker = path.join(root, 'reused-owner-ran');
    const reused = writeRequest('job35.1', { command: `touch "${marker}"`, ownerPid: process.pid });
    fs.writeFileSync(path.join(reused.dir, 'owner-start'), 'Mon Jan  1 00:00:00 2001\n');
    const agent = createGuiAgent(paths, createDeps());
    await lookAtThem(agent, () => !fs.existsSync(reused.dir), 'the request of the reused pid to be removed');
    assert.equal(fs.existsSync(marker), false, 'the step was not run');

    const own = readProcessStart(process.pid);
    assert.equal(own.kind, 'known');
    const genuine = writeRequest('job35.2', { command: 'exit 4', ownerPid: process.pid });
    fs.writeFileSync(path.join(genuine.dir, 'owner-start'), `${own.kind === 'known' ? own.text : ''}\n`);
    await tickUntil(agent, 'the exit code', () => readExit(genuine.dir) !== null);
    assert.equal(readExit(genuine.dir), '4', 'a script that IS the recorded process gets its step run');
  });

  it('a request folder removed between the agent reading it and starting it is no crash and no step: `started` is written without making the folder, and nothing runs for a script that is gone', async () => {
    const marker = path.join(root, 'gone-before-start');
    const request = writeRequest('job36.1', { command: `touch "${marker}"; exec sleep 300` });
    let isRemoved = false;
    const reported: string[] = [];
    const agent = createGuiAgent(paths, createDeps({
      reportError: (line) => reported.push(line),
      // The look at the script's pid is the last thing before the step starts: the script cuts its step and removes the folder right then.
      isProcessAlive: (pid) => {
        if (!isRemoved && pid === process.pid) {
          isRemoved = true;
          fs.rmSync(request.dir, { recursive: true, force: true });
        }
        return checkIsProcessAlive(pid);
      },
    }));
    for (let look = 0; look < 8; look += 1) {
      agent.tick();
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(isRemoved, true);
    assert.deepEqual(reported, [], 'a folder that is gone is not even an error to report');
    assert.equal(fs.existsSync(request.dir), false, 'the folder was not made again');
    assert.equal(fs.existsSync(marker), false, 'no step was started for it');
    assert.equal(agent.getRunningCount(), 0);
  });

  it('a group that cannot be recorded (the `pgid` file cannot be written) is ended at once — it must not run where no cut could find it — and the answer is 126', async () => {
    const pidFile = path.join(root, 'unrecorded.pid');
    const reported: string[] = [];
    const agent = createGuiAgent(paths, createDeps({ reportError: (line) => reported.push(line) }));
    const { dir } = writeRequest('job37.1', { command: `echo $$ > "${pidFile}"; exec sleep 300` });
    // A folder where the file should go: the rename of `pgid` fails with something that is not «the request is gone».
    fs.mkdirSync(path.join(dir, 'pgid'));
    await tickUntil(agent, 'the answer', () => readExit(dir) !== null);
    assert.equal(readExit(dir), '126');
    assert.match(reported.join('\n'), /the process group of a step could not be recorded/);
    await tickUntil(agent, 'the step\'s process to be gone', () => fs.existsSync(pidFile) && !checkIsProcessAlive(Number(fs.readFileSync(pidFile, 'utf8').trim())));
    assert.equal(agent.getRunningCount(), 0);
  });

  it('a request that cannot be handled at all is told and the agent goes on with the others: one bad folder never takes the agent down', async () => {
    const reported: string[] = [];
    let isFirstRead = true;
    const agent = createGuiAgent(paths, createDeps({
      reportError: (line) => reported.push(line),
      readEnv: () => {
        if (isFirstRead) {
          isFirstRead = false;
          throw new Error('the environment cannot be read');
        }
        return { PATH: process.env.PATH, HOME: paths.homeDir };
      },
    }));
    const first = writeRequest('job38.1', { command: 'exit 0' });
    agent.tick();
    assert.match(reported.join('\n'), /could not be handled \(job38\.1: the environment cannot be read\)/);
    fs.rmSync(first.dir, { recursive: true, force: true });
    const second = writeRequest('job38.2', { command: 'exit 6' });
    await tickUntil(agent, 'the other request to be answered', () => readExit(second.dir) !== null);
    assert.equal(readExit(second.dir), '6');
  });
});

describe('the agent itself', () => {
  it('runGuiAgent leaves with `removed` when its always-on service is gone — asked no oftener than the interval says', async () => {
    let nowMs = 1_000_000;
    let isRemoved = false;
    let questions = 0;
    const result = runGuiAgent(paths, createDeps({ now: () => nowMs }), { signal: new AbortController().signal, getAppId: () => 'app-a', checkIsServiceRemoved: () => { questions += 1; return isRemoved; }, serviceCheckIntervalMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(questions, 0, 'the interval has not passed');
    nowMs += 5_000;
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(questions, 1);
    isRemoved = true;
    nowMs += 5_000;
    assert.equal(await result, 'removed');
    assert.equal(fs.existsSync(paths.guiAgentStatus), false);
  });

  it('beats on its first look and keeps beating, with its pid, account and start', () => {
    let nowMs = 1_000_000;
    const agent = createGuiAgent(paths, createDeps({ now: () => nowMs, pid: 4242, uid: 501, account: 'runner' }));
    agent.tick();
    assert.deepEqual(readGuiAgentStatus(paths), { pid: 4242, uid: 501, account: 'runner', startedAtMs: 1_000_000, beatAtMs: 1_000_000 });
    nowMs += guiAgentBeatIntervalMs - 1;
    agent.tick();
    assert.equal(readGuiAgentStatus(paths)?.beatAtMs, 1_000_000, 'not before the interval');
    nowMs += 1;
    agent.tick();
    assert.deepEqual([readGuiAgentStatus(paths)?.beatAtMs, readGuiAgentStatus(paths)?.startedAtMs], [1_000_000 + guiAgentBeatIntervalMs, 1_000_000]);
  });

  it('stopping removes the heartbeat at once, so the runner says «no session» now and not twenty seconds later', () => {
    const agent = createGuiAgent(paths, createDeps());
    agent.tick();
    assert.notEqual(readGuiAgentStatus(paths), null);
    agent.stop();
    assert.equal(fs.existsSync(paths.guiAgentStatus), false);
  });

  it('runGuiAgent runs until aborted and leaves no heartbeat; an update (another package copy) makes an IDLE agent leave for a restart, a busy one finishes first', async () => {
    const controller = new AbortController();
    let appId = 'app-a';
    const stoppedRun = runGuiAgent(paths, createDeps(), { signal: controller.signal, getAppId: () => appId });
    const deadline = Date.now() + waitBoundMs;
    while (readGuiAgentStatus(paths) === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.notEqual(readGuiAgentStatus(paths), null, 'it beats at once');
    controller.abort();
    assert.equal(await stoppedRun, 'stopped');
    assert.equal(fs.existsSync(paths.guiAgentStatus), false);

    const busyMarker = path.join(root, 'busy.started');
    const request = writeRequest('job10.1', { command: `touch "${busyMarker}"; sleep 1` });
    const restartRun = runGuiAgent(paths, createDeps(), { signal: new AbortController().signal, getAppId: () => appId });
    while (!fs.existsSync(busyMarker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    appId = 'app-b';
    assert.equal(await restartRun, 'restart');
    assert.notEqual(readExit(request.dir), null, 'the step that was running finished before the agent left');
  });
});

describe('`charness-runner gui-agent`, the command a LaunchAgent runs', () => {
  let daemonsDir = '';
  let linkPlist = '';
  let agentPlist = '';
  let output = '';

  function pair(): void {
    fs.mkdirSync(paths.root, { recursive: true });
    writeRunnerConfig(paths, {
      runnerId: 'abcdef012345',
      name: 'mac',
      hub: { host: 'host.example', port: 22, user: 'hubuser', hostKey: generateEd25519KeyPair('h').publicKey, publicKey: generateEd25519KeyPair('p').publicKey, label: '@ExampleBot' },
      packageId: null,
      pairedAtMs: 1,
    });
  }

  beforeEach(() => {
    pair();
    const names = getServiceNames(paths.root);
    daemonsDir = path.join(root, 'LaunchDaemons');
    fs.mkdirSync(daemonsDir);
    linkPlist = path.join(daemonsDir, `${names.launchdLink}.plist`);
    fs.writeFileSync(linkPlist, '');
    agentPlist = getGuiAgentFile(paths.homeDir, names);
    fs.mkdirSync(path.dirname(agentPlist), { recursive: true });
    fs.writeFileSync(agentPlist, 'the agent\'s own definition');
    output = '';
  });

  const io = { stdout: (text: string): void => { output += text; }, stderr: (text: string): void => { output += text; } };

  async function waitForHeartbeat(): Promise<void> {
    const deadline = Date.now() + waitBoundMs;
    while (readGuiAgentStatus(paths) === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.notEqual(readGuiAgentStatus(paths), null, `the agent never beat; ${output}`);
  }

  it('beats while its service is there and ends with 0 when stopped, leaving its definition for the next login', async () => {
    const controller = new AbortController();
    const running = runGuiAgentCommand(io, paths.homeDir, { launchDaemonsDir: daemonsDir, serviceCheckIntervalMs: 100, signal: controller.signal });
    await waitForHeartbeat();
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.notEqual(readGuiAgentStatus(paths), null, 'the service is there: it stays');
    controller.abort();
    assert.equal(await running, 0);
    assert.equal(fs.existsSync(agentPlist), true);
    assert.equal(fs.existsSync(paths.guiAgentStatus), false);
  });

  it('the daemons removed by an admin: the agent removes ITS OWN definition and leaves for good — no command of the admin\'s had to name the account\'s folders', async () => {
    const running = runGuiAgentCommand(io, paths.homeDir, { launchDaemonsDir: daemonsDir, serviceCheckIntervalMs: 100, signal: new AbortController().signal });
    await waitForHeartbeat();
    fs.rmSync(linkPlist);
    const result = await Promise.race([running, new Promise<'still running'>((resolve) => { setTimeout(() => resolve('still running'), waitBoundMs); })]);
    assert.equal(result, 0);
    assert.equal(fs.existsSync(agentPlist), false);
    assert.equal(fs.existsSync(paths.guiAgentStatus), false);
    assert.match(output, /the always-on service of this account was removed: the login session's agent removes itself and leaves/);
  });

  it('an update (another package copy behind `current`) makes it leave with the restart code, which launchd reads as «start me again»', async () => {
    const appA = path.join(paths.root, 'app.aaaa');
    const appB = path.join(paths.root, 'app.bbbb');
    fs.mkdirSync(appA);
    fs.mkdirSync(appB);
    fs.symlinkSync(appA, paths.currentApp);
    const running = runGuiAgentCommand(io, paths.homeDir, { launchDaemonsDir: daemonsDir, serviceCheckIntervalMs: 60_000, signal: new AbortController().signal });
    await waitForHeartbeat();
    fs.rmSync(paths.currentApp);
    fs.symlinkSync(appB, paths.currentApp);
    const result = await Promise.race([running, new Promise<'still running'>((resolve) => { setTimeout(() => resolve('still running'), waitBoundMs); })]);
    assert.equal(result, restartExitCode);
    assert.equal(fs.existsSync(agentPlist), true, 'it comes back as itself');
  });

  it('an account that is not paired (removed, unpaired by hand) has nothing to do: it ends with 0 — which launchd does not restart — and beats no more', async () => {
    fs.rmSync(paths.config);
    assert.equal(await runGuiAgentCommand(io, paths.homeDir, { launchDaemonsDir: daemonsDir, signal: new AbortController().signal }), 0);
    assert.match(output, /this account is not paired: the login session's agent has nothing to do and ends/);
    assert.equal(fs.existsSync(paths.guiAgentStatus), false);
  });
});

describe('who does the Simulator work', () => {
  it('on an always-on Mac the login session\'s agent does the check and the silencing — the daemon link does neither', () => {
    assert.deepEqual(planSimulatorWork('darwin', 'system-service'), { linkChecksSimulator: false, linkSilencesSimulators: false });
  });

  it('a Mac link that is in a login session itself (a user service, `charness-runner run`) checks AND silences: jobs and link share the session, so the Simulators a job boots are the ones the silencer lists', () => {
    for (const kind of ['user-service', null]) assert.deepEqual(planSimulatorWork('darwin', kind), { linkChecksSimulator: true, linkSilencesSimulators: true }, String(kind));
  });

  it('off a Mac there is no Simulator to silence (the check records «skipped» as before)', () => {
    for (const kind of ['user-service', 'system-service', null]) assert.deepEqual(planSimulatorWork('linux', kind), { linkChecksSimulator: true, linkSilencesSimulators: false }, String(kind));
  });
});
