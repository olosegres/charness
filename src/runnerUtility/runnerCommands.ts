import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { formatListTimestamp } from '../runners/runnersList';
import { cancelReplySchema, redeemReplySchema, unpairReplySchema, type RedeemReply, type RedeemRequest } from '../runners/gateProtocol';
import { decodePairCode, type PairCodePayload } from '../runners/pairCode';
import { checkIsAdminAccount, formatAdminWarning, readAccountFacts } from './adminCheck';
import { ensureLauncher } from './launcher';
import { removeOldApps, restartExitCode, switchCurrentApp } from './appInstall';
import { connectToHub, HubConnectionError, requestGateJson, type HubEndpoint } from './hubClient';
import { recoverPairing } from './pairingRecovery';
import { createLinkLoop } from './linkLoop';
import { collectMachineReport, createMachineProbe, formatMachineReport, type MachineReport } from './machineReport';
import { ensurePueueDaemon, inspectPueue, pueueUnfinishedStatuses, stopAllPueueJobs, waitForPueueDaemon } from './pueueDaemon';
import { createGuiAgentDeps, runGuiAgent } from './guiAgent';
import { checkCanReadLid, createIoregReader, createLidWatcher } from './lidState';
import { createGuiAgentHealer, guiAgentHealIntervalMs, writeGuiAgentInstallFailure } from './guiAgentHeal';
import { describeKeepAwakeMethod } from '../remoteRun/probe';
import { createKeepAwakeDeps, startKeepAwake, type KeepAwakeState } from './keepAwake';
import { createIosCheckDeps, readIosCheck, refreshIosCheck } from './iosCheck';
import { onStopSignals } from './stopSignals';
import { createSilencerDeps, createSilencerLook, createSimulatorSilencer, silencerPollMs } from './simulatorSilencer';
import { checkIsRunnerLinkProcess, createProcessControl, stopLocalLink, type ProcessControl } from './localLinkStop';
import { runCommand, type CommandRunner } from '../selfUpdate/commandRunner';
import { checkIsRunnerPaused, setRunnerPaused } from './runnerFlags';
import { formatSystemStepAnswer, getGuiAgentFile, systemLaunchDaemonsDir } from './serviceCommon';
import { getServiceNames } from './serviceUnits';
import { checkCanReadAsSelf, findReadableHomes, formatForeignNodeWarning, formatReadableHomesWarning, listSubfolders } from './homeFolders';
import { createServiceDeps, installService, readServiceKind, runSystemStep, uninstallService, parseServiceCommand, systemServiceRemovalPointer, type ServiceDeps } from './serviceManager';
import { readPairingInProgress, readRunnerConfig, readRunnerStatus, removePairingInProgress, writePairingInProgress, writeRunnerConfig, type RunnerConfig } from './runnerConfig';
import { getRunnerHomePaths, type RunnerHomePaths } from './runnerHome';
import { ensureRunnerKeys, readRunnerKeys, type RunnerKeys } from './runnerKeys';
import { readExecEnv } from './execEnv';
import { createRunnerServers } from './runnerServers';
import { createStepRunner, stepLabels, type RunStep } from './progress';
import { createShimDeps, ensurePackageManagerShims, formatShimLine, type ShimOutcome } from './packageManagerShims';
import { createToolDeps, ensurePueue, ensureRsync, findPueue, findRsync, type ToolDeps, type ToolInstallOutcome } from './toolInstall';

/**
 * @description The commands of `charness-runner` that need the installed package (and so its dependencies): `pair`, `run`, `status`,
 * `check`. `runnerCli.ts` starts them only after the app is installed.
 */

export interface CommandIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** How the long steps are shown (`progress.ts`); absent = one plain line per step on `stdout`. */
  runStep?: RunStep;
}

