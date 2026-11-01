import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { formatListTimestamp } from '../runners/runnersList';
import { redeemReplySchema, unpairReplySchema, type RedeemReply, type RedeemRequest } from '../runners/gateProtocol';
import { decodePairCode } from '../runners/pairCode';
import { checkIsAdminAccount, formatAdminWarning, readAccountFacts } from './adminCheck';
import { ensureLauncher } from './launcher';
import { removeOldApps, switchCurrentApp } from './appInstall';
import { connectToHub, HubConnectionError, requestGateJson, type HubEndpoint } from './hubClient';
import { recoverPairing } from './pairingRecovery';
import { createLinkLoop } from './linkLoop';
import { collectMachineReport, createMachineProbe, formatMachineReport, type MachineReport } from './machineReport';
import { ensurePueueDaemon, waitForPueueDaemon } from './pueueDaemon';
import { createIosCheckDeps, readIosCheck, refreshIosCheck } from './iosCheck';
import { checkIsRunnerPaused, setRunnerPaused } from './runnerFlags';
import { createServiceDeps, installService, readServiceKind, uninstallService, parseServiceCommand, type ServiceDeps } from './serviceManager';
import { readPairingInProgress, readRunnerConfig, readRunnerStatus, removePairingInProgress, writePairingInProgress, writeRunnerConfig, type RunnerConfig } from './runnerConfig';
import { getRunnerHomePaths, type RunnerHomePaths } from './runnerHome';
import { ensureRunnerKeys, readRunnerKeys, type RunnerKeys } from './runnerKeys';
import { readExecEnv } from './execEnv';
import { createRunnerServers } from './runnerServers';
import { createToolDeps, ensurePueue, ensureRsync, findPueue, findRsync, type ToolDeps, type ToolInstallOutcome } from './toolInstall';

/**
 * @description The commands of `charness-runner` that need the installed package (and so its dependencies): `pair`, `run`, `status`,
 * `check`. `runnerCli.ts` starts them only after the app is installed.
 */

export interface CommandIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const envFileTemplate = '# KEY=VALUE lines, added to the environment of every job that runs on this machine (read again for each job).\n';
const shutdownGraceMs = 3000;
/** How long `run` waits for the service-managed Pueue to answer. */
const pueueServiceWaitMs = 20 * 1000;
/** How often the link looks at Xcode: a new version is checked again (`iosCheck.ts`). */
const iosRecheckIntervalMs = 60 * 60 * 1000;
const packageJsonRelativePath = path.join('..', '..', 'package.json');

