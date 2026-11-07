/**
 * @description What the runner-link flow shares: a throwaway HUB made of a loopback `sshd` (no root: its own host key, key login only,
 * `AuthorizedKeysFile` pointed at a temp HOME) and a COPY of the built charness (so a change to the package can be made without touching
 * `dist/`), and a throwaway RUNNER MACHINE — a temp HOME with the real pair line run in it and the real `charness-runner run` started in
 * a process group of its own. Everything lives under `/tmp/crr-*` (short paths for unix sockets) and is ended by pid at the end, also from
 * the next run's reap of layouts whose owner is gone (`remoteRunFlowSweep.ts`).
 *
 * No registry is reached: the runner's dependencies come from this repository's `node_modules` (the test seam `CHARNESS_TEST_RUNNER_NODE_MODULES`)
 * and Pueue / rsync are the ones on this machine, put where the utility looks for its own.
 */

import { execFileSync, spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { builtCliPath, getFreePort } from '../e2e/isolatedCharness';
import { flowLayoutPrefix, reapDeadFlowLayouts, sweepFlowLayout, writeFlowLayoutOwner } from '../remoteRunE2e/remoteRunFlowSweep';
import { installAppFromDirectory, switchCurrentApp, testNodeModulesEnvName } from '../../runnerUtility/appInstall';
import { ensureLauncher } from '../../runnerUtility/launcher';
import { getRunnerHomePaths } from '../../runnerUtility/runnerHome';
import { runnerLockRelativePath } from '../../runners/runnerLock';
import { ensureNodeScriptRelativePath, testKeepNodeEnvName } from '../../runnerUtility/managedNode';

export { waitUntil } from '../runnersTestKit';

const sshdPath = '/usr/sbin/sshd';
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const ensureNodeScriptPath = path.join(repoRoot, ensureNodeScriptRelativePath);
const sshdStartAttempts = 5;
const lineTimeoutMs = 180_000;

export const isCi = process.env.CI === 'true' || process.env.CI === '1';

export function getMissingTools(): string[] {
  const missing: string[] = [];
  if (!fs.existsSync(sshdPath)) missing.push(`${sshdPath} (openssh-server)`);
  for (const tool of ['ssh', 'ssh-keygen', 'ssh-keyscan', 'rsync', 'pueue', 'pueued', 'tar', 'fold', 'bash']) {
    if (spawnSync('which', [tool], { stdio: 'ignore' }).status !== 0) missing.push(tool);
  }
  if (!fs.existsSync(builtCliPath)) missing.push('dist/cli.js (run `yarn build` first)');
  return missing;
}

export interface RunnerLinkLayout {
  root: string;
  hubHome: string;
  /** The registry folder of the hub (`~/.config/charness/runners`). */
  hubDir: string;
  /** A copy of the built charness the hub runs from. */
  hubInstall: string;
  runnerHome: string;
  sshPort: number;
  sshdProcess: ChildProcess | null;
  extraSshd: Set<ChildProcess>;
  /** The impostor server, once started (see {@link startImpostorSshd}). */
  impostor: SshdInstance | null;
  groups: Set<ChildProcess>;
}

function copyBuiltCharness(destination: string): void {
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(path.join(repoRoot, 'dist'), path.join(destination, 'dist'), {
    recursive: true,
    filter: (source) => !/(\.d\.ts|\.d\.ts\.map|\.js\.map)$/.test(source) && !source.includes(`${path.sep}__tests__`),
  });
  fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(destination, 'package.json'));
  fs.mkdirSync(path.join(destination, 'remoteRun'));
  fs.copyFileSync(path.join(repoRoot, 'remoteRun', 'runner.sh'), path.join(destination, 'remoteRun', 'runner.sh'));
  writeNodeInstallerStandIn(path.join(destination, ensureNodeScriptRelativePath));
  // The lock the hub packs for the runner (`runners/runnerLock.ts`): a package is made of it and `package.json`, and refused without it.
  fs.copyFileSync(path.join(repoRoot, runnerLockRelativePath), path.join(destination, runnerLockRelativePath));
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(destination, 'node_modules'), 'dir');
}