/** The step runner of `io`: its own, or plain lines on its `stdout`. */
function getStepRunner(io: CommandIo): RunStep {
  return io.runStep ?? createStepRunner({ write: io.stdout, isTerminal: false });
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
  const report = await getStepRunner(io)(stepLabels.checkMachine, () => collectMachineReport(createMachineProbe(paths.homeDir), paths.root));
  io.stdout(`${formatMachineReport(report).join('\n')}\n`);
  const account = os.userInfo().username;
  if (checkIsAdminAccount(readAccountFacts())) io.stdout(`${formatAdminWarning(account).join('\n')}\n`);
  return report;
}

/**
 * @description Make the job PATH offer `yarn` and `pnpm` (`ensurePackageManagerShims`) and say what it offers. A manager it cannot offer is a
 * warning in the log and in `runners` — the link goes up anyway, as it does without Pueue; a failure of the preparation itself is told, never fatal.
 */
async function prepareJobPackageManagers(paths: RunnerHomePaths, io: CommandIo): Promise<void> {
  let outcomes: ShimOutcome[];
  try {
    outcomes = await ensurePackageManagerShims(paths, createShimDeps());
  } catch (error) {
    io.stderr(`charness-runner: the package managers for jobs could not be prepared (${error instanceof Error ? error.message : 'unknown error'})\n`);
    return;
  }
  io.stdout(`${formatShimLine(outcomes)}\n`);
  if (outcomes.some((outcome) => outcome.kind === 'missing')) io.stderr('charness-runner: a job that calls a missing package manager ends with exit 127 — `charness remote-run runners` shows what jobs run with.\n');
}

async function installTools(paths: RunnerHomePaths, deps: ToolDeps, io: CommandIo): Promise<void> {
  const runStep = getStepRunner(io);
  const pueue = await runStep(stepLabels.getPueue, () => ensurePueue(paths, deps), (outcome) => !outcome.ok);
  const rsync = await runStep(stepLabels.findRsync, () => ensureRsync(paths, deps), (outcome) => !outcome.ok);
  io.stdout(`${formatToolLine(rsync, pueue)}\n`);
  for (const outcome of [pueue, rsync]) if (!outcome.ok) io.stderr(`charness-runner: ${outcome.reason}\n`);
  await prepareJobPackageManagers(paths, io);
}

/** @description The «Keep it running» part of the pairing text: the terminal, a service without admin, and — on a Mac — the admin line that makes it always on. */
export function formatKeepRunningHelp(paths: RunnerHomePaths, platform: NodeJS.Platform = process.platform): string {
  const lines = [
    'Keep it running:',
    `  ${paths.launcher} run`,
    '      here, in this terminal (Ctrl-C stops)',
    `  ${paths.launcher} service install`,
    platform === 'darwin' ? '      in the background while this user is logged in' : '      in the background, also after a logout or a reboot (a systemd user service that lingers)',
  ];
  if (platform === 'darwin') {
    lines.push('  an admin account\'s paste of a fresh admin line from /runners', '      always, also logged out — the admin line installs the service for this account (it finds it paired)');
  }
  lines.push('');
  return lines.join('\n');
}

export function formatRemovedMessage(label: string): string {
  return `This runner was removed by ${label}. Pair again with a new line from /runners.`;
}

/** @description What the pairing says in place of {@link formatKeepRunningHelp} when an admin's line installs the service next. */
export function formatServiceFollowsNote(): string {
  return 'Keeping it running: the always-on service for this account is installed next, by the same line.\n';
}

