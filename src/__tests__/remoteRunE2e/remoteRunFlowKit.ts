/**
 * @description What the `charness remote-run` flow shares: a throwaway RUNNER built from nothing but a loopback `sshd` (no root: its own
 * host key, `ListenAddress 127.0.0.1`, a free port, key login only), a private Pueue (config, directories and socket in the temp
 * layout), a temp HOME with the `runners.json` the CLI reads, a git project, and the BUILT CLI started as a child process whose
 * output arrives with timestamps. Nothing leaves the machine and nothing outlives the test: the teardown ends the CLI children, the ssh
 * masters, Pueue's daemon, sshd and every decoy process by pid — also from `process.on('exit')`, where nothing asynchronous runs.
 *
 * The layout lives under `/tmp` and not under `TMPDIR`: an ssh control socket path may be 108 bytes at most, and a long `TMPDIR` would
 * push it over.
 */

import { execFileSync, spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { getRunnersConfigPath, type RunnersConfig } from '../../remoteRun/runnersConfig';
import { getProjectSlug } from '../../remoteRun/jobId';
import { closeSshMaster } from '../../remoteRun/ssh';
import { builtCliPath, checkIsProcessRunning, getFreePort } from '../e2e/isolatedCharness';
import { flowLayoutPrefix, listLayoutProcesses, reapDeadFlowLayouts, sweepFlowLayout, writeFlowLayoutOwner } from './remoteRunFlowSweep';

export { checkIsProcessRunning };

const sshdPath = '/usr/sbin/sshd';
const sshdReadyTimeoutMs = 10_000;
const sshdStartAttempts = 5;
const pollIntervalMs = 100;
const reaperPath = path.join(__dirname, 'remoteRunFlowReaper.ts');
const tsxLoaderPath = path.join(path.resolve(__dirname, '..', '..', '..'), 'node_modules', 'tsx', 'dist', 'loader.mjs');
export const runnerName = 'box1';

export const isCi = process.env.CI === 'true' || process.env.CI === '1';

/** The tools the flow needs; a local run without one is SKIPPED with the reason, CI fails (it installs them). */
export function getMissingTools(): string[] {
  const missing: string[] = [];
  if (!fs.existsSync(sshdPath)) missing.push(`${sshdPath} (openssh-server)`);
  for (const tool of ['ssh', 'ssh-keygen', 'rsync', 'pueue', 'pueued', 'git', 'bash']) {
    if (spawnSync('which', [tool], { stdio: 'ignore' }).status !== 0) missing.push(tool);
  }
  if (!fs.existsSync(builtCliPath)) missing.push('dist/cli.js (run `yarn build` first)');
  return missing;
}

export interface FlowLayout {
  root: string;
  home: string;
  cacheDir: string;
  workDir: string;
  projectsDir: string;
  sshPort: number;
  sshUser: string;
  clientKeyPath: string;
  knownHostsPath: string;
  pueueBin: string;
  pueueConfigPath: string;
  pueuePidPath: string;
  sshdPidPath: string;
  sshdProcess: ChildProcess | null;
  cliChildren: Set<ChildProcess>;
  /** The entries of the runners.json last written: their ssh masters are closed at the end. */
  runners: RunnersConfig['runners'];
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** @description Poll `check` until it returns a value that is not `null`/`false`, or fail with `description` after `timeoutMs`. */
export async function waitUntil<T>(description: string, timeoutMs: number, check: () => T | null | false | undefined): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== null && value !== false && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${description}`);
    await sleep(pollIntervalMs);
  }
}

function writeSshdConfig(layout: FlowLayout, port: number): string {
  const configPath = path.join(layout.root, 'sshd', 'sshd_config');
  fs.writeFileSync(configPath, [
    `Port ${port}`,
    'ListenAddress 127.0.0.1',
    `HostKey ${path.join(layout.root, 'sshd', 'host_key')}`,
    `PidFile ${layout.sshdPidPath}`,
    `AuthorizedKeysFile ${path.join(layout.root, 'sshd', 'authorized_keys')}`,
    'UsePAM no',
    'StrictModes no',
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'PubkeyAuthentication yes',
    'PermitUserEnvironment no',
    'LogLevel ERROR',
  ].join('\n'));
  return configPath;
}

async function startSshd(layout: FlowLayout): Promise<void> {
  for (let attempt = 1; attempt <= sshdStartAttempts; attempt += 1) {
    const port = await getFreePort();
    layout.sshPort = port;
    const logPath = path.join(layout.root, 'sshd', 'sshd.log');
    const logFd = fs.openSync(logPath, 'w');
    // Absolute path: sshd re-executes itself and refuses a relative one.
    const child = spawn(sshdPath, ['-D', '-e', '-f', writeSshdConfig(layout, port)], { stdio: ['ignore', logFd, logFd] });
    fs.closeSync(logFd);
    layout.sshdProcess = child;
    const exited = new Promise<boolean>((resolve) => child.once('exit', () => resolve(true)));
    const isReady = await Promise.race([
      waitUntil('sshd to listen', sshdReadyTimeoutMs, () => checkIsPortOpenSync(port)).then(() => true),
      exited.then(() => false),
    ]).catch(() => false);
    if (isReady) return;
    child.kill('SIGKILL');
    if (attempt === sshdStartAttempts) throw new Error(`sshd did not start after ${sshdStartAttempts} attempts: ${fs.readFileSync(logPath, 'utf8').slice(-500)}`);
  }
}

/** A synchronous probe, for `waitUntil`'s synchronous check: a connect from a child `node` would be slower than `ss`. */
function checkIsPortOpenSync(port: number): boolean {
  const result = spawnSync('bash', ['-c', `exec 3<>/dev/tcp/127.0.0.1/${port}`], { stdio: 'ignore' });
  return result.status === 0;
}

function writePueueConfig(layout: FlowLayout): void {
  const pueueRoot = path.join(layout.root, 'pueue');
  const runtimeDir = path.join(pueueRoot, 'run');
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(pueueRoot, 'data'), { recursive: true });
  fs.writeFileSync(layout.pueueConfigPath, [
    'shared:',
    `  pueue_directory: ${path.join(pueueRoot, 'data')}`,
    `  runtime_directory: ${runtimeDir}`,
    '  use_unix_socket: true',
    `  unix_socket_path: ${path.join(runtimeDir, 'pueue.socket')}`,
    `  pid_path: ${layout.pueuePidPath}`,
    '',
  ].join('\n'));
}

/** Start the detached reaper of the layout in a session of its own; it needs nothing from this process to go on. */
function startFlowLayoutReaper(root: string): void {
  const reaper = spawn(process.execPath, ['--import', pathToFileURL(tsxLoaderPath).href, reaperPath, root], {
    detached: true,
    stdio: 'ignore',
    env: { HOME: process.env.HOME ?? '', PATH: process.env.PATH ?? '' },
  });
  reaper.unref();
}

/** @description Build the whole runner: layout, keys, sshd, Pueue config (the daemon itself is started by remote-run, as in real use). */
export async function createFlowLayout(): Promise<FlowLayout> {
  for (const reapedRoot of reapDeadFlowLayouts()) console.log(`[remote-run flow] reaped a dead earlier layout: ${reapedRoot}`);
  const root = fs.mkdtempSync(flowLayoutPrefix);
  writeFlowLayoutOwner(root);
  startFlowLayoutReaper(root);
  const pueueBin = execFileSync('which', ['pueue'], { encoding: 'utf8' }).trim();
  const layout: FlowLayout = {
    root,
    home: path.join(root, 'home'),
    cacheDir: path.join(root, 'cache'),
    workDir: path.join(root, 'work'),
    projectsDir: path.join(root, 'projects'),
    sshPort: 0,
    sshUser: os.userInfo().username,
    clientKeyPath: path.join(root, 'keys', 'client_key'),
    knownHostsPath: path.join(root, 'keys', 'known_hosts'),
    pueueBin,
    pueueConfigPath: path.join(root, 'pueue', 'pueue.yml'),
    pueuePidPath: path.join(root, 'pueue', 'run', 'pueue.pid'),
    sshdPidPath: path.join(root, 'sshd', 'sshd.pid'),
    sshdProcess: null,
    cliChildren: new Set(),
    runners: [],
  };
  for (const directory of [layout.home, layout.cacheDir, layout.projectsDir, path.join(root, 'keys'), path.join(root, 'sshd')]) fs.mkdirSync(directory, { recursive: true });
  // The runner's work dir is made by remote-run itself: nothing is prepared on the runner by hand.
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(root, 'sshd', 'host_key')]);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', layout.clientKeyPath]);
  fs.copyFileSync(`${layout.clientKeyPath}.pub`, path.join(root, 'sshd', 'authorized_keys'));
  writePueueConfig(layout);
  await startSshd(layout);
  const hostKey = fs.readFileSync(path.join(root, 'sshd', 'host_key.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ');
  fs.writeFileSync(layout.knownHostsPath, `[127.0.0.1]:${layout.sshPort} ${hostKey}\n`);
  return layout;
}

/** The ssh options of an entry of runners.json: the operator's own, as the plan has it (`-F /dev/null`, a key, a port, known hosts checked strictly). */
export function getSshOptions(layout: FlowLayout, options: { port?: number; knownHostsPath?: string } = {}): string[] {
  return [
    '-F', '/dev/null',
    '-i', layout.clientKeyPath,
    '-p', `${options.port ?? layout.sshPort}`,
    '-o', 'IdentitiesOnly=yes',
    '-o', `UserKnownHostsFile=${options.knownHostsPath ?? layout.knownHostsPath}`,
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'LogLevel=ERROR',
  ];
}

export function createRunnerEntry(layout: FlowLayout, overrides: Partial<RunnersConfig['runners'][number]> = {}): RunnersConfig['runners'][number] {
  return {
    name: runnerName,
    ssh: `${layout.sshUser}@127.0.0.1`,
    sshOptions: getSshOptions(layout),
    workDir: layout.workDir,
    pueue: { bin: layout.pueueBin, config: layout.pueueConfigPath },
    groups: { default: 3, emulator: 1 },
    ...overrides,
  };
}

/** @description Write the `runners.json` the CLI will read from the layout's HOME. */
export function writeRunnersJson(layout: FlowLayout, runners: RunnersConfig['runners']): void {
  const filePath = getRunnersConfigPath(layout.home);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ runners }));
  layout.runners = runners;
}

export interface FlowProject {
  root: string;
  /** The runner-side folder of this project: `<workDir>/p/<slug>`. */
  runnerDirectory: string;
}

function git(directory: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=Test', '-C', directory, ...args], { stdio: 'ignore' });
}

/** @description A git project with `files` committed (name → content); `.gitignore` is added by the caller when wanted. */
export function createProject(layout: FlowLayout, name: string, files: Readonly<Record<string, string>>): FlowProject {
  fs.mkdirSync(path.join(layout.projectsDir, name), { recursive: true });
  const root = fs.realpathSync(path.join(layout.projectsDir, name));
  git(root, 'init', '-q', '-b', 'main');
  for (const [file, content] of Object.entries(files)) writeProjectFile({ root, runnerDirectory: '' }, file, content);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  const slug = getProjectSlug(root, { hostname: os.hostname(), uid: os.userInfo().uid });
  return { root, runnerDirectory: path.join(layout.workDir, 'p', slug) };
}

export function writeProjectFile(project: FlowProject, relativePath: string, content: string): void {
  const target = path.join(project.root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

export function readProjectFile(project: FlowProject, relativePath: string): string | null {
  try {
    return fs.readFileSync(path.join(project.root, relativePath), 'utf8');
  } catch {
    return null;
  }
}

export interface CliOutputChunk {
  atMs: number;
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface CliRun {
  child: ChildProcess;
  chunks: CliOutputChunk[];
  stdout: () => string;
  stderr: () => string;
  /** Resolves when the process ended. */
  finished: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
}

/** @description Start the BUILT CLI as `charness remote-run <args>` in `cwd`, with an environment of its own (the layout's HOME and cache, nothing else of this process's). */
export function startCli(layout: FlowLayout, args: readonly string[], options: { cwd: string; env?: NodeJS.ProcessEnv } = { cwd: layout.projectsDir }): CliRun {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: layout.home,
    XDG_CACHE_HOME: layout.cacheDir,
    TMPDIR: process.env.TMPDIR,
    LANG: 'C.UTF-8',
    ...options.env,
  };
  const child = spawn(process.execPath, [builtCliPath, 'remote-run', ...args], { cwd: options.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  layout.cliChildren.add(child);
  const chunks: CliOutputChunk[] = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (text: string) => chunks.push({ atMs: Date.now(), stream: 'stdout', text }));
  child.stderr.on('data', (text: string) => chunks.push({ atMs: Date.now(), stream: 'stderr', text }));
  const finished = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (exitCode, signal) => {
      layout.cliChildren.delete(child);
      resolve({ exitCode, signal });
    });
  });
  return {
    child,
    chunks,
    stdout: () => chunks.filter((chunk) => chunk.stream === 'stdout').map((chunk) => chunk.text).join(''),
    stderr: () => chunks.filter((chunk) => chunk.stream === 'stderr').map((chunk) => chunk.text).join(''),
    finished,
  };
}

export interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  chunks: CliOutputChunk[];
}

/** @description Run the CLI to its end, killed (and the test failed) when it runs past `timeoutMs`. */
export async function runCli(layout: FlowLayout, args: readonly string[], options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<CliResult> {
  const run = startCli(layout, args, options);
  const timeoutMs = options.timeoutMs ?? 120_000;
  const timer = setTimeout(() => run.child.kill('SIGKILL'), timeoutMs);
  const { exitCode, signal } = await run.finished;
  clearTimeout(timer);
  if (signal === 'SIGKILL' && exitCode === null) throw new Error(`remote-run ${args.join(' ')} ran past ${timeoutMs} ms\nstdout: ${run.stdout()}\nstderr: ${run.stderr()}`);
  return { exitCode, stdout: run.stdout(), stderr: run.stderr(), chunks: run.chunks };
}

/** @description The pid a decoy command wrote into the project's runner folder (`../<name>.pid` from the project root), once it exists. */
export function waitForPidFile(project: FlowProject, name: string, timeoutMs = 30_000): Promise<number> {
  return waitUntil(`${name} to write its pid`, timeoutMs, () => {
    try {
      const pid = Number(fs.readFileSync(path.join(project.runnerDirectory, name), 'utf8').trim());
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  });
}

/** @description A command that records its own pid and its child's under `<runner folder>/<name>.pid|.child`, then waits: what "nothing is left" is asserted on. */
export function createDecoyCommand(name: string, options: { isIgnoringTerm?: boolean } = {}): string {
  const trap = options.isIgnoringTerm === true ? `trap "" TERM; ` : '';
  return `sh -c '${trap}echo $$ > ../${name}.pid; sleep 300 & echo $! > ../${name}.child; wait'`;
}

/** The longest a gated command waits for its gate: a bound for a test that failed before it opened it (a cleanup kills the job anyway). */
const gateWaitMaxSeconds = 180;
const gatePollSeconds = 0.2;

/**
 * @description A command that does `before`, waits for the gate file `name` the TEST creates in the runner's project folder
 * (`openGate`), then does `after`. A state the test controls instead of a sleep: "the job is still running" stays true for as long
 * as the test needs it, however loaded the machine is.
 */
export function createGatedCommand(name: string, steps: { before?: string; after: string }): string {
  const polls = Math.round(gateWaitMaxSeconds / gatePollSeconds);
  const wait = `n=0; while [ ! -f ../${name} ] && [ $n -lt ${polls} ]; do sleep ${gatePollSeconds}; n=$((n+1)); done`;
  return `sh -c '${[steps.before, wait, steps.after].filter((step) => step !== undefined && step !== '').join('; ')}'`;
}

/** @description Open the gate of a gated command. */
export function openGate(project: FlowProject, name: string): number {
  fs.writeFileSync(path.join(project.runnerDirectory, name), '');
  return Date.now();
}

/** @description Wait until a process of the layout whose command line `matches` runs (e.g. the runner script's `wait` for a job). */
export function waitForLayoutProcess(layout: FlowLayout, description: string, matches: (commandLine: string) => boolean, timeoutMs = 30_000): Promise<true> {
  return waitUntil(description, timeoutMs, () => listLayoutProcesses(layout.root).some((candidate) => matches(candidate.args)));
}

/**
 * @description End what a test left running, so that one failing test cannot hold the project lock against every test after it: the CLI
 * children first (a stopped one included), then every job of the runner that is still queued or running, through the CLI like an agent.
 */
export async function cleanUpOpenJobs(layout: FlowLayout, project: FlowProject, env: NodeJS.ProcessEnv): Promise<void> {
  for (const child of layout.cliChildren) child.kill('SIGKILL');
  const listed = await runCli(layout, ['ls', '--all'], { cwd: project.root, env, timeoutMs: 60_000 }).catch(() => null);
  if (listed === null) return;
  for (const line of listed.stdout.split('\n')) {
    const match = /^(box1-[a-z2-7]{6}) +(queued|running)\b/.exec(line);
    if (match !== null) await runCli(layout, ['kill', match[1]], { cwd: project.root, env, timeoutMs: 60_000 }).catch(() => null);
  }
}

/** @description Wait until a pid is gone (zombies do not count). */
export function waitForProcessGone(description: string, pid: number, timeoutMs: number): Promise<true> {
  return waitUntil(description, timeoutMs, () => !checkIsProcessRunning(pid));
}

/** @description Synchronous end of everything the layout started (also called from `process.on('exit')`); `removeFiles: false` keeps the folder for a look. */
export function stopFlowLayoutSync(layout: FlowLayout, removeFiles = true): void {
  for (const child of layout.cliChildren) child.kill('SIGKILL');
  layout.cliChildren.clear();
  // Pueue's daemon first, politely, so its state file is closed; everything else is the sweep's (by the layout's folder).
  if (fs.existsSync(layout.pueuePidPath)) {
    spawnSync(layout.pueueBin, ['-c', layout.pueueConfigPath, 'shutdown'], { stdio: 'ignore', timeout: 10_000 });
  }
  sweepFlowLayout(layout.root, { removeFiles });
}

/** The cache dir the CLI of this layout uses (`$XDG_CACHE_HOME/charness/remote-run`). */
function getCliCacheDir(layout: FlowLayout): string {
  return path.join(layout.cacheDir, 'charness', 'remote-run');
}

/** @description The async part of the teardown (the masters' closing), then the synchronous stop. */
export async function stopFlowLayout(layout: FlowLayout): Promise<void> {
  await Promise.all(layout.runners.map((runner) => closeSshMaster(runner, getCliCacheDir(layout))));
  stopFlowLayoutSync(layout);
}
