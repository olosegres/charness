#!/usr/bin/env node

/**
 * `rootServiceCli.js install <account>` — the root step of the admin pairing line (`runners/bootstrapLine.ts`), run by it from a copy of
 * the package that root unpacked into a folder of its own. Node built-ins only (that copy has no `node_modules`), and it never reads or
 * runs anything from the account's home but through `sudo -u <account>` (see `adminService.ts`).
 */

import { createAdminServiceDeps, installServiceForAccount } from './adminService';

const usageExitCode = 2;

async function main(): Promise<number> {
  const [command, account, ...rest] = process.argv.slice(2);
  if (command !== 'install' || account === undefined || rest.length > 0) {
    process.stderr.write('Usage: rootServiceCli.js install <account>\n');
    return usageExitCode;
  }
  const result = await installServiceForAccount(account, createAdminServiceDeps());
  if (result.lines.length > 0) (result.ok ? process.stdout : process.stderr).write(`${result.lines.join('\n')}\n`);
  return result.ok ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: Error) => {
    process.stderr.write(`charness-runner: ${error.message}\n`);
    process.exit(1);
  },
);