export interface PairingOptions {
  /** An admin's line installs the service right after this pairing (`pairArgs.ts`): no help about keeping it running is printed. */
  isServiceFollowing: boolean;
  /** The homes of other users this account can read (the plain line says so, with the fix); a test's own. Default: look at `/Users` and `/home` as this account. */
  scanReadableHomes?: () => Promise<string[]>;
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
async function finishPairing(paths: RunnerHomePaths, inputs: PairingOutcomeInputs, io: CommandIo, isRecovered: boolean, options: PairingOptions): Promise<void> {
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
  io.stdout(`Its agents will run their projects' code on this machine as user «${os.userInfo().username}».\n\n${options.isServiceFollowing ? formatServiceFollowsNote() : formatKeepRunningHelp(paths)}`);
  // The admin line's root step looks at the homes itself, as the account, and says so after its own work: what this program prints is the account's word.
  if (options.isServiceFollowing) return;
  const accountName = os.userInfo().username;
  const readableHomes = await (options.scanReadableHomes ?? ((): Promise<string[]> => findReadableHomes(accountName, paths.homeDir, { listFolders: listSubfolders, checkCanRead: checkCanReadAsSelf })))();
  const warnings = formatPairingWarnings({ accountName, homeDir: paths.homeDir, nodePath: process.execPath, readableHomes });
  if (warnings.length > 0) io.stdout(`\n${warnings.join('\n')}\n`);
}

/**
 * @description What the plain pairing line warns about once the machine is paired: the homes of other users that this account can read (with the
 * one-line fix for each), and a Node.js that lives in another user's home. `[]` when there is nothing to say.
 */
export function formatPairingWarnings(inputs: { accountName: string; homeDir: string; nodePath: string; readableHomes: readonly string[] }): string[] {
  return [...formatReadableHomesWarning(inputs.accountName, inputs.readableHomes), ...formatForeignNodeWarning(inputs.nodePath, inputs.homeDir)];
}

/** @description Close `payload`'s code on the hub (the `cancel` request, with the code's own key); a hub that cannot be reached is said, never fatal: the code then runs out by itself. */
async function cancelPairingCode(payload: PairCodePayload, io: CommandIo): Promise<void> {
  try {
    const client = await connectToHub({ host: payload.host, port: payload.port, user: payload.user, hostKey: payload.hostKey }, payload.privateKey);
    try {
      await requestGateJson(client, 'cancel', null, cancelReplySchema);
    } finally {
      client.end();
    }
  } catch (error) {
    io.stderr(`charness-runner: the pairing code of this line could not be closed on the hub (${error instanceof Error ? error.message : 'unknown error'}); it stays open until it expires\n`);
  }
}

/**
 * @description `charness-runner pair <code>` (run from the INSTALLED copy): redeem the code, record who the runner serves, install its
 * tools. A pairing that an earlier run left half done is recovered FIRST (with the runner's own key), whatever the new code is. Returns the exit code.
 */
export async function runPair(code: string, appDir: string, packageId: string | null, io: CommandIo, homeDir: string = os.homedir(), options: PairingOptions = { isServiceFollowing: false }): Promise<number> {
  const paths = getRunnerHomePaths(homeDir);
  const existing = readRunnerConfig(paths);
  if (existing !== null) {
    // An admin line pasted again for an account that is already paired (a service step that failed, or one only a Mac's always-on is missing):
    // nothing is paired twice, the line's code is closed on the hub (it will never be redeemed, and must not stay open in sudo's log and
    // keep its Telegram messages waiting), and the line goes on to the service.
    if (options.isServiceFollowing) {
      const decodedRetry = decodePairCode(code);
      if (!decodedRetry.ok) {
        io.stderr(`charness-runner: ${decodedRetry.error}\n`);
        return 1;
      }
      io.stdout(`This account is already paired (as “${existing.name}” with ${existing.hub.label}): it is not paired again. Its always-on service is installed next, by the same line.\n`);
      await cancelPairingCode(decodedRetry.payload, io);
      return 0;
    }
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
      await finishPairing(paths, { endpoint: interrupted, keys, reply: recovery.reply, packageId: interrupted.packageId, appDir }, io, true, options);
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
    reply = await getStepRunner(io)(stepLabels.pair, async () => {
      const client = await connectToHub(endpoint, payload.privateKey);
      try {
        return await requestGateJson(client, 'redeem', JSON.stringify(request), redeemReplySchema);
      } finally {
        client.end();
      }
    });
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
      await finishPairing(paths, { endpoint, keys, reply: recovery.reply, packageId, appDir }, io, true, options);
      return 0;
    }
    if (recovery.kind === 'not-registered') removePairingInProgress(paths);
    io.stderr(`charness-runner: ${failure}${recovery.kind === 'unreachable' ? ' (run `charness-runner pair` again later to finish if the hub did register this machine)' : ''}\n`);
    return 1;
  }
  await finishPairing(paths, { endpoint, keys, reply, packageId, appDir }, io, false, options);
  return 0;
}

