import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCommand, type CommandRunner } from '../selfUpdate/commandRunner';
import { writeGuiAgentInstallFailure } from './guiAgentHeal';
import { describeForeignNode, findForeignHome } from './homeFolders';
import { checkIsRunnerLinkProcess } from './localLinkStop';
import { ensurePueueConfig, inspectPueue, shutDownPueue } from './pueueDaemon';
import { readRunnerConfig, readRunnerStatus } from './runnerConfig';
import { getRunnerHomePaths, type RunnerHomePaths } from './runnerHome';
import {
  commandTimeoutMs,
  fail,
  getGuiAgentFile,
  getLaunchdFiles,
  installLaunchdJobs,
  readPreviousDefinitions,
  restorePreviousDefinitions,
  stopLaunchdJobs,
  systemLaunchDaemonsDir,
  writeDefinition,
  type ServiceFiles,
  type ServiceResult,
  type SystemStepAnswer,
} from './serviceCommon';
import {
  describeLingerRemedy,
  getServiceNames,
  parseLingerState,
  planGuiAgentJob,
  planLaunchdJobs,
  renderLaunchdPlist,
  renderSystemdLinkUnit,
  renderSystemdPueuedUnit,
  type ServiceNames,
} from './serviceUnits';

/**
 * @description `charness-runner service install|uninstall`: keep the link and Pueue running without a terminal — as the account that runs
 * them, with the account's own rights.
 *
 *   Linux            two systemd USER units and `loginctl enable-linger` — no admin; where polkit wants one for the lingering, the one
 *                    `sudo` line is printed and the units are installed all the same
 *   macOS            two LaunchAgents — no admin; they run while the account is logged in (switched away included)
 *   always on        (a Mac, logged out too; or Linux lingering set by an admin) is the ADMIN pairing line's work, not this command's: root must
 *                    not run anything from this account's folder, so the admin line runs `adminService.ts` from a root-owned copy of the
 *                    package, and that calls back into THIS program, as the account, for the account's own side (`service system-step`
 *                    below). `--system` here is refused and says so.
 *
 * One kind at a time: installing one while the other's files exist is refused with the command that removes it. The kind is written to
 * `~/.charness-runner/service` (one word) for `status` and for `runner.sh probe`.
 */

const markerMode = 0o644;

export type ServiceKind = 'user-service' | 'system-service';

export interface ServiceDeps {
  runner: CommandRunner;
  platform: NodeJS.Platform;
  /** The uid of this process. */
  uid: number;
  /** Is `pid` the runner's link (alive and running `runnerCli.js run`)? A stale or reused pid in `status.json` is not. */
  checkIsRunnerLink: (pid: number) => boolean;
  /** The account that runs this process, and its home. */
  accountName: string;
  homeDir: string;
  nodePath: string;
  /** Where LaunchDaemons live (`/Library/LaunchDaemons`; a test's own folder): read to see whether an always-on service is gone. */
  launchDaemonsDir: string;
}

export interface ServiceRequest {
  isSystem: boolean;
  /** `--user`: required with `--system`. */
  userName: string | null;
}

export type { ServiceResult } from './serviceCommon';

export type ServiceCommandParsing = { ok: true; action: 'install' | 'uninstall'; request: ServiceRequest } | { ok: false; error: string };

/** @description `install|uninstall [--system --user <name>]` (the pair is read only to be refused with the way that works). */
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

