/**
 * @description What the process-level tests share to run the BUILT charness as
 * an ISOLATED instance (request/answer plan S6–S9): a temp layout with its
 * own HOME, DATA_DIR, WORK_ROOT and a private tmux server in a private
 * TMUX_TMPDIR; the fake `claude` launcher; the instance started through
 * `scripts/run-isolated.sh` with nothing but its own HOME config; read-only
 * tmux listings; and the synchronous sweep that ends everything the instance
 * started — also from `process.on('exit')`, where nothing asynchronous runs.
 *
 * Nothing here knows which flow a test runs: the test writes the instance's
 * env file and chooses the readiness line.
 */

import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { randomInt } from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
export const builtCliPath = path.join(repoRoot, 'dist', 'cli.js');
const runIsolatedPath = path.join(repoRoot, 'scripts', 'run-isolated.sh');
export const fakeClaudePath = path.join(__dirname, '..', 'jiraE2e', 'fakeClaude.ts');
const tsxLoaderPath = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs');

/** The only variables `run-isolated.sh` passes to the instance. */
export const isolatedLaunchEnvNames = ['HOME', 'PATH', 'USER', 'SHELL', 'LANG', 'TERM'];

const waitStepMs = 250;
/** How much of charness's output a failed wait quotes. */
const outputTailChars = 4000;
const stopTimeoutMs = 20 * 1000;

/** An OS-chosen free port — from the EPHEMERAL range, the one every outgoing connection on the host is given too. */
export async function getFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === 'string') throw new Error('no TCP port was assigned');
  return address.port;
}

/** Where Linux starts handing ports to outgoing connections when `ip_local_port_range` cannot be read (the kernel default). */
const defaultEphemeralPortFloor = 32768;
/** The fixed ports are drawn from [this, the ephemeral floor): above the well-known services, below every client socket. */
const fixedPortRangeStart = 20000;
const fixedPortProbeAttempts = 50;

function getEphemeralPortFloor(): number {
  try {
    const floor = Number(fs.readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/)[0]);
    return Number.isInteger(floor) && floor > fixedPortRangeStart ? floor : defaultEphemeralPortFloor;
  } catch {
    return defaultEphemeralPortFloor;
  }
}

function checkIsPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

/**
 * @description A free port the instance must bind on EVERY start — the bot MCP's:
 * a re-adopted agent keeps the MCP address of its launch, so a restart that
 * finds the port taken (the bot then falls back to an ephemeral one) leaves the
 * agent answering into a dead port. {@link getFreePort}'s ports are ephemeral,
 * which is exactly what any outgoing connection on the host is given while the
 * instance is down; this one lies below that range, where only another listener
 * could collide.
 */
export async function getFreeFixedPort(): Promise<number> {
  const ephemeralPortFloor = getEphemeralPortFloor();
  for (let attempt = 0; attempt < fixedPortProbeAttempts; attempt += 1) {
    const port = randomInt(fixedPortRangeStart, ephemeralPortFloor);
    if (await checkIsPortFree(port)) return port;
  }
  throw new Error(`no free port below the ephemeral range after ${fixedPortProbeAttempts} tries`);
}

/**
 * The test's own environment with `TMUX_TMPDIR` set to `dir`, or removed (tmux then uses `/tmp`) for `null`.
 * `TMUX` / `TMUX_PANE` are always removed: run from inside a tmux session, a command without `-L` / `-S`
 * goes to the server `$TMUX` names — the user's default one — whatever `TMUX_TMPDIR` says.
 */
export function getTmuxEnv(dir: string | null): NodeJS.ProcessEnv {
  const { TMUX_TMPDIR: _userTmuxTmpDir, TMUX: _userTmuxServer, TMUX_PANE: _userTmuxPane, ...env } = process.env;
  return dir === null ? env : { ...env, TMUX_TMPDIR: dir };
}

/** Session names on a tmux server — read-only; an empty list when that server is not running. */
export function listTmuxSessions(socketArgs: readonly string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const result = spawnSync('tmux', [...socketArgs, 'list-sessions', '-F', '#{session_name}'], { encoding: 'utf8', env });
  return result.status === 0 ? result.stdout.split('\n').filter(Boolean) : [];
}