/** What the Simulator work (the boot check, the silencer) is done by, for a link or a login session's agent. */
export interface SimulatorWorkPlan {
  /** The link runs the iOS Simulator check (every platform: it records «skipped» off a Mac). */
  linkChecksSimulator: boolean;
  /** The link runs the silencer: only on a Mac, and only when the link itself is in a login session. */
  linkSilencesSimulators: boolean;
}

/**
 * @description Who does the Simulator work. On an always-on Mac (`system-service`) the link is a LaunchDaemon in the System session: it can neither judge the
 * Simulator (a check from it would only write «needs the runner user's login session» over the agent's) nor see the Simulators of the account's session, so the
 * login session's agent does both. A Mac link that IS in a login session (a user service, `charness-runner run`) does them itself — jobs and link share the
 * session, so the Simulators a job boots are the ones the silencer lists.
 */
export function planSimulatorWork(platform: NodeJS.Platform, serviceKind: string | null): SimulatorWorkPlan {
  const isAgentsWork = platform === 'darwin' && serviceKind === 'system-service';
  return { linkChecksSimulator: !isAgentsWork, linkSilencesSimulators: platform === 'darwin' && !isAgentsWork };
}

/** @description What the link says of keeping the machine awake as it starts: the method, or that it is not and why (also what `runners` shows). */
export function describeKeepAwake(state: KeepAwakeState): string {
  return state.method === null
    ? `charness-runner: this machine is NOT kept awake while the link runs (${state.reason}) — it may sleep when idle`
    : `charness-runner: keeping this machine awake while the link runs (${describeKeepAwakeMethod(state.method)})`;
}

/** Start the silencer of the Simulators in this process' own session, looking every {@link silencerPollMs}. */
function startSimulatorSilencing(io: CommandIo): void {
  const deps = createSilencerDeps((line) => { io.stderr(`charness-runner: ${line}\n`); });
  const look = createSilencerLook(createSimulatorSilencer(deps), deps);
  setInterval(look, silencerPollMs).unref();
}

/**
 * The record cannot be written (the state folder, a full disk): the Mac then says «being checked» — and why is in the log, not nowhere. Runs the iOS
 * Simulator check now and then once an hour, the way a link in a login session (or the login session's agent) judges the Simulator.
 */
function startIosCheck(paths: RunnerHomePaths, io: CommandIo): void {
  const iosDeps = createIosCheckDeps();
  const logIosCheckError = (error: unknown): void => { io.stderr(`charness-runner: the iOS Simulator check could not be recorded (${error instanceof Error ? error.message : 'unknown error'})\n`); };
  void refreshIosCheck(paths, iosDeps, { isStartup: true }).catch(logIosCheckError);
  const iosTimer = setInterval(() => { void refreshIosCheck(paths, iosDeps, { isStartup: false }).catch(logIosCheckError); }, iosRecheckIntervalMs);
  iosTimer.unref();
}

/**
 * An always-on Mac's link puts the login session's agent in place itself (`guiAgentHeal.ts`) — a Mac paired before the agent existed, or a newer version's
 * definition — now and then once an hour. In the background: the link goes up without waiting for `launchctl`.
 */
