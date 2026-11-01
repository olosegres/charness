/**
 * @description `charness remote-run` at PROCESS level, end to end, against a runner made of a throwaway loopback `sshd` (no root) and
 * a private Pueue, all in temp dirs (`remoteRunE2e/remoteRunFlowKit.ts`, shared helpers in `remoteRunFlowHarness.ts`): the built CLI is run
 * as a child process exactly as an agent runs it, with its own HOME, `runners.json` and cache. This file is the first half of the flow, in
 * order, each step on the state the one before left (the second half — kill, time limits, `exec` — is `remoteRunLifecycleE2e.test.ts`,
 * with a runner of its own, so the two run side by side):
 *
 *   runners → the stand-in online with its capabilities; an entry on a closed port offline with its last snapshot; an unknown host key
 *     says to connect once by hand
 *   → a passing and a failing command return their exit codes, output streams while the command runs
 *   → deletions are mirrored, the runner's own ignored files are never touched, a `.env` is held back until `send:` names it
 *   → the dependencies step runs once, again when the lockfile changes, again after a failure
 *   → no environment variable of this process reaches the runner, `-e` passes one
 *   → `--bg` + `wait`/`ls`/`status`/`logs`/`fetch`: the job's code, only the files it created or changed come back, nothing stale
 *   → two jobs of one project queue and each runs its OWN tree; one job's result files survive the next job
 *   → refusals: not a git project, a capability no runner has, an unknown group
 *
 * "Nothing left" is asserted on real pids: every decoy writes its own pid and its child's.
 *
 * Needs sshd, ssh, rsync, Pueue and the built CLI (`yarn build`): a local run without them is SKIPPED with the reason, CI (`CI` is `true`
 * or `1`) installs them and fails without. Test case: N/A — Charness has no Jira tracker.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createProject,
  createRunnerEntry,
  getSshOptions,
  openGate,
  checkIsProcessRunning,
  createDecoyCommand,
  createGatedCommand,
  readProjectFile,
  runnerName,
  startCli,
  waitForLayoutProcess,
  waitForPidFile,
  waitUntil,
  writeProjectFile,
  writeRunnersJson,
} from './remoteRunE2e/remoteRunFlowKit';
import { listLayoutProcesses } from './remoteRunE2e/remoteRunFlowSweep';
import { closeSshMaster } from '../remoteRun/ssh';
import {
  skipReason,
  flowEnv,
  baseRemoteRunConfig,
  afterInterruptTimeoutMs,
  layout,
  project,
  writeRemoteRunConfig,
  readDepsCounter,
  readJobId,
  run,
  registerOpenJobCleanup,
  waitForExit,
  expectNothingLeft,
  setUpFlow,
  tearDownFlow,
} from './remoteRunE2e/remoteRunFlowHarness';

describe('charness remote-run against a loopback runner', { skip: skipReason }, () => {
  before(setUpFlow);
  after(tearDownFlow);

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

    it('`-e PATH=…` puts a tool the runner\'s own PATH lacks within reach of the command AND of the dependencies step (the way docs/remote-run.md gives)', async () => {
      const toolDirectory = path.join(layout.root, 'runner-tools');
      fs.mkdirSync(toolDirectory, { recursive: true });
      fs.writeFileSync(path.join(toolDirectory, 'rr-tool'), '#!/bin/sh\necho "tool ran: $1"\n', { mode: 0o755 });
      const toolPath = `PATH=${toolDirectory}:/usr/bin:/bin`;
      const missing = await run(['rr-tool', 'plain']);
      assert.equal(missing.exitCode, 127, 'without it the tool is not found, as on a runner whose PATH lacks nvm');
      writeRemoteRunConfig("pull: out test-results\ninstall: sh -c 'rr-tool install >> ../tool-install.log'\n");
      try {
        writeProjectFile(project, 'yarn.lock', '# lock for the tool path\n');
        const failedStep = await run(['true']);
        assert.equal(failedStep.exitCode, 125, 'the dependencies step cannot find it either: «dependencies step failed»');
        const withPath = await run(['-e', toolPath, 'rr-tool', 'command']);
        assert.equal(withPath.exitCode, 0, withPath.stderr);
        assert.match(withPath.stdout, /tool ran: command/);
        assert.match(fs.readFileSync(path.join(project.runnerDirectory, 'tool-install.log'), 'utf8'), /tool ran: install/, 'the dependencies step found it too');
      } finally {
        writeRemoteRunConfig(baseRemoteRunConfig);
        writeProjectFile(project, 'yarn.lock', '# lock v3\n');
      }
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

    it('a hostile runner cannot plant a git hook or replace .remote-run, however broad the project\'s pull pattern is', async () => {
      writeRemoteRunConfig('pull: **\ninstall: none\n');
      try {
        const jobId = readJobId(await run(['--bg', "sh -c 'mkdir -p out; echo fine > out/fine.txt'"]));
        const jobDir = path.join(project.runnerDirectory, 'jobs', jobId);
        await waitUntil('the job to finish', 60_000, () => fs.existsSync(path.join(jobDir, 'exit')));
        // The runner is the attacker: next to what the job made it puts a hook and a replacement for the project's config.
        const planted = (relativePath: string, content: string): void => {
          fs.mkdirSync(path.dirname(path.join(jobDir, 'artifacts', relativePath)), { recursive: true });
          fs.writeFileSync(path.join(jobDir, 'artifacts', relativePath), content);
        };
        // The project keeps its hooks in a folder of its own (core.hooksPath), and has husky's conventional folder too.
        execFileSync('git', ['-C', project.root, 'config', 'core.hooksPath', 'ci/git-hooks']);
        planted('.git/hooks/pre-commit', '#!/bin/sh\ntouch /tmp/planted-by-runner\n');
        planted('ci/git-hooks/pre-commit', '#!/bin/sh\ntouch /tmp/planted-by-runner\n');
        planted('.husky/pre-push', '#!/bin/sh\ntouch /tmp/planted-by-runner\n');
        planted('.remote-run', 'install: touch /tmp/planted-by-runner\n');
        const configBefore = fs.readFileSync(path.join(project.root, '.remote-run'), 'utf8');
        const fetched = await run(['fetch', jobId]);
        assert.equal(fetched.exitCode, 0, fetched.stderr);
        assert.match(fetched.stderr, /4 refused \(not a regular file a "pull:" pattern names, or inside a \.git, the project's \.remote-run or a git hooks folder\)/);
        assert.equal(readProjectFile(project, 'out/fine.txt'), 'fine\n', 'what the job really made came back');
        assert.equal(fs.existsSync(path.join(project.root, '.git', 'hooks', 'pre-commit')), false, 'no hook was planted');
        assert.equal(fs.existsSync(path.join(project.root, 'ci', 'git-hooks')), false, 'nor in the folder core.hooksPath names');
        assert.equal(fs.existsSync(path.join(project.root, '.husky')), false, 'nor in husky\'s');
        assert.equal(fs.readFileSync(path.join(project.root, '.remote-run'), 'utf8'), configBefore, 'the project\'s config is untouched');
      } finally {
        writeRemoteRunConfig(baseRemoteRunConfig);
      }
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

  describe('refusals', () => {
    it('a folder that is not a git project is refused with what remote-run needs', async () => {
      const result = await run(['echo', 'x'], { cwd: layout.projectsDir });
      assert.equal(result.exitCode, 125);
      assert.match(result.stderr, /remote-run: .* is not inside a git working tree/);
    });

    it('a job the runner refuses at once says why — its own last line — and not only «state unknown»', async () => {
      // The runner's Pueue, wrapped: everything goes through to the real one except `add`, which fails the way a full or broken queue would.
      const failingPueue = path.join(layout.root, 'failing-pueue.sh');
      fs.writeFileSync(failingPueue, `#!/usr/bin/env bash\nfor word in "$@"; do\n  if [ "$word" = add ]; then echo 'pueue: simulated failure' >&2; exit 1; fi\ndone\nexec ${layout.pueueBin} "$@"\n`, { mode: 0o755 });
      writeRunnersJson(layout, [createRunnerEntry(layout, { pueue: { bin: failingPueue, config: layout.pueueConfigPath } })]);
      try {
        const result = await run(['echo', 'x']);
        assert.equal(result.exitCode, 125);
        assert.match(result.stderr, /remote-run: the runner said: pueue add failed \(does the group "default" exist on this runner\?\)/);
        assert.match(result.stderr, /remote-run: the state of job \S+ is unknown \(unknown\)/);
      } finally {
        writeRunnersJson(layout, [createRunnerEntry(layout)]);
        fs.rmSync(failingPueue, { force: true });
      }
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
      assert.match(unknownRunner.stderr, /no runner named "nope" \(configured: box1\)/);
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
