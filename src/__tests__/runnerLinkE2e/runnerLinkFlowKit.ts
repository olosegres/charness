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
import { testNodeModulesEnvName } from '../../runnerUtility/appInstall';
import { getRunnerHomePaths } from '../../runnerUtility/runnerHome';

export { waitUntil } from '../runnersTestKit';

const sshdPath = '/usr/sbin/sshd';
const repoRoot = path.resolve(__dirname, '..', '..', '..');
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
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(destination, 'node_modules'), 'dir');
}

async function startSshd(layout: RunnerLinkLayout): Promise<void> {
  const sshdDir = path.join(layout.root, 'sshd');
  fs.mkdirSync(sshdDir, { recursive: true });
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(sshdDir, 'host_key')]);
  for (let attempt = 1; attempt <= sshdStartAttempts; attempt += 1) {
    layout.sshPort = await getFreePort();
    const configPath = path.join(sshdDir, 'sshd_config');
    fs.writeFileSync(configPath, [
      `Port ${layout.sshPort}`,
      'ListenAddress 127.0.0.1',
      `HostKey ${path.join(sshdDir, 'host_key')}`,
      `PidFile ${path.join(sshdDir, 'sshd.pid')}`,
      `AuthorizedKeysFile ${path.join(layout.hubHome, '.ssh', 'authorized_keys')}`,
      'UsePAM no',
      'StrictModes no',
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'PubkeyAuthentication yes',
      'LogLevel ERROR',
    ].join('\n'));
    const logFd = fs.openSync(path.join(sshdDir, 'sshd.log'), 'w');
    layout.sshdProcess = spawn(sshdPath, ['-D', '-e', '-f', configPath], { stdio: ['ignore', logFd, logFd] });
    fs.closeSync(logFd);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (spawnSync('ssh-keyscan', ['-p', String(layout.sshPort), '-T', '2', '127.0.0.1'], { encoding: 'utf8' }).stdout.includes('ssh-ed25519')) return;
      await new Promise((resolve) => { setTimeout(resolve, 150); });
    }
    layout.sshdProcess.kill('SIGKILL');
  }
  throw new Error('sshd did not start');
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
    groups: new Set(),
  };
  for (const directory of [layout.hubHome, layout.runnerHome, path.join(root, 'tmp')]) fs.mkdirSync(directory, { recursive: true });
  copyBuiltCharness(layout.hubInstall);
  await startSshd(layout);
  // Pueue and rsync are the machine's own, placed where the utility looks for its own: the flow never downloads or builds anything.
  const runnerBin = getRunnerHomePaths(layout.runnerHome).binDir;
  fs.mkdirSync(runnerBin, { recursive: true });
  for (const tool of ['pueue', 'pueued']) fs.symlinkSync(execFileSync('which', [tool], { encoding: 'utf8' }).trim(), path.join(runnerBin, tool));
  return layout;
}

export function getHubCliPath(layout: RunnerLinkLayout): string {
  return path.join(layout.hubInstall, 'dist', 'cli.js');
}

function createEnv(home: string, layout: RunnerLinkLayout, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { HOME: home, PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}`, TMPDIR: path.join(layout.root, 'tmp'), LANG: 'C.UTF-8', ...extra };
}

/** @description `charness <args>` of the hub's copy, with the hub's HOME. */
export function runHubCli(layout: RunnerLinkLayout, args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [getHubCliPath(layout), ...args], { encoding: 'utf8', env: createEnv(layout.hubHome, layout), timeout: 60_000 });
}

/** @description Make a pairing line on the hub; returns the `sh -c '…'` line. */
export function makePairingLine(layout: RunnerLinkLayout): string {
  const result = runHubCli(layout, ['runners', 'pair', '--host', `127.0.0.1:${layout.sshPort}`, '--label', '@ExampleBot']);
  const line = result.stdout.split('\n').find((candidate) => candidate.startsWith("sh -c '"));
  if (result.status !== 0 || line === undefined) throw new Error(`runners pair failed: ${result.stderr}${result.stdout}`);
  return line;
}

/** @description Run the pasted line on the runner machine. */
export function runPairingLine(layout: RunnerLinkLayout, line: string): SpawnSyncReturns<string> {
  return spawnSync('sh', ['-c', line], {
    encoding: 'utf8',
    env: createEnv(layout.runnerHome, layout, { [testNodeModulesEnvName]: path.join(repoRoot, 'node_modules') }),
    timeout: lineTimeoutMs,
  });
}

/** @description Start `charness-runner run` through the launcher, in a process group of its own, with `FLOW_SECRET` in ITS environment (a job must never see it). */
export function startRunner(layout: RunnerLinkLayout): ChildProcess {
  const paths = getRunnerHomePaths(layout.runnerHome);
  const child = spawn(paths.launcher, ['run'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: createEnv(layout.runnerHome, layout, {
      FLOW_SECRET: 'leak',
      [testNodeModulesEnvName]: path.join(repoRoot, 'node_modules'),
      // The linked runner asks the hub for its package every 2 s instead of every 5 minutes (the seam may only shorten the window).
      CHARNESS_TEST_TIMINGS: JSON.stringify({ runnerVersionPollMs: 2000 }),
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

/** @description Plain `ssh` from the hub to the runner through the link, exactly as remote-run's ssh calls go. */
export function sshThroughLink(layout: RunnerLinkLayout, runnerId: string, command: string): SpawnSyncReturns<string> {
  const hubDir = layout.hubDir;
  return spawnSync('ssh', [
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
  ], { encoding: 'utf8', timeout: 60_000, env: createEnv(layout.hubHome, layout) });
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
  sweepFlowLayout(layout.root);
}