function startGuiAgentHealing(paths: RunnerHomePaths, io: CommandIo): void {
  const account = os.userInfo();
  const healer = createGuiAgentHealer(paths, {
    runner: runCommand,
    uid: account.uid,
    accountName: account.username,
    nodeDir: path.dirname(process.execPath),
    getServiceKind: () => readServiceKind(paths),
    // Queued jobs count as work here: they start the moment the old agent is gone.
    readQueue: () => inspectPueue(paths, undefined, pueueUnfinishedStatuses),
  }, (line) => { io.stderr(`charness-runner: ${line}\n`); });
  void healer.look();
  setInterval(() => { void healer.look(); }, guiAgentHealIntervalMs).unref();
}

/** The id of the package copy that `current` points at (`app.<id>`); `null` when it cannot be read. */
function readCurrentAppName(paths: RunnerHomePaths): string | null {
  try {
    return path.basename(fs.realpathSync(paths.currentApp));
  } catch {
    return null;
  }
}

/** What a test may change of the agent's command: where the always-on definitions live, how often it looks for them, and its own stop signal (no process handlers then). */
export interface GuiAgentCommandOverrides {
  launchDaemonsDir?: string;
  serviceCheckIntervalMs?: number;
  signal?: AbortSignal;
}

/**
 * @description `charness-runner gui-agent` (internal: the LaunchAgent in the account's login session starts it; see `guiAgent.ts`): runs the steps of the
 * jobs that need iOS where Xcode can build, keeps the Simulator check of the Mac, and keeps every Simulator silent. Removes itself and leaves when the always-on
 * service it belongs to is gone (the admin removed the daemons; no command of theirs names this account's folders). Leaves for a restart (exit 0, the
 * LaunchAgent starts it again) when an update replaced the package and no step runs.
 */
