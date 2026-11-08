/**
 * @description The second half of the `charness remote-run` process-level flow (the first is `remoteRunE2e.test.ts`; the helpers are
 * `remoteRunE2e/remoteRunFlowHarness.ts`): what ends a job. It runs against a runner of its own (a throwaway loopback `sshd` and a private
 * Pueue), so it runs side by side with the first half:
 *
 *   SIGINT, SIGTERM, SIGHUP of a foreground run kill the whole remote job (also a command that ignores SIGTERM)
 *   → a closed stdout (`remote-run … | head`) stops the job and SAYS why, `exec` too; a read-only `ls` / `logs -f` just ends
 *   → SIGKILL of a foreground run, and a frozen one (no heartbeat), end the job when the lease runs out
 *   → `--timeout` and `kill <id>` leave nothing, a job killed while queued, a task number Pueue gives to another job
 *   → `exec` runs in the copy of the project's latest job and is killed like a foreground job
 *   → `clean` refuses a copy a job or an `exec` is using, and removes it (and says what it freed) once nothing is
 *   → `clean-after-success:` of `.remote-run` empties the named folders of the copy after a job that succeeded — and only then
 *
 * "Nothing left" is asserted on real pids: every decoy writes its own pid and its child's.
 *
 * Needs sshd, ssh, rsync, Pueue and the built CLI (`yarn build`): a local run without them is SKIPPED with the reason, CI (`CI` is `true`
 * or `1`) installs them and fails without. Test case: N/A — Charness has no Jira tracker.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createProject,
  createRunnerEntry,
  type FlowProject,
  openGate,
  createChattyDecoyCommand,
  createDecoyCommand,
  createGatedCommand,
  jobStartTimeoutMs,
  startCli,
  waitForPidFile,
  waitUntil,
  writeProjectFile,
  writeRunnersJson,
} from './remoteRunE2e/remoteRunFlowKit';
import {
  skipReason,
  flowLeaseMs,
  flowEnv,
  runnerScriptPath,
  afterInterruptTimeoutMs,
  afterLeaseLostTimeoutMs,
  layout,
  project,
  readJobId,
  run,
  registerOpenJobCleanup,
  startDecoyRun,
  waitForExit,
  expectNothingLeft,
  readNewestJobState,
  setUpFlow,
  tearDownFlow,
} from './remoteRunE2e/remoteRunFlowHarness';

/**
 * The `--timeout` of the decoy jobs that must write their pids before it runs out. The limit counts from the moment the job is
 * queued (staging included), so a limit of 3 s was enough for an idle machine and not for a loaded one, where the decoy was cut
 * before it ever wrote its pid file and the test timed out waiting for it.
 */
const decoyLimitSeconds = 20;

