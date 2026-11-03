#!/usr/bin/env node

/**
 * `rootServiceCli.js install <account> [--bootstrap <package folder> --archive <file> --package-id <id> <code>]` — the root step of the admin
 * pairing line (`runners/bootstrapLine.ts`), run by it from a copy of the package that root unpacked into a folder of its own. Node built-ins
 * only (that copy has no `node_modules`), and it never reads or runs anything from the account's home but through `sudo -u <account>`
 * with no terminal attached (see `adminService.ts`, `isolatedCommand.ts`).
 *
 * With the pairing arguments it first has the account pair itself (`pairAccountFromPackage`) and installs the service only when that worked;
 * without them it installs the service of an account that is paired already.
 */

import { createAdminServiceDeps, installServiceForAccount, pairAccountFromPackage, type PairRequest } from './adminService';
import { checkIsTerminal, createStepRunner, stepLabels } from './progress';

const usageExitCode = 2;
const usage = 'Usage: rootServiceCli.js install <account> [--bootstrap <folder> --archive <file> --package-id <id> <code>]\n';
const pairedWithoutServiceText = 'is paired, but has no service: fix the above and paste a fresh admin line';

type InstallArguments = { account: string; pairRequest: PairRequest | null };

/** @description `install <account>` or `install <account> --bootstrap <folder> --archive <file> --package-id <id> <code>`; `null` for anything else. */
export function parseInstallArguments(args: readonly string[]): InstallArguments | null {
  const [command, account, ...rest] = args;
  if (command !== 'install' || account === undefined) return null;
  if (rest.length === 0) return { account, pairRequest: null };
  const [bootstrapFlag, bootstrapDir, archiveFlag, archivePath, idFlag, packageId, code, ...extra] = rest;
  if (bootstrapFlag !== '--bootstrap' || archiveFlag !== '--archive' || idFlag !== '--package-id' || extra.length > 0) return null;
  if (bootstrapDir === undefined || archivePath === undefined || packageId === undefined || code === undefined) return null;
  return { account, pairRequest: { bootstrapDir, archivePath, packageId, code } };
}

async function main(): Promise<number> {
  const parsed = parseInstallArguments(process.argv.slice(2));
  if (parsed === null) {
    process.stderr.write(usage);
    return usageExitCode;
  }
  const { account, pairRequest } = parsed;
  const deps = createAdminServiceDeps();
  if (pairRequest !== null) {
    const pairing = await pairAccountFromPackage(account, pairRequest, deps);
    if (!pairing.ok) {
      process.stderr.write(`${pairing.lines.join('\n')}\n`);
      return 1;
    }
  }
  const runStep = createStepRunner({ write: (text) => { process.stdout.write(text); }, isTerminal: checkIsTerminal(process.stdout), getColumns: () => process.stdout.columns });
  const result = await runStep(stepLabels.installService(account), () => installServiceForAccount(account, deps), (outcome) => !outcome.ok);
  if (result.lines.length > 0) (result.ok ? process.stdout : process.stderr).write(`${result.lines.join('\n')}\n`);
  if (!result.ok && pairRequest !== null) process.stderr.write(`charness-runner: ${account} ${pairedWithoutServiceText}\n`);
  return result.ok ? 0 : 1;
}

// Only when this file IS the program (`node <copy>/rootServiceCli.js install <account> …`): importing it, as the self-check does, installs nothing.
if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: Error) => {
      process.stderr.write(`charness-runner: ${error.message}\n`);
      process.exit(1);
    },
  );
}