/**
 * The package's `remoteRun/ensureNode.sh` as a flow has it: no download — the runner's Node is the one running the flow. A flow that is about the Node
 * install itself puts the real script back ({@link placeRealNodeInstaller}, {@link placeRootNodeInstallerWrapper}) and a local mirror of nodejs.org with it.
 */
function writeNodeInstallerStandIn(scriptPath: string): void {
  fs.writeFileSync(scriptPath, `#!/bin/sh\n# A flow's stand-in: the Node that runs the flow, not a download.\necho ${JSON.stringify(process.execPath)}\n`, { mode: 0o755 });
}

/** @description Put the REAL `ensureNode.sh` at `scriptPath` (the runner's installed copy of the package, for a flow about the move off a system Node). */
export function placeRealNodeInstaller(scriptPath: string): void {
  fs.copyFileSync(ensureNodeScriptPath, scriptPath);
  fs.chmodSync(scriptPath, 0o755);
}

/**
 * @description Make the hub's package carry a `remoteRun/ensureNode.sh` that runs the REAL script in `root` mode (what the admin line runs as root) with this
 * flow's own shared folder instead of `/usr/local` and this flow's mirror of nodejs.org instead of the network — the script's test seams, which the pasted line
 * never passes. Everything the script does is the real thing; only where it reads from and writes to is the flow's.
 */
export function placeRootNodeInstallerWrapper(layout: RunnerLinkLayout, options: { base: string; distDir: string }): void {
  const wrapper = [
    '#!/bin/sh',
    '# A flow\'s wrapper around the real script: its own shared folder, its own mirror of nodejs.org.',
    `exec sh ${JSON.stringify(ensureNodeScriptPath)} "$1" "$2" ${JSON.stringify(options.base)} "" ${JSON.stringify(`file://${options.distDir}`)}`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(layout.hubInstall, ensureNodeScriptRelativePath), wrapper, { mode: 0o755 });
}

export interface SshdInstance {
  port: number;
  process: ChildProcess;
}

/**
 * OpenSSH 9.8 and later refuse EVERY connection from an address after a few failed logins from it (`PerSourcePenalties`: «Connection closed by
 * 127.0.0.1», a good key too), and the flows refuse logins on purpose — all from 127.0.0.1. Older sshd knows no such keyword and rejects the whole
 * config for it, so sshd itself is asked whether it does.
 */
function checkIsPerSourcePenaltiesKnown(sshdDir: string, hostKeyPath: string): boolean {
  const probeConfigPath = path.join(sshdDir, 'penalties_probe_config');
  fs.writeFileSync(probeConfigPath, `HostKey ${hostKeyPath}\nPerSourcePenalties no\n`);
  return spawnSync(sshdPath, ['-t', '-f', probeConfigPath], { stdio: 'ignore' }).status === 0;
}

/** A loopback sshd (own host key, key login only) that reads the keys of `authorizedKeysPath`. */
async function startSshdInstance(root: string, name: string, authorizedKeysPath: string): Promise<SshdInstance> {
  const sshdDir = path.join(root, name);
  fs.mkdirSync(sshdDir, { recursive: true });
  const hostKeyPath = path.join(sshdDir, 'host_key');
  fs.rmSync(hostKeyPath, { force: true });
  fs.rmSync(`${hostKeyPath}.pub`, { force: true });
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKeyPath]);
  const penaltyConfigLines = checkIsPerSourcePenaltiesKnown(sshdDir, hostKeyPath) ? ['PerSourcePenalties no'] : [];
  for (let attempt = 1; attempt <= sshdStartAttempts; attempt += 1) {
    const port = await getFreePort();
    const configPath = path.join(sshdDir, 'sshd_config');
    fs.writeFileSync(configPath, [
      `Port ${port}`,
      'ListenAddress 127.0.0.1',
      `HostKey ${path.join(sshdDir, 'host_key')}`,
      `PidFile ${path.join(sshdDir, 'sshd.pid')}`,
      `AuthorizedKeysFile ${authorizedKeysPath}`,
      'UsePAM no',
      'StrictModes no',
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'PubkeyAuthentication yes',
      'LogLevel ERROR',
      ...penaltyConfigLines,
    ].join('\n'));
    const logFd = fs.openSync(path.join(sshdDir, 'sshd.log'), 'w');
    const child = spawn(sshdPath, ['-D', '-e', '-f', configPath], { stdio: ['ignore', logFd, logFd] });
    fs.closeSync(logFd);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (spawnSync('ssh-keyscan', ['-p', String(port), '-T', '2', '127.0.0.1'], { encoding: 'utf8' }).stdout.includes('ssh-ed25519')) return { port, process: child };
      await new Promise((resolve) => { setTimeout(resolve, 150); });
    }
    child.kill('SIGKILL');
  }
  throw new Error('sshd did not start');
}