export async function runGuiAgentCommand(io: CommandIo, homeDir: string = os.homedir(), overrides: GuiAgentCommandOverrides = {}): Promise<number> {
  const paths = getRunnerHomePaths(homeDir);
  if (readRunnerConfig(paths) === null) {
    // The agent comes back only after a crash: an unpaired account (removed, unpaired by hand) is done with it, not a reason to start it every ten seconds.
    io.stderr('charness-runner: this account is not paired: the login session\'s agent has nothing to do and ends.\n');
    return 0;
  }
  const log = (line: string): void => { io.stderr(`charness-runner: ${line}\n`); };
  // The agent is up: whatever the link could not do about it earlier is not a problem any more.
  writeGuiAgentInstallFailure(paths, null);
  startIosCheck(paths, io);
  const silencerDeps = createSilencerDeps(log);
  const lookAtSimulators = createSilencerLook(createSimulatorSilencer(silencerDeps), silencerDeps);
  const controller = new AbortController();
  const removeStopSignals = overrides.signal === undefined ? onStopSignals(() => { controller.abort(); }) : null;
  io.stdout(`charness-runner: the login session's agent is up (${os.userInfo().username}); iOS steps run here\n`);
  const names = getServiceNames(paths.root);
  const result = await runGuiAgent(paths, createGuiAgentDeps(() => readExecEnv(paths)), {
    signal: overrides.signal ?? controller.signal,
    getAppId: () => readCurrentAppName(paths),
    onTick: lookAtSimulators,
    checkIsServiceRemoved: () => !fs.existsSync(path.join(overrides.launchDaemonsDir ?? systemLaunchDaemonsDir, `${names.launchdLink}.plist`)),
    serviceCheckIntervalMs: overrides.serviceCheckIntervalMs,
  });
  removeStopSignals?.();
  if (result === 'removed') {
    // The admin removed the daemons: nothing is left to serve. The definition is the account's own file — it goes too, so the agent does not come back at the next login.
    fs.rmSync(getGuiAgentFile(paths.homeDir, names), { force: true });
    io.stdout('charness-runner: the always-on service of this account was removed: the login session\'s agent removes itself and leaves\n');
    return 0;
  }
  io.stdout(`charness-runner: the login session's agent ${result === 'restart' ? 'leaves for a restart onto the updated program' : 'stopped'}\n`);
  // The restart code is an unsuccessful exit as far as launchd is concerned (`KeepAlive` on `SuccessfulExit` false): it starts the agent again, on the new program.
  return result === 'restart' ? restartExitCode : 0;
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
      await finishPairing(paths, { endpoint: interrupted, keys, reply: recovery.reply, packageId: interrupted.packageId, appDir }, io, true, { isServiceFollowing: false });
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
  startGuiAgentHealing(paths, io);
  const toolDeps = createToolDeps();
  if (!(await findPueue(paths, toolDeps))) await ensurePueue(paths, toolDeps);
  await prepareJobPackageManagers(paths, io);
  // A service that manages Pueue owns the daemon: starting a second one here would only fight it for the socket.
  const isPueueRunning = readServiceKind(paths) === null ? await ensurePueueDaemon(paths) : await waitForPueueDaemon(paths, pueueServiceWaitMs);
  if (!isPueueRunning) io.stderr('charness-runner: Pueue is not running; jobs cannot be queued until it is (the link goes up anyway).\n');
  // On an always-on Mac the Simulator work is the login session's agent's (`runGuiAgentCommand`); a link in a login session does it itself.
  const simulatorWork = planSimulatorWork(process.platform, readServiceKind(paths));
  if (simulatorWork.linkChecksSimulator) startIosCheck(paths, io);
  if (simulatorWork.linkSilencesSimulators) startSimulatorSilencing(io);
  const loopRef: { current: ReturnType<typeof createLinkLoop> | null } = { current: null };
  const servers = createRunnerServers({
    serverPrivateKey: keys.server.privateKey,
    hubPublicKey: config.hub.publicKey,
    readEnv: () => readExecEnv(paths),
    cwd: paths.workDir,
    onActiveCountChange: () => loopRef.current?.notifyActiveCountChange(),
  });
  loopRef.current = createLinkLoop({
    paths,
    config,
    keys,
    servers,
    // A MacBook's lid decides whether the hub may hand it a new job (`lidState.ts`); no other runner reports one.
    lid: checkCanReadLid(process.platform, process.env) ? createLidWatcher({ readRegistry: createIoregReader(), log: (line) => io.stderr(`charness-runner: ${line}\n`) }) : undefined,
    log: (line) => io.stderr(`charness-runner: ${line}\n`),
    stopJobs: async () => { await stopAllPueueJobs(paths); },
  });
  const controller = new AbortController();
  const stop = (): void => {
    controller.abort();
    setTimeout(() => process.exit(0), shutdownGraceMs).unref();
  };
  onStopSignals(stop);
  // The machine is kept awake while the link runs; the holder is tied to this process (it ends with it, however it ends), and `stop` runs from `exit` too.
  const keepAwake = await startKeepAwake(createKeepAwakeDeps(paths));
  process.once('exit', () => { keepAwake.stop(); });
  io.stdout(`${describeKeepAwake(keepAwake.getState())}\n`);
  io.stdout(`charness-runner: serving ${config.hub.label} as “${config.name}” (Ctrl-C stops)\n`);
  try {
    return await loopRef.current.run(controller.signal);
  } finally {
    keepAwake.stop();
  }
}

