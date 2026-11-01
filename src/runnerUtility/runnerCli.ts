#!/usr/bin/env node

/**
 * `charness-runner` — the program that attaches a machine to a charness hub as a runner (see `src/runners/README.md` for the hub side
 * and `src/runnerUtility/README.md` for this one).
 *
 *   charness-runner                        what this account is attached to and what the link is doing (= `status`)
 *   charness-runner pair <code>            attach this account with a pairing code (the line from /runners does it for you)
 *   charness-runner run                    hold the link to the hub; Ctrl-C stops (a service does the same, see the pairing text)
 *   charness-runner check                  look at this machine and install what a runner needs (Pueue, rsync)
 *   charness-runner service install        keep it running without a terminal (see `serviceManager.ts`)
 *   charness-runner pause | resume | unpair
 *
 * This file is the FIRST thing a pairing runs, from a package that has no `node_modules` yet (`pair --bootstrap <folder> <code>`,
 * started by the pasted line): it imports Node built-ins only, installs the package's dependencies into a new app folder, and starts
 * the installed copy to do the pairing. Everything else is loaded after that, on demand.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { installAppFromDirectory, restartExitCode } from './appInstall';
import { checkArchiveHasId, checkIsPackageId } from './packageId';
import { getRunnerHomePaths } from './runnerHome';

const usageExitCode = 2;
const usage = `Usage:
  charness-runner                    what this account is attached to and what the link is doing
  charness-runner pair <code>        attach this account with a pairing code
  charness-runner run                hold the link to the hub (Ctrl-C stops)
  charness-runner check              look at this machine; install Pueue and rsync when they are missing
  charness-runner service install    keep it running in the background (systemd user service on Linux, LaunchAgent on macOS)
  sudo charness-runner service install --system --user <account>
                                     macOS: always on, also logged out (LaunchDaemon running as <account>), once, by an admin
  charness-runner service uninstall  remove the services (with --system --user <account> for the daemons)
  charness-runner pause | resume     take this machine out of rotation, or back in
  charness-runner unpair [--local]   tell the hub and forget the pairing (--local: forget it here only)
`;

/** The folder of the copy that is running: this file is `<app>/dist/runnerUtility/runnerCli.js`. */
function getOwnAppDir(): string {
  return path.resolve(__dirname, '..', '..');
}

interface BootstrapArgs {
  bootstrapDir: string;
  archivePath: string;
  packageId: string;
  code: string;
}

/** `--bootstrap <folder> --archive <file> --package-id <id> <code>` — what the pasted line passes. */
function parseBootstrapArgs(args: readonly string[]): BootstrapArgs | null {
  const [bootstrapFlag, bootstrapDir, archiveFlag, archivePath, idFlag, packageId, code, ...rest] = args;
  if (bootstrapFlag !== '--bootstrap' || archiveFlag !== '--archive' || idFlag !== '--package-id' || rest.length > 0) return null;
  return bootstrapDir === undefined || archivePath === undefined || packageId === undefined || code === undefined ? null : { bootstrapDir, archivePath, packageId, code };
}

/** `<code> [--package-id <id>]` — `pair` from an installed copy. */
function parsePairArgs(args: readonly string[]): { code: string; packageId: string | null } | null {
  const [code, flag, packageId, ...rest] = args;
  if (code === undefined || rest.length > 0) return null;
  if (flag === undefined) return { code, packageId: null };
  return flag === '--package-id' && packageId !== undefined && checkIsPackageId(packageId) ? { code, packageId } : null;
}

function runBootstrap(args: BootstrapArgs): number {
  const { bootstrapDir, archivePath, packageId, code } = args;
  // The archive is checked against the id the hub announced with it, and THAT id — not whatever the hub offers a moment later — is
  // what the runner records as installed.
  if (!checkArchiveHasId(archivePath, packageId)) {
    process.stderr.write('charness-runner: the package that was downloaded is not the one the hub announced; run the line again\n');
    return 1;
  }
  const paths = getRunnerHomePaths();
  let appDir: string;
  try {
    appDir = installAppFromDirectory(bootstrapDir, paths);
  } catch (error) {
    process.stderr.write(`charness-runner: ${error instanceof Error ? error.message : 'could not install'}\n`);
    return 1;
  }
  const installedCli = path.join(appDir, 'dist', 'runnerUtility', 'runnerCli.js');
  const result = spawnSync(process.execPath, [installedCli, 'pair', code, '--package-id', packageId], { stdio: 'inherit' });
  const isCurrent = fs.existsSync(paths.currentApp) && fs.realpathSync(paths.currentApp) === fs.realpathSync(appDir);
  if (!isCurrent) fs.rmSync(appDir, { recursive: true, force: true });
  return result.status ?? 1;
}

async function main(): Promise<number> {
  const [command = 'status', ...args] = process.argv.slice(2);
  if (command === 'pair' && args[0] === '--bootstrap') {
    const bootstrapArgs = parseBootstrapArgs(args);
    if (bootstrapArgs === null) {
      process.stderr.write(usage);
      return usageExitCode;
    }
    return runBootstrap(bootstrapArgs);
  }
  const io = { stdout: (text: string): void => { process.stdout.write(text); }, stderr: (text: string): void => { process.stderr.write(text); } };
  switch (command) {
    case 'pair': {
      const pairArgs = parsePairArgs(args);
      if (pairArgs === null) {
        process.stderr.write(usage);
        return usageExitCode;
      }
      const { runPair } = await import('./runnerCommands');
      return runPair(pairArgs.code, getOwnAppDir(), pairArgs.packageId, io);
    }
    case 'run': {
      const { runLink } = await import('./runnerCommands');
      return runLink(io, getOwnAppDir());
    }
    case 'status': {
      const { runStatus } = await import('./runnerCommands');
      return runStatus(io);
    }
    case 'check': {
      const { runCheck } = await import('./runnerCommands');
      return runCheck(io);
    }
    case 'service': {
      const { runService } = await import('./runnerCommands');
      return runService(args, io);
    }
    case 'pause':
    case 'resume': {
      const { runPause } = await import('./runnerCommands');
      return runPause(command === 'pause', io);
    }
    case 'unpair': {
      if (args.length > 1 || (args.length === 1 && args[0] !== '--local')) {
        process.stderr.write(usage);
        return usageExitCode;
      }
      const { runUnpair } = await import('./runnerCommands');
      return runUnpair({ isLocalOnly: args[0] === '--local' }, io);
    }
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(usage);
      return 0;
    default:
      process.stderr.write(`charness-runner: unknown command: ${command}\n\n${usage}`);
      return usageExitCode;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
    // `run` holds sockets, a Pueue probe and timers: it leaves by itself — also with the restart code after an update; every other command ends when its output is flushed.
    if (process.argv[2] === 'run' || code === restartExitCode) process.exit(code);
  },
  (error: Error) => {
    process.stderr.write(`charness-runner: ${error.message}\n`);
    process.exit(1);
  },
);
