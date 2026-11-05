/**
 * @description `charness remote-run` through a PAIRED runner, at process level, end to end: a hub made of a loopback `sshd` and a copy of
 * the built charness, and a runner machine made of a temp HOME (`runnerLinkE2e/runnerLinkFlowKit.ts`, the kit of the runner-link flow); the
 * REAL pasted line pairs the machine, the REAL `charness-runner run` holds the link, and the BUILT `charness remote-run` — which knows
 * nothing of the runner but its entry in the hub's registry — reaches it by ssh through `charness runner-proxy`. In order, each step on
 * the state the one before left:
 *
 *   runners → the paired runner is listed online with what it can do, the program it runs and how it is kept running
 *   run → output and exit code come back (pass and fail), output arrives while the job still runs
 *   --bg + wait → the job id, then the result files back in the project
 *   interrupt → the remote job and its child are gone
 *   exec → the command runs in the runner's copy as the last job left it
 *   paused → from the hub, and on the runner itself: never picked, said so; resumed: used again
 *   lid closed → the REAL runner process plays a Mac (a stand-in `ioreg` on its PATH says what the lid is): it tells the hub its lid is shut, and it takes no new
 *               job (any pick, a named one, `--needs`, `exec`) while every view says «lid closed» and a job it already runs goes on; a `--needs` job waits and
 *               starts when the lid opens; a lid that shut while the runner was offline is known to the hub before the runner is online again — at no instant
 *               is it online with an open lid
 *   --needs → a runner offline: `--runner-wait 0` and a capability nobody has fail at once (125); the wait gives up on time; an
 *             interrupt ends it with 130; a runner paused from the hub meanwhile is given up on and runs nothing when it comes back;
 *             the runner coming back lets the waiting job run
 *
 * The hub's home folder has a SPACE in its name (the CLI runs with `HOME` set to a symlink called «hub home»): every path of the ssh line —
 * the proxy socket, the known-hosts file, the key — must survive ssh's own option parsing and rsync's `-e` splitter, or the pinned host key
 * is not found and the first call is refused.
 *
 * The Playwright capability is real: the runner's `env` file points `PLAYWRIGHT_BROWSERS_PATH` at a folder that holds a `chromium-*`
 * entry, so the probe reports it on any machine. Needs sshd, ssh, ssh-keyscan, rsync, Pueue, git, tar and the built CLI (`yarn build`):
 * a local run without them is SKIPPED with the reason, CI fails without. No registry and no download is used.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { getRunnerLinkStatus } from '../runners/linkControl';
import { getRunnerHomePaths, type RunnerHomePaths } from '../runnerUtility/runnerHome';
import {
  createDecoyCommand,
  createGatedCommand,
  createProject,
  openGate,
  runCli,
  startCli,
  waitForPidFile,
  waitForProcessGone,
  type CliFlowLayout,
  type CliRun,
  type FlowProject,
  type ProjectFlowLayout,
} from './remoteRunE2e/remoteRunFlowKit';
import {
  createRunnerLinkLayout,
  destroyRunnerLinkLayout,
  getMissingTools,
  isCi,
  makePairingLine,
  readJson,
  runHubCli,
  runPairingLine,
  startRunner,
  stopRunner,
  waitUntil,
  type RunnerLinkLayout,
} from './runnerLinkE2e/runnerLinkFlowKit';
import { killRecordedProcess, readRecordedPid } from './recordedProcess';
import { createIoregStandIn, type IoregStandIn } from './runnerLinkE2e/ioregStandIn';

const missingTools = [...getMissingTools(), ...(spawnSync('which', ['git'], { stdio: 'ignore' }).status === 0 ? [] : ['git'])];
const skipReason = missingTools.length > 0 && !isCi ? `missing: ${missingTools.join(', ')}` : false;

const leaseMs = 3000;
const pollMs = 1000;
/** The flow's windows: the test seam's floor for the lease and a one-second wait poll (production: 45 s and 10 s). */
const flowEnv = { CHARNESS_TEST_TIMINGS: JSON.stringify({ remoteRunLeaseMs: leaseMs, remoteRunRunnerPollMs: pollMs }) };
const linkTimeoutMs = 90_000;
const ordinaryRunTimeoutMs = 120_000;
const atOnceBoundMs = 30_000;
const afterInterruptTimeoutMs = 60_000;
/** A probe that is held would run for its own 20 s; a command told to stop ends well before that. */
const heldProbeStopBoundMs = 15_000;