function readOwnVersion(): string {
  try {
    const parsed: { version?: string } = JSON.parse(fs.readFileSync(path.join(__dirname, packageJsonRelativePath), 'utf8'));
    return parsed.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function formatToolLine(rsync: ToolInstallOutcome | null, pueue: ToolInstallOutcome | null): string {
  const describe = (name: string, outcome: ToolInstallOutcome | null): string => {
    if (outcome === null) return `${name}: not checked`;
    if (!outcome.ok) return `${name}: MISSING`;
    return `${name} ${outcome.tool.version} (${outcome.wasInstalled ? 'installed' : path.dirname(outcome.tool.path)})`;
  };
  return `  tools: ${describe('rsync', rsync)} · ${describe('pueue', pueue)}`;
}

async function printMachineCheck(paths: RunnerHomePaths, io: CommandIo): Promise<MachineReport> {
  io.stdout('charness-runner — checking this machine\n');
  const report = await collectMachineReport(createMachineProbe(paths.homeDir), paths.root);
  io.stdout(`${formatMachineReport(report).join('\n')}\n`);
  const account = os.userInfo().username;
  if (checkIsAdminAccount(readAccountFacts())) io.stdout(`${formatAdminWarning(account).join('\n')}\n`);
  return report;
}

async function installTools(paths: RunnerHomePaths, deps: ToolDeps, io: CommandIo): Promise<void> {
  const pueue = await ensurePueue(paths, deps);
  const rsync = await ensureRsync(paths, deps);
  io.stdout(`${formatToolLine(rsync, pueue)}\n`);
  for (const outcome of [pueue, rsync]) if (!outcome.ok) io.stderr(`charness-runner: ${outcome.reason}\n`);
}

/** @description The «Keep it running» part of the pairing text: the terminal, a service without admin, and — on a Mac — the always-on daemon. */
export function formatKeepRunningHelp(paths: RunnerHomePaths, platform: NodeJS.Platform = process.platform, accountName: string = os.userInfo().username): string {
  const lines = [
    'Keep it running:',
    `  ${paths.launcher} run`,
    '      here, in this terminal (Ctrl-C stops)',
    `  ${paths.launcher} service install`,
    platform === 'darwin' ? '      in the background while this user is logged in' : '      in the background, also after a logout or a reboot (a systemd user service that lingers)',
  ];
  if (platform === 'darwin') {
    lines.push(`  sudo ${paths.launcher} service install --system --user ${accountName}`, '      always, also logged out — once, from an admin account');
  }
  lines.push('');
  return lines.join('\n');
}

export function formatRemovedMessage(label: string): string {
  return `This runner was removed by ${label}. Pair again with a new line from /runners.`;
}

export interface PairingOutcomeInputs {
  endpoint: HubEndpoint;
  keys: RunnerKeys;
  reply: Extract<RedeemReply, { ok: true }>;
  /** The id of the archive this copy was installed from — NOT the hub's current package, which is only what is available now. */
  packageId: string | null;
  appDir: string;
}

/** @description Record a pairing the hub has committed: folders, `current`, launcher, `config.json`; then the tools. Removes `pairing.json`. */
async function finishPairing(paths: RunnerHomePaths, inputs: PairingOutcomeInputs, io: CommandIo, isRecovered: boolean): Promise<void> {
  const { endpoint, reply } = inputs;
  const config: RunnerConfig = {
    runnerId: reply.runnerId,
    name: reply.name,
    hub: { host: endpoint.host, port: endpoint.port, user: endpoint.user, hostKey: endpoint.hostKey, publicKey: reply.hubPublicKey, label: reply.label },
    packageId: inputs.packageId,
    pairedAtMs: Date.now(),
  };
  for (const directory of [paths.workDir, paths.logsDir]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(paths.envFile)) fs.writeFileSync(paths.envFile, envFileTemplate, { mode: 0o600 });
  switchCurrentApp(paths, inputs.appDir);
  ensureLauncher(paths, process.execPath);
  writeRunnerConfig(paths, config);
  removePairingInProgress(paths);
  removeOldApps(paths);
  await installTools(paths, createToolDeps(), io);
  io.stdout(`\n${isRecovered ? 'Recovered a pairing whose answer was lost: paired' : 'Paired'} with charness ${reply.label} (${endpoint.host}:${endpoint.port}) as runner “${reply.name}”.\n`);
  io.stdout(`Its agents will run their projects' code on this machine as user «${os.userInfo().username}».\n\n${formatKeepRunningHelp(paths)}`);
}

/**
 * @description `charness-runner pair <code>` (run from the INSTALLED copy): redeem the code, record who the runner serves, install its
 * tools. A pairing that an earlier run left half done is recovered FIRST (with the runner's own key), whatever the new code is. Returns the exit code.
 */
export async function runPair(code: string, appDir: string, packageId: string | null, io: CommandIo, homeDir: string = os.homedir()): Promise<number> {
  const paths = getRunnerHomePaths(homeDir);
  const existing = readRunnerConfig(paths);
  if (existing !== null) {
    io.stderr(`charness-runner: this account is already paired (as “${existing.name}” with ${existing.hub.label}).\n`);
    return 1;
  }
  const decoded = decodePairCode(code);
  if (!decoded.ok) {
    io.stderr(`charness-runner: ${decoded.error}\n`);
    return 1;
  }
  const payload = decoded.payload;
  const keys = ensureRunnerKeys(paths);
  const interrupted = readPairingInProgress(paths);
  if (interrupted !== null) {
    const recovery = await recoverPairing({ host: interrupted.host, port: interrupted.port, user: interrupted.user, hostKey: interrupted.hostKey }, keys);
    if (recovery.kind === 'recovered') {
      await finishPairing(paths, { endpoint: interrupted, keys, reply: recovery.reply, packageId: interrupted.packageId, appDir }, io, true);
      return 0;
    }
    if (recovery.kind === 'unreachable') {
      io.stderr(`charness-runner: an earlier pairing was interrupted and the hub cannot be asked about it now (${recovery.message}); try again in a moment.\n`);
      return 1;
    }
    removePairingInProgress(paths);
  }
  const endpoint: HubEndpoint = { host: payload.host, port: payload.port, user: payload.user, hostKey: payload.hostKey };
  const report = await printMachineCheck(paths, io);
  const request: RedeemRequest = {
    suggestedName: os.hostname(),
    publicKey: keys.client.publicKey,
    hostKey: keys.server.publicKey,
    workDir: paths.workDir,
    os: report.osName,
    arch: report.arch,
    version: readOwnVersion(),
    serviceKind: 'foreground',
  };
  writePairingInProgress(paths, { pairId: payload.pairId, ...endpoint, startedAtMs: Date.now(), packageId });
  let reply: RedeemReply | null = null;
  let failure = 'pairing failed';
  try {
    const client = await connectToHub(endpoint, payload.privateKey);
    try {
      reply = await requestGateJson(client, 'redeem', JSON.stringify(request), redeemReplySchema);
    } finally {
      client.end();
    }
  } catch (error) {
    failure = error instanceof HubConnectionError && error.failure === 'auth' ? 'the hub refused this pairing line — it has expired or has been used already; make a new one' : error instanceof Error ? error.message : failure;
  }
  if (reply !== null && !reply.ok) {
    removePairingInProgress(paths);
    io.stderr(`charness-runner: the hub refused the pairing: ${reply.reason}\n`);
    return 1;
  }
  if (reply === null) {
    // No answer: the hub may have committed all the same (its answer lost on the way). The runner's own key can ask.
    const recovery = await recoverPairing(endpoint, keys);
    if (recovery.kind === 'recovered') {
      await finishPairing(paths, { endpoint, keys, reply: recovery.reply, packageId, appDir }, io, true);
      return 0;
    }
    if (recovery.kind === 'not-registered') removePairingInProgress(paths);
    io.stderr(`charness-runner: ${failure}${recovery.kind === 'unreachable' ? ' (run `charness-runner pair` again later to finish if the hub did register this machine)' : ''}\n`);
    return 1;
  }
  await finishPairing(paths, { endpoint, keys, reply, packageId, appDir }, io, false);
  return 0;
}

/** @description `charness-runner run`: ensure the tools and Pueue, then hold the link until stopped. Returns the exit code (75 = restart onto an update). */
export async function runLink(io: CommandIo, appDir: string, homeDir: string = os.homedir()): Promise<number> {
  const paths = getRunnerHomePaths(homeDir);
  let config = readRunnerConfig(paths);
  const keys = readRunnerKeys(paths);
  const interrupted = config === null && keys !== null ? readPairingInProgress(paths) : null;
  if (interrupted !== null && keys !== null) {
    const recovery = await recoverPairing({ host: interrupted.host, port: interrupted.port, user: interrupted.user, hostKey: interrupted.hostKey }, keys);
    if (recovery.kind === 'recovered') {
      await finishPairing(paths, { endpoint: interrupted, keys, reply: recovery.reply, packageId: interrupted.packageId, appDir }, io, true);
      config = readRunnerConfig(paths);
    } else if (recovery.kind === 'not-registered') {
      removePairingInProgress(paths);
    }
  }
  if (config === null || keys === null) {
    io.stderr('charness-runner: this account is not paired. Run the line from /runners on this machine first.\n');
    return 1;
  }
  ensureLauncher(paths, process.execPath);
  const toolDeps = createToolDeps();
  if (!(await findPueue(paths, toolDeps))) await ensurePueue(paths, toolDeps);
  // A service that manages Pueue owns the daemon: starting a second one here would only fight it for the socket.
  const isPueueRunning = readServiceKind(paths) === null ? await ensurePueueDaemon(paths) : await waitForPueueDaemon(paths, pueueServiceWaitMs);
  if (!isPueueRunning) io.stderr('charness-runner: Pueue is not running; jobs cannot be queued until it is (the link goes up anyway).\n');
  const iosDeps = createIosCheckDeps();
  void refreshIosCheck(paths, iosDeps, { isStartup: true }).catch(() => undefined);
  const iosTimer = setInterval(() => { void refreshIosCheck(paths, iosDeps, { isStartup: false }).catch(() => undefined); }, iosRecheckIntervalMs);
  iosTimer.unref();
  const loopRef: { current: ReturnType<typeof createLinkLoop> | null } = { current: null };
  const servers = createRunnerServers({
    serverPrivateKey: keys.server.privateKey,
    hubPublicKey: config.hub.publicKey,
    readEnv: () => readExecEnv(paths),
    cwd: paths.workDir,
    onActiveCountChange: () => loopRef.current?.notifyActiveCountChange(),
  });
  loopRef.current = createLinkLoop({ paths, config, keys, servers, log: (line) => io.stderr(`charness-runner: ${line}\n`) });
  const controller = new AbortController();
  const stop = (): void => {
    controller.abort();
    setTimeout(() => process.exit(0), shutdownGraceMs).unref();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  io.stdout(`charness-runner: serving ${config.hub.label} as “${config.name}” (Ctrl-C stops)\n`);
  return loopRef.current.run(controller.signal);
}

function checkIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** @description `charness-runner status`. */
export function runStatus(io: CommandIo, homeDir: string = os.homedir()): number {
  const paths = getRunnerHomePaths(homeDir);
  const config = readRunnerConfig(paths);
  if (config === null) {
    io.stdout('This account is not paired. Run the line from /runners on this machine to attach it to a charness.\n');
    return 0;
  }
  const status = readRunnerStatus(paths);
  const lines = [`Runner “${config.name}” of charness ${config.hub.label} (${config.hub.host}:${config.hub.port})`];
  if (status === null || !checkIsProcessAlive(status.pid)) {
    lines.push('  link: not running (start it with `charness-runner run`)');
  } else if (status.state === 'removed') {
    lines.push(`  ${formatRemovedMessage(config.hub.label)}`);
  } else {
    lines.push(`  link: ${status.state} since ${formatListTimestamp(status.sinceMs)}${status.lastError === null ? '' : ` (last error: ${status.lastError})`}`);
    lines.push(`  jobs running over the link: ${status.activeJobs}`);
  }
  const serviceKind = readServiceKind(paths);
  lines.push(`  service: ${serviceKind === null ? 'none (run it by hand, or `service install`)' : serviceKind === 'system-service' ? 'system service (always on)' : 'user service'}${checkIsRunnerPaused(paths) ? ' · PAUSED (no jobs are sent here; `resume` ends it)' : ''}`);
  const ios = readIosCheck(paths);
  if (ios !== null && ios.status !== 'skipped') lines.push(`  ios: ${ios.status === 'pass' ? `the Simulator boots (Xcode ${ios.xcode ?? 'unknown'})` : `no — needs the runner user's login session (${ios.reason ?? 'the boot check failed'})`}`);
  lines.push(`  package: ${config.packageId ?? 'unknown'} · paired ${formatListTimestamp(config.pairedAtMs)}`);
  io.stdout(`${lines.join('\n')}\n`);
  return 0;
}

/** @description `charness-runner check`: the machine report and the tools, installing what is missing. */
export async function runCheck(io: CommandIo, homeDir: string = os.homedir()): Promise<number> {
  const paths = getRunnerHomePaths(homeDir);
  await printMachineCheck(paths, io);
  const toolDeps = createToolDeps();
  await installTools(paths, toolDeps, io);
  return (await findRsync(paths, toolDeps)) !== null && (await findPueue(paths, toolDeps)) !== null ? 0 : 1;
}

/** @description `charness-runner pause` / `resume`: take this machine out of rotation, or back in. */
export function runPause(isPaused: boolean, io: CommandIo, homeDir: string = os.homedir()): number {
  const paths = getRunnerHomePaths(homeDir);
  if (readRunnerConfig(paths) === null) {
    io.stderr('charness-runner: this account is not paired.\n');
    return 1;
  }
  setRunnerPaused(paths, isPaused);
  io.stdout(isPaused ? 'Paused: the link stays up, but no job is sent to this machine until `charness-runner resume`.\n' : 'Resumed: this machine takes jobs again.\n');
  return 0;
}

/** @description `charness-runner service install|uninstall [--system --user <account>]`. */
export async function runService(args: readonly string[], io: CommandIo, deps: ServiceDeps = createServiceDeps()): Promise<number> {
  const parsed = parseServiceCommand(args);
  if (!parsed.ok) {
    io.stderr(`charness-runner: ${parsed.error}\n`);
    return 2;
  }
  const result = parsed.action === 'install' ? await installService(parsed.request, deps) : await uninstallService(parsed.request, deps);
  io.stdout(result.lines.length === 0 ? '' : `${result.lines.join('\n')}\n`);
  return result.ok ? 0 : 1;
}

export interface UnpairOptions {
  /** Do not tell the hub (it is gone, or this machine cannot reach it). */
  isLocalOnly: boolean;
}

/**
 * @description `charness-runner unpair`: tell the hub (which removes its key line and cuts the link), stop the user service, and forget the
 * pairing here — `config.json`, the keys, the status, the pause and the iOS result. The installed program, the tools, the work folder and
 * the queue stay (a pairing again reuses them).
 */
export async function runUnpair(options: UnpairOptions, io: CommandIo, homeDir: string = os.homedir(), serviceDeps: ServiceDeps = createServiceDeps()): Promise<number> {
  const paths = getRunnerHomePaths(homeDir);
  const config = readRunnerConfig(paths);
  const keys = readRunnerKeys(paths);
  if (config === null || keys === null) {
    io.stderr('charness-runner: this account is not paired.\n');
    return 1;
  }
  if (!options.isLocalOnly) {
    try {
      const client = await connectToHub({ host: config.hub.host, port: config.hub.port, user: config.hub.user, hostKey: config.hub.hostKey }, keys.client.privateKey);
      try {
        await requestGateJson(client, 'unpair', null, unpairReplySchema);
      } finally {
        client.end();
      }
    } catch (error) {
      // A hub that no longer accepts the key has already forgotten this machine: nothing is left to tell it.
      if (!(error instanceof HubConnectionError && error.failure === 'auth')) {
        io.stderr(`charness-runner: the hub could not be told (${error instanceof Error ? error.message : 'unknown error'}). Try again, or use \`unpair --local\` to forget the pairing here only.\n`);
        return 1;
      }
    }
  }
  const serviceKind = readServiceKind(paths);
  if (serviceKind === 'user-service') {
    const removed = await uninstallService({ isSystem: false, userName: null }, serviceDeps);
    if (!removed.ok) io.stderr(`charness-runner: ${removed.lines.join(' ')}\n`);
  } else if (serviceKind === 'system-service') {
    io.stderr(`charness-runner: a system service is installed; remove it as an admin: sudo ${paths.launcher} service uninstall --system --user ${os.userInfo().username}\n`);
  }
  for (const file of [paths.config, paths.status, paths.pairing, paths.pausedFlag, paths.iosCheck]) fs.rmSync(file, { force: true });
  fs.rmSync(paths.keysDir, { recursive: true, force: true });
  io.stdout(`Unpaired from charness ${config.hub.label}${options.isLocalOnly ? ' (here only — the hub was not told)' : ''}. This machine no longer serves it.\n`);
  return 0;
}
