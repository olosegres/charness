import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCommand, type CommandRunner } from '../selfUpdate/commandRunner';
import { readRunnerConfig } from './runnerConfig';
import { getRunnerHomePaths, type RunnerHomePaths } from './runnerHome';
import {
  describeLingerRemedy,
  getServiceNames,
  parseLingerState,
  planLaunchdJobs,
  renderLaunchdPlist,
  renderSystemdLinkUnit,
  renderSystemdPueuedUnit,
  type LaunchdJobSpec,
  type ServiceNames,
} from './serviceUnits';

/**
 * @description `charness-runner service install|uninstall`: keep the link and Pueue running without a terminal.
 *
 *   Linux            two systemd USER units and `loginctl enable-linger` — no admin; where polkit wants one for the lingering, the one
 *                    `sudo` line is printed and the units are installed all the same
 *   macOS            two LaunchAgents — no admin; they run while the account is logged in (switched away included)
 *   macOS --system   two LaunchDaemons with `UserName=<account>`, installed ONCE by an admin (`sudo … service install --system --user
 *                    <account>`): always on, also logged out, across fast user switching; the jobs run as that account, with no extra rights
 *
 * One kind at a time: installing one while the other's files exist is refused with the command that removes it. The kind is written to
 * `~/.charness-runner/service` (one word) for `status` and for `runner.sh probe`.
 */

const commandTimeoutMs = 60 * 1000;
const unitFileMode = 0o644;
const logsDirMode = 0o700;
const rootUid = 0;
const wheelGid = 0;
const markerMode = 0o644;

export type ServiceKind = 'user-service' | 'system-service';

export interface TargetAccount {
  name: string;
  uid: number;
  gid: number;
  homeDir: string;
}

export interface ServiceDeps {
  runner: CommandRunner;
  platform: NodeJS.Platform;
  /** The uid of this process (a `--system` install must be root). */
  uid: number;
  /** The account that runs this process, and its home. */
  accountName: string;
  homeDir: string;
  nodePath: string;
  /** Where LaunchDaemons live (`/Library/LaunchDaemons`; a test's own folder). */
  launchDaemonsDir: string;
  /** Give a file to an account (`fs.chownSync`; a test is not root). */
  chown: (filePath: string, uid: number, gid: number) => void;
  /** Who `--user <name>` names; `null` when there is no such account. */
  resolveAccount: (name: string) => Promise<TargetAccount | null>;
}

export interface ServiceRequest {
  isSystem: boolean;
  /** `--user`: required with `--system`. */
  userName: string | null;
}

export interface ServiceResult {
  ok: boolean;
  lines: string[];
}

export type ServiceCommandParsing = { ok: true; action: 'install' | 'uninstall'; request: ServiceRequest } | { ok: false; error: string };

/** @description `install|uninstall [--system --user <name>]`. */
export function parseServiceCommand(args: readonly string[]): ServiceCommandParsing {
  const [action, ...flags] = args;
  if (action !== 'install' && action !== 'uninstall') return { ok: false, error: 'service needs «install» or «uninstall»' };
  const request: ServiceRequest = { isSystem: false, userName: null };
  for (let index = 0; index < flags.length; index += 1) {
    if (flags[index] === '--system') {
      request.isSystem = true;
    } else if (flags[index] === '--user' && flags[index + 1] !== undefined) {
      request.userName = flags[index + 1];
      index += 1;
    } else {
      return { ok: false, error: `unknown argument: ${flags[index]}` };
    }
  }
  if (request.isSystem !== (request.userName !== null)) return { ok: false, error: '--system and --user <account> go together (the daemon runs as that account)' };
  return { ok: true, action, request };
}

