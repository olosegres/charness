/**
 * @description Several jobs on one runner at the same time, against a REAL Pueue (a private `pueued`, the real `runner.sh` subcommands as the hub calls them over ssh, real job processes): the limit of the `default` group decides how many jobs
 * run side by side (two jobs of two projects overlap with 2, do not with 1); a limit LOWERED while jobs run stops none of them - both finish - and the next job starts only after both have (Pueue's `parallel` gates starts only, which the
 * `/runners` picker promises); and a job whose project has another job under way takes no slot («adding the job to Pueue» in `runner.sh`): it is stashed, so a job of ANOTHER project starts at once, and it is enqueued when its
 * predecessor ends - in submit order, one at a time - or, when the predecessor was SIGKILLed before it could say so, by the next `probe` or `prepare`. A stashed job can be waited for and killed. Every "running at the same time" is
 * a state the test holds with a gate file, not a sleep; the one thing that cannot be gated, "it did NOT start", is observed over a hold of a few seconds, after the positive facts it depends on.
 *
 * Needs Pueue and rsync (the job's apply step): a local run without them is SKIPPED with the reason, CI installs them and fails without. Test case: N/A — Charness has no Jira tracker.
 */

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const scriptPath = path.resolve(__dirname, '..', '..', 'remoteRun', 'runner.sh');
const isCi = process.env.CI === 'true' || process.env.CI === '1';
const missingTools = ['pueue', 'pueued', 'rsync', 'bash'].filter((tool) => spawnSync('which', [tool], { stdio: 'ignore' }).status !== 0);
const skipReason = !isCi && missingTools.length > 0 ? `missing here: ${missingTools.join(', ')} (CI has them)` : false;

/** How long "it did not start" is watched: Pueue starts a free slot's task within about a second. */
const holdMs = 3000;
const startBoundMs = 45_000;
const pollMs = 50;

let root = '';
let workDir = '';
let marksDir = '';
let pueueBin = '';
let pueueConfig = '';
let currentLimit = 1;
/** Every job a test submitted: released and waited for after it, so one failing test cannot hold the next one's slots. */
let submitted: Array<{ slug: string; jobId: string }> = [];
const children = new Set<ChildProcess>();

function getEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, PUEUE_BIN: pueueBin, PUEUE_CONFIG: pueueConfig };
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runScript(args: string[]): Run {
  const result = spawnSync('bash', [scriptPath, ...args], { encoding: 'utf8', env: getEnvironment(), timeout: 120_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function stopPueueSync(): void {
  for (const child of children) child.kill('SIGKILL');
  children.clear();
  if (pueueConfig !== '' && fs.existsSync(path.join(root, 'pueue', 'run', 'pueue.pid'))) spawnSync(pueueBin, ['-c', pueueConfig, 'shutdown'], { stdio: 'ignore', timeout: 15_000 });
  for (const pidFile of findJobPidFiles()) {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 1) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }
}

function findJobPidFiles(): string[] {
  const files: string[] = [];
  const projectsDir = path.join(workDir, 'p');
  if (!fs.existsSync(projectsDir)) return files;
  for (const slug of fs.readdirSync(projectsDir)) {
    const jobsDir = path.join(projectsDir, slug, 'jobs');
    if (!fs.existsSync(jobsDir)) continue;
    for (const jobId of fs.readdirSync(jobsDir)) {
      const pidFile = path.join(jobsDir, jobId, 'pid');
      if (fs.existsSync(pidFile)) files.push(pidFile);
    }
  }
  return files;
}

const markFile = (name: string, kind: 'started' | 'go' | 'ended'): string => path.join(marksDir, `${name}.${kind}`);
const jobFolder = (slug: string, jobId: string): string => path.join(workDir, 'p', slug, 'jobs', jobId);
const readExit = (slug: string, jobId: string): string | null => {
  const file = path.join(jobFolder(slug, jobId), 'exit');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null;
};

async function waitUntil(description: string, check: () => boolean, limitMs = startBoundMs): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Watch for `holdMs` that `check` stays true: the way to observe that something did NOT happen. */
async function expectToStayTrue(description: string, check: () => boolean): Promise<void> {
  const until = Date.now() + holdMs;
  while (Date.now() < until) {
    assert.ok(check(), description);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * The job of a test: says it started, waits for its gate (`<name>.go`, bounded), says it ended. A job is named `<slug>-<n>`; the project copy is the slug.
 */
function createGatedCommand(name: string): string {
  return `touch '${markFile(name, 'started')}'; waited=0; while [ ! -f '${markFile(name, 'go')}' ] && [ $waited -lt 1200 ]; do sleep 0.1; waited=$((waited+1)); done; touch '${markFile(name, 'ended')}'`;
}

/** Everything the hub's calls do for a background job: `prepare` (with the runner's limit), the staged files, `submit`. The job's name is its mark name. */
function submitJob(slug: string, jobId: string, options: { command?: string } = {}): void {
  const prepared = runScript(['prepare', workDir, slug, jobId, `default=${currentLimit}`]);
  assert.equal(prepared.status, 0, prepared.stderr);
  const folder = jobFolder(slug, jobId);
  const stage = path.join(workDir, 'p', slug, 'stage', jobId);
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, 'a.txt'), 'x');
  fs.writeFileSync(path.join(folder, 'manifest'), 'a.txt\n');
  fs.writeFileSync(path.join(folder, 'subfolder'), '');
  fs.writeFileSync(path.join(folder, 'cmd'), options.command ?? createGatedCommand(jobId));
  fs.writeFileSync(path.join(folder, 'timeout-sec'), '300');
  const result = runScript(['submit', workDir, slug, jobId, 'default']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'queued');
  submitted.push({ slug, jobId });
}

function setLimit(limit: number): void {
  const applied = runScript(['apply-groups', workDir, `default=${limit}`]);
  assert.equal(applied.status, 0, applied.stderr);
  currentLimit = limit;
}

const release = (jobId: string): void => fs.writeFileSync(markFile(jobId, 'go'), '');
const hasStarted = (jobId: string): boolean => fs.existsSync(markFile(jobId, 'started'));
const hasEnded = (jobId: string): boolean => fs.existsSync(markFile(jobId, 'ended'));

/** The state word Pueue gives the task of `jobId` (`Running`, `Queued`, `Stashed`, `Done`, …), or null when it has none. */
function readPueueState(jobId: string): string | null {
  const status = runScript(['pueue', workDir, 'status', '--json']);
  assert.equal(status.status, 0, status.stderr);
  const tasks = (JSON.parse(status.stdout) as { tasks: Record<string, { label: string | null; status: string | Record<string, unknown> }> }).tasks;
  const task = Object.values(tasks).find((candidate) => candidate.label === `rr-${jobId}`);
  if (task === undefined) return null;
  return typeof task.status === 'string' ? task.status : Object.keys(task.status)[0];
}

/** The job is over: it wrote its result, or it was SIGKILLed (a process that was recorded and is gone writes none). */
function hasJobEnded(slug: string, jobId: string): boolean {
  if (readExit(slug, jobId) !== null) return true;
  const pidFile = path.join(jobFolder(slug, jobId), 'pid');
  if (!fs.existsSync(pidFile)) return false;
  try {
    process.kill(Number(fs.readFileSync(pidFile, 'utf8').trim()), 0);
    return false;
  } catch {
    return true;
  }
}

const readMarkTime = (jobId: string, kind: 'started' | 'ended'): number => fs.statSync(markFile(jobId, kind)).mtimeMs;

describe('jobs side by side on one runner, against a real Pueue', { skip: skipReason }, () => {
  before(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sched-')));
    workDir = path.join(root, 'work');
    marksDir = path.join(root, 'marks');
    fs.mkdirSync(marksDir, { recursive: true });
    fs.mkdirSync(path.join(root, 'pueue', 'run'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(root, 'pueue', 'data'), { recursive: true });
    pueueBin = spawnSync('which', ['pueue'], { encoding: 'utf8' }).stdout.trim();
    pueueConfig = path.join(root, 'pueue', 'pueue.yml');
    fs.writeFileSync(pueueConfig, ['shared:', `  pueue_directory: ${path.join(root, 'pueue', 'data')}`, `  runtime_directory: ${path.join(root, 'pueue', 'run')}`, '  use_unix_socket: true', `  unix_socket_path: ${path.join(root, 'pueue', 'run', 'pueue.socket')}`, `  pid_path: ${path.join(root, 'pueue', 'run', 'pueue.pid')}`, ''].join('\n'));
    process.on('exit', stopPueueSync);
    setLimit(1);
  });

  after(() => {
    stopPueueSync();
    process.off('exit', stopPueueSync);
    fs.rmSync(root, { recursive: true, force: true });
  });

  afterEach(async () => {
    // Whatever a test left running is let go and waited for, so the next test starts with every slot free.
    for (const { jobId } of submitted) release(jobId);
    for (const { slug, jobId } of submitted) {
      try {
        await waitUntil(`${jobId} to end`, () => hasJobEnded(slug, jobId), 60_000);
      } catch {
        runScript(['kill', workDir, slug, jobId]);
      }
    }
    submitted = [];
    for (const child of children) child.kill('SIGKILL');
    children.clear();
  });

  describe('the limit of the default group', () => {
    it('with 2, two jobs of two projects run AT THE SAME TIME: both have started while neither has been let go', async () => {
      setLimit(2);
      submitJob('l2-p', 'l2-p-1');
      submitJob('l2-q', 'l2-q-1');
      await waitUntil('both jobs to start', () => hasStarted('l2-p-1') && hasStarted('l2-q-1'));
      assert.equal(hasEnded('l2-p-1') || hasEnded('l2-q-1'), false, 'neither has ended: they overlap');
      release('l2-p-1');
      release('l2-q-1');
      await waitUntil('both to end', () => readExit('l2-p', 'l2-p-1') !== null && readExit('l2-q', 'l2-q-1') !== null);
      assert.deepEqual([readExit('l2-p', 'l2-p-1'), readExit('l2-q', 'l2-q-1')], ['0', '0']);
    });

    it('with 1 they do not: the second starts only after the first has ended', async () => {
      setLimit(1);
      submitJob('l1-p', 'l1-p-1');
      submitJob('l1-q', 'l1-q-1');
      await waitUntil('the first job to start', () => hasStarted('l1-p-1'));
      await expectToStayTrue('the second job must not start while the first runs', () => !hasStarted('l1-q-1'));
      release('l1-p-1');
      await waitUntil('the second job to start', () => hasStarted('l1-q-1'));
      assert.ok(hasEnded('l1-p-1'), 'it started after the first had ended');
      assert.ok(readMarkTime('l1-q-1', 'started') >= readMarkTime('l1-p-1', 'ended'));
      release('l1-q-1');
      await waitUntil('the second to end', () => readExit('l1-q', 'l1-q-1') !== null);
    });

    it('LOWERED from 2 to 1 while two jobs run: both go on and finish, and the third starts only after BOTH have ended', async () => {
      setLimit(2);
      submitJob('lw-p', 'lw-p-1');
      submitJob('lw-q', 'lw-q-1');
      submitJob('lw-r', 'lw-r-1');
      await waitUntil('the first two to start', () => hasStarted('lw-p-1') && hasStarted('lw-q-1'));
      await expectToStayTrue('the third waits for a slot', () => !hasStarted('lw-r-1'));
      setLimit(1);
      // Nothing was stopped: both are alive and still running, in Pueue's own words too.
      for (const jobId of ['lw-p-1', 'lw-q-1']) {
        const pid = Number(fs.readFileSync(path.join(jobFolder(jobId.slice(0, 4), jobId), 'pid'), 'utf8').trim());
        assert.doesNotThrow(() => process.kill(pid, 0), `${jobId} is alive`);
        assert.equal(readPueueState(jobId), 'Running', jobId);
        assert.equal(hasEnded(jobId), false, jobId);
      }
      await expectToStayTrue('the third still waits: two run, the limit is one', () => !hasStarted('lw-r-1'));
      release('lw-p-1');
      await waitUntil('the first of the two to end', () => hasEnded('lw-p-1'));
      await expectToStayTrue('the third still waits: one runs, the limit is one', () => !hasStarted('lw-r-1'));
      release('lw-q-1');
      await waitUntil('the third to start', () => hasStarted('lw-r-1'));
      assert.ok(hasEnded('lw-p-1') && hasEnded('lw-q-1'), 'both ended before it started');
      assert.ok(readMarkTime('lw-r-1', 'started') >= Math.max(readMarkTime('lw-p-1', 'ended'), readMarkTime('lw-q-1', 'ended')));
      release('lw-r-1');
      await waitUntil('all to end', () => ['lw-p', 'lw-q', 'lw-r'].every((slug) => readExit(slug, `${slug}-1`) !== null));
      assert.deepEqual(['lw-p', 'lw-q', 'lw-r'].map((slug) => readExit(slug, `${slug}-1`)), ['0', '0', '0'], 'every job finished with its own exit code - none was cut');
    });
  });

  describe('a job whose project has another job under way takes no slot', () => {
    it('with 2: the second job of project P is STASHED, so the job of project Q starts at once; P\'s second job runs after its first has ended', async () => {
      setLimit(2);
      submitJob('st-p', 'st-p-1');
      submitJob('st-p', 'st-p-2');
      submitJob('st-q', 'st-q-1');
      await waitUntil('P\'s first and Q\'s job to start', () => hasStarted('st-p-1') && hasStarted('st-q-1'));
      assert.equal(readPueueState('st-p-2'), 'Stashed');
      assert.equal(fs.existsSync(path.join(jobFolder('st-p', 'st-p-2'), 'stashed')), true);
      assert.equal(hasStarted('st-p-2'), false);
      await expectToStayTrue('P\'s second job waits for its first', () => !hasStarted('st-p-2'));
      release('st-p-1');
      await waitUntil('P\'s second job to start', () => hasStarted('st-p-2'));
      assert.ok(readMarkTime('st-p-2', 'started') >= readMarkTime('st-p-1', 'ended'), 'after the first had ended');
      assert.equal(fs.existsSync(path.join(jobFolder('st-p', 'st-p-2'), 'stashed')), false, 'the mark goes when it is enqueued');
      release('st-p-2');
      release('st-q-1');
      await waitUntil('all to end', () => readExit('st-p', 'st-p-2') !== null && readExit('st-q', 'st-q-1') !== null);
      assert.deepEqual([readExit('st-p', 'st-p-1'), readExit('st-p', 'st-p-2'), readExit('st-q', 'st-q-1')], ['0', '0', '0']);
    });

    it('several jobs of one project run in submit order, one at a time, each enqueued only when the one before has ended', async () => {
      setLimit(3);
      for (const n of [1, 2, 3]) submitJob('or-p', `or-p-${n}`);
      await waitUntil('the first to start', () => hasStarted('or-p-1'));
      assert.deepEqual([readPueueState('or-p-2'), readPueueState('or-p-3')], ['Stashed', 'Stashed']);
      release('or-p-1');
      await waitUntil('the second to start', () => hasStarted('or-p-2'));
      assert.equal(readPueueState('or-p-3'), 'Stashed', 'the third waits behind the second');
      await expectToStayTrue('the third does not start beside the second', () => !hasStarted('or-p-3'));
      release('or-p-2');
      await waitUntil('the third to start', () => hasStarted('or-p-3'));
      assert.ok(readMarkTime('or-p-2', 'started') >= readMarkTime('or-p-1', 'ended') && readMarkTime('or-p-3', 'started') >= readMarkTime('or-p-2', 'ended'));
      release('or-p-3');
      await waitUntil('all to end', () => readExit('or-p', 'or-p-3') !== null);
      assert.deepEqual([1, 2, 3].map((n) => readExit('or-p', `or-p-${n}`)), ['0', '0', '0']);
    });

    it('`wait` on a stashed job blocks until it has been enqueued and has run: it returns "done" with the job\'s result in place', async () => {
      setLimit(2);
      submitJob('wt-p', 'wt-p-1');
      submitJob('wt-p', 'wt-p-2');
      release('wt-p-2');
      await waitUntil('the first to start', () => hasStarted('wt-p-1'));
      const waiting = new Promise<Run>((resolve) => {
        const child = spawn('bash', [scriptPath, 'wait', workDir, 'wt-p', 'wt-p-2'], { env: getEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
        children.add(child);
        let stdout = '';
        child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        child.on('close', (status) => resolve({ status, stdout, stderr: '' }));
      });
      await expectToStayTrue('the wait does not return while the job is stashed', () => !hasStarted('wt-p-2') && readExit('wt-p', 'wt-p-2') === null);
      release('wt-p-1');
      const done = await waiting;
      assert.equal(done.stdout.trim(), 'done');
      assert.equal(readExit('wt-p', 'wt-p-2'), '0');
    });

    it('a predecessor that was SIGKILLed before it could say so leaves its successor stashed - until the next `probe` enqueues it', async () => {
      setLimit(2);
      submitJob('pk-p', 'pk-p-1');
      submitJob('pk-p', 'pk-p-2');
      release('pk-p-2');
      await waitUntil('the first to start', () => hasStarted('pk-p-1'));
      const pid = Number(fs.readFileSync(path.join(jobFolder('pk-p', 'pk-p-1'), 'pid'), 'utf8').trim());
      process.kill(-pid, 'SIGKILL');
      await waitUntil('Pueue to see the first one gone', () => readPueueState('pk-p-1') === 'Done');
      assert.equal(readPueueState('pk-p-2'), 'Stashed', 'nobody ran finish_job for it');
      assert.match(runScript(['pueue', workDir, 'status']).stdout, /Stashed/);
      await expectToStayTrue('the second job stays stashed until something looks', () => !hasStarted('pk-p-2'));
      const probed = runScript(['probe', workDir]);
      assert.equal(probed.status, 0, probed.stderr);
      await waitUntil('the probe to have enqueued the second job and it to start', () => hasStarted('pk-p-2'));
      await waitUntil('it to end', () => readExit('pk-p', 'pk-p-2') !== null);
      assert.equal(readExit('pk-p', 'pk-p-2'), '0');
    });

    it('the same for `prepare`: the next job submitted to the runner (any project) enqueues it', async () => {
      setLimit(2);
      submitJob('pp-p', 'pp-p-1');
      submitJob('pp-p', 'pp-p-2');
      release('pp-p-2');
      await waitUntil('the first to start', () => hasStarted('pp-p-1'));
      process.kill(-Number(fs.readFileSync(path.join(jobFolder('pp-p', 'pp-p-1'), 'pid'), 'utf8').trim()), 'SIGKILL');
      await waitUntil('Pueue to see the first one gone', () => readPueueState('pp-p-1') === 'Done');
      assert.equal(readPueueState('pp-p-2'), 'Stashed');
      submitJob('pp-q', 'pp-q-1');
      release('pp-q-1');
      await waitUntil('the stashed job to start', () => hasStarted('pp-p-2'));
      await waitUntil('both to end', () => readExit('pp-p', 'pp-p-2') !== null && readExit('pp-q', 'pp-q-1') !== null);
    });

    it('`kill` of a stashed job removes it from Pueue like a queued one - it ends with 137 and never starts - and the job behind it is not let go while the first is under way', async () => {
      setLimit(2);
      submitJob('kl-p', 'kl-p-1');
      submitJob('kl-p', 'kl-p-2');
      submitJob('kl-p', 'kl-p-3');
      release('kl-p-3');
      await waitUntil('the first to start', () => hasStarted('kl-p-1'));
      assert.deepEqual([readPueueState('kl-p-2'), readPueueState('kl-p-3')], ['Stashed', 'Stashed']);
      const killed = runScript(['kill', workDir, 'kl-p', 'kl-p-2']);
      assert.equal(killed.stdout.trim(), 'killed', killed.stderr);
      assert.equal(readPueueState('kl-p-2'), null, 'gone from Pueue');
      assert.equal(readExit('kl-p', 'kl-p-2'), '137');
      assert.equal(fs.existsSync(path.join(jobFolder('kl-p', 'kl-p-2'), 'stashed')), false);
      assert.equal(readPueueState('kl-p-3'), 'Stashed', 'the first is still under way');
      await expectToStayTrue('the third does not start beside the first', () => !hasStarted('kl-p-3'));
      release('kl-p-1');
      await waitUntil('the third to start', () => hasStarted('kl-p-3'));
      await waitUntil('it to end', () => readExit('kl-p', 'kl-p-3') !== null);
      assert.equal(hasStarted('kl-p-2'), false, 'the killed job never ran');
    });

    it('`kill` of the job under way lets the stashed one behind it go - at once, by the dying job\'s own end', async () => {
      setLimit(2);
      submitJob('kr-p', 'kr-p-1');
      submitJob('kr-p', 'kr-p-2');
      release('kr-p-2');
      await waitUntil('the first to start', () => hasStarted('kr-p-1'));
      assert.equal(readPueueState('kr-p-2'), 'Stashed');
      const killed = runScript(['kill', workDir, 'kr-p', 'kr-p-1']);
      assert.equal(killed.stdout.trim(), 'killed', killed.stderr);
      assert.equal(readExit('kr-p', 'kr-p-1'), '137');
      await waitUntil('the stashed job to start', () => hasStarted('kr-p-2'));
      await waitUntil('it to end', () => readExit('kr-p', 'kr-p-2') !== null);
      assert.equal(readExit('kr-p', 'kr-p-2'), '0');
    });
  });
});
