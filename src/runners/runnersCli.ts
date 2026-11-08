import * as os from 'os';
import type { CliIo } from '../remoteRun/output';
import { getJobsAtOnce, jobsAtOnceSchema, maxJobsAtOnce } from '../remoteRun/runnersConfig';
import { getRemoteRunCacheDir } from '../remoteRun/ssh';
import { buildAdminBootstrapLine, checkIsAccountName, defaultRunnerAccount } from './bootstrapLine';
import { ensureGateWrapper } from './gateWrapper';
import { checkHubAddress, parseHubAddress, scanHostKey, type HostKeyScanner } from './hubAddress';
import { createHubContext, type HubContext } from './hubPaths';
import { createPairing, findPairedRunner, setPairedRunnerJobsAtOnce, setPairedRunnerPaused, sweepExpiredPairings } from './hubPairing';
import { applyRunnerGroups, type RunnerGroupsOutcome } from './runnerGroups';
import { formatLifetime, readPairingLifetimeMs } from './pairingTiming';
import { HubRegistryError, readClosedCodes, readPairedFile, readPendingFile } from './hubRegistry';
import { removeRunnerAndEndItsWork } from './runnerRemoval';
import { readRunnersOverview, refreshStaleSnapshots } from './runnersOverview';
import { formatListTimestamp, formatRunnerList, serviceKindLabels } from './runnersList';
import { formatServiceRemovalNote, formatServiceRemovalUnknownNote, readServiceRemovalForRunner } from './serviceRemoval';

/**
 * @description `charness runners [ls | pair | remove <name> | service-removal <name> | pause <name> | resume <name> | jobs-at-once <name> <n>]` — the headless twin of `/runners`, for an
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
  charness runners pair --host <host[:port]> [--label <text>] [--account <name>] [--jobs-at-once <n>] [--wait]
                                              make two pairing lines (valid 10 minutes, single use, the first one used wins) to run on
                                              the runner machine: one for an ADMIN account there (it pairs <name>, default "runner", and
                                              installs its always-on service), one for the runner account itself;
                                              <host[:port]> is the address the runner dials to reach this machine's sshd;
                                              --jobs-at-once <n> (1-8, default 1) is how many jobs the new runner runs side by side;
                                              --wait blocks until a line is used or the code expires (a line pasted for a machine that
                                              was already paired ends it too, with exit 0: nothing new was paired)
  charness runners remove <name>              detach a runner: its key is deleted and its link cut (a machine that runs as an always-on
                                              service keeps it until an admin there removes it: the commands are printed)
  charness runners service-removal <name>     the admin's commands that remove a runner's always-on service on its machine
  charness runners pause <name>               keep a runner attached but send it no jobs
  charness runners resume <name>
  charness runners jobs-at-once <name> <n>    how many jobs a runner runs at once (1-8; default 1): told to the runner now when it is online, else
                                              at its next job. A job that runs is never stopped by a lower number: it only keeps the next ones waiting.
                                              Jobs side by side must use the ports and the simulator the runner gives them (docs/remote-run.md)
`;

/** @description What the CLI needs from outside; tests replace the scanner, the clock and the wait. */
export interface RunnersCliDeps {
  ctx: HubContext;
  /** Where remote-run keeps the last probe snapshot of each machine: `ls` reads them, and refreshes the stale ones. */
  cacheDir: string;
  /** Asks the machines whose report is older than their link what they are like now (default: the `/runners` screen's own probe; a test's own). */
  refreshStale: typeof refreshStaleSnapshots;
  scanHostKey: HostKeyScanner;
  /** Tells a runner its jobs-at-once limit now (default: over its link, `runners/runnerGroups.ts`; a test's own). */
  applyGroups: typeof applyRunnerGroups;
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
    applyGroups: applyRunnerGroups,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  };
}

interface PairOptions {
  host: string | null;
  label: string | null;
  account: string;
  jobsAtOnce: number | null;
  isWaiting: boolean;
}

/** Plain digits only: `Number()` would also take «1e1», «0x2», «  3» and the empty string. */
const plainCountPattern = /^\d{1,3}$/;

/** `text` as a number of jobs at once (a plain integer in 1..{@link maxJobsAtOnce}), or `null`. */
function parseJobsAtOnce(text: string): number | null {
  const parsed = jobsAtOnceSchema.safeParse(plainCountPattern.test(text) ? Number(text) : Number.NaN);
  return parsed.success ? parsed.data : null;
}

const jobsAtOnceRangeProblem = `the number of jobs at once must be a whole number from 1 to ${maxJobsAtOnce}`;

