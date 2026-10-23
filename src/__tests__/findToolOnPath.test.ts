/**
 * @description `findToolOnPath` (`installManager.ts`): the PATH lookup behind "is the agent CLI installed". It used to run
 * `which`, which Windows does not have, so every tool read as missing there. It now reads PATH itself, the way `which`
 * (POSIX) and `where` (Windows: each `PATHEXT` extension — npm installs `opencode.cmd`) do. The Windows host is
 * simulated with real files in a temp dir, so the extension logic runs on the CI host.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { after, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findToolOnPath } from '../installManager';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'findToolOnPath-'));
const firstDir = path.join(tempRoot, 'first');
const secondDir = path.join(tempRoot, 'second');
fs.mkdirSync(firstDir);
fs.mkdirSync(secondDir);
const executableMode = 0o755;
const plainMode = 0o644;

after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function writeFile(directory: string, name: string, mode: number): string {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, '#!/bin/sh\n');
  fs.chmodSync(filePath, mode);
  return filePath;
}

// The executable bit is a POSIX file-system property: on Windows every file passes `X_OK`, so the POSIX case runs elsewhere.
const posixHostTest = process.platform === 'win32' ? test.skip : test;

posixHostTest('POSIX: the first executable of that name on PATH; a non-executable one or a directory does not count', () => {
  writeFile(firstDir, 'posix-tool', plainMode);
  const executable = writeFile(secondDir, 'posix-tool', executableMode);
  fs.mkdirSync(path.join(firstDir, 'dir-tool'));
  const environment = { platform: 'linux' as const, pathValue: `${firstDir}:${secondDir}`, pathExtValue: undefined };
  assert.equal(findToolOnPath('posix-tool', environment), executable);
  assert.equal(findToolOnPath('dir-tool', environment), null);
  assert.equal(findToolOnPath('missing-tool', environment), null);
});

test('Windows: the name with a PATHEXT extension (npm\'s opencode.cmd), in PATH order; the bare name alone does not run', () => {
  const shim = writeFile(secondDir, 'win-tool.cmd', plainMode);
  writeFile(firstDir, 'win-tool', plainMode);
  const environment = { platform: 'win32' as const, pathValue: `${firstDir};${secondDir}`, pathExtValue: '.COM;.EXE;.BAT;.CMD' };
  assert.equal(findToolOnPath('win-tool', environment), shim, 'the upper-case PATHEXT entry finds the lower-case shim');
  assert.equal(findToolOnPath('win-tool', { ...environment, pathExtValue: undefined }), shim, 'an unset PATHEXT means the shell default');
  writeFile(firstDir, 'bare-only', plainMode);
  assert.equal(findToolOnPath('bare-only', environment), null, 'where finds no extension-less file either');
});

test('the process\'s own PATH is read by default', () => {
  const nodeName = path.basename(process.execPath);
  assert.ok(findToolOnPath(process.platform === 'win32' ? path.parse(nodeName).name : nodeName) !== null, 'node itself is on PATH');
});
