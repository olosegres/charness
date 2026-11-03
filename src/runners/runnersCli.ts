import * as os from 'os';
import type { CliIo } from '../remoteRun/output';
import { getRemoteRunCacheDir } from '../remoteRun/ssh';
import { buildAdminBootstrapLine, buildBootstrapLine, checkIsAccountName, defaultRunnerAccount } from './bootstrapLine';
import { ensureGateWrapper } from './gateWrapper';
import { checkHubAddress, parseHubAddress, scanHostKey, type HostKeyScanner } from './hubAddress';
import { createHubContext, type HubContext } from './hubPaths';
import { createPairing, findPairedRunner, setPairedRunnerPaused, sweepExpiredPairings } from './hubPairing';
import { formatLifetime, readPairingLifetimeMs } from './pairingTiming';
import { HubRegistryError, readClosedCodes, readPairedFile, readPendingFile } from './hubRegistry';
import { removeRunnerAndEndItsWork } from './runnerRemoval';
import { readRunnersOverview, refreshStaleSnapshots } from './runnersOverview';
import { formatListTimestamp, formatRunnerList } from './runnersList';

/**
 * @description `charness runners [ls | pair | remove <name> | pause <name> | resume <name>]` — the headless twin of `/runners`, for an
 * instance without Telegram (a Jira-only one) and for the flow tests. It works on the registry of the OS user
 * (`~/.config/charness/runners/`), loads no env file and never touches `DATA_DIR`.
 */

/** What the admin line does to the machine it is pasted on, in the words every place that offers it uses (the Telegram message has it in each language). */
export const adminLineTrustSentence = 'It runs code from this charness host as root on that machine';

const usageExitCode = 2;
const failedExitCode = 1;
const waitPollMs = 1000;

export const runnersUsage = `Usage:
  charness runners [ls]                       the machines paired as runners: online or not, OS, how they are kept running
                                              (as each machine last reported it; one whose report is older than its link is asked first)
  charness runners pair --host <host[:port]> [--label <text>] [--account <name>] [--wait]
                                              make two pairing lines (valid 10 minutes, single use, the first one used wins) to run on
                                              the runner machine: one for an ADMIN account there (it pairs <name>, default "runner", and
                                              installs its always-on service), one for the runner account itself;
                                              <host[:port]> is the address the runner dials to reach this machine's sshd;
                                              --wait blocks until a line is used or the code expires (a line pasted for a machine that
                                              was already paired ends it too, with exit 0: nothing new was paired)
  charness runners remove <name>              detach a runner: its key is deleted and its link cut
  charness runners pause <name>               keep a runner attached but send it no jobs
  charness runners resume <name>
`;

/** @description What the CLI needs from outside; tests replace the scanner, the clock and the wait. */
export interface RunnersCliDeps {
  ctx: HubContext;
  /** Where remote-run keeps the last probe snapshot of each machine: `ls` reads them, and refreshes the stale ones. */
  cacheDir: string;
  /** Asks the machines whose report is older than their link what they are like now (default: the `/runners` screen's own probe; a test's own). */
  refreshStale: typeof refreshStaleSnapshots;
  scanHostKey: HostKeyScanner;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  sshUser?: string;
}

export function createRunnersCliDeps(io: Pick<CliIo, 'homeDir' | 'env'>): RunnersCliDeps {
  return {
    ctx: createHubContext({ homeDir: io.homeDir }),
    cacheDir: getRemoteRunCacheDir(io.env, io.homeDir),
    refreshStale: refreshStaleSnapshots,
    scanHostKey,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  };
}

interface PairOptions {
  host: string | null;
  label: string | null;
  account: string;
  isWaiting: boolean;
}

function parsePairOptions(args: readonly string[]): PairOptions | string {
  const options: PairOptions = { host: null, label: null, account: defaultRunnerAccount, isWaiting: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--wait') {
      options.isWaiting = true;
    } else if (argument === '--host' || argument === '--label' || argument === '--account') {
      const value = args[index + 1];
      if (value === undefined) return `${argument} needs a value`;
      if (argument === '--host') options.host = value;
      else if (argument === '--label') options.label = value;
      else if (checkIsAccountName(value)) options.account = value;
      else return '--account must be a plain account name (letters, digits, ".", "_", "-")';
      index += 1;
    } else {
      return `unknown argument: ${argument}`;
    }
  }
  return options;
}

async function runPairCommand(args: readonly string[], io: CliIo, deps: RunnersCliDeps): Promise<number> {
  const options = parsePairOptions(args);
  if (typeof options === 'string' || options.host === null) {
    io.stderr(`runners: ${typeof options === 'string' ? options : '--host <host[:port]> is required (the address runners dial to reach this machine over ssh)'}\n\n${runnersUsage}`);
    return usageExitCode;
  }
  const parsedAddress = parseHubAddress(options.host);
  if (!parsedAddress.ok) {
    io.stderr(`runners: ${parsedAddress.error}\n`);
    return usageExitCode;
  }
  const check = await checkHubAddress(parsedAddress.address, deps.scanHostKey);
  if (!check.ok) {
    io.stderr(`runners: ${check.error}\n`);
    return failedExitCode;
  }
  if (check.note !== null) io.stderr(`runners: ${check.note}\n`);
  ensureGateWrapper(deps.ctx);
  const pairing = await createPairing(deps.ctx, {
    host: parsedAddress.address.host,
    port: parsedAddress.address.port,
    hostKey: check.hostKey,
    label: options.label ?? os.hostname(),
    nowMs: deps.now(),
    lifetimeMs: readPairingLifetimeMs(io.env),
    sshUser: deps.sshUser,
  });
  io.stdout(
    `Pair a runner — valid ${formatLifetime(readPairingLifetimeMs(io.env))}, single use.\n\n` +
      `1) From an admin account of the runner machine: it pairs "${options.account}" (the last word of the line — change it if the account is named otherwise) and keeps it running. ${adminLineTrustSentence}:\n\n` +
      `${buildAdminBootstrapLine(pairing.payload, options.account)}\n\n` +
      `2) Without admin rights: run this one in the terminal of the runner account itself:\n\n` +
      `${buildBootstrapLine(pairing.payload)}\n\n` +
      `The account must be an existing standard user, not your main account — it runs the agents' code.\n` +
      `Anyone with either line can attach a machine to this charness until one of them is used or expires.\n`,
  );
  return options.isWaiting ? waitForPairing(pairing.pairId, io, deps) : 0;
}