/**
 * @description A second sshd with a host key of its own, that knows no key at all: what a runner must refuse to trust. ONE per layout —
 * every case that needs an impostor gets the same server (a second `ssh-keygen` into the same folder would stop to ask about overwriting
 * the host key), and it lives until the layout is destroyed.
 */
export async function startImpostorSshd(layout: RunnerLinkLayout): Promise<SshdInstance> {
  if (layout.impostor !== null) return layout.impostor;
  const emptyKeys = path.join(layout.root, 'impostor-authorized_keys');
  fs.writeFileSync(emptyKeys, '');
  const instance = await startSshdInstance(layout.root, 'impostor', emptyKeys);
  layout.extraSshd.add(instance.process);
  layout.impostor = instance;
  return instance;
}

/** @description Build the hub and an empty runner machine. */
export async function createRunnerLinkLayout(): Promise<RunnerLinkLayout> {
  for (const reaped of reapDeadFlowLayouts()) console.log(`[runner-link flow] reaped a dead earlier layout: ${reaped}`);
  const root = fs.mkdtempSync(flowLayoutPrefix);
  writeFlowLayoutOwner(root);
  const layout: RunnerLinkLayout = {
    root,
    hubHome: path.join(root, 'hub'),
    hubDir: path.join(root, 'hub', '.config', 'charness', 'runners'),
    hubInstall: path.join(root, 'hub-install'),
    runnerHome: path.join(root, 'machine'),
    sshPort: 0,
    sshdProcess: null,
    extraSshd: new Set(),
    impostor: null,
    groups: new Set(),
  };
  for (const directory of [layout.hubHome, layout.runnerHome, path.join(root, 'tmp')]) fs.mkdirSync(directory, { recursive: true });
  copyBuiltCharness(layout.hubInstall);
  const main = await startSshdInstance(root, 'sshd', path.join(layout.hubHome, '.ssh', 'authorized_keys'));
  layout.sshPort = main.port;
  layout.sshdProcess = main.process;
  placeMachineTools(layout.runnerHome);
  return layout;
}

/** Pueue is the machine's own, placed where the utility looks for its own: the flow never downloads or builds anything (rsync is found on PATH). */
function placeMachineTools(home: string): void {
  const binDir = getRunnerHomePaths(home).binDir;
  fs.mkdirSync(binDir, { recursive: true });
  for (const tool of ['pueue', 'pueued']) fs.symlinkSync(execFileSync('which', [tool], { encoding: 'utf8' }).trim(), path.join(binDir, tool));
}

/** @description A second, empty machine (a home of its own) next to the first. */
export function createExtraMachine(layout: RunnerLinkLayout, name: string): string {
  const home = path.join(layout.root, name);
  fs.mkdirSync(home, { recursive: true });
  placeMachineTools(home);
  return home;
}

