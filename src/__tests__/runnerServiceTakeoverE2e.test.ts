/**
 * @description The runner's queue with REAL Pueue daemons and REAL job processes, around the service manager and the removal of a runner
 * (the systemd / launchd commands are a recording stand-in; everything about Pueue is real):
 *
 *   fresh install      the queue's configuration and the service record exist when the first service starts
 *   foreground → service  a daemon a foreground `run` started, idle, is shut down so the managed one can take the socket; one that is
 *                      running a job is NOT touched — the install is refused and the job goes on
 *   removal            `stopAllPueueJobs` ends a running background job and empties the queue, so the queued job does not start in its place
 *
 * Needs `pueue` and `pueued` on PATH: a local run without them is SKIPPED with the reason, CI (`CI` is `true` or `1`) fails without.
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCommand, type CommandRunner } from '../selfUpdate/commandRunner';
import { checkIsPueueRunning, ensurePueueConfig, ensurePueueDaemon, inspectPueue, stopAllPueueJobs } from '../runnerUtility/pueueDaemon';
import { writeRunnerConfig } from '../runnerUtility/runnerConfig';
import { getRunnerHomePaths, type RunnerHomePaths } from '../runnerUtility/runnerHome';
import { installService, readServiceKind, type ServiceDeps } from '../runnerUtility/serviceManager';
import { generateEd25519KeyPair } from '../runners/sshKeys';
import { waitUntil } from './runnersTestKit';

const isCi = process.env.CI === 'true' || process.env.CI === '1';
const missing = ['pueue', 'pueued'].filter((tool) => spawnSync('which', [tool], { stdio: 'ignore' }).status !== 0);
const skipReason = missing.length > 0 && !isCi ? `missing: ${missing.join(', ')}` : false;

describe('the runner\'s queue and its services (real Pueue)', { skip: skipReason }, () => {
  let home = '';
  let paths: RunnerHomePaths;
  let commands: string[] = [];

  /** Pueue's own binaries run for real; the service managers are a recording stand-in that says yes. */
  const runner: CommandRunner = async (file, args, options) => {
    if (path.basename(file) === 'pueue' || path.basename(file) === 'pueued') return runCommand(file, args, options);
    commands.push(`${file} ${args.join(' ')}`);
    return { ok: true, exitCode: 0, stdout: '', stderr: '', isTimedOut: false };
  };

  function createDeps(): ServiceDeps {
    return {
      runner,
      platform: 'linux',
      uid: os.userInfo().uid,
      checkIsProcessAlive: () => false,
      accountName: os.userInfo().username,
      homeDir: home,
      nodePath: process.execPath,
      launchDaemonsDir: path.join(home, 'LaunchDaemons'),
      chown: () => undefined,
      resolveAccount: async () => null,
    };
  }

  function pueue(args: string[]): string {
    return execFileSync(path.join(paths.binDir, 'pueue'), ['--config', paths.pueueConfig, ...args], { encoding: 'utf8' });
  }

  /** A running background job that writes its own pid, as the agents' jobs do; returns the pidfile. */
  async function startJob(name: string, command = 'sleep 120'): Promise<string> {
    const pidFile = path.join(home, `${name}.pid`);
    pueue(['add', '--immediate', '--', 'sh', '-c', `echo $$ > ${pidFile}; ${command}`]);
    await waitUntil(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '', `job ${name} to start`, 15_000);
    return pidFile;
  }

  function isAlive(pidFile: string): boolean {
    try {
      process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 0);
      return true;
    } catch {
      return false;
    }
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join('/tmp', 'rq-'));
    paths = getRunnerHomePaths(home);
    fs.mkdirSync(paths.binDir, { recursive: true });
    for (const tool of ['pueue', 'pueued']) fs.symlinkSync(execFileSync('which', [tool], { encoding: 'utf8' }).trim(), path.join(paths.binDir, tool));
    commands = [];
    writeRunnerConfig(paths, {
      runnerId: 'abcdef012345',
      name: 'mac',
      hub: { host: 'host.example', port: 22, user: 'hubuser', hostKey: generateEd25519KeyPair('h').publicKey, publicKey: generateEd25519KeyPair('p').publicKey, label: '@ExampleBot' },
      packageId: null,
      pairedAtMs: 1,
    });
  });
  afterEach(async () => {
    await stopAllPueueJobs(paths).catch(() => false);
    try {
      const pid = Number(fs.readFileSync(path.join(paths.pueueDir, 'run', 'pueue.pid'), 'utf8'));
      process.kill(pid, 'SIGKILL');
    } catch {
      /* no daemon */
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('a fresh install: Pueue\'s configuration and the service record are there before the first service starts', async () => {
    const seen: Array<{ hasConfig: boolean; kind: string | null }> = [];
    const watching: CommandRunner = async (file, args, options) => {
      if (args.includes('enable')) seen.push({ hasConfig: fs.existsSync(paths.pueueConfig), kind: readServiceKind(paths) });
      return runner(file, args, options);
    };
    const result = await installService({ isSystem: false, userName: null }, { ...createDeps(), runner: watching });
    assert.equal(result.ok, true, result.lines.join('\n'));
    assert.deepEqual(seen, [{ hasConfig: true, kind: 'user-service' }]);
    assert.equal(await checkIsPueueRunning(paths), false, 'no unmanaged daemon was started on the way');
  });

  it('foreground → service: an idle daemon is shut down first so the managed one can take the socket', async () => {
    assert.equal(await ensurePueueDaemon(paths), true);
    assert.equal(await checkIsPueueRunning(paths), true);
    const result = await installService({ isSystem: false, userName: null }, createDeps());
    assert.equal(result.ok, true, result.lines.join('\n'));
    assert.equal(await checkIsPueueRunning(paths), false, 'the foreground daemon is gone: its socket is free');
    assert.ok(commands.some((line) => line.includes('enable --now')));
  });

  it('foreground → service: a daemon that is running a job is left alone — the install is refused and the job goes on', async () => {
    assert.equal(await ensurePueueDaemon(paths), true);
    const pidFile = await startJob('busy');
    const result = await installService({ isSystem: false, userName: null }, createDeps());
    assert.equal(result.ok, false);
    assert.match(result.lines.join('\n'), /running 1 job\(s\)/);
    assert.equal(await checkIsPueueRunning(paths), true, 'the daemon was not asked to stop');
    assert.equal(isAlive(pidFile), true, 'the job was not killed');
    assert.deepEqual(commands, [], 'nothing was started');
    assert.equal(readServiceKind(paths), null);
    assert.equal(fs.existsSync(path.join(home, '.config', 'systemd')), false);
  });

  it('removal: stopping the jobs kills the running background job and empties the queue, so the queued job does not start in its place', async () => {
    ensurePueueConfig(paths);
    assert.equal(await ensurePueueDaemon(paths), true);
    const runningPid = await startJob('running');
    const queuedMarker = path.join(home, 'queued-ran');
    pueue(['add', '--', 'sh', '-c', `echo ran > ${queuedMarker}`]);
    assert.deepEqual(await inspectPueue(paths), { kind: 'busy', activeJobs: 1 });

    assert.equal(await stopAllPueueJobs(paths), true);
    await waitUntil(() => !isAlive(runningPid), 'the running job to be killed', 15_000);
    assert.deepEqual(await inspectPueue(paths), { kind: 'idle' });
    await new Promise((resolve) => { setTimeout(resolve, 1500); });
    assert.equal(fs.existsSync(queuedMarker), false, 'the queued job never started');
  });
});