/** The folder tmux keeps this user's sockets in under a TMUX_TMPDIR: `<dir>/tmux-<uid>`. */
export function getTmuxSocketDir(dir: string): string {
  return path.join(dir, `tmux-${process.getuid?.() ?? 0}`);
}

/** Lines another process may still be appending to: only those already ended by a newline are read. */
export function readJsonLines<TRecord>(filePath: string): TRecord[] {
  if (!fs.existsSync(filePath)) return [];
  const completeLines = fs.readFileSync(filePath, 'utf8').split('\n').slice(0, -1);
  return completeLines.filter(Boolean).map((line) => JSON.parse(line));
}

/** The variable NAMES a running process was started with (Linux `/proc`); `null` where `/proc` is not available. */
export function getProcessEnvNames(pid: number): string[] | null {
  const environPath = `/proc/${pid}/environ`;
  if (!fs.existsSync(environPath)) return null;
  return fs.readFileSync(environPath, 'utf8').split('\0').filter(Boolean).map((entry) => entry.slice(0, entry.indexOf('=')));
}

/**
 * @name IsolatedInstanceLayout
 * @description The instance's temp folder and what lives in it. Every path is
 * outside the user's HOME; the tmux server is private (its own TMUX_TMPDIR).
 * The env file is the instance's global config under its own HOME, which is
 * what the env loader reads.
 */
export interface IsolatedInstanceLayout {
  testRoot: string;
  instanceHome: string;
  dataDir: string;
  workRoot: string;
  fakeLogDir: string;
  envFile: string;
  tmuxTmpDir: string;
  /** A private PATH: the running `node`, the fake `claude`, the system tools — no other agent binary. */
  binDir: string;
}

/**
 * @description Create the layout under the OS temp dir. `prefix` names the
 * test (`charness-j7-`); `projectFolders` are created under WORK_ROOT.
 */
