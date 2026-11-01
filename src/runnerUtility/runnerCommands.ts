import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { formatListTimestamp } from '../runners/runnersList';
import { redeemReplySchema, type RedeemRequest } from '../runners/gateProtocol';
import { decodePairCode } from '../runners/pairCode';
import { checkIsAdminAccount, formatAdminWarning, readAccountFacts } from './adminCheck';
import { ensureLauncher } from './launcher';
import { removeOldApps, switchCurrentApp } from './appInstall';
import { connectToHub, HubConnectionError, requestGateJson } from './hubClient';
import { createLinkLoop } from './linkLoop';
import { collectMachineReport, createMachineProbe, formatMachineReport, type MachineReport } from './machineReport';
import { ensurePueueDaemon } from './pueueDaemon';
import { readRunnerConfig, readRunnerStatus, writeRunnerConfig, type RunnerConfig } from './runnerConfig';
import { getRunnerHomePaths, type RunnerHomePaths } from './runnerHome';
import { ensureRunnerKeys, readRunnerKeys } from './runnerKeys';
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

export function formatKeepRunningHelp(paths: RunnerHomePaths): string {
  return [
    'Keep it running:',
    `  ${paths.launcher} run      here, in this terminal (Ctrl-C stops)`,
    '',
  ].join('\n');
}

export function formatRemovedMessage(label: string): string {
  return `This runner was removed by ${label}. Pair again with a new line from /runners.`;
}

/** @description `charness-runner pair <code>` (run from the INSTALLED copy): redeem the code, record who the runner serves, install its tools. Returns the exit code. */
export async function runPair(code: string, appDir: string, io: CommandIo, homeDir: string = os.homedir()): Promise<number> {
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
  let reply;
  try {
    const client = await connectToHub({ host: payload.host, port: payload.port, user: payload.user, hostKey: payload.hostKey }, payload.privateKey);
    try {
      reply = await requestGateJson(client, 'redeem', JSON.stringify(request), redeemReplySchema);
    } finally {
      client.end();
    }
  } catch (error) {
    io.stderr(`charness-runner: ${error instanceof HubConnectionError && error.failure === 'auth' ? 'the hub refused this pairing line — it has expired or has been used already; make a new one' : error instanceof Error ? error.message : 'pairing failed'}\n`);
    return 1;
  }
  if (!reply.ok) {
    io.stderr(`charness-runner: the hub refused the pairing: ${reply.reason}\n`);
    return 1;
  }
  const config: RunnerConfig = {
    runnerId: reply.runnerId,
    name: reply.name,
    hub: { host: payload.host, port: payload.port, user: payload.user, hostKey: payload.hostKey, publicKey: reply.hubPublicKey, label: reply.label },
    packageId: reply.packageId,
    pairedAtMs: Date.now(),
  };
  for (const directory of [paths.workDir, paths.logsDir]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(paths.envFile)) fs.writeFileSync(paths.envFile, envFileTemplate, { mode: 0o600 });
  switchCurrentApp(paths, appDir);
  ensureLauncher(paths, process.execPath);
  writeRunnerConfig(paths, config);
  removeOldApps(paths);
  await installTools(paths, createToolDeps(), io);
  io.stdout(`\nPaired with charness ${reply.label} (${payload.host}:${payload.port}) as runner “${reply.name}”.\n`);
  io.stdout(`Its agents will run their projects' code on this machine as user «${os.userInfo().username}».\n\n${formatKeepRunningHelp(paths)}`);
  return 0;
}

/** @description `charness-runner run`: ensure the tools and Pueue, then hold the link until stopped. Returns the exit code (75 = restart onto an update). */
export async function runLink(io: CommandIo, homeDir: string = os.homedir()): Promise<number> {
  const paths = getRunnerHomePaths(homeDir);
  const config = readRunnerConfig(paths);
  const keys = readRunnerKeys(paths);
  if (config === null || keys === null) {
    io.stderr('charness-runner: this account is not paired. Run the line from /runners on this machine first.\n');
    return 1;
  }
  ensureLauncher(paths, process.execPath);
  const toolDeps = createToolDeps();
  if (!(await findPueue(paths, toolDeps))) await ensurePueue(paths, toolDeps);
  if (!(await ensurePueueDaemon(paths))) io.stderr('charness-runner: Pueue is not running; jobs cannot be queued until it is (the link goes up anyway).\n');
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