/** @description `charness-runner status`. */
export function runStatus(io: CommandIo, homeDir: string = os.homedir(), processControl: ProcessControl = createProcessControl()): number {
  const paths = getRunnerHomePaths(homeDir);
  const config = readRunnerConfig(paths);
  if (config === null) {
    io.stdout('This account is not paired. Run the line from /runners on this machine to attach it to a charness.\n');
    return 0;
  }
  const status = readRunnerStatus(paths);
  const lines = [`Runner “${config.name}” of charness ${config.hub.label} (${config.hub.host}:${config.hub.port})`];
  if (status === null || !checkIsRunnerLinkProcess(status.pid, processControl)) {
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

/**
 * @description `charness-runner service install|uninstall`, and the internal `service system-step prepare|abandon` (the account's side of
 * the admin line's always-on install: one JSON line on stdout, see `serviceManager.ts`).
 */
export async function runService(args: readonly string[], io: CommandIo, deps: ServiceDeps = createServiceDeps()): Promise<number> {
  if (args[0] === 'system-step') {
    if (args.length !== 2) {
      io.stderr('charness-runner: service system-step needs «prepare» or «abandon»\n');
      return 2;
    }
    const answer = await runSystemStep(args[1], deps);
    io.stdout(formatSystemStepAnswer(answer));
    return answer.ok ? 0 : 1;
  }
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

export interface UnpairDeps {
  service: ServiceDeps;
  process: ProcessControl;
  queueRunner: CommandRunner;
}

export function createUnpairDeps(): UnpairDeps {
  return { service: createServiceDeps(), process: createProcessControl(), queueRunner: runCommand };
}

/**
 * @description `charness-runner unpair`: forget the pairing — and make that true. In this order:
 *   1. a system service (installed by an admin) is NOT touched from the account: unpair stops there and prints the admin command, because a
 *      pairing cannot be forgotten under a running daemon that holds it;
 *   2. the hub is told (it removes the key line and cuts the link) unless `--local`;
 *   3. the link on this machine is STOPPED and checked to be gone — the user service removed (verified), a foreground `run` ended — since a
 *      running link keeps the keys in memory and goes on serving the hub's commands whatever the files say;
 *   4. the queue's jobs are stopped (this machine no longer serves that hub's agents);
 *   5. only then `config.json`, the keys, the status, the pause and the iOS result are deleted. The installed program, the tools, the work
 *      folder and the queue (now empty) stay.
 * A step that fails stops the command with exit 1 and says what is left.
 */
export async function runUnpair(options: UnpairOptions, io: CommandIo, homeDir: string = os.homedir(), deps: UnpairDeps = createUnpairDeps()): Promise<number> {
  const paths = getRunnerHomePaths(homeDir);
  const config = readRunnerConfig(paths);
  const keys = readRunnerKeys(paths);
  if (config === null || keys === null) {
    io.stderr('charness-runner: this account is not paired.\n');
    return 1;
  }
  const serviceKind = readServiceKind(paths);
  if (serviceKind === 'system-service') {
    io.stderr(`charness-runner: this runner runs as a system service (always on), which only an admin can stop. ${systemServiceRemovalPointer}\nOnce an admin has run them, run \`charness-runner service uninstall\` here and unpair again. Nothing was changed.\n`);
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
        io.stderr(`charness-runner: the hub could not be told (${error instanceof Error ? error.message : 'unknown error'}). Nothing was changed. Try again, or use \`unpair --local\` to forget the pairing here only.\n`);
        return 1;
      }
    }
  }
  if (serviceKind === 'user-service') {
    const removed = await uninstallService({ isSystem: false, userName: null }, deps.service);
    if (!removed.ok) {
      io.stderr(`charness-runner: the service on this machine could not be stopped, so the pairing is kept here: ${removed.lines.join(' ')}\n`);
      return 1;
    }
  }
  const stillRunning = await stopLocalLink(paths, deps.process);
  if (stillRunning !== null) {
    io.stderr(`charness-runner: the runner on this machine could not be stopped (${stillRunning}), so the pairing is kept here. Stop it by hand and run unpair again.\n`);
    return 1;
  }
  if (!(await stopAllPueueJobs(paths, deps.queueRunner))) io.stderr('charness-runner: some jobs of the queue may still be running; check `pueue status` with the runner\'s configuration.\n');
  for (const file of [paths.config, paths.status, paths.pairing, paths.pausedFlag, paths.iosCheck]) fs.rmSync(file, { force: true });
  fs.rmSync(paths.keysDir, { recursive: true, force: true });
  io.stdout(`Unpaired from charness ${config.hub.label}${options.isLocalOnly ? ' (here only — the hub was not told)' : ''}. The link on this machine is stopped, and so are its jobs.\n`);
  return 0;
}
