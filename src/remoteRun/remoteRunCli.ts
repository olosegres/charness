import {
  runCleanCommand,
  runExecCommand,
  runFetchCommand,
  runKillCommand,
  runLogsCommand,
  runLsCommand,
  runRunCommand,
  runRunnersCommand,
  runStatusCommand,
  runWaitCommand,
  type CommandContext,
} from './commands';
import { parseRemoteRunArgs } from './cliArgs';
import { remoteRunExitCodes } from './exitCodes';
import { addInterruptHandlerWithHardStop } from './interrupts';
import { readRemoteRunLeaseMs } from './leaseTiming';
import { createProcessIo, type CliIo } from './output';
import { RemoteRunError } from './remoteRunError';
import { readRunnerScript } from './runnerClient';
import { getRunnersConfigPath, type RunnersConfig } from './runnersConfig';
import { loadRunnersCatalog } from './runnersCatalog';
import { sleepUntilStopped } from './runnerWait';
import { readRunnerWaitPollMs } from './runnerWaitTiming';
import { ensureRemoteRunCacheDir, getRemoteRunCacheDir } from './ssh';

/**
 * @description `charness remote-run …` — send a command to a runner (a machine PAIRED with this charness — `charness runners pair`, the
 * pasted line — or reached by ordinary ssh and listed in `~/.config/charness/runners.json`) and get its output, exit code and declared result files back as if it had run here. The
 * contracts are in `src/remoteRun/README.md`; the user-facing description is `docs/remote-run.md`.
 *
 * The CLI loads NO env file (it would read the PROJECT's `.env`: agents run it from project folders) and never touches `DATA_DIR` or
 * the state store: it needs nothing from an instance.
 */

export { createProcessIo };

export const remoteRunUsage = `Usage:
  charness remote-run [--runner <name>] [--needs android|ios|docker|playwright] [--runner-wait <dur>] [--group <g>]
                      [--timeout <dur>] [--with-git] [--send <path>]… [-e NAME=VALUE]… [--bg] <command…>
                              run <command> on a runner, in the same folder of a copy of this git project;
                              output and exit code come back, interrupt or timeout kills the remote job.
                              --bg prints a job id and returns (long runs).
                              --send <path> sends a held-back secret-looking file (a pattern, relative to the project root) for this call only.
                              --needs with a paired runner that has it but is offline waits for it up to --runner-wait
                              (default 15m, 0 = fail at once). An iOS build or a Simulator test always carries --needs ios: an
                              always-on Mac runs such a job in its login session and refuses it with the reason when there is none.
                              Options go BEFORE the command; a command that starts with a subcommand name goes after --
                              (--runner <name> exec … is exec on that runner; other options before a subcommand name are refused)
  charness remote-run runners                 the runners: online, hardware, load, what each can do
  charness remote-run ls [--all]              jobs of this project (all projects with --all)
  charness remote-run status <id>             one job
  charness remote-run logs <id> [-f] [--tail N]
  charness remote-run wait <id>               block until the job ends, fetch its files, exit with its code
  charness remote-run kill <id>
  charness remote-run fetch <id>              bring a finished job's result files back (again)
  charness remote-run exec [--runner <name>] <command…>
                              one-off command in the runner's copy as the last job left it (no sync)
  charness remote-run clean [<slug>]
                              remove a task's copy of the project from every runner: the copy of the project you are in, or the named one
                              (the name a runner's disk message gives: myapp-0a1b2c3d4e). Frees its disk; its jobs' logs and result files go
                              with it. Refused (exit 125) while a job of it runs or waits, an exec runs in it or a job is being submitted.
Exit codes: the command's own; 125 remote-run failed, 124 timeout, 130/143/129 interrupted (SIGINT/SIGTERM/SIGHUP), 141 stdout closed (| head), 137 job killed, 2 bad usage.
Setup: docs/remote-run.md
`;

/**
 * @description The runners as they are right now, for a look in the middle of a command (the wait for an offline runner re-reads them at
 * every look). A file that is half-way through an edit, or a name that clashes for a moment, must not end a wait that may be 15 minutes
 * in: the list that last loaded is used. Only when nothing ever loaded does a broken file or registry stop the caller with its errors.
 * No runner at all is an empty list.
 */
export function readCurrentRunners(homeDir: string): RunnersConfig {
  const load = loadRunnersCatalog(homeDir);
  if (load.status === 'invalid') {
    if (load.config !== null) return load.config;
    throw new RemoteRunError(load.errors.join('\n'));
  }
  return load.config;
}

function createContext(io: CliIo): CommandContext {
  const load = loadRunnersCatalog(io.homeDir);
  if (load.status === 'missing') {
    throw new RemoteRunError(`no runners are set up: ${getRunnersConfigPath(io.homeDir)} does not exist and none is paired (docs/remote-run.md explains how to add one; \`charness runners pair\` pairs one)`);
  }
  if (load.status === 'invalid') throw new RemoteRunError(load.errors.join('\n'));
  if (load.config.runners.length === 0) throw new RemoteRunError(`${getRunnersConfigPath(io.homeDir)} lists no runners and none is paired`);
  const cacheDir = getRemoteRunCacheDir(io.env, io.homeDir);
  ensureRemoteRunCacheDir(cacheDir);
  return {
    io,
    config: load.config,
    cacheDir,
    script: readRunnerScript(),
    leaseMs: readRemoteRunLeaseMs(io.env),
    now: Date.now,
    loadRunners: () => readCurrentRunners(io.homeDir),
    runnerPollMs: readRunnerWaitPollMs(io.env),
    sleep: sleepUntilStopped,
    watchInterrupts: addInterruptHandlerWithHardStop,
  };
}

/** @description Run the command line (the words after `remote-run`); resolves with the exit code. */
export async function runRemoteRunCli(argv: readonly string[], io: CliIo = createProcessIo()): Promise<number> {
  const parsed = parseRemoteRunArgs(argv);
  if (!parsed.ok) {
    io.stderr(`remote-run: ${parsed.error}\n\n${remoteRunUsage}`);
    return remoteRunExitCodes.usage;
  }
  const { command } = parsed;
  if (command.kind === 'help') {
    if (argv.length === 0) {
      io.stderr(remoteRunUsage);
      return remoteRunExitCodes.usage;
    }
    io.stdout(remoteRunUsage);
    return 0;
  }
  try {
    const context = createContext(io);
    switch (command.kind) {
      case 'run': return await runRunCommand(command, context);
      case 'runners': return await runRunnersCommand(context);
      case 'ls': return await runLsCommand(command, context);
      case 'status': return await runStatusCommand(command, context);
      case 'logs': return await runLogsCommand(command, context);
      case 'wait': return await runWaitCommand(command, context);
      case 'fetch': return await runFetchCommand(command, context);
      case 'kill': return await runKillCommand(command, context);
      case 'exec': return await runExecCommand(command, context);
      case 'clean': return await runCleanCommand(command, context);
    }
  } catch (error) {
    if (error instanceof RemoteRunError) {
      io.stderr(`remote-run: ${error.message}\n`);
      return error.exitCode;
    }
    io.stderr(`remote-run: unexpected error: ${error instanceof Error ? error.message : 'unknown'}\n`);
    return remoteRunExitCodes.failed;
  }
}