async function resolveMacAccount(name: string, runner: CommandRunner): Promise<TargetAccount | null> {
  const uid = await runner('id', ['-u', name], { timeoutMs: commandTimeoutMs });
  const gid = await runner('id', ['-g', name], { timeoutMs: commandTimeoutMs });
  if (!uid.ok || !gid.ok) return null;
  const home = await runner('dscl', ['.', '-read', `/Users/${name}`, 'NFSHomeDirectory'], { timeoutMs: commandTimeoutMs });
  const homeDir = home.ok ? /NFSHomeDirectory:\s*(\S.*)$/m.exec(home.stdout)?.[1].trim() : undefined;
  return { name, uid: Number(uid.stdout.trim()), gid: Number(gid.stdout.trim()), homeDir: homeDir ?? `/Users/${name}` };
}

export function createServiceDeps(): ServiceDeps {
  return {
    runner: runCommand,
    platform: process.platform,
    uid: os.userInfo().uid,
    accountName: os.userInfo().username,
    homeDir: os.homedir(),
    nodePath: process.execPath,
    launchDaemonsDir: '/Library/LaunchDaemons',
    chown: fs.chownSync,
    resolveAccount: (name) => resolveMacAccount(name, runCommand),
  };
}

/** @description The kind written by the last install, or `null`. */
export function readServiceKind(paths: RunnerHomePaths): ServiceKind | null {
  try {
    const text = fs.readFileSync(paths.serviceMarker, 'utf8').trim();
    return text === 'user-service' || text === 'system-service' ? text : null;
  } catch {
    return null;
  }
}

interface ServiceFiles {
  /** Where the link and pueued definitions are written. */
  link: string;
  pueued: string;
  directory: string;
}

function getSystemdFiles(homeDir: string, names: ServiceNames): ServiceFiles {
  const directory = path.join(homeDir, '.config', 'systemd', 'user');
  return { directory, link: path.join(directory, names.systemdLink), pueued: path.join(directory, names.systemdPueued) };
}

function getLaunchdFiles(isSystem: boolean, homeDir: string, names: ServiceNames, daemonsDir: string): ServiceFiles {
  const directory = isSystem ? daemonsDir : path.join(homeDir, 'Library', 'LaunchAgents');
  return { directory, link: path.join(directory, `${names.launchdLink}.plist`), pueued: path.join(directory, `${names.launchdPueued}.plist`) };
}

function writeDefinition(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, { mode: unitFileMode });
  fs.chmodSync(filePath, unitFileMode);
}

function writeMarker(paths: RunnerHomePaths, kind: ServiceKind, owner: TargetAccount | null, chown: ServiceDeps['chown']): void {
  fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.serviceMarker, `${kind}\n`, { mode: markerMode });
  if (owner !== null) chown(paths.serviceMarker, owner.uid, owner.gid);
}

function fail(...lines: string[]): ServiceResult {
  return { ok: false, lines };
}

async function installSystemd(paths: RunnerHomePaths, deps: ServiceDeps): Promise<ServiceResult> {
  const names = getServiceNames(paths.root);
  const files = getSystemdFiles(paths.homeDir, names);
  writeDefinition(files.pueued, renderSystemdPueuedUnit(paths));
  writeDefinition(files.link, renderSystemdLinkUnit(paths, names));
  const reload = await deps.runner('systemctl', ['--user', 'daemon-reload'], { timeoutMs: commandTimeoutMs });
  if (!reload.ok) {
    return fail(
      'systemctl --user cannot reach a user session. Log in with ssh or the console (not `su` / `sudo -u`), or `export XDG_RUNTIME_DIR=/run/user/$(id -u)`, then run this again.',
      `(the unit files are written in ${files.directory})`,
    );
  }
  const enable = await deps.runner('systemctl', ['--user', 'enable', '--now', names.systemdPueued, names.systemdLink], { timeoutMs: commandTimeoutMs });
  if (!enable.ok) return fail(`systemctl --user enable failed: ${enable.stderr.trim().split('\n').slice(-1)[0]}`);
  const lines = [`Installed two user services: ${names.systemdLink} (the link) and ${names.systemdPueued} (the queue).`];
  const lingering = await deps.runner('loginctl', ['show-user', deps.accountName, '-p', 'Linger'], { timeoutMs: commandTimeoutMs });
  if (parseLingerState(lingering.stdout) === 'yes') {
    lines.push('Lingering is on: they run without a login and start at boot.');
  } else {
    const enableLinger = await deps.runner('loginctl', ['enable-linger'], { timeoutMs: commandTimeoutMs });
    lines.push(enableLinger.ok ? 'Lingering switched on: they run without a login and start at boot.' : describeLingerRemedy(deps.accountName));
  }
  writeMarker(paths, 'user-service', null, deps.chown);
  return { ok: true, lines };
}