async function waitForPairing(pairId: string, io: CliIo, deps: RunnersCliDeps): Promise<number> {
  for (;;) {
    const runner = readPairedFile(deps.ctx.dir).runners.find((candidate) => candidate.pairId === pairId);
    if (runner !== undefined) {
      io.stdout(`Runner "${runner.name}" paired ${formatListTimestamp(runner.pairedAtMs)}.\n`);
      return 0;
    }
    const pairing = readPendingFile(deps.ctx.dir).pending.find((candidate) => candidate.pairId === pairId);
    // A code closed unused is not a failure: its line was pasted for a machine that was already paired, and did its job (the service).
    if (pairing === undefined) {
      const { codes, problem } = readClosedCodes(deps.ctx.dir);
      if (problem !== null) io.stderr(`runners: ${problem}\n`);
      if (codes.some((entry) => entry.pairId === pairId)) {
        io.stdout('The pairing line was used on a machine that was already paired: nothing new was paired.\n');
        return 0;
      }
    }
    if (pairing === undefined || pairing.expiresAtMs <= deps.now()) {
      await sweepExpiredPairings(deps.ctx, deps.now());
      io.stderr('runners: the pairing code expired unused.\n');
      return failedExitCode;
    }
    await deps.sleep(waitPollMs);
  }
}

async function runListCommand(io: CliIo, deps: RunnersCliDeps): Promise<number> {
  await sweepExpiredPairings(deps.ctx, deps.now());
  // The screen's first step — the registry, which links are up, the last report of each machine — and a fresh look at the machines whose report
  // is older than their link (a service installed after pairing starts the link anew), and nothing more: a listing that finds the reports fresh
  // makes no ssh call, and a machine is online exactly when its link is, whatever its probe says.
  const overview = await deps.refreshStale(deps.ctx, await readRunnersOverview(deps.ctx, deps.cacheDir, deps.now()), deps.cacheDir, deps.now());
  io.stdout(formatRunnerList(overview.entries, readPendingFile(deps.ctx.dir).pending, deps.now()));
  return 0;
}

async function runRemoveCommand(name: string, io: CliIo, deps: RunnersCliDeps): Promise<number> {
  const removal = await removeRunnerAndEndItsWork(deps.ctx, name, deps.now());
  if (removal === null) {
    io.stderr(`runners: no runner named "${name}"\n`);
    return failedExitCode;
  }
  const jobsNote = {
    stopped: 'the jobs it had running are stopped',
    failed: 'the jobs it had running could not be stopped from here (it stops them itself once it finds out it was removed)',
    offline: 'it is offline: it stops the jobs it had running itself once it finds out it was removed',
  }[removal.jobs];
  io.stdout(`Runner "${removal.runner.name}" removed: its key is deleted and its link cut; ${jobsNote}.\n`);
  return 0;
}

async function runPauseCommand(name: string, isPaused: boolean, io: CliIo, deps: RunnersCliDeps): Promise<number> {
  const runner = findPairedRunner(readPairedFile(deps.ctx.dir).runners, name);
  const updated = runner === undefined ? null : await setPairedRunnerPaused(deps.ctx, runner.id, isPaused);
  if (updated === null) {
    io.stderr(`runners: no runner named "${name}"\n`);
    return failedExitCode;
  }
  io.stdout(`Runner "${updated.name}" ${isPaused ? 'paused: it gets no jobs until resumed' : 'resumed'}.\n`);
  return 0;
}

/** @description Run the command line (the words after `runners`); resolves with the exit code. */
export async function runRunnersCli(argv: readonly string[], io: CliIo, deps: RunnersCliDeps = createRunnersCliDeps(io)): Promise<number> {
  const [command = 'ls', ...args] = argv;
  try {
    switch (command) {
      case 'ls':
        return await runListCommand(io, deps);
      case 'pair':
        return await runPairCommand(args, io, deps);
      case 'remove':
      case 'pause':
      case 'resume': {
        if (args.length !== 1) {
          io.stderr(`runners: ${command} needs exactly one runner name\n\n${runnersUsage}`);
          return usageExitCode;
        }
        return command === 'remove' ? await runRemoveCommand(args[0], io, deps) : await runPauseCommand(args[0], command === 'pause', io, deps);
      }
      case '--help':
      case '-h':
      case 'help':
        io.stdout(runnersUsage);
        return 0;
      default:
        io.stderr(`runners: unknown command: ${command}\n\n${runnersUsage}`);
        return usageExitCode;
    }
  } catch (error) {
    io.stderr(`runners: ${error instanceof HubRegistryError ? error.message : `failed (${error instanceof Error ? error.name : 'unknown error'}: ${error instanceof Error ? error.message : ''})`}\n`);
    return failedExitCode;
  }
}
