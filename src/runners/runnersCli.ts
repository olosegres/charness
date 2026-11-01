import * as os from 'os';
import type { CliIo } from '../remoteRun/output';
import { buildBootstrapLine } from './bootstrapLine';
import { ensureGateWrapper } from './gateWrapper';
import { checkHubAddress, parseHubAddress, scanHostKey, type HostKeyScanner } from './hubAddress';
import { createHubContext, type HubContext } from './hubPaths';
import { createPairing, findPairedRunner, removePairedRunner, setPairedRunnerPaused, sweepExpiredPairings } from './hubPairing';
import { formatLifetime, readPairingLifetimeMs } from './pairingTiming';
import { HubRegistryError, readPairedFile, readPendingFile } from './hubRegistry';
import { cutRunnerLink, getRunnerLinkStatus } from './linkControl';
import { formatListTimestamp, formatRunnerList } from './runnersList';

/**
 * @description `charness runners [ls | pair | remove <name> | pause <name> | resume <name>]` — the headless twin of `/runners`, for an
 * instance without Telegram (a Jira-only one) and for the flow tests. It works on the registry of the OS user
 * (`~/.config/charness/runners/`), loads no env file and never touches `DATA_DIR`.
 */

const usageExitCode = 2;
const failedExitCode = 1;
const waitPollMs = 1000;

export const runnersUsage = `Usage:
  charness runners [ls]                       the machines paired as runners: online or not, OS, how they are kept running
  charness runners pair --host <host[:port]> [--label <text>] [--wait]
                                              make a pairing line (valid 10 minutes, single use) to run on the runner machine;
                                              <host[:port]> is the address the runner dials to reach this machine's sshd;
                                              --wait blocks until the line is used or expires
  charness runners remove <name>              detach a runner: its key is deleted and its link cut
  charness runners pause <name>               keep a runner attached but send it no jobs
  charness runners resume <name>
`;

/** @description What the CLI needs from outside; tests replace the scanner, the clock and the wait. */
export interface RunnersCliDeps {
  ctx: HubContext;
  scanHostKey: HostKeyScanner;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  sshUser?: string;
}

export function createRunnersCliDeps(io: Pick<CliIo, 'homeDir'>): RunnersCliDeps {
  return {
    ctx: createHubContext({ homeDir: io.homeDir }),
    scanHostKey,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  };
}

interface PairOptions {
  host: string | null;
  label: string | null;
  isWaiting: boolean;
}

function parsePairOptions(args: readonly string[]): PairOptions | string {
  const options: PairOptions = { host: null, label: null, isWaiting: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--wait') {
      options.isWaiting = true;
    } else if (argument === '--host' || argument === '--label') {
      const value = args[index + 1];
      if (value === undefined) return `${argument} needs a value`;
      if (argument === '--host') options.host = value;
      else options.label = value;
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
      `Run this on the runner machine, as the account that will run jobs\n` +
      `(not your main account — it runs the agents' code):\n\n` +
      `${buildBootstrapLine(pairing.payload)}\n\n` +
      `Anyone with this line can attach a machine to this charness until it is used or expires.\n`,
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
  const paired = readPairedFile(deps.ctx.dir);
  const entries = await Promise.all(paired.runners.map(async (runner) => ({ runner, status: await getRunnerLinkStatus(deps.ctx.dir, runner.id) })));
  io.stdout(formatRunnerList(entries, readPendingFile(deps.ctx.dir).pending, deps.now()));
  return 0;
}

async function runRemoveCommand(name: string, io: CliIo, deps: RunnersCliDeps): Promise<number> {
  const removed = await removePairedRunner(deps.ctx, name, deps.now());
  if (removed === null) {
    io.stderr(`runners: no runner named "${name}"\n`);
    return failedExitCode;
  }
  cutRunnerLink(deps.ctx.dir, removed.id);
  io.stdout(`Runner "${removed.name}" removed: its key is deleted and its link cut.\n`);
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