async function uninstallSystemd(paths: RunnerHomePaths, deps: ServiceDeps): Promise<ServiceResult> {
  const names = getServiceNames(paths.root);
  const files = getSystemdFiles(paths.homeDir, names);
  await deps.runner('systemctl', ['--user', 'disable', '--now', names.systemdLink, names.systemdPueued], { timeoutMs: commandTimeoutMs });
  for (const file of [files.link, files.pueued]) fs.rmSync(file, { force: true });
  await deps.runner('systemctl', ['--user', 'daemon-reload'], { timeoutMs: commandTimeoutMs });
  fs.rmSync(paths.serviceMarker, { force: true });
  return { ok: true, lines: ['Removed the two user services. Lingering is left as it was.'] };
}

interface LaunchdEntry {
  job: LaunchdJobSpec;
  file: string;
}

async function loadLaunchdJobs(entries: readonly LaunchdEntry[], domain: string, deps: ServiceDeps, owner: TargetAccount | null, isSystem: boolean): Promise<ServiceResult> {
  for (const { job, file } of entries) {
    fs.mkdirSync(path.dirname(job.logPath), { recursive: true, mode: logsDirMode });
    if (owner !== null) deps.chown(path.dirname(job.logPath), owner.uid, owner.gid);
    writeDefinition(file, renderLaunchdPlist(job));
    if (isSystem) deps.chown(file, rootUid, wheelGid);
    await deps.runner('launchctl', ['bootout', `${domain}/${job.label}`], { timeoutMs: commandTimeoutMs });
    const boot = await deps.runner('launchctl', ['bootstrap', domain, file], { timeoutMs: commandTimeoutMs });
    if (!boot.ok) return fail(`launchctl bootstrap ${domain} failed for ${job.label}: ${boot.stderr.trim().split('\n').slice(-1)[0]}`);
  }
  return { ok: true, lines: [] };
}

async function installLaunchd(request: ServiceRequest, deps: ServiceDeps, paths: RunnerHomePaths, owner: TargetAccount | null): Promise<ServiceResult> {
  const names = getServiceNames(paths.root);
  const files = getLaunchdFiles(request.isSystem, paths.homeDir, names, deps.launchDaemonsDir);
  const otherFiles = getLaunchdFiles(!request.isSystem, paths.homeDir, names, deps.launchDaemonsDir);
  if (fs.existsSync(otherFiles.link) || fs.existsSync(otherFiles.pueued)) {
    return fail(request.isSystem ? 'A user service (LaunchAgent) is installed for this runner: remove it first with `charness-runner service uninstall`.' : 'A system service (LaunchDaemon) is installed for this runner: remove it first with `sudo charness-runner service uninstall --system --user <account>`.');
  }
  const accountName = owner?.name ?? deps.accountName;
  const jobs = planLaunchdJobs(paths, names, accountName, path.dirname(deps.nodePath), request.isSystem ? accountName : null);
  const domain = request.isSystem ? 'system' : `gui/${deps.uid}`;
  const loaded = await loadLaunchdJobs([{ job: jobs.pueued, file: files.pueued }, { job: jobs.link, file: files.link }], domain, deps, owner, request.isSystem);
  if (!loaded.ok) return loaded;
  writeMarker(paths, request.isSystem ? 'system-service' : 'user-service', owner, deps.chown);
  return {
    ok: true,
    lines: request.isSystem
      ? [`Installed two LaunchDaemons (${names.launchdLink}, ${names.launchdPueued}) that run as ${accountName}: always on, also logged out.`]
      : [`Installed two LaunchAgents (${names.launchdLink}, ${names.launchdPueued}): they run while ${accountName} is logged in. For always-on (also logged out), an admin runs once: sudo ${paths.launcher} service install --system --user ${accountName}`],
  };
}