describe('charness remote-run against a loopback runner — what ends a job', { skip: skipReason }, () => {
  before(setUpFlow);
  after(tearDownFlow);

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

  describe('a caller that stops reading', () => {
    registerOpenJobCleanup();
    it('a foreground run whose stdout is closed (piped into `head`) stops its job, says why on stderr and ends with 141 — nothing is left', async () => {
      const name = 'decoy-chatty';
      const cli = startCli(layout, [createChattyDecoyCommand(name)], { cwd: project.root, env: flowEnv });
      const decoyPid = await waitForPidFile(project, `${name}.pid`);
      const childPid = await waitForPidFile(project, `${name}.child`);
      await waitUntil('the first line of the job to arrive', jobStartTimeoutMs, () => cli.stdout().includes('line\n'));
      cli.child.stdout?.destroy();
      assert.equal(await waitForExit(cli, afterInterruptTimeoutMs), 141, cli.stderr());
      assert.match(cli.stderr(), /remote-run: stdout was closed \(what reads it, a pipe into `head` for one, is gone\) — job box1-[a-z2-7]{6} was stopped on box1; to read only a part of a long output, start it with --bg and use `charness remote-run logs box1-[a-z2-7]{6} --tail <lines>`/);
      assert.doesNotMatch(cli.stderr(), /interrupted —|unexpected error|EPIPE/);
      await expectNothingLeft(decoyPid, childPid, 20_000);
      assert.match(await readNewestJobState(), /\bkilled\b/);
    });

    it('`exec` whose stdout is closed stops its command and says why', async () => {
      const name = 'decoy-chatty-exec';
      const cli = startCli(layout, ['exec', createChattyDecoyCommand(name)], { cwd: project.root, env: flowEnv });
      const decoyPid = await waitForPidFile(project, `${name}.pid`);
      const childPid = await waitForPidFile(project, `${name}.child`);
      await waitUntil('the first line of the command to arrive', jobStartTimeoutMs, () => cli.stdout().includes('line\n'));
      cli.child.stdout?.destroy();
      assert.equal(await waitForExit(cli, afterInterruptTimeoutMs), 141, cli.stderr());
      assert.match(cli.stderr(), /remote-run: stdout was closed \(what reads it, a pipe into `head` for one, is gone\) — the command was stopped on box1; /);
      await expectNothingLeft(decoyPid, childPid, 20_000);
    });

    it('`ls`, which owns no job, ends with its own code when its stdout is closed — no crash, no message', async () => {
      const listed = await run(['ls']);
      assert.equal(listed.exitCode, 0, listed.stderr);
      const cli = startCli(layout, ['ls', '--all'], { cwd: project.root, env: flowEnv });
      cli.child.stdout?.destroy();
      const exitCode = await waitForExit(cli, afterInterruptTimeoutMs);
      assert.ok(exitCode === 0 || exitCode === 141, `ended with ${exitCode}; ${cli.stderr()}`);
      assert.doesNotMatch(cli.stderr(), /unexpected error|EPIPE|at .*\.js:/);
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
      const result = await run(['--timeout', `${decoyLimitSeconds}s`, decoy]);
      assert.equal(result.exitCode, 124, result.stderr);
      assert.match(result.stderr, new RegExp(`timed out after ${decoyLimitSeconds}s`));
      await expectNothingLeft(await waitForPidFile(project, 'decoy-timeout.pid'), await waitForPidFile(project, 'decoy-timeout.child'), 20_000);
    });

    it('`--timeout` of a background job is the runner\'s own watchdog: `wait` gives 124 and nothing is left', async () => {
      const jobId = readJobId(await run(['--bg', '--timeout', `${decoyLimitSeconds}s`, createDecoyCommand('decoy-bgtimeout')]));
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

    it('a foreground run that waited behind a busy group until its limit ran out is recorded as TIMED OUT — the same word its exit code 124 says — not as killed', async () => {
      const holder = readJobId(await run(['--bg', '--group', 'emulator', createGatedCommand('gate-fglimit', { before: 'echo started > ../fglimit-holder-started', after: 'true' })]));
      await waitUntil('the holder to hold the emulator group', 60_000, () => fs.existsSync(path.join(project.runnerDirectory, 'fglimit-holder-started')));
      // Nothing runs on the runner for this job yet, so only the CLI's own timer can end it — and it used to record a plain kill.
      const queued = await run(['--group', 'emulator', '--timeout', '4s', 'true'], { timeoutMs: 90_000 });
      assert.equal(queued.exitCode, 124, queued.stderr);
      assert.match(queued.stderr, /timed out after 4s/);
      assert.match(await readNewestJobState(), /timed out/, 'ls says timed out, as the exit code does');
      openGate(project, 'gate-fglimit');
      assert.equal((await run(['wait', holder])).exitCode, 0);
    });

    it('`kill` of a job that has already finished says it had already ended, with its exit code — and does not mark it killed', async () => {
      const finishedId = readJobId(await run(['--bg', "sh -c 'exit 3'"]));
      assert.equal((await run(['wait', finishedId])).exitCode, 3);
      const killed = await run(['kill', finishedId]);
      assert.equal(killed.exitCode, 0, killed.stderr);
      assert.match(killed.stderr, new RegExp(`job ${finishedId} had already ended \\(exit 3\\) — nothing to kill`));
      assert.ok(!/ killed\s*$/.test(killed.stderr.trim()), killed.stderr);
      assert.match(await readNewestJobState(), /failed/, 'it is still the failed job it was');
    });

    it('a job killed while queued: Pueue gives its task number to the next job, and `wait` / `logs -f` of the killed job still end at once with its own 137 instead of following the other job', async () => {
      const holder = readJobId(await run(['--bg', '--group', 'emulator', createGatedCommand('gate-reuse', { before: 'echo started > ../reuse-holder-started', after: 'true' })]));
      await waitUntil('the holder to hold the emulator group', 60_000, () => fs.existsSync(path.join(project.runnerDirectory, 'reuse-holder-started')));
      const killedId = readJobId(await run(['--bg', '--group', 'emulator', 'true']));
      assert.match((await run(['status', killedId])).stdout, /— queued/, 'it waits behind the holder');
      assert.equal((await run(['kill', killedId])).exitCode, 0);
      const nextId = readJobId(await run(['--bg', '--group', 'emulator', 'true']));
      const readTaskNumber = (id: string): string => fs.readFileSync(path.join(project.runnerDirectory, 'jobs', id, 'task-id'), 'utf8').trim();
      assert.equal(readTaskNumber(nextId), readTaskNumber(killedId), 'the setup: Pueue gave the freed number to the next job');

      // The next job is queued behind the closed gate for as long as this test wants: a wait that follows its number cannot return.
      const waited = await run(['wait', killedId], { timeoutMs: 30_000 });
      assert.equal(waited.exitCode, 137, `wait followed the other job instead of ending: ${waited.stderr}`);
      const followed = await run(['logs', '-f', killedId], { timeoutMs: 30_000 });
      assert.equal(followed.exitCode, 0, followed.stderr);
      assert.match(await readNewestJobState(), /queued/, 'and the next job is still waiting behind the holder');

      // Whose number is whose, as the runner script asks Pueue itself (the real status output, not a stand-in for it).
      const ask = (taskNumber: string, jobName: string): number | null => spawnSync('bash', ['-c', `source ${runnerScriptPath}; check_task_belongs_to_job ${taskNumber} ${jobName}`], {
        env: { ...process.env, PUEUE_BIN: layout.pueueBin, PUEUE_CONFIG: layout.pueueConfigPath },
        timeout: 30_000,
      }).status;
      assert.equal(ask(readTaskNumber(nextId), nextId), 0, 'the number is the next job\'s');
      assert.notEqual(ask(readTaskNumber(killedId), killedId), 0, 'and not the killed job\'s, whose record still holds it');

      openGate(project, 'gate-reuse');
      assert.equal((await run(['wait', holder])).exitCode, 0);
      assert.equal((await run(['wait', nextId])).exitCode, 0, 'the next job runs as any other');
    });

    it('a command that ignores SIGTERM is SIGKILLed after the grace time and still ends as an ENDED job: its exit is recorded — 137 for `kill`, 124 for the time limit — so prune can remove it', async () => {
      const killedId = readJobId(await run(['--bg', createDecoyCommand('decoy-stubborn-killed', { isIgnoringTerm: true })]));
      const killedPid = await waitForPidFile(project, 'decoy-stubborn-killed.pid');
      const killedChild = await waitForPidFile(project, 'decoy-stubborn-killed.child');
      assert.equal((await run(['kill', killedId])).exitCode, 0);
      await expectNothingLeft(killedPid, killedChild, 30_000);
      assert.equal(fs.readFileSync(path.join(project.runnerDirectory, 'jobs', killedId, 'exit'), 'utf8').trim(), '137', 'the kill is on record');
      assert.equal((await run(['wait', killedId])).exitCode, 137);

      const limitedId = readJobId(await run(['--bg', '--timeout', `${decoyLimitSeconds}s`, createDecoyCommand('decoy-stubborn-limited', { isIgnoringTerm: true })]));
      const limitedPid = await waitForPidFile(project, 'decoy-stubborn-limited.pid');
      const limitedChild = await waitForPidFile(project, 'decoy-stubborn-limited.child');
      const waited = await run(['wait', limitedId]);
      assert.equal(waited.exitCode, 124, waited.stderr);
      await expectNothingLeft(limitedPid, limitedChild, 30_000);
      assert.equal(fs.readFileSync(path.join(project.runnerDirectory, 'jobs', limitedId, 'exit'), 'utf8').trim(), '124', 'the limit\'s kill is on record');
    });

    it('the lock of a job that had to be SIGKILLed passes to the jobs queued behind it ONE at a time — two of them never run on the project together', async () => {
      const holder = readJobId(await run(['--bg', createDecoyCommand('decoy-lockholder', { isIgnoringTerm: true })]));
      const holderPid = await waitForPidFile(project, 'decoy-lockholder.pid');
      const holderChild = await waitForPidFile(project, 'decoy-lockholder.child');
      const section = "sh -c 'echo start >> ../lock-sections; sleep 2; echo end >> ../lock-sections'";
      const first = readJobId(await run(['--bg', section]));
      const second = readJobId(await run(['--bg', section]));
      for (const waiting of [first, second]) {
        await waitUntil(`${waiting} to wait for the lock`, 60_000, () => {
          const log = path.join(project.runnerDirectory, 'jobs', waiting, 'log');
          return fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes(`waiting for job ${holder}`);
        });
      }
      // The holder ignores SIGTERM: after the grace time it is SIGKILLed and cannot give the lock back — both waiters see a dead holder.
      assert.equal((await run(['kill', holder])).exitCode, 0);
      await expectNothingLeft(holderPid, holderChild, 30_000);
      assert.equal((await run(['wait', first])).exitCode, 0);
      assert.equal((await run(['wait', second])).exitCode, 0);
      const sections = fs.readFileSync(path.join(project.runnerDirectory, 'lock-sections'), 'utf8').split('\n').filter((line) => line !== '');
      assert.deepEqual(sections, ['start', 'end', 'start', 'end'], 'each ran alone, one after the other');
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
    // exec runs in the copy the last job left: make one, with a folder of the runner's own in it, instead of relying on earlier steps.
    before(async () => {
      writeProjectFile(project, 'src/a.txt', 'version A\n');
      assert.equal((await run(['true'])).exitCode, 0);
      fs.mkdirSync(path.join(project.runnerDirectory, 'tree', 'node_modules'), { recursive: true });
    });

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
      assert.ok(!failing.stderr.includes('\u001e'), 'and shows nothing of the exit marker');
      const exits255 = await run(['exec', "sh -c 'echo before; exit 255'"]);
      assert.equal(exits255.exitCode, 255, 'a command that really exits 255 keeps its code — it is not a lost connection');
      assert.ok(!exits255.stderr.includes('connection'), exits255.stderr);
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

    it('with several runners and no --runner it goes to the runner of the project\'s LAST job — not to the first one in the file, which holds another copy', async () => {
      // A second runner on the same sshd and Pueue, with a work dir of its own: its copy of the project is a different folder.
      const secondWorkDir = path.join(layout.root, 'work-second');
      writeRunnersJson(layout, [createRunnerEntry(layout), createRunnerEntry(layout, { name: 'box2', workDir: secondWorkDir })]);
      try {
        const ranOnSecond = await run(['--runner', 'box2', 'true']);
        assert.equal(ranOnSecond.exitCode, 0, ranOnSecond.stderr);
        const onSecond = await run(['exec', 'pwd']);
        assert.equal(onSecond.exitCode, 0, onSecond.stderr);
        assert.ok(onSecond.stdout.trim().startsWith(`${secondWorkDir}/`), `exec ran in ${onSecond.stdout.trim()}, not in the copy on box2`);
        const ranOnFirst = await run(['--runner', 'box1', 'true']);
        assert.equal(ranOnFirst.exitCode, 0, ranOnFirst.stderr);
        const onFirst = await run(['exec', 'pwd']);
        assert.ok(onFirst.stdout.trim().startsWith(`${layout.workDir}/`), `after a job on box1, exec ran in ${onFirst.stdout.trim()}`);
        const named = await run(['exec', '--runner', 'box2', 'pwd']);
        assert.ok(named.stdout.trim().startsWith(`${secondWorkDir}/`), '--runner still names the runner');
      } finally {
        writeRunnersJson(layout, [createRunnerEntry(layout)]);
      }
    });
  });

  describe('clean', () => {
    registerOpenJobCleanup();
    // A project of its own: the copy of a project folder is shared by everything run from it, and the jobs the other steps of this flow left in the flow's project (killed, never fetched) would — rightly — keep it.
    let cleanProject: FlowProject;
    const runHere = (args: string[]): ReturnType<typeof run> => run(args, { cwd: cleanProject.root });
    before(() => {
      cleanProject = createProject(layout, 'clean-app', { 'src/a.txt': 'version A\n' });
    });
    /** The copy of this project on the runner: made (again) by a foreground job. */
    async function makeCopy(): Promise<void> {
      writeProjectFile(cleanProject, 'src/a.txt', 'version A\n');
      assert.equal((await runHere(['true'])).exitCode, 0);
      assert.ok(fs.existsSync(path.join(cleanProject.runnerDirectory, 'tree', 'src', 'a.txt')));
    }
    /** A background job that runs on a decoy and is killed: ended (137), its results not fetched by anybody. */
    async function startAndKillBackgroundJob(name: string): Promise<string> {
      const jobId = readJobId(await runHere(['--bg', createDecoyCommand(name)]));
      const decoyPid = await waitForPidFile(cleanProject, `${name}.pid`);
      const childPid = await waitForPidFile(cleanProject, `${name}.child`);
      const refused = await runHere(['clean']);
      assert.equal(refused.exitCode, 125, refused.stderr);
      assert.match(refused.stdout, new RegExp(`^box1: NOT cleaned — ${jobId} is running in it`, 'm'));
      assert.ok(fs.existsSync(path.join(cleanProject.runnerDirectory, 'tree', 'src', 'a.txt')), 'the copy is untouched');
      assert.equal((await runHere(['kill', jobId])).exitCode, 0);
      await expectNothingLeft(decoyPid, childPid, 20_000);
      return jobId;
    }

    it('right after a foreground run it takes the copy and says what it freed — the run has handed over its results, so nothing keeps the copy — and a second clean has nothing to do; the next run sends the project afresh', async () => {
      await makeCopy();
      const cleaned = await runHere(['clean']);
      assert.equal(cleaned.exitCode, 0, cleaned.stderr);
      assert.match(cleaned.stdout, /^box1: removed the project copy \S+( \(freed [0-9.]+ GB\))?$/m);
      assert.equal(fs.existsSync(cleanProject.runnerDirectory), false, 'nothing of the copy is left on the runner');
      const again = await runHere(['clean']);
      assert.equal(again.exitCode, 0, again.stderr);
      assert.match(again.stdout, /^box1: no copy of \S+ \(nothing to clean\)$/m);
      const rerun = await runHere(['cat src/a.txt']);
      assert.equal(rerun.exitCode, 0, rerun.stderr);
      assert.match(rerun.stdout, /version A/);
    });

    it('is refused, naming the job, while a job of the project runs; once it is killed its results are still nobody\'s until `wait` fetches them — then the copy goes', async () => {
      await makeCopy();
      const jobId = await startAndKillBackgroundJob('decoy-clean');
      const unfetched = await runHere(['clean']);
      assert.equal(unfetched.exitCode, 125, unfetched.stderr);
      assert.match(unfetched.stdout, new RegExp(`^box1: NOT cleaned — ${jobId} ended less than an hour ago and its results were not fetched`, 'm'));
      assert.ok(fs.existsSync(path.join(cleanProject.runnerDirectory, 'jobs', jobId, 'log')), 'and the job\'s log is still there to be read');
      assert.equal((await runHere(['wait', jobId])).exitCode, 137);
      const cleaned = await runHere(['clean']);
      assert.equal(cleaned.exitCode, 0, cleaned.stderr);
      assert.match(cleaned.stdout, /^box1: removed the project copy /m);
      assert.equal(fs.existsSync(cleanProject.runnerDirectory), false);
    });

    it('`fetch` hands the results over too: the copy of a job that was killed and fetched goes', async () => {
      await makeCopy();
      const jobId = await startAndKillBackgroundJob('decoy-clean-fetch');
      assert.equal((await runHere(['clean'])).exitCode, 125);
      const fetched = await runHere(['fetch', jobId]);
      assert.equal(fetched.exitCode, 0, fetched.stderr);
      const cleaned = await runHere(['clean']);
      assert.equal(cleaned.exitCode, 0, cleaned.stderr);
      assert.match(cleaned.stdout, /^box1: removed the project copy /m);
    });

    it('is refused while an `exec` runs in the copy, and removes it once the exec has ended', async () => {
      await makeCopy();
      const cli = startCli(layout, ['exec', createDecoyCommand('decoy-clean-exec')], { cwd: cleanProject.root, env: flowEnv });
      const decoyPid = await waitForPidFile(cleanProject, 'decoy-clean-exec.pid');
      const childPid = await waitForPidFile(cleanProject, 'decoy-clean-exec.child');
      const refused = await runHere(['clean']);
      assert.equal(refused.exitCode, 125, refused.stderr);
      assert.match(refused.stdout, /^box1: NOT cleaned — an `exec` is running in it/m);
      assert.ok(fs.existsSync(path.join(cleanProject.runnerDirectory, 'tree')), 'the copy is untouched');
      cli.child.kill('SIGINT');
      assert.equal(await waitForExit(cli, afterInterruptTimeoutMs), 130, cli.stderr());
      await expectNothingLeft(decoyPid, childPid, 20_000);
      await waitUntil('the exec to take its marker out of the copy', 20_000, () => (fs.readdirSync(cleanProject.runnerDirectory).some((name) => name.startsWith('exec.')) ? null : true));
      const cleaned = await runHere(['clean']);
      assert.equal(cleaned.exitCode, 0, cleaned.stderr);
      assert.match(cleaned.stdout, /^box1: removed the project copy /m);
      assert.equal(fs.existsSync(cleanProject.runnerDirectory), false);
    });
  });

  describe('clean-after-success', () => {
    registerOpenJobCleanup();
    // A project of its own: its `.remote-run` names the folder, and its copy is not shared with the other steps of this flow.
    let buildProject: FlowProject;
    const runHere = (args: string[]): ReturnType<typeof run> => run(args, { cwd: buildProject.root });
    const buildCommand = 'mkdir -p build/Intermediates.noindex build/Products && echo object > build/Intermediates.noindex/o.o && echo app > build/Products/app.txt';
    const getRunnerPath = (relativePath: string): string => path.join(buildProject.runnerDirectory, 'tree', relativePath);
    before(() => {
      buildProject = createProject(layout, 'clean-after-app', { 'src/a.txt': 'version A\n', '.remote-run': 'clean-after-success: build/Intermediates.noindex\n' });
    });

    it('a job that fails keeps what it built in the runner\'s copy — it is what a person looks at to find out why', async () => {
      const failed = await runHere([`${buildCommand} && exit 3`]);
      assert.equal(failed.exitCode, 3, failed.stderr);
      assert.ok(fs.existsSync(getRunnerPath('build/Intermediates.noindex/o.o')), 'the intermediates of the failed job are still there');
      assert.ok(fs.existsSync(getRunnerPath('build/Products/app.txt')));
    });

    it('a job that succeeds leaves the copy without the folder the project named (also what an earlier, failed job left in it) — the rest stays for the next job', async () => {
      const succeeded = await runHere([buildCommand]);
      assert.equal(succeeded.exitCode, 0, succeeded.stderr);
      // The job's result is recorded BEFORE the removal starts (a run does not wait for it), so the folder goes a moment after the run has returned.
      await waitUntil('the named folder to be removed', 20_000, () => (fs.existsSync(getRunnerPath('build/Intermediates.noindex')) ? null : true));
      assert.ok(fs.existsSync(getRunnerPath('build/Products/app.txt')), 'the products are not named, so they stay');
      assert.ok(fs.existsSync(getRunnerPath('src/a.txt')), 'and so does the project');
      const next = await runHere(['cat build/Products/app.txt']);
      assert.equal(next.exitCode, 0, next.stderr);
      assert.match(next.stdout, /^app$/m, 'the next job finds the copy as it was left');
    });
  });
});
