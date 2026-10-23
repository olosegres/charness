/**
 * @description `getToolLaunch` (`installManager.ts`): how the bot launches what `findToolOnPath` found. On Windows npm
 * installs `opencode.cmd`, a batch shim that `spawn` cannot run without a shell (Node refuses batch files since the
 * 2024 fix) and that a bare `spawn('opencode')` never finds (no PATHEXT). npm's own shim is read and the Node script it
 * wraps runs on this Node — no shell; another batch file runs through `cmd.exe /d /s /c` with a quoted command line.
 *
 * The Windows host is simulated (its shims are real files here); on a real Windows host — the
 * `file-send-cross-platform` CI job — the shim and the batch file are really launched and their arguments read back.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { after, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getToolLaunch, type ToolLaunchHost } from '../installManager';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'launchToolCommand-'));
after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

/** npm's cmd-shim for a package bin that is a Node script (as `npm install -g opencode-ai` writes it). */
const npmNodeShim = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\opencode-ai\\bin\\opencode" %*',
  '',
].join('\r\n');
/** npm's cmd-shim for a bin whose shebang is `#!/bin/sh`: the same `"%_prog%"` form, but the program is `sh`. */
const npmShShim = npmNodeShim
  .replace('IF EXIST "%dp0%\\node.exe" (', 'IF EXIST "%dp0%\\sh.exe" (')
  .replace('SET "_prog=%dp0%\\node.exe"', 'SET "_prog=%dp0%\\sh.exe"')
  .replace('SET "_prog=node"', 'SET "_prog=sh"')
  .replace('node_modules\\opencode-ai\\bin\\opencode', 'node_modules\\fork\\bin\\fork.sh');
/** npm's cmd-shim for a bin that is a native executable: it runs the target itself. */
const npmNativeShim = ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '"%dp0%\\node_modules\\tool\\bin\\tool.exe"   %*', ''].join('\r\n');

function createWindowsHost(files: Record<string, string>): ToolLaunchHost {
  return {
    platform: 'win32',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    comSpec: 'C:\\Windows\\system32\\cmd.exe',
    readFile: (filePath) => {
      const text = files[filePath];
      if (text === undefined) throw new Error(`ENOENT: ${filePath}`);
      return text;
    },
  };
}

test('POSIX, and a Windows .exe: launched as found, the arguments as they are', () => {
  assert.deepEqual(getToolLaunch('/usr/local/bin/opencode', ['models'], { ...createWindowsHost({}), platform: 'linux' }), { command: '/usr/local/bin/opencode', args: ['models'], windowsVerbatimArguments: false });
  assert.deepEqual(getToolLaunch('C:\\tools\\opencode.exe', ['serve'], createWindowsHost({})), { command: 'C:\\tools\\opencode.exe', args: ['serve'], windowsVerbatimArguments: false });
});

test('Windows, npm\'s shim of a Node script: the script runs on this Node, no shell', () => {
  const shimPath = 'C:\\Users\\user\\AppData\\Roaming\\npm\\opencode.cmd';
  assert.deepEqual(getToolLaunch(shimPath, ['serve', '--port', '4096'], createWindowsHost({ [shimPath]: npmNodeShim })), {
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode', 'serve', '--port', '4096'],
    windowsVerbatimArguments: false,
  });
});

test('Windows, npm\'s shim of a native binary: the binary runs directly', () => {
  const shimPath = 'C:\\npm\\tool.CMD';
  assert.deepEqual(getToolLaunch(shimPath, ['--version'], createWindowsHost({ [shimPath]: npmNativeShim })), {
    command: 'C:\\npm\\node_modules\\tool\\bin\\tool.exe',
    args: ['--version'],
    windowsVerbatimArguments: false,
  });
});

test('Windows, npm\'s shim of a script for another interpreter (sh): run as npm wrote it, through cmd.exe — never on Node', () => {
  const shimPath = 'C:\\npm\\fork.cmd';
  assert.ok(npmShShim.includes('SET "_prog=sh"') && !/_prog=[^"]*node/i.test(npmShShim), 'precondition: the shim\'s program is sh, not node');
  assert.deepEqual(getToolLaunch(shimPath, ['serve'], createWindowsHost({ [shimPath]: npmShShim })), {
    command: 'C:\\Windows\\system32\\cmd.exe',
    args: ['/d', '/s', '/c', '""C:\\npm\\fork.cmd" "serve""'],
    windowsVerbatimArguments: true,
  });
});

test('Windows, another batch file: through cmd.exe /d /s /c with a quoted command line; a cmd.exe metacharacter is refused', () => {
  const batchPath = 'C:\\Program Files\\Tool\\tool.bat';
  assert.deepEqual(getToolLaunch(batchPath, ['serve', '--port', '4096'], createWindowsHost({ [batchPath]: '@echo off\r\n"%~dp0tool.exe" %*\r\n' })), {
    command: 'C:\\Windows\\system32\\cmd.exe',
    args: ['/d', '/s', '/c', '""C:\\Program Files\\Tool\\tool.bat" "serve" "--port" "4096""'],
    windowsVerbatimArguments: true,
  });
  for (const unsafeArgument of ['a&b', 'x|y', '%PATH%', 'say"hi', '!x!']) {
    assert.throws(() => getToolLaunch(batchPath, [unsafeArgument], createWindowsHost({ [batchPath]: '@echo off\r\n' })), /cmd\.exe interprets/, unsafeArgument);
  }
  // An unreadable shim is run through cmd.exe as well.
  assert.equal(getToolLaunch('C:\\gone\\tool.cmd', [], createWindowsHost({})).command, 'C:\\Windows\\system32\\cmd.exe');
});

const windowsHostTest = process.platform === 'win32' ? test : test.skip;

windowsHostTest('on a real Windows host: an npm shim and a plain batch file really run, and get their arguments', () => {
  const echoScript = path.join(tempRoot, 'node_modules', 'echo-tool', 'bin', 'echo-tool');
  fs.mkdirSync(path.dirname(echoScript), { recursive: true });
  fs.writeFileSync(echoScript, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  const shimPath = path.join(tempRoot, 'echo-tool.cmd');
  fs.writeFileSync(shimPath, npmNodeShim.replace('node_modules\\opencode-ai\\bin\\opencode', 'node_modules\\echo-tool\\bin\\echo-tool'));
  const shimLaunch = getToolLaunch(shimPath, ['serve', '--port', '4096']);
  const shimRun = spawnSync(shimLaunch.command, shimLaunch.args, { encoding: 'utf8', windowsVerbatimArguments: shimLaunch.windowsVerbatimArguments });
  assert.equal(shimRun.status, 0, shimRun.stderr);
  assert.deepEqual(JSON.parse(shimRun.stdout), ['serve', '--port', '4096']);

  const batchPath = path.join(tempRoot, 'echo tool.bat');
  fs.writeFileSync(batchPath, '@echo off\r\necho %1 %2\r\n');
  const batchLaunch = getToolLaunch(batchPath, ['models', 'list']);
  const batchRun = spawnSync(batchLaunch.command, batchLaunch.args, { encoding: 'utf8', windowsVerbatimArguments: batchLaunch.windowsVerbatimArguments });
  assert.equal(batchRun.status, 0, batchRun.stderr);
  assert.equal(batchRun.stdout.trim(), '"models" "list"');
});
