#!/usr/bin/env node

/**
 * `charness-runner` — the program that attaches a machine to a charness hub as a runner (see `src/runners/README.md` for the hub side
 * and `src/runnerUtility/README.md` for this one).
 *
 *   charness-runner                        what this account is attached to and what the link is doing (= `status`)
 *   charness-runner pair <code>            attach this account with a pairing code (the line from /runners does it for you)
 *   charness-runner run                    hold the link to the hub; Ctrl-C stops (a service does the same, see the pairing text)
 *   charness-runner check                  look at this machine and install what a runner needs (Pueue, rsync)
 *
 * This file is the FIRST thing a pairing runs, from a package that has no `node_modules` yet (`pair --bootstrap <folder> <code>`,
 * started by the pasted line): it imports Node built-ins only, installs the package's dependencies into a new app folder, and starts
 * the installed copy to do the pairing. Everything else is loaded after that, on demand.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { installAppFromDirectory, restartExitCode } from './appInstall';
import { getRunnerHomePaths } from './runnerHome';

const usageExitCode = 2;
const usage = `Usage:
  charness-runner                    what this account is attached to and what the link is doing
  charness-runner pair <code>        attach this account with a pairing code
  charness-runner run                hold the link to the hub (Ctrl-C stops)
  charness-runner check              look at this machine; install Pueue and rsync when they are missing
`;

/** The folder of the copy that is running: this file is `<app>/dist/runnerUtility/runnerCli.js`. */
function getOwnAppDir(): string {
  return path.resolve(__dirname, '..', '..');
}

function runBootstrap(bootstrapDir: string, code: string): number {
  const paths = getRunnerHomePaths();
  let appDir: string;
  try {
    appDir = installAppFromDirectory(bootstrapDir, paths);
  } catch (error) {
    process.stderr.write(`charness-runner: ${error instanceof Error ? error.message : 'could not install'}\n`);
    return 1;
  }
  const installedCli = path.join(appDir, 'dist', 'runnerUtility', 'runnerCli.js');
  const result = spawnSync(process.execPath, [installedCli, 'pair', code], { stdio: 'inherit' });
  const isCurrent = fs.existsSync(paths.currentApp) && fs.realpathSync(paths.currentApp) === fs.realpathSync(appDir);
  if (!isCurrent) fs.rmSync(appDir, { recursive: true, force: true });
  return result.status ?? 1;
}

async function main(): Promise<number> {
  const [command = 'status', ...args] = process.argv.slice(2);
  if (command === 'pair' && args[0] === '--bootstrap') {
    const [, bootstrapDir, code] = args;
    if (bootstrapDir === undefined || code === undefined) {
      process.stderr.write(usage);
      return usageExitCode;
    }
    return runBootstrap(bootstrapDir, code);
  }
  const io = { stdout: (text: string): void => { process.stdout.write(text); }, stderr: (text: string): void => { process.stderr.write(text); } };
  switch (command) {
    case 'pair': {
      if (args.length !== 1) {
        process.stderr.write(usage);
        return usageExitCode;
      }
      const { runPair } = await import('./runnerCommands');
      return runPair(args[0], getOwnAppDir(), io);
    }
    case 'run': {
      const { runLink } = await import('./runnerCommands');
      return runLink(io);
    }
    case 'status': {
      const { runStatus } = await import('./runnerCommands');
      return runStatus(io);
    }
    case 'check': {
      const { runCheck } = await import('./runnerCommands');
      return runCheck(io);
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