describe('remote-run through a paired runner (process level)', { skip: skipReason }, () => {
  let layout: RunnerLinkLayout;
  let runnerPaths: RunnerHomePaths;
  let cliLayout: CliFlowLayout & ProjectFlowLayout;
  let project: FlowProject;
  let runner: ChildProcess | null = null;
  let runnerName = '';
  let runnerId = '';
  /** The Mac the runner plays: its `ioreg` says what the lid is. */
  let ioreg: IoregStandIn;

  before(async () => {
    assert.deepEqual(missingTools, [], 'CI installs everything this flow needs');
    layout = await createRunnerLinkLayout();
    runnerPaths = getRunnerHomePaths(layout.runnerHome);
    // The same folder under a name with a space: what the CLI sees as its HOME (`runHubCli` keeps the plain one).
    const spacedHubHome = path.join(layout.root, 'hub home');
    fs.symlinkSync(layout.hubHome, spacedHubHome, 'dir');
    cliLayout = {
      home: spacedHubHome,
      cacheDir: path.join(layout.root, 'cache'),
      cliChildren: new Set(),
      projectsDir: path.join(layout.root, 'projects'),
      workDir: runnerPaths.workDir,
    };
    fs.mkdirSync(cliLayout.cacheDir, { recursive: true });
    fs.mkdirSync(cliLayout.projectsDir, { recursive: true });

    const pairing = runPairingLine(layout, makePairingLine(layout));
    assert.equal(pairing.status, 0, `${pairing.stderr}\n${pairing.stdout}`);
    const pairedRunner = readJson<{ runners: Array<{ name: string; id: string }> }>(path.join(layout.hubDir, 'paired.json')).runners[0];
    runnerName = pairedRunner.name;
    runnerId = pairedRunner.id;
    ioreg = createIoregStandIn(layout.root);
    // The runner "has Playwright browsers": a folder with a chromium-* entry, named in the runner's own env file (read again for every job).
    const browsersDir = path.join(layout.root, 'browsers');
    fs.mkdirSync(path.join(browsersDir, 'chromium-1000'), { recursive: true });
    fs.writeFileSync(runnerPaths.envFile, `PLAYWRIGHT_BROWSERS_PATH=${browsersDir}\n`, { mode: 0o600 });

    project = createProject(cliLayout, 'app', {
      '.gitignore': 'out/\n',
      '.remote-run': 'pull: out\n',
      'package.json': '{ "name": "app" }\n',
      'src/a.txt': 'version A\n',
    });
    runner = startMacRunner();
    await waitForListedState('online');
  });

  after(async () => {
    for (const child of cliLayout?.cliChildren ?? []) child.kill('SIGKILL');
    if (layout !== undefined) await destroyRunnerLinkLayout(layout);
  });

  function run(args: string[], timeoutMs: number = ordinaryRunTimeoutMs): ReturnType<typeof runCli> {
    return runCli(cliLayout, args, { cwd: project.root, env: flowEnv, timeoutMs });
  }

  function start(args: string[]): CliRun {
    return startCli(cliLayout, args, { cwd: project.root, env: flowEnv });
  }

  /** What `charness runners ls` of the hub says about the runner: `online`, `offline`, or `lid closed`. */
  async function waitForListedState(state: 'online' | 'offline' | 'lid closed'): Promise<void> {
    await waitUntil(() => new RegExp(`^${runnerName} — ${state}`, 'm').test(runHubCli(layout, ['runners', 'ls']).stdout), `the hub to list ${runnerName} as ${state}`, linkTimeoutMs);
  }

  /** The runner as a Mac: `ioreg` on its PATH is the stand-in, so the utility looks at a lid like it does on a MacBook (its look is a second here, ten in production). */
  function startMacRunner(): ChildProcess {
    return startRunner(layout, layout.runnerHome, { PATH: `${ioreg.binDir}:${path.dirname(process.execPath)}:${process.env.PATH ?? ''}` });
  }

  async function stopTheRunner(): Promise<void> {
    assert.ok(runner !== null);
    await stopRunner(layout, runner);
    runner = null;
    await waitForListedState('offline');
  }

  async function startTheRunner(): Promise<void> {
    runner = startMacRunner();
    await waitForListedState('online');
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

  it('lists the paired runner online: what it can do, the program it runs and how it is kept running', async () => {
    const result = await run(['runners']);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`^${runnerName} — online · `, 'm'));
    assert.match(result.stdout, /playwright \(chromium\)/, 'the capability the runner\'s env file gives it');
    assert.match(result.stdout, /ios: no \(Linux\)/);
    assert.match(result.stdout, /^ {2}charness-runner \S+ · run by hand$/m);
    assert.ok(!result.stdout.includes('MISSING'), 'the runner has its Pueue');
    // The link keeps its machine awake — by systemd-inhibit where this box lets it, and then `runners` says so; where it does not, it says NO and why.
    const hasWorkingSystemdInhibit = spawnSync('systemd-inhibit', ['--what=idle', '--why=test', '--mode=block', 'true']).status === 0;
    assert.match(result.stdout, hasWorkingSystemdInhibit ? /^ {2}keeps awake: yes \(systemd-inhibit --what=idle; a closed lid still sleeps it\)$/m : /^ {2}keeps awake: NO — /m);
  });

  it('a passing and a failing command: output and exit code come back through the link', async () => {
    const passed = await run(['echo hello from the runner']);
    assert.equal(passed.exitCode, 0, passed.stderr);
    assert.match(passed.stdout, /^hello from the runner$/m);
    const failed = await run(['echo out; echo err >&2; exit 3']);
    assert.equal(failed.exitCode, 3, failed.stderr);
    assert.match(failed.stdout, /^out$/m);
    assert.match(failed.stdout, /^err$/m, 'the job\'s stderr is in its output');
  });

  it('output arrives while the job still runs — not when it ends', async () => {
    const cli = start([createGatedCommand('live.gate', { before: 'echo first', after: 'echo second' })]);
    await waitUntil(() => cli.stdout().includes('first\n'), 'the first line to arrive', ordinaryRunTimeoutMs);
    assert.equal(cli.child.exitCode, null, 'the job is still waiting for its gate');
    assert.ok(!cli.stdout().includes('second'));
    openGate(project, 'live.gate');
    assert.equal(await waitForExit(cli, ordinaryRunTimeoutMs), 0, cli.stderr());
    assert.match(cli.stdout(), /^first\nsecond\n$/);
  });

  it('--bg prints the job id and `wait` brings the result files back, with the job\'s exit code', async () => {
    const submitted = await run(['--bg', 'mkdir -p out && echo built > out/result.txt']);
    assert.equal(submitted.exitCode, 0, submitted.stderr);
    const jobId = submitted.stdout.trim();
    assert.match(jobId, new RegExp(`^${runnerName}-[a-z2-7]{6}$`));
    const waited = await run(['wait', jobId]);
    assert.equal(waited.exitCode, 0, waited.stderr);
    assert.equal(fs.readFileSync(path.join(project.root, 'out', 'result.txt'), 'utf8'), 'built\n');
    const listed = await run(['ls']);
    assert.match(listed.stdout, new RegExp(jobId));
  });

  it('an interrupt (Ctrl-C) ends the remote job and everything it started', async () => {
    const cli = start([createDecoyCommand('decoy')]);
    const decoyPid = await waitForPidFile(project, 'decoy.pid');
    const childPid = await waitForPidFile(project, 'decoy.child');
    cli.child.kill('SIGINT');
    assert.equal(await waitForExit(cli, afterInterruptTimeoutMs), 130, cli.stderr());
    await waitForProcessGone('the decoy to be gone', decoyPid, afterInterruptTimeoutMs);
    await waitForProcessGone('the decoy\'s child to be gone', childPid, afterInterruptTimeoutMs);
  });

  it('`exec` runs in the runner\'s copy of the project as the last job left it', async () => {
    const result = await run(['exec', 'cat src/a.txt']);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, 'version A\n');
  });

  it('a runner paused from the hub is never picked — and the message says who paused it and how to resume', async () => {
    assert.equal(runHubCli(layout, ['runners', 'pause', runnerName]).status, 0);
    try {
      const any = await run(['echo x']);
      assert.equal(any.exitCode, 125);
      assert.match(any.stderr, new RegExp(`no runner is online \\(paused, so not used: ${runnerName}\\)`));
      const named = await run(['--runner', runnerName, 'echo x']);
      assert.equal(named.exitCode, 125);
      assert.match(named.stderr, new RegExp(`runner "${runnerName}" is paused from the hub — \`charness runners resume ${runnerName}\``));
      const view = await run(['runners']);
      assert.match(view.stdout, new RegExp(`^${runnerName} — online · paused from the hub · `, 'm'));
    } finally {
      assert.equal(runHubCli(layout, ['runners', 'resume', runnerName]).status, 0);
    }
    const resumed = await run(['echo again']);
    assert.equal(resumed.exitCode, 0, resumed.stderr);
    assert.match(resumed.stdout, /^again$/m);
  });

  it('a runner paused on the runner itself (its own flag, reported by the probe) is never picked either', async () => {
    const flag = path.join(runnerPaths.root, 'paused');
    fs.writeFileSync(flag, '');
    try {
      const blocked = await run(['echo x']);
      assert.equal(blocked.exitCode, 125);
      assert.match(blocked.stderr, new RegExp(`no runner is online \\(paused, so not used: ${runnerName}\\)`));
      assert.match((await run(['runners'])).stdout, new RegExp(`^${runnerName} — online · paused on the runner · `, 'm'));
    } finally {
      fs.rmSync(flag);
    }
    assert.equal((await run(['echo free'])).exitCode, 0);
  });

  describe('a runner whose Mac has its lid closed', () => {
    afterEach(async () => {
      // Whatever a case did, the next one starts with the lid open.
      ioreg.setLid('open');
      await waitForListedState('online');
    });

    it('takes no new job — every pick, a named runner, `--needs`, `exec` and every view say so — while a job it already runs goes on; it takes jobs again when the lid opens', async () => {
      const markerName = 'lid-closed.marker';
      const running = start([createGatedCommand('lid.gate', { before: 'echo before the lid', after: 'echo after the lid' })]);
      await waitUntil(() => running.stdout().includes('before the lid\n'), 'the job to be running', ordinaryRunTimeoutMs);
      ioreg.setLid('closed');
      await waitForListedState('lid closed');
      assert.match((await run(['runners'])).stdout, new RegExp(`^${runnerName} — lid closed · takes no new jobs until its lid is opened \\(a job already running there goes on\\) — as last probed: `, 'm'));
      const any = await run([`touch ../${markerName}`]);
      assert.equal(any.exitCode, 125, any.stderr);
      assert.match(any.stderr, new RegExp(`no runner is online \\(lid closed, so not used: ${runnerName}\\)`));
      const needing = await run(['--needs', 'playwright', '--runner-wait', '0', `touch ../${markerName}`]);
      assert.equal(needing.exitCode, 125, needing.stderr);
      assert.match(needing.stderr, new RegExp(`no online runner can do "playwright" \\(lid closed, so not used: ${runnerName}\\)`));
      const named = await run(['--runner', runnerName, `touch ../${markerName}`]);
      assert.equal(named.exitCode, 125, named.stderr);
      assert.match(named.stderr, new RegExp(`runner "${runnerName}" has its lid closed`));
      assert.equal((await run(['exec', 'cat src/a.txt'])).exitCode, 125, 'exec is a new command too');
      assert.equal(fs.existsSync(path.join(project.runnerDirectory, markerName)), false, 'none of them ran anything');
      // The job that was already there is not touched: its lease holds, the gate opens, it finishes.
      assert.equal(running.child.exitCode, null);
      openGate(project, 'lid.gate');
      assert.equal(await waitForExit(running, ordinaryRunTimeoutMs), 0, running.stderr());
      assert.match(running.stdout(), /^before the lid\nafter the lid\n$/);
      // The lid opens: the Mac's next look makes it available.
      ioreg.setLid('open');
      await waitForListedState('online');
      const again = await run(['echo available again']);
      assert.equal(again.exitCode, 0, again.stderr);
      assert.match(again.stdout, /^available again$/m);
    });

    it('a lid shut with an external display keeping the Mac awake (clamshell mode), or an ioreg that cannot be read, leaves the runner available: only a lid that sleeps the Mac closes it', async () => {
      ioreg.setLid('clamshell');
      await new Promise((resolve) => { setTimeout(resolve, 3000); });
      assert.equal((await run(['echo clamshell'])).exitCode, 0);
      ioreg.setLid('unreadable');
      await new Promise((resolve) => { setTimeout(resolve, 3000); });
      assert.equal((await run(['echo unreadable'])).exitCode, 0);
      assert.match(runHubCli(layout, ['runners', 'ls']).stdout, new RegExp(`^${runnerName} — online`, 'm'));
    });

    it('a job that is already queued or running there can be asked about and waited for while the lid is shut: those commands do not pick a runner', async () => {
      const submitted = await run(['--bg', createGatedCommand('lid-wait.gate', { before: 'echo started', after: 'echo done' })]);
      assert.equal(submitted.exitCode, 0, submitted.stderr);
      const jobId = submitted.stdout.trim();
      ioreg.setLid('closed');
      await waitForListedState('lid closed');
      const status = await run(['status', jobId]);
      assert.equal(status.exitCode, 0, status.stderr);
      openGate(project, 'lid-wait.gate');
      const waited = await run(['wait', jobId]);
      assert.equal(waited.exitCode, 0, waited.stderr);
      assert.match(waited.stdout, /done/);
    });

    it('a `--needs` job waits for the lid — announced once, with why — and starts when the Mac says it is open', async () => {
      const markerName = 'lid-wait.marker';
      ioreg.setLid('closed');
      await waitForListedState('lid closed');
      const cli = start(['--needs', 'playwright', '--runner-wait', '5m', `touch ../${markerName}; echo the lid opened`]);
      await waitUntil(() => cli.stderr().includes('waiting for a runner with playwright'), 'the wait to begin', ordinaryRunTimeoutMs);
      assert.match(cli.stderr(), new RegExp(`waiting for a runner with playwright \\(${runnerName} has its lid closed\\) — looking again every 1 s, up to 5 min`));
      await new Promise((resolve) => { setTimeout(resolve, 3 * pollMs); });
      assert.equal(cli.child.exitCode, null, 'still waiting');
      assert.equal(fs.existsSync(path.join(project.runnerDirectory, markerName)), false, 'nothing ran while the lid was shut');
      ioreg.setLid('open');
      assert.equal(await waitForExit(cli, ordinaryRunTimeoutMs), 0, cli.stderr());
      assert.match(cli.stdout(), /^the lid opened$/m);
      assert.equal(fs.existsSync(path.join(project.runnerDirectory, markerName)), true);
      assert.equal(cli.stderr().split('waiting for a runner with playwright').length - 1, 1, 'announced once, not on every look');
    });

    it('a lid that shut while the runner was OFFLINE (the Mac slept before it could say so) is known to the hub before the runner is online again: at no instant is it online with an open lid', async () => {
      await stopTheRunner();
      // The hub's record says «open» — the last thing this runner told it. The lid shuts now, with no way to say so.
      ioreg.setLid('closed');
      runner = startMacRunner();
      const sightings: boolean[] = [];
      await waitUntil(async () => {
        const status = await getRunnerLinkStatus(layout.hubDir, runnerId);
        if (status.isOnline) sightings.push(status.isLidClosed);
        return status.isOnline;
      }, 'the runner to be online', linkTimeoutMs);
      for (let look = 0; look < 25; look += 1) {
        sightings.push((await getRunnerLinkStatus(layout.hubDir, runnerId)).isLidClosed);
        await new Promise((resolve) => { setTimeout(resolve, 20); });
      }
      assert.deepEqual([...new Set(sightings)], [true], `every sighting of the link online says the lid is shut: ${sightings.join(',')}`);
      await waitForListedState('lid closed');
      const blocked = await run(['echo x']);
      assert.equal(blocked.exitCode, 125, blocked.stderr);
      assert.match(blocked.stderr, /lid closed, so not used/);
    });

    it('and the other way: a lid that OPENED while the runner was offline makes it available at the moment it is online, with no wait for a look', async () => {
      ioreg.setLid('closed');
      await waitForListedState('lid closed');
      await stopTheRunner();
      ioreg.setLid('open');
      runner = startMacRunner();
      await waitForListedState('online');
      assert.equal((await run(['echo opened while away'])).exitCode, 0);
    });
  });

  describe('--needs with the runner offline', () => {
    before(async () => {
      await stopTheRunner();
    });

    it('--runner-wait 0 fails at once (125) and the view says the runner is not connected', async () => {
      const startedAtMs = Date.now();
      const result = await run(['--needs', 'playwright', '--runner-wait', '0', 'echo x']);
      assert.equal(result.exitCode, 125);
      assert.match(result.stderr, /no online runner can do "playwright"/);
      assert.match(result.stderr, new RegExp(`${runnerName} — offline \\(the runner is not connected\\)`));
      assert.ok(!result.stderr.includes('waiting for a runner'));
      assert.ok(Date.now() - startedAtMs < atOnceBoundMs);
    });

    it('a capability that no runner ever had is not waited for, however long --runner-wait is', async () => {
      const startedAtMs = Date.now();
      const result = await run(['--needs', 'ios', '--runner-wait', '10m', 'echo x']);
      assert.equal(result.exitCode, 125);
      assert.match(result.stderr, /no online runner can do "ios"/);
      assert.ok(!result.stderr.includes('waiting for a runner'));
      assert.ok(Date.now() - startedAtMs < atOnceBoundMs, 'it did not wait');
    });

    it('the wait gives up when --runner-wait ends, with the reason and how long it waited', async () => {
      const startedAtMs = Date.now();
      const result = await run(['--needs', 'playwright', '--runner-wait', '3s', 'echo x']);
      // A smoke check of the whole command, not of the deadline arithmetic (an offline paired runner is found offline at once, so even a
      // loop that ignored the deadline would end soon): the wait really happened — the last look is a second before the end — and ended.
      // Where the deadline is kept (sleeps cut, probes cut at what is left, an answer after the end refused) is `remoteRunRunnerWait.test.ts`.
      const elapsedMs = Date.now() - startedAtMs;
      assert.ok(elapsedMs >= 2_000, `it waited for the runner (${elapsedMs} ms)`);
      assert.ok(elapsedMs < 20_000, `and stopped (${elapsedMs} ms)`);
      assert.equal(result.exitCode, 125);
      assert.match(result.stderr, new RegExp(`waiting for a runner with playwright \\(${runnerName} offline since `));
      assert.match(result.stderr, /waited \d+ s for a runner with "playwright" to come back — none did/);
    });

    it('an interrupt while it waits ends it with 130 and starts no job — in a sleep or in a probe, whichever the signal finds', async () => {
      const cli = start(['--needs', 'playwright', '--runner-wait', '10m', 'echo x']);
      await waitUntil(() => cli.stderr().includes('waiting for a runner with playwright'), 'the wait to begin', ordinaryRunTimeoutMs);
      cli.child.kill('SIGINT');
      assert.equal(await waitForExit(cli, afterInterruptTimeoutMs), 130, cli.stderr());
      assert.match(cli.stderr(), /interrupted while waiting for a runner/);
      assert.equal(cli.stdout(), '');
    });

    /**
     * A stand-in for the link of the offline runner that takes connections and never answers: the probe the next look makes goes through it and is
     * held where it is — an ssh client waiting for a banner that does not come — until the command is told to stop. `hasProbeStarted` is true once
     * ssh has spoken through the proxy, so the probe is certainly in flight.
     */
    async function holdLinkWithSilentSocket(): Promise<{ hasProbeStarted: () => boolean; getOpenConnectionCount: () => number; release: () => void }> {
      const runnerId = readJson<{ runners: Array<{ id: string }> }>(path.join(layout.hubDir, 'paired.json')).runners[0].id;
      const socketPath = path.join(layout.hubDir, 'link', `${runnerId}.sock`);
      fs.rmSync(socketPath, { force: true });
      const openConnections = new Set<net.Socket>();
      let hasSsh = false;
      const server = net.createServer((connection) => {
        openConnections.add(connection);
        connection.on('error', () => undefined);
        connection.on('close', () => openConnections.delete(connection));
        connection.on('data', () => { hasSsh = true; });
      });
      await new Promise<void>((resolve) => { server.listen(socketPath, resolve); });
      return {
        hasProbeStarted: () => hasSsh,
        getOpenConnectionCount: () => openConnections.size,
        release: () => {
          for (const connection of openConnections) connection.destroy();
          server.close();
          fs.rmSync(socketPath, { force: true });
        },
      };
    }

    for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
      it(`${signal} while a probe of the wait is held ends it with ${exitCode} at once — the probe's ssh is stopped, no runner is picked and no job starts`, async () => {
        const markerName = `held-probe-${signal}.marker`;
        const cli = start(['--needs', 'playwright', '--runner-wait', '10m', `touch ../${markerName}`]);
        await waitUntil(() => cli.stderr().includes('waiting for a runner with playwright'), 'the wait to begin', ordinaryRunTimeoutMs);
        const link = await holdLinkWithSilentSocket();
        try {
          await waitUntil(() => link.hasProbeStarted(), 'a probe to be held on the silent link', ordinaryRunTimeoutMs);
          const signalledAtMs = Date.now();
          cli.child.kill(signal);
          assert.equal(await waitForExit(cli, afterInterruptTimeoutMs), exitCode, cli.stderr());
          assert.ok(Date.now() - signalledAtMs < heldProbeStopBoundMs, `it ended at once (${Date.now() - signalledAtMs} ms), not when the probe's own 20 s ran out`);
          assert.match(cli.stderr(), /interrupted while waiting for a runner/);
          assert.equal(cli.stdout(), '');
          await waitUntil(() => link.getOpenConnectionCount() === 0, 'the probe\'s connection to the silent link to be closed', afterInterruptTimeoutMs);
          assert.equal(fs.existsSync(path.join(project.runnerDirectory, markerName)), false, 'nothing was run on the runner');
        } finally {
          link.release();
        }
      });
    }

    it('SIGINT during a probe that has already LOGGED IN — its ssh only a client of a ControlPersist master that keeps the pipes — ends the command at once with 130; the master is not waited for', async () => {
      // A stand-in `ssh` first on the CLI's PATH: «the master» is a sleeping grandchild that inherits the pipes the CLI reads and outlives the client,
      // the client is another sleep. Killing the client leaves the pipes open, so a call that waits for `close` waits for the master.
      const decoyDir = path.join(layout.root, 'decoy-ssh-bin');
      const masterPidFile = path.join(layout.root, 'decoy-master.pid');
      fs.mkdirSync(decoyDir, { recursive: true });
      fs.rmSync(masterPidFile, { force: true });
      fs.writeFileSync(path.join(decoyDir, 'ssh'), `#!/bin/sh\nsleep 300 &\necho $! > "${masterPidFile}"\nexec sleep 300\n`, { mode: 0o755 });
      const markerName = 'logged-in-probe.marker';
      const cli = startCli(cliLayout, ['--needs', 'playwright', '--runner-wait', '10m', `touch ../${markerName}`], { cwd: project.root, env: { ...flowEnv, PATH: `${decoyDir}:${process.env.PATH}` } });
      await waitUntil(() => cli.stderr().includes('waiting for a runner with playwright'), 'the wait to begin', ordinaryRunTimeoutMs);
      const link = await holdLinkWithSilentSocket();
      try {
        await waitUntil(() => readRecordedPid(masterPidFile) !== null, 'the probe to be held by the stand-in ssh', ordinaryRunTimeoutMs);
        const signalledAtMs = Date.now();
        cli.child.kill('SIGINT');
        assert.equal(await waitForExit(cli, afterInterruptTimeoutMs), 130, cli.stderr());
        assert.ok(Date.now() - signalledAtMs < heldProbeStopBoundMs, `it ended at once (${Date.now() - signalledAtMs} ms), not when the master ended`);
        assert.match(cli.stderr(), /interrupted while waiting for a runner/);
        assert.equal(cli.stdout(), '');
        assert.equal(fs.existsSync(path.join(project.runnerDirectory, markerName)), false, 'nothing was run on the runner');
      } finally {
        link.release();
        killRecordedProcess(masterPidFile);
      }
    });

    it('a runner paused from the hub while the command waits is given up on — and runs nothing when it comes back', async () => {
      const markerName = 'paused-wait.marker';
      const cli = start(['--needs', 'playwright', '--runner-wait', '5m', `touch ../${markerName}`]);
      await waitUntil(() => cli.stderr().includes('waiting for a runner with playwright'), 'the wait to begin', ordinaryRunTimeoutMs);
      assert.equal(runHubCli(layout, ['runners', 'pause', runnerName]).status, 0);
      try {
        assert.equal(await waitForExit(cli, afterInterruptTimeoutMs), 125, cli.stderr());
        assert.match(cli.stderr(), /waited \d+ s for a runner with "playwright" to come back — none did/);
        await startTheRunner();
        await new Promise((resolve) => { setTimeout(resolve, 4 * pollMs); });
        assert.equal(fs.existsSync(path.join(project.runnerDirectory, markerName)), false, 'the command was not run on the paused runner');
      } finally {
        assert.equal(runHubCli(layout, ['runners', 'resume', runnerName]).status, 0);
      }
      await stopTheRunner();
    });

    it('the runner coming back lets the waiting job run — the wait is announced once', async () => {
      const cli = start(['--needs', 'playwright', '--runner-wait', '5m', 'echo it came back']);
      await waitUntil(() => cli.stderr().includes('waiting for a runner with playwright'), 'the wait to begin', ordinaryRunTimeoutMs);
      await startTheRunner();
      assert.equal(await waitForExit(cli, ordinaryRunTimeoutMs), 0, cli.stderr());
      assert.match(cli.stdout(), /^it came back$/m);
      assert.equal(cli.stderr().split('waiting for a runner with playwright').length - 1, 1, 'announced once, not on every look');
      assert.match(cli.stderr(), new RegExp(`waiting for a runner with playwright \\(${runnerName} offline since \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC\\) — looking again every 1 s, up to 5 min`));
    });
  });
});