export function createIsolatedInstanceLayout(prefix: string, projectFolders: readonly string[]): IsolatedInstanceLayout {
  const testRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const layout: IsolatedInstanceLayout = {
    testRoot,
    instanceHome: path.join(testRoot, 'home'),
    dataDir: path.join(testRoot, 'data'),
    workRoot: path.join(testRoot, 'work'),
    fakeLogDir: path.join(testRoot, 'fake-claude-log'),
    envFile: path.join(testRoot, 'home', '.config', 'telegramcode', '.env'),
    tmuxTmpDir: path.join(testRoot, 'tmux'),
    binDir: path.join(testRoot, 'bin'),
  };
  for (const dir of [layout.instanceHome, path.dirname(layout.envFile), layout.dataDir, layout.fakeLogDir, layout.binDir, ...projectFolders.map((folder) => path.join(layout.workRoot, folder))]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.mkdirSync(layout.tmuxTmpDir, { mode: 0o700 });
  // The running node under its own name, so the instance's PATH needs no other folder that could hold an agent binary.
  fs.symlinkSync(process.execPath, path.join(layout.binDir, 'node'));
  return layout;
}

/**
 * @description The PATH the instance is started with: its private bin folder
 * first (the running `node`, the fake `claude`), then the system folders for
 * `sh`, `env` and `tmux`. Never the caller's PATH — under `yarn test` it starts
 * with yarn's `node` shim, and on a developer's box it holds the real agents.
 */
export function getIsolatedPath(layout: IsolatedInstanceLayout): string {
  return [layout.binDir, '/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter);
}

/** @description Write the fake `claude` launcher into the layout's bin folder and resolve its path. */
export function writeFakeClaudeLauncher(layout: IsolatedInstanceLayout): string {
  const fakeStateDir = path.join(layout.testRoot, 'fake-claude-state');
  fs.mkdirSync(fakeStateDir);
  const claudeBin = path.join(layout.binDir, 'claude');
  fs.writeFileSync(claudeBin, [
    '#!/bin/sh',
    `export FAKE_CLAUDE_LOG_DIR='${layout.fakeLogDir}'`,
    `export FAKE_CLAUDE_STATE_DIR='${fakeStateDir}'`,
    `exec '${process.execPath}' --import '${pathToFileURL(tsxLoaderPath).href}' '${fakeClaudePath}' "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  return claudeBin;
}

/** @description Write the instance's env file (`NAME=value` lines, owner-only). */
export function writeInstanceEnvFile(layout: IsolatedInstanceLayout, variables: Record<string, string>): void {
  fs.writeFileSync(layout.envFile, `${Object.entries(variables).map(([name, value]) => `${name}=${value}`).join('\n')}\n`, { mode: 0o600 });
}

/** @description The variable NAMES the instance's env file sets — never a value. */
export function getInstanceEnvNames(layout: IsolatedInstanceLayout): string[] {
  return fs.readFileSync(layout.envFile, 'utf8').split('\n').filter(Boolean).map((line) => line.split('=')[0]);
}

/**
 * @description One charness process started the way an isolated instance is
 * started: `run-isolated.sh` with only its HOME config. Everything it prints
 * (stdout and stderr, across restarts) accumulates in `output`.
 */
export class IsolatedCharness {
  private child: ChildProcess | null = null;
  /** Everything every run printed, stdout and stderr together. */
  output = '';

  constructor(private readonly layout: IsolatedInstanceLayout) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /**
   * @description Start and wait until `checkIsReady` accepts this run's output
   * (a Telegram instance adds its own signal: its first poll reaching the fake Bot
   * API, since telegraf's `launch` resolves only when polling STOPS); an exit
   * before that fails.
   */
  async start(timeoutMs: number, checkIsReady: (runOutput: string) => boolean): Promise<void> {
    const outputStart = this.output.length;
    const child = spawn(runIsolatedPath, [], {
      // run-isolated.sh passes on only these; HOME is the instance's own temp home.
      env: {
        HOME: this.layout.instanceHome,
        PATH: getIsolatedPath(this.layout),
        USER: process.env.USER ?? '',
        SHELL: '/bin/sh',
        LANG: 'C.UTF-8',
        TERM: 'dumb',
      },
      cwd: this.layout.testRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout?.on('data', (chunk: Buffer) => { this.output += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { this.output += chunk.toString('utf8'); });
    await this.waitFor('charness to be ready', timeoutMs, () => {
      if (child.exitCode !== null) throw new Error(`charness exited with ${child.exitCode}:\n${this.output.slice(outputStart)}`);
      return checkIsReady(this.output.slice(outputStart));
    });
  }

  /** @description A graceful stop (SIGTERM, then SIGKILL after the grace period). */
  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    const isStopped = await Promise.race([exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), stopTimeoutMs))]);
    if (!isStopped) {
      child.kill('SIGKILL');
      await exited;
    }
  }

  /** @description Kill outright — the synchronous sweep's step. */
  killSync(): void {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
    this.child = null;
  }

  /** @description Poll `check` until it holds; a timeout quotes the output tail. */
  async waitFor(description: string, timeoutMs: number, check: () => boolean): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${description}; charness output tail:\n${this.output.slice(-outputTailChars)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, waitStepMs));
    }
  }
}

/**
 * @description Stop everything the instance started, SYNCHRONOUSLY — so it also
 * runs from `process.on('exit')` after a signal or an uncaught failure, where
 * nothing asynchronous runs any more: charness (killed outright), the instance's
 * own tmux server (which ends the fake agents in it) and the temp folder.
 * Only the instance's server: the `default` socket inside its private
 * TMUX_TMPDIR, never the user's.
 */
export function removeIsolatedInstanceSync(layout: IsolatedInstanceLayout | null, charness: IsolatedCharness | null): void {
  charness?.killSync();
  if (!layout) return;
  // Every kill names its socket by FULL PATH (`-S`), which tmux never swaps for the server `$TMUX` names.
  spawnSync('tmux', ['-S', path.join(getTmuxSocketDir(layout.tmuxTmpDir), 'default'), 'kill-server'], { env: getTmuxEnv(null) });
  fs.rmSync(layout.testRoot, { recursive: true, force: true });
}

/** A signal ends the run through `exit`, whose handler cleans up (a signal's default action would skip it). */
export function exitOnSignal(signal: NodeJS.Signals): void {
  process.exit(128 + os.constants.signals[signal]);
}
