/**
 * @description `runnerUtility/runnerHome.ts`, `appInstall.ts`, `launcher.ts`, `runnerConfig.ts`, `runnerKeys.ts`: the state folder, the
 * installed copies of the package and the atomic switch between them, the launcher that restarts onto an update, the strict config
 * files, and the two keys.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { createAppId, installAppFromDirectory, installDependencies, removeOldApps, restartExitCode, switchCurrentApp, testNodeModulesEnvName } from '../runnerUtility/appInstall';
import { ensureLauncher, renderLauncher } from '../runnerUtility/launcher';
import { readRunnerConfig, readRunnerStatus, RunnerConfigError, writeRunnerConfig, writeRunnerStatus, type RunnerConfig } from '../runnerUtility/runnerConfig';
import { getAppDirPath, getRunnerHomePaths, type RunnerHomePaths } from '../runnerUtility/runnerHome';
import { ensureRunnerKeys, readRunnerKeys } from '../runnerUtility/runnerKeys';
import { generateEd25519KeyPair } from '../runners/sshKeys';
import { waitUntil } from './runnersTestKit';

let home = '';
let paths: RunnerHomePaths;

function createConfig(): RunnerConfig {
  return {
    runnerId: 'abcdef012345',
    name: 'mac',
    hub: { host: 'host.example', port: 22, user: 'hubuser', hostKey: generateEd25519KeyPair('h').publicKey, publicKey: generateEd25519KeyPair('p').publicKey, label: '@ExampleBot' },
    packageId: '0123456789abcdef',
    pairedAtMs: Date.UTC(2026, 10, 1, 12, 0, 0),
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ru-'));
  paths = getRunnerHomePaths(home);
  fs.mkdirSync(paths.root, { recursive: true });
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('state folder', () => {
  it('lives in ~/.charness-runner', () => {
    assert.equal(paths.root, path.join(home, '.charness-runner'));
    assert.equal(paths.launcher, path.join(home, '.charness-runner', 'bin', 'charness-runner'));
    assert.equal(getAppDirPath(paths, 'ab12'), path.join(home, '.charness-runner', 'app.ab12'));
  });
});

describe('installed copies', () => {
  function createPackage(): string {
    const source = path.join(home, 'source');
    fs.mkdirSync(path.join(source, 'dist', 'runnerUtility'), { recursive: true });
    fs.writeFileSync(path.join(source, 'package.json'), '{"name":"charness"}');
    fs.writeFileSync(path.join(source, 'dist', 'runnerUtility', 'runnerCli.js'), '// cli');
    return source;
  }

  it('app ids are 12 hex digits and differ', () => {
    assert.match(createAppId(), /^[0-9a-f]{12}$/);
    assert.notEqual(createAppId(), createAppId());
  });

  it('the test seam links a node_modules folder instead of running npm; without it npm would run', async () => {
    const appDir = path.join(home, 'app');
    fs.mkdirSync(appDir);
    const modules = path.join(home, 'modules');
    fs.mkdirSync(modules);
    await installDependencies(appDir, { [testNodeModulesEnvName]: modules });
    assert.equal(fs.realpathSync(path.join(appDir, 'node_modules')), fs.realpathSync(modules));
  });

  it('copies the package into a new app folder and installs into it; every install gets a folder of its own', async () => {
    const modules = path.join(home, 'modules');
    fs.mkdirSync(modules);
    const previous = process.env[testNodeModulesEnvName];
    process.env[testNodeModulesEnvName] = modules;
    try {
      const appDir = await installAppFromDirectory(createPackage(), paths);
      assert.match(path.basename(appDir), /^app\.[0-9a-f]{12}$/);
      assert.ok(fs.existsSync(path.join(appDir, 'dist', 'runnerUtility', 'runnerCli.js')));
      assert.ok(fs.existsSync(path.join(appDir, 'node_modules')));
      process.env[testNodeModulesEnvName] = path.join(home, 'missing-folder-links-fine');
      const before = fs.readdirSync(paths.root).length;
      await assert.doesNotReject(installAppFromDirectory(createPackage(), paths), 'a dangling link is still a link');
      assert.equal(fs.readdirSync(paths.root).length, before + 1);
    } finally {
      if (previous === undefined) delete process.env[testNodeModulesEnvName];
      else process.env[testNodeModulesEnvName] = previous;
    }
  });

  it('current is replaced whole: it always points at an app', () => {
    const first = getAppDirPath(paths, 'aaaaaaaaaaaa');
    const second = getAppDirPath(paths, 'bbbbbbbbbbbb');
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    switchCurrentApp(paths, first);
    assert.equal(fs.realpathSync(paths.currentApp), fs.realpathSync(first));
    switchCurrentApp(paths, second);
    assert.equal(fs.realpathSync(paths.currentApp), fs.realpathSync(second));
    assert.deepEqual(fs.readdirSync(paths.root).filter((name) => name.includes('.tmp')), []);
  });

  it('keeps the current app and the newest other one, removes the rest', () => {
    const ids = ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc', 'dddddddddddd'];
    ids.forEach((id, index) => {
      const dir = getAppDirPath(paths, id);
      fs.mkdirSync(dir);
      const time = new Date(Date.now() - (ids.length - index) * 60_000);
      fs.utimesSync(dir, time, time);
    });
    switchCurrentApp(paths, getAppDirPath(paths, 'aaaaaaaaaaaa'));
    removeOldApps(paths);
    assert.deepEqual(fs.readdirSync(paths.root).filter((name) => name.startsWith('app.')).sort(), ['app.aaaaaaaaaaaa', 'app.dddddddddddd']);
  });
});

describe('launcher', () => {
  it('starts the app current points at and starts it again only on the restart code', () => {
    const text = renderLauncher(paths, '/opt/node/bin/node');
    assert.ok(text.startsWith('#!/bin/sh\n'));
    assert.ok(text.includes(`NODE='/opt/node/bin/node'`));
    assert.ok(text.includes(`'${paths.currentApp}/dist/runnerUtility/runnerCli.js' "$@"`));
    assert.ok(text.includes(`[ "$code" = ${restartExitCode} ] || exit "$code"`));
    assert.equal(restartExitCode, 75);
  });

  it('is valid sh, runs the app, and loops on 75 only', () => {
    fs.mkdirSync(path.join(paths.currentApp, 'dist', 'runnerUtility'), { recursive: true });
    const counter = path.join(home, 'counter');
    fs.writeFileSync(path.join(paths.currentApp, 'dist', 'runnerUtility', 'runnerCli.js'), [
      `const fs = require('fs');`,
      `const counter = ${JSON.stringify(counter)};`,
      `const runs = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;`,
      `fs.writeFileSync(counter, String(runs + 1));`,
      `process.exit(runs < 2 ? 75 : 3);`,
    ].join('\n'));
    const launcher = ensureLauncher(paths, process.execPath);
    assert.equal(fs.statSync(launcher).mode & 0o777, 0o755);
    const result = spawnSync(launcher, ['run'], { encoding: 'utf8' });
    assert.equal(result.status, 3, 'a code other than 75 ends the loop and is passed on');
    assert.equal(fs.readFileSync(counter, 'utf8'), '3', 'two restarts, then the last run');
  });

  it('passes TERM on to the app and ends with it — the launcher is the process a service manager signals', async () => {
    const appDir = path.join(paths.currentApp, 'dist', 'runnerUtility');
    fs.mkdirSync(appDir, { recursive: true });
    const gotTerm = path.join(home, 'got-term');
    const appPid = path.join(home, 'app-pid');
    fs.writeFileSync(path.join(appDir, 'runnerCli.js'), [
      `const fs = require('fs');`,
      `fs.writeFileSync(${JSON.stringify(appPid)}, String(process.pid));`,
      `process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(gotTerm)}, '1'); process.exit(0); });`,
      `setInterval(() => undefined, 1000);`,
    ].join('\n'));
    const launcher = ensureLauncher(paths, process.execPath);
    const child = spawn(launcher, ['run'], { stdio: 'ignore' });
    const exited = new Promise<number | null>((resolve) => { child.once('exit', (code) => resolve(code)); });
    await waitUntil(() => fs.existsSync(appPid), 'the app to start');
    child.kill('SIGTERM');
    assert.equal(await exited, 0, 'the launcher ends with the app\'s exit code');
    assert.equal(fs.existsSync(gotTerm), true, 'the app received the TERM');
    assert.throws(() => process.kill(Number(fs.readFileSync(appPid, 'utf8')), 0), 'the app is gone: nothing is left running unsupervised');
  });

  it('is rewritten only when its text changes', () => {
    ensureLauncher(paths, '/a/node');
    const inode = fs.statSync(paths.launcher).ino;
    ensureLauncher(paths, '/a/node');
    assert.equal(fs.statSync(paths.launcher).ino, inode);
    ensureLauncher(paths, '/b/node');
    assert.ok(fs.readFileSync(paths.launcher, 'utf8').includes('/b/node'));
  });
});

describe('config and status files', () => {
  it('round-trip, and the config is private', () => {
    assert.equal(readRunnerConfig(paths), null);
    const config = createConfig();
    writeRunnerConfig(paths, config);
    assert.deepEqual(readRunnerConfig(paths), config);
    assert.equal(fs.statSync(paths.config).mode & 0o777, 0o600);
    const status = { pid: process.pid, state: 'linked' as const, sinceMs: 1, updatedAtMs: 2, lastError: null, activeJobs: 0, packageId: null };
    writeRunnerStatus(paths, status);
    assert.deepEqual(readRunnerStatus(paths), status);
  });

  it('an invalid config names the field and echoes no value; an invalid status reads as none', () => {
    fs.writeFileSync(paths.config, JSON.stringify({ ...createConfig(), runnerId: 'secret-looking-value' }));
    assert.throws(() => readRunnerConfig(paths), (error: Error) => error instanceof RunnerConfigError && /runnerId/.test(error.message) && !error.message.includes('secret-looking-value'));
    fs.writeFileSync(paths.config, '{broken');
    assert.throws(() => readRunnerConfig(paths), /not valid JSON/);
    fs.writeFileSync(paths.status, '{broken');
    assert.equal(readRunnerStatus(paths), null);
  });

  it('refuses a config with a key that is not ed25519 or a host with a space', () => {
    const config = createConfig();
    assert.throws(() => writeRunnerConfig(paths, { ...config, hub: { ...config.hub, publicKey: 'ssh-rsa AAAA' } }));
    assert.throws(() => writeRunnerConfig(paths, { ...config, hub: { ...config.hub, host: 'two words' } }));
  });
});

describe('runner keys', () => {
  it('makes a client key and a host key once, private, and reads them back', () => {
    assert.equal(readRunnerKeys(paths), null);
    const made = ensureRunnerKeys(paths);
    assert.notEqual(made.client.publicKey, made.server.publicKey);
    assert.equal(fs.statSync(paths.clientKey).mode & 0o777, 0o600);
    assert.equal(fs.statSync(paths.keysDir).mode & 0o777, 0o700);
    assert.deepEqual(readRunnerKeys(paths), made);
    assert.deepEqual(ensureRunnerKeys(paths), made, 'a second call keeps the keys');
  });
});