/** @description What the pasted line does on a machine up to the redemption: install the charness package, point `current` at it, write the launcher. */
export async function installRunnerApp(layout: RunnerLinkLayout, home: string): Promise<void> {
  const paths = getRunnerHomePaths(home);
  const previous = process.env[testNodeModulesEnvName];
  process.env[testNodeModulesEnvName] = path.join(repoRoot, 'node_modules');
  const unpackedPackage = path.join(layout.root, 'runner-package-source');
  fs.rmSync(unpackedPackage, { recursive: true, force: true });
  fs.cpSync(layout.hubInstall, unpackedPackage, { recursive: true, filter: (source) => path.basename(source) !== 'node_modules' });
  try {
    switchCurrentApp(paths, await installAppFromDirectory(unpackedPackage, paths));
  } finally {
    if (previous === undefined) delete process.env[testNodeModulesEnvName];
    else process.env[testNodeModulesEnvName] = previous;
  }
  ensureLauncher(paths, process.execPath);
}

export function getHubCliPath(layout: RunnerLinkLayout): string {
  return path.join(layout.hubInstall, 'dist', 'cli.js');
}

function createEnv(home: string, layout: RunnerLinkLayout, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { HOME: home, PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}`, TMPDIR: path.join(layout.root, 'tmp'), LANG: 'C.UTF-8', ...extra };
}

/** @description `charness <args>` of the hub's copy, with the hub's HOME. */
export function runHubCli(layout: RunnerLinkLayout, args: string[], extraEnv: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [getHubCliPath(layout), ...args], { encoding: 'utf8', env: createEnv(layout.hubHome, layout, extraEnv), timeout: 60_000 });
}

/** @description Make a pairing line on the hub; returns the `sh -c '…'` line. */
export function makePairingLine(layout: RunnerLinkLayout, extraEnv: NodeJS.ProcessEnv = {}): string {
  const result = runHubCli(layout, ['runners', 'pair', '--host', `127.0.0.1:${layout.sshPort}`, '--label', '@ExampleBot'], extraEnv);
  const line = result.stdout.split('\n').find((candidate) => candidate.startsWith("sh -c '"));
  if (result.status !== 0 || line === undefined) throw new Error(`runners pair failed: ${result.stderr}${result.stdout}`);
  return line;
}

/** @description Make a pairing on the hub; returns both lines of it: the one for an ADMIN account (`sudo sh -c …`, `account` as its last word) and the plain one. */
export function makePairingLines(layout: RunnerLinkLayout, account: string): { adminLine: string; plainLine: string } {
  const result = runHubCli(layout, ['runners', 'pair', '--host', `127.0.0.1:${layout.sshPort}`, '--label', '@ExampleBot', '--account', account]);
  const lines = result.stdout.split('\n');
  const adminLine = lines.find((candidate) => candidate.startsWith("sudo sh -c '"));
  const plainLine = lines.find((candidate) => candidate.startsWith("sh -c '"));
  if (result.status !== 0 || adminLine === undefined || plainLine === undefined) throw new Error(`runners pair failed: ${result.stderr}${result.stdout}`);
  return { adminLine, plainLine };
}

/** @description Run the pasted line on a runner machine (the flow's first one unless `home` names another). */
export function runPairingLine(layout: RunnerLinkLayout, line: string, home: string = layout.runnerHome): SpawnSyncReturns<string> {
  return spawnSync('sh', ['-c', line], {
    encoding: 'utf8',
    env: createEnv(home, layout, { [testNodeModulesEnvName]: path.join(repoRoot, 'node_modules') }),
    timeout: lineTimeoutMs,
  });
}

/** @description Start `charness-runner run` through the launcher, in a process group of its own, with `FLOW_SECRET` in ITS environment (a job must never see it); `extraEnv` is added to (and wins over) the flow's own variables. */
export function startRunner(layout: RunnerLinkLayout, home: string = layout.runnerHome, extraEnv: NodeJS.ProcessEnv = {}): ChildProcess {
  const paths = getRunnerHomePaths(home);
  const child = spawn(paths.launcher, ['run'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: createEnv(home, layout, {
      FLOW_SECRET: 'leak',
      [testNodeModulesEnvName]: path.join(repoRoot, 'node_modules'),
      // The runner keeps the Node the flow runs on: only a flow about the move off a system Node lets it download (from a mirror).
      [testKeepNodeEnvName]: '1',
      // The linked runner asks the hub for its package every 2 s instead of every 5 minutes, and a Mac's looks at its lid every second instead of every ten (the seam may only shorten the windows).
      CHARNESS_TEST_TIMINGS: JSON.stringify({ runnerVersionPollMs: 2000, runnerLidPollMs: 1000 }),
      ...extraEnv,
    }),
  });
  layout.groups.add(child);
  return child;
}

/** @description End a runner started by {@link startRunner}: its whole process group (the launcher loop and the app). */
export async function stopRunner(layout: RunnerLinkLayout, child: ChildProcess): Promise<void> {
  const exited = new Promise<void>((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', () => resolve()); });
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  await exited;
  layout.groups.delete(child);
}

/** The arguments of a plain `ssh` from the hub to the runner through the link, exactly as remote-run's ssh calls go. */
function buildSshThroughLinkArguments(layout: RunnerLinkLayout, runnerId: string, command: string): string[] {
  const hubDir = layout.hubDir;
  return [
    '-F', '/dev/null',
    '-o', `ProxyCommand=${process.execPath} ${getHubCliPath(layout)} runner-proxy ${path.join(hubDir, 'link', `${runnerId}.sock`)}`,
    '-o', `HostKeyAlias=charness-runner-${runnerId}`,
    '-o', `UserKnownHostsFile=${path.join(hubDir, 'known_hosts')}`,
    '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'StrictHostKeyChecking=yes',
    '-i', path.join(hubDir, 'hub_ed25519'),
    '-o', 'IdentitiesOnly=yes',
    '-o', 'IdentityAgent=none',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=20',
    'runner@link',
    command,
  ];
}

/** @description Plain `ssh` from the hub to the runner through the link, exactly as remote-run's ssh calls go. */
export function sshThroughLink(layout: RunnerLinkLayout, runnerId: string, command: string): SpawnSyncReturns<string> {
  return spawnSync('ssh', buildSshThroughLinkArguments(layout, runnerId, command), { encoding: 'utf8', timeout: 60_000, env: createEnv(layout.hubHome, layout) });
}

/** @description The same, left running: a command held over the link while the flow looks at what the runner does meanwhile. The caller ends it. */
export function startSshThroughLink(layout: RunnerLinkLayout, runnerId: string, command: string): ChildProcess {
  return spawn('ssh', buildSshThroughLinkArguments(layout, runnerId, command), { stdio: 'ignore', env: createEnv(layout.hubHome, layout) });
}

/** @description `ssh` to the hub's sshd with the RUNNER'S OWN key and `extraArgs` — what a runner (or someone holding its key) could try. */
export function sshToHubWithRunnerKey(layout: RunnerLinkLayout, extraArgs: string[], command: string | null): SpawnSyncReturns<string> {
  const keyPath = getRunnerHomePaths(layout.runnerHome).clientKey;
  return spawnSync('ssh', [
    '-F', '/dev/null', '-p', String(layout.sshPort), '-i', keyPath,
    '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no',
    '-o', `UserKnownHostsFile=${path.join(layout.root, 'known_hosts.scratch')}`, '-o', 'ConnectTimeout=20',
    ...extraArgs, `${os.userInfo().username}@127.0.0.1`, ...(command === null ? [] : [command]),
  ], { encoding: 'utf8', timeout: 30_000 });
}

export function readJson<TValue>(filePath: string): TValue {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/** @description End everything of the layout and remove it. */
export async function destroyRunnerLinkLayout(layout: RunnerLinkLayout): Promise<void> {
  for (const child of [...layout.groups]) await stopRunner(layout, child);
  layout.sshdProcess?.kill('SIGKILL');
  for (const extra of layout.extraSshd) extra.kill('SIGKILL');
  sweepFlowLayout(layout.root);
}
