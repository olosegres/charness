/**
 * @description Coverage for `src/selfUpdate/installKind.ts` — how an install is classified: npm global (prefix writable),
 * git checkout (incl. `npm link` and a mounted one), npx, and every case that can only notify. The filesystem is a stub, so
 * every row is one path and a set of writable folders.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { detectInstallKind, type InstallKind, type InstallKindFs } from '../selfUpdate/installKind';

function createFs(existing: string[], writable: string[]): InstallKindFs {
  return {
    checkExists: (target) => existing.includes(target),
    checkIsWritable: (directory) => writable.includes(directory),
  };
}

function detect(packageRoot: string, existing: string[], writable: string[], options: { platform?: NodeJS.Platform; hasExecve?: boolean } = {}): InstallKind {
  return detectInstallKind({ packageRoot, fs: createFs(existing, writable), platform: options.platform ?? 'linux', hasExecve: options.hasExecve ?? true });
}

const globalRoot = '/home/user/.npm-global/lib/node_modules/charness';

test('npm global with a writable prefix → npmGlobal with that prefix', () => {
  assert.deepEqual(detect(globalRoot, [], ['/home/user/.npm-global/lib/node_modules', '/home/user/.npm-global/bin']), {
    kind: 'npmGlobal',
    prefix: '/home/user/.npm-global',
  });
});

test('a root-owned npm prefix can only notify, with the npm command to run by hand', () => {
  assert.deepEqual(detect('/usr/lib/node_modules/charness', [], []), {
    kind: 'notifyOnly',
    reason: 'readOnlyPrefix',
    manualCommand: 'npm install -g charness@latest',
  });
  assert.equal(detect(globalRoot, [], ['/home/user/.npm-global/lib/node_modules']).kind, 'notifyOnly', 'bin must be writable too');
});

test('a git checkout with a script and a writable folder → checkout; npm link resolves to the same thing', () => {
  const root = '/srv/charness';
  const existing = [`${root}/.git`, `${root}/scripts/self-update.sh`];
  assert.deepEqual(detect(root, existing, [root]), { kind: 'checkout', root });
});

test('a git worktree (.git is a file) is a checkout like any other', () => {
  const root = '/srv/charness-wt';
  assert.deepEqual(detect(root, [`${root}/.git`, `${root}/scripts/self-update.sh`], [root]), { kind: 'checkout', root });
});

test('a read-only checkout, or one without the update script, can only notify with the script path', () => {
  const root = '/opt/charness';
  assert.deepEqual(detect(root, [`${root}/.git`, `${root}/scripts/self-update.sh`], []), {
    kind: 'notifyOnly',
    reason: 'readOnlyCheckout',
    manualCommand: '/opt/charness/scripts/self-update.sh',
  });
  assert.equal(detect(root, [`${root}/.git`], [root]).kind, 'notifyOnly');
});

test('npx is ephemeral', () => {
  assert.deepEqual(detect('/home/user/.npm/_npx/abc123/node_modules/charness', [], ['/home/user/.npm/_npx/abc123/node_modules']), { kind: 'ephemeral' });
});

test('pnpm, yarn and bun global installs are not driven: notify with their own command', () => {
  assert.deepEqual(detect('/home/u/.local/share/pnpm/global/5/node_modules/.pnpm/charness@3.4.0/node_modules/charness', [], []), {
    kind: 'notifyOnly',
    reason: 'packageManager',
    manualCommand: 'pnpm add -g charness@latest',
  });
  assert.equal(detect('/home/u/.config/yarn/global/node_modules/charness', [], []).kind, 'notifyOnly');
  assert.deepEqual(detect('/home/u/.bun/install/global/node_modules/charness', [], []), {
    kind: 'notifyOnly',
    reason: 'packageManager',
    manualCommand: 'bun add -g charness@latest',
  });
});

test('a project-local install (not under a global lib) can only notify', () => {
  assert.deepEqual(detect('/work/project/node_modules/charness', [], ['/work/project/node_modules']), {
    kind: 'notifyOnly',
    reason: 'localInstall',
    manualCommand: 'npm install charness@latest',
  });
});

test('a Node without process.execve (or Windows) notifies whatever the folder allows', () => {
  assert.deepEqual(detect(globalRoot, [], ['/home/user/.npm-global/lib/node_modules', '/home/user/.npm-global/bin'], { hasExecve: false }), {
    kind: 'notifyOnly',
    reason: 'noExecve',
    manualCommand: 'npm install -g charness@latest',
  });
  const root = '/srv/charness';
  assert.equal(detect(root, [`${root}/.git`, `${root}/scripts/self-update.sh`], [root], { hasExecve: false }).kind, 'notifyOnly');
});