function parsePairOptions(args: readonly string[]): PairOptions | string {
  const options: PairOptions = { host: null, label: null, account: defaultRunnerAccount, jobsAtOnce: null, isWaiting: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--wait') {
      options.isWaiting = true;
    } else if (argument === '--host' || argument === '--label' || argument === '--account' || argument === '--jobs-at-once') {
      const value = args[index + 1];
      if (value === undefined) return `${argument} needs a value`;
      if (argument === '--host') options.host = value;
      else if (argument === '--label') options.label = value;
      else if (argument === '--jobs-at-once') {
        options.jobsAtOnce = parseJobsAtOnce(value);
        if (options.jobsAtOnce === null) return `--jobs-at-once: ${jobsAtOnceRangeProblem}`;
      } else if (checkIsAccountName(value)) options.account = value;
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
    ...(options.jobsAtOnce === null ? {} : { jobsAtOnce: options.jobsAtOnce }),
  });
  io.stdout(
    `Pair a runner — valid ${formatLifetime(readPairingLifetimeMs(io.env))}, single use.\n\n` +
      `From an admin account of the runner machine; it pairs "${options.account}" and keeps it running. ${adminLineTrustSentence}:\n\n` +
      `${buildAdminBootstrapLine(pairing.payload, options.account)}\n\n` +
      `The last word, "${options.account}", is the account the runner and the agents' code run as: change it if the account is named otherwise. It must be an existing standard ` +
      `(non-admin) account, not your main one.\n` +
      `Without admin rights: run the same line in the terminal of that account itself, without the leading "sudo" — it then pairs that account only, and the always-on service is yours to set up.\n` +
      `Anyone with the line can attach a machine to this charness until it is used or expires.\n`,
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

async function runServiceRemovalCommand(name: string, io: CliIo, deps: RunnersCliDeps): Promise<number> {
  const found = readServiceRemovalForRunner(deps.ctx, deps.cacheDir, name);
  if (found === null) {
    io.stderr(`runners: no runner named "${name}"\n`);
    return failedExitCode;
  }
  if (found.kind !== 'system-service') {
    io.stdout(`Runner "${found.runner.name}" does not run as an always-on service (${serviceKindLabels[found.kind]}): there is nothing for an admin to remove.\n`);
    return 0;
  }
  io.stdout(found.commands.length > 0 ? formatServiceRemovalNote(found.runner.name, found.commands) : formatServiceRemovalUnknownNote(found.runner.name));
  return 0;
}

async function runRemoveCommand(name: string, io: CliIo, deps: RunnersCliDeps): Promise<number> {
  // Read BEFORE the removal: it deletes the runner's last report, which says how the machine is kept running.
  const serviceRemoval = readServiceRemovalForRunner(deps.ctx, deps.cacheDir, name);
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
  // The always-on service is the machine's, and root's: removing the runner here leaves it running there until an admin removes it.
  if (serviceRemoval !== null && serviceRemoval.kind === 'system-service') {
    io.stdout(`\n${serviceRemoval.commands.length > 0 ? formatServiceRemovalNote(removal.runner.name, serviceRemoval.commands) : formatServiceRemovalUnknownNote(removal.runner.name)}`);
  }
  return 0;
}

/** What the operator is told about the number being on the runner: the three outcomes of {@link applyRunnerGroups}. */
const jobsAtOnceOutcomeNotes: Record<RunnerGroupsOutcome, string> = {
  applied: 'told to the runner now',
  offline: 'the runner is offline: it takes the number at its next job',
  failed: 'the runner did not take it now (see above): it takes the number at its next job',
};

async function runJobsAtOnceCommand(args: readonly string[], io: CliIo, deps: RunnersCliDeps): Promise<number> {
  const [name, count, ...extra] = args;
  if (name === undefined || count === undefined || extra.length > 0) {
    io.stderr(`runners: jobs-at-once needs a runner name and a number\n\n${runnersUsage}`);
    return usageExitCode;
  }
  const jobsAtOnce = parseJobsAtOnce(count);
  if (jobsAtOnce === null) {
    io.stderr(`runners: ${jobsAtOnceRangeProblem}\n`);
    return usageExitCode;
  }
  const runner = findPairedRunner(readPairedFile(deps.ctx.dir).runners, name);
  const updated = runner === undefined ? null : await setPairedRunnerJobsAtOnce(deps.ctx, runner.id, jobsAtOnce);
  if (updated === null) {
    io.stderr(`runners: no runner named "${name}"\n`);
    return failedExitCode;
  }
  const outcome = await deps.applyGroups(deps.ctx, updated, deps.cacheDir);
  io.stdout(`Runner "${updated.name}" runs ${getJobsAtOnce(updated)} job${getJobsAtOnce(updated) === 1 ? '' : 's'} at once (${jobsAtOnceOutcomeNotes[outcome]}). A job that runs is never stopped by a lower number.\n`);
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
      case 'jobs-at-once':
        return await runJobsAtOnceCommand(args, io, deps);
      case 'service-removal':
      case 'remove':
      case 'pause':
      case 'resume': {
        if (args.length !== 1) {
          io.stderr(`runners: ${command} needs exactly one runner name\n\n${runnersUsage}`);
          return usageExitCode;
        }
        if (command === 'service-removal') return await runServiceRemovalCommand(args[0], io, deps);
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
