import { spawnSync } from 'child_process';
import * as os from 'os';

/**
 * @description Is the account that runs the jobs an admin one? The agents' code runs with its rights, so a runner on an account that can
 * `sudo` (or is root) gets a warning at pairing: make a standard user for it. macOS: member of the `admin` group; Linux: uid 0 or a
 * member of `sudo`, `wheel` or `admin`.
 */

export const linuxAdminGroups: readonly string[] = ['sudo', 'wheel', 'admin'];
export const macAdminGroup = 'admin';

export interface AccountFacts {
  platform: NodeJS.Platform;
  uid: number;
  groups: readonly string[];
}

export function checkIsAdminAccount(account: AccountFacts): boolean {
  if (account.platform === 'darwin') return account.groups.includes(macAdminGroup);
  return account.uid === 0 || account.groups.some((group) => linuxAdminGroups.includes(group));
}

/** @description The account's group names (`id -Gn`), empty when it cannot be asked. */
export function readAccountGroups(): string[] {
  const result = spawnSync('id', ['-Gn'], { encoding: 'utf8', timeout: 4000 });
  return result.status === 0 ? result.stdout.trim().split(/\s+/).filter((group) => group !== '') : [];
}

export function readAccountFacts(): AccountFacts {
  return { platform: process.platform, uid: os.userInfo().uid, groups: readAccountGroups() };
}

export function formatAdminWarning(accountName: string): string[] {
  return [
    `⚠ «${accountName}» is an admin account: the agents' code would run with its rights.`,
    '  Create a standard user for runs (System Settings → Users & Groups, or `adduser`) and run the line there.',
  ];
}