export function createServiceDeps(): ServiceDeps {
  return {
    runner: runCommand,
    platform: process.platform,
    uid: os.userInfo().uid,
    checkIsRunnerLink: checkIsRunnerLinkProcess,
    accountName: os.userInfo().username,
    homeDir: os.homedir(),
    nodePath: process.execPath,
    launchDaemonsDir: systemLaunchDaemonsDir,
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

function getSystemdFiles(homeDir: string, names: ServiceNames): ServiceFiles {
  const directory = path.join(homeDir, '.config', 'systemd', 'user');
  return { directory, link: path.join(directory, names.systemdLink), pueued: path.join(directory, names.systemdPueued) };
}

function writeMarker(paths: RunnerHomePaths, kind: ServiceKind): void {
  fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.serviceMarker, `${kind}\n`, { mode: markerMode });
}

const stillRunningStates: readonly string[] = ['active', 'activating', 'reloading', 'deactivating'];

/**
 * Everything that must be true BEFORE either service starts, or the services start into a mess:
 *   - the Pueue binaries exist (a unit that cannot start would restart in a loop);
 *   - no foreground `charness-runner run` is linked (two links for one runner fight for the hub's socket, and its Pueue daemon would
 *     fight the managed one for Pueue's);
 *   - a Pueue daemon that NO service owns is dealt with explicitly: while it runs jobs it is left alone and the install is refused —
 *     Pueue kills the jobs it runs when it stops — and an idle one is shut down so the managed one can take the socket;
 *   - Pueue's private configuration exists, and the service record is written, so the first start of the queue has its configuration and
 *     the link, seeing the record, waits for the service's queue instead of starting a daemon of its own.
 * Returns the refusal, or `null` when the services may start. `hadService` tells a re-install (the daemon is the service's own then).
 * All of it is the ACCOUNT's own doing, in the account's own tree (the always-on install reaches it through `service system-step`).
 */
async function prepareManagedStart(paths: RunnerHomePaths, deps: ServiceDeps, kind: ServiceKind): Promise<{ refusal: ServiceResult | null; hadService: boolean }> {
  const hadService = readServiceKind(paths) !== null;
  const refuse = (...lines: string[]): { refusal: ServiceResult; hadService: boolean } => ({ refusal: fail(...lines), hadService });
  if (!fs.existsSync(path.join(paths.binDir, 'pueued'))) return refuse('Pueue is not installed for this runner yet: run `charness-runner check` (it installs it), then install the service.');
  if (hadService) {
    // Replacing a loaded service boots its jobs out (`launchctl bootout` / `systemctl`): the queue's running jobs, and the login session's agent's steps,
    // would be cut with it. A runner that is working is left alone; the install is asked for again when its jobs are done (or killed).
    const queue = await inspectPueue(paths, deps.runner);
    if (queue.kind === 'busy') return refuse(`The Pueue queue of this runner is running ${queue.activeJobs} job(s): replacing the service now would cut them. Let them finish (\`charness remote-run ls\` shows them) or stop them (\`charness remote-run kill <id>\`), then install the service again.`);
    if (queue.kind === 'unreadable') return refuse('A Pueue daemon answers but its state cannot be read, so it cannot be told apart from one with running jobs: replacing the service now could cut them. Stop the daemon by hand and install the service again.');
  }
  if (!hadService) {
    const status = readRunnerStatus(paths);
    if (status !== null && deps.checkIsRunnerLink(status.pid)) {
      return refuse(`A foreground \`charness-runner run\` is linked (pid ${status.pid}). Stop it (Ctrl-C in its terminal) and install the service again — the service takes over the link and the queue.`);
    }
    const queue = await inspectPueue(paths, deps.runner);
    if (queue.kind === 'busy') return refuse(`The Pueue queue of this runner is running ${queue.activeJobs} job(s), and a service cannot take the queue over without stopping them. Install the service when they have finished (\`pueue --config ${paths.pueueConfig} status\`).`);
    if (queue.kind === 'unreadable') return refuse('A Pueue daemon answers but its state cannot be read, so it cannot be told apart from one with running jobs. Stop it by hand and install the service again.');
    if (queue.kind === 'idle' && !(await shutDownPueue(paths, deps.runner))) return refuse('An idle Pueue daemon is running and did not shut down; stop it by hand and install the service again.');
  }
  ensurePueueConfig(paths);
  writeMarker(paths, kind);
  return { refusal: null, hadService };
}

async function stopSystemdUnits(names: ServiceNames, deps: ServiceDeps): Promise<string | null> {
  await deps.runner('systemctl', ['--user', 'disable', '--now', names.systemdLink, names.systemdPueued], { timeoutMs: commandTimeoutMs });
  for (const unit of [names.systemdLink, names.systemdPueued]) {
    const state = await deps.runner('systemctl', ['--user', 'show', '-p', 'ActiveState', '--value', unit], { timeoutMs: commandTimeoutMs });
    if (!state.ok) return `systemd cannot be asked whether ${unit} still runs (${state.stderr.trim().split('\n').slice(-1)[0] || 'no answer'})`;
    if (stillRunningStates.includes(state.stdout.trim())) return `${unit} is still running (${state.stdout.trim()})`;
  }
  return null;
}

async function installSystemd(paths: RunnerHomePaths, deps: ServiceDeps): Promise<ServiceResult> {
  const names = getServiceNames(paths.root);
  const files = getSystemdFiles(paths.homeDir, names);
  const { refusal, hadService } = await prepareManagedStart(paths, deps, 'user-service');
  if (refusal !== null) return refusal;
  const previous = hadService ? readPreviousDefinitions([files.link, files.pueued]) : [];
  const rollBack = async (...reason: string[]): Promise<ServiceResult> => {
    if (hadService) {
      // A re-install that fails must not take the working service down with it: its definitions come back, its units are not touched.
      restorePreviousDefinitions(previous);
      const reloaded = await deps.runner('systemctl', ['--user', 'daemon-reload'], { timeoutMs: commandTimeoutMs });
      return fail(...reason, reloaded.ok
        ? 'The service installed before was left as it was.'
        : 'Its definitions are back as they were, but systemd could not be asked to read them again: run `systemctl --user daemon-reload`.');
    }
    await stopSystemdUnits(names, deps);
    for (const file of [files.link, files.pueued]) fs.rmSync(file, { force: true });
    await deps.runner('systemctl', ['--user', 'daemon-reload'], { timeoutMs: commandTimeoutMs });
    fs.rmSync(paths.serviceMarker, { force: true });
    return fail(...reason, 'Nothing was left installed.');
  };
  writeDefinition(files.pueued, renderSystemdPueuedUnit(paths));
  writeDefinition(files.link, renderSystemdLinkUnit(paths, names));
  const reload = await deps.runner('systemctl', ['--user', 'daemon-reload'], { timeoutMs: commandTimeoutMs });
  if (!reload.ok) {
    return rollBack('systemctl --user cannot reach a user session. Log in with ssh or the console (not `su` / `sudo -u`), or `export XDG_RUNTIME_DIR=/run/user/$(id -u)`, then run this again.');
  }
  const enable = await deps.runner('systemctl', ['--user', 'enable', '--now', names.systemdPueued, names.systemdLink], { timeoutMs: commandTimeoutMs });
  if (!enable.ok) return rollBack(`systemctl --user enable failed: ${enable.stderr.trim().split('\n').slice(-1)[0]}`);
  const lines = [`Installed two user services: ${names.systemdLink} (the link) and ${names.systemdPueued} (the queue).`];
  const lingering = await deps.runner('loginctl', ['show-user', deps.accountName, '-p', 'Linger'], { timeoutMs: commandTimeoutMs });
  if (parseLingerState(lingering.stdout) === 'yes') {
    lines.push('Lingering is on: they run without a login and start at boot.');
  } else {
    const enableLinger = await deps.runner('loginctl', ['enable-linger'], { timeoutMs: commandTimeoutMs });
    lines.push(enableLinger.ok ? 'Lingering switched on: they run without a login and start at boot.' : describeLingerRemedy(deps.accountName));
  }
  return { ok: true, lines };
}

async function uninstallSystemd(paths: RunnerHomePaths, deps: ServiceDeps): Promise<ServiceResult> {
  const names = getServiceNames(paths.root);
  const files = getSystemdFiles(paths.homeDir, names);
  const reason = await stopSystemdUnits(names, deps);
  if (reason !== null) {
    return fail(`The services were not removed: ${reason}.`, 'Their definitions and the record of them stay, so this can be run again; to stop them by hand: ' + `systemctl --user stop ${names.systemdLink} ${names.systemdPueued}`);
  }
  for (const file of [files.link, files.pueued]) fs.rmSync(file, { force: true });
  await deps.runner('systemctl', ['--user', 'daemon-reload'], { timeoutMs: commandTimeoutMs });
  fs.rmSync(paths.serviceMarker, { force: true });
  return { ok: true, lines: ['Removed the two user services (stopped, and checked to be stopped). Lingering is left as it was.'] };
}

const adminLineText = 'paste a fresh admin line from /runners (or `charness runners pair`) in an admin account\'s terminal on this machine';

async function installLaunchd(deps: ServiceDeps, paths: RunnerHomePaths): Promise<ServiceResult> {
  const names = getServiceNames(paths.root);
  const files = getLaunchdFiles(false, paths.homeDir, names, deps.launchDaemonsDir);
  const daemonFiles = getLaunchdFiles(true, paths.homeDir, names, deps.launchDaemonsDir);
  if (fs.existsSync(daemonFiles.link) || fs.existsSync(daemonFiles.pueued)) {
    return fail('A system service (LaunchDaemon) is installed for this runner: remove it first with `charness-runner service uninstall` (it prints the admin commands).');
  }
  const { refusal, hadService } = await prepareManagedStart(paths, deps, 'user-service');
  if (refusal !== null) return refusal;
  const jobs = planLaunchdJobs(paths, names, deps.accountName, path.dirname(deps.nodePath), null);
  const result = await installLaunchdJobs({
    runner: deps.runner,
    domain: `gui/${deps.uid}`,
    files,
    names,
    jobs,
    hadService,
    isLogDirMade: true,
    forgetFirstInstall: () => { fs.rmSync(paths.serviceMarker, { force: true }); },
    retryText: 'run `charness-runner service install` again.',
    render: renderLaunchdPlist,
  });
  if (!result.ok) return result;
  return { ok: true, lines: [`Installed two LaunchAgents (${names.launchdLink}, ${names.launchdPueued}): they run while ${deps.accountName} is logged in. For always-on (also logged out), an admin can ${adminLineText}.`] };
}

/**
 * Where an admin gets the commands that remove an always-on service: from the HUB (`runners/serviceRemoval.ts`), never from this program. The agents
 * run as this account and can change what the program prints, so a command it printed could be anything an admin would then run with `sudo`.
 */
export const systemServiceRemovalPointer = 'The commands that remove it come from the charness host that paired this machine — `charness runners service-removal <name>` there (`charness runners remove <name>` prints them too, and so does the Remove button of /runners) — and not from this program: the agents run as this account and can change what it prints.';

/**
 * The runner is an always-on (system) service: only an admin can stop it, and root must not run this program to do it (see the file's
 * head). Once the admin has run the plain commands, running this again FORGETS the service record — and only then, when both daemons are
 * gone from launchd and from `/Library/LaunchDaemons`.
 */
async function removeSystemService(paths: RunnerHomePaths, deps: ServiceDeps): Promise<ServiceResult> {
  const names = getServiceNames(paths.root);
  const files = getLaunchdFiles(true, paths.homeDir, names, deps.launchDaemonsDir);
  const isLoaded = async (label: string): Promise<boolean> => (await deps.runner('launchctl', ['print', `system/${label}`], { timeoutMs: commandTimeoutMs })).ok;
  const isPresent = fs.existsSync(files.link) || fs.existsSync(files.pueued) || (await isLoaded(names.launchdLink)) || (await isLoaded(names.launchdPueued));
  if (isPresent) {
    return fail('This runner runs as a system service (always on), which only an admin can stop.', systemServiceRemovalPointer, 'Once an admin has run them, run `charness-runner service uninstall` again here, as this account: it forgets the service once they are gone.');
  }
  // The login session's agent goes with the service (best effort: from here only the account's own session can still reach it).
  await deps.runner('launchctl', ['bootout', `gui/${deps.uid}/${names.launchdGui}`], { timeoutMs: commandTimeoutMs });
  fs.rmSync(getGuiAgentFile(paths.homeDir, names), { force: true });
  fs.rmSync(paths.serviceMarker, { force: true });
  return { ok: true, lines: ['The always-on service is gone (stopped and removed by an admin): its record here is forgotten.'] };
}

async function uninstallLaunchd(deps: ServiceDeps, paths: RunnerHomePaths): Promise<ServiceResult> {
  const names = getServiceNames(paths.root);
  const files = getLaunchdFiles(false, paths.homeDir, names, deps.launchDaemonsDir);
  const domain = `gui/${deps.uid}`;
  const reason = await stopLaunchdJobs([names.launchdLink, names.launchdPueued], domain, deps.runner);
  if (reason !== null) {
    return fail(`The services were not removed: ${reason}.`, 'Their definitions and the record of them stay, so this can be run again.');
  }
  for (const file of [files.link, files.pueued]) fs.rmSync(file, { force: true });
  fs.rmSync(paths.serviceMarker, { force: true });
  return { ok: true, lines: ['Removed the two LaunchAgents (stopped, and checked to be stopped).'] };
}

const systemRefusal = `An always-on service is installed by an admin, through a pairing line: ${adminLineText}. It pairs a machine that is not paired yet, and for one that is, only installs the service. This command does not do it, because it would run this account's own files as root.`;

/** @description `service install` for `request`. */
export async function installService(request: ServiceRequest, deps: ServiceDeps): Promise<ServiceResult> {
  if (deps.platform !== 'linux' && deps.platform !== 'darwin') return fail(`Services are supported on Linux (systemd) and macOS (launchd), not on ${deps.platform}.`);
  if (request.isSystem) return fail(systemRefusal);
  const paths = getRunnerHomePaths(deps.homeDir);
  if (readRunnerConfig(paths) === null) return fail('This account is not paired yet: run the line from /runners on this machine first, then install the service.');
  if (readServiceKind(paths) === 'system-service') return fail('This runner runs as a system service already; an admin removes it with the commands that `charness runners service-removal <name>` gives on the charness host (the Remove button of /runners and `charness runners remove` print them too), then `charness-runner service uninstall` here forgets it.');
  const foreignHome = findForeignHome(deps.nodePath, paths.homeDir);
  if (foreignHome !== null) return fail(`The service would depend on ${describeForeignNode(deps.nodePath, foreignHome)}, then run this again.`);
  return deps.platform === 'linux' ? installSystemd(paths, deps) : installLaunchd(deps, paths);
}

/** @description `service uninstall` for `request`. */
export async function uninstallService(request: ServiceRequest, deps: ServiceDeps): Promise<ServiceResult> {
  if (deps.platform !== 'linux' && deps.platform !== 'darwin') return fail(`Services are supported on Linux (systemd) and macOS (launchd), not on ${deps.platform}.`);
  if (request.isSystem) return fail('An always-on service is removed by an admin with plain `launchctl` commands (no charness program runs as root).', systemServiceRemovalPointer);
  const paths = getRunnerHomePaths(deps.homeDir);
  if (readServiceKind(paths) === 'system-service') return removeSystemService(paths, deps);
  return deps.platform === 'linux' ? uninstallSystemd(paths, deps) : uninstallLaunchd(deps, paths);
}

/**
 * @description `service system-step prepare|abandon` — the ACCOUNT's side of the always-on install, run by the admin step
 * (`adminService.ts`) through `sudo -u <account>`, never by hand. `prepare` does what must be true before the daemons start (the same as a
 * user service's install, `prepareManagedStart`, and the account must be paired and have no LaunchAgents) and answers in one JSON line;
 * `abandon` forgets the record `prepare` wrote when the daemons could not be loaded and nothing was left installed.
 */
export async function runSystemStep(step: string, deps: ServiceDeps): Promise<SystemStepAnswer> {
  if (deps.platform !== 'darwin') return { ok: false, lines: ['The always-on service is for macOS (a LaunchDaemon); a Linux account installs its own user service.'] };
  if (deps.uid === 0) return { ok: false, lines: ['This step is the account\'s own: it must not run as root.'] };
  const paths = getRunnerHomePaths(deps.homeDir);
  if (step === 'abandon') {
    if (readServiceKind(paths) === 'system-service') {
      fs.rmSync(paths.serviceMarker, { force: true });
      fs.rmSync(getGuiAgentFile(paths.homeDir, getServiceNames(paths.root)), { force: true });
    }
    return { ok: true, hadService: false };
  }
  if (step !== 'prepare') return { ok: false, lines: [`unknown step: ${step}`] };
  if (readRunnerConfig(paths) === null) return { ok: false, lines: ['This account is not paired yet: run the line from /runners on this machine first, then install the service.'] };
  const names = getServiceNames(paths.root);
  const agentFiles = getLaunchdFiles(false, paths.homeDir, names, deps.launchDaemonsDir);
  if (fs.existsSync(agentFiles.link) || fs.existsSync(agentFiles.pueued)) {
    return { ok: false, lines: ['A user service (LaunchAgent) is installed for this runner: remove it first with `charness-runner service uninstall`.'] };
  }
  const { refusal, hadService } = await prepareManagedStart(paths, deps, 'system-service');
  if (refusal !== null) return { ok: false, lines: refusal.lines };
  // The login session's agent's definition is the account's own file in its own LaunchAgents folder (root never writes into the account's tree); the admin
  // step only loads it into the account's GUI session — now when there is one, at the account's next login when there is not.
  const guiJob = planGuiAgentJob(paths, names, deps.accountName, path.dirname(deps.nodePath));
  fs.mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
  writeDefinition(getGuiAgentFile(paths.homeDir, names), renderLaunchdPlist(guiJob));
  // The admin step loads it next: what the link could not do on its own (`guiAgentHeal.ts`) is now the admin line's to do, and it says so itself if it fails.
  writeGuiAgentInstallFailure(paths, null);
  return { ok: true, hadService };
}