async function uninstallLaunchd(request: ServiceRequest, deps: ServiceDeps, paths: RunnerHomePaths): Promise<ServiceResult> {
  const names = getServiceNames(paths.root);
  const files = getLaunchdFiles(request.isSystem, paths.homeDir, names, deps.launchDaemonsDir);
  const domain = request.isSystem ? 'system' : `gui/${deps.uid}`;
  for (const label of [names.launchdLink, names.launchdPueued]) await deps.runner('launchctl', ['bootout', `${domain}/${label}`], { timeoutMs: commandTimeoutMs });
  for (const file of [files.link, files.pueued]) fs.rmSync(file, { force: true });
  fs.rmSync(paths.serviceMarker, { force: true });
  return { ok: true, lines: [`Removed the two ${request.isSystem ? 'LaunchDaemons' : 'LaunchAgents'}.`] };
}

/** The paths of the account the request is about: this one, or — with `--system --user` — the named one. */
async function resolveTarget(request: ServiceRequest, action: 'install' | 'uninstall', deps: ServiceDeps): Promise<{ paths: RunnerHomePaths; owner: TargetAccount | null } | ServiceResult> {
  if (!request.isSystem) return { paths: getRunnerHomePaths(deps.homeDir), owner: null };
  if (deps.platform !== 'darwin') return fail('--system is for macOS (a LaunchDaemon). On Linux `service install` makes a user service that lingers: no admin, it runs without a login.');
  if (deps.uid !== rootUid) return fail(`A system service is installed by an admin, once: sudo ${getRunnerHomePaths(deps.homeDir).launcher} service ${action} --system --user ${request.userName ?? '<account>'}`);
  const owner = request.userName === null ? null : await deps.resolveAccount(request.userName);
  if (owner === null) return fail(`There is no account named «${request.userName ?? ''}».`);
  if (owner.uid === rootUid) return fail('The service must run as a standard account, not as root.');
  return { paths: getRunnerHomePaths(owner.homeDir), owner };
}

/** @description `service install` for `request`. */
export async function installService(request: ServiceRequest, deps: ServiceDeps): Promise<ServiceResult> {
  if (deps.platform !== 'linux' && deps.platform !== 'darwin') return fail(`Services are supported on Linux (systemd) and macOS (launchd), not on ${deps.platform}.`);
  const target = await resolveTarget(request, 'install', deps);
  if ('ok' in target) return target;
  if (readRunnerConfig(target.paths) === null) return fail('This account is not paired yet: run the line from /runners on this machine first, then install the service.');
  return deps.platform === 'linux' ? installSystemd(target.paths, deps) : installLaunchd(request, deps, target.paths, target.owner);
}

/** @description `service uninstall` for `request`. */
export async function uninstallService(request: ServiceRequest, deps: ServiceDeps): Promise<ServiceResult> {
  if (deps.platform !== 'linux' && deps.platform !== 'darwin') return fail(`Services are supported on Linux (systemd) and macOS (launchd), not on ${deps.platform}.`);
  const target = await resolveTarget(request, 'uninstall', deps);
  if ('ok' in target) return target;
  return deps.platform === 'linux' ? uninstallSystemd(target.paths, deps) : uninstallLaunchd(request, deps, target.paths);
}
