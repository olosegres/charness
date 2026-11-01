/**
 * @description `runnerUtility/localLinkStop.ts` with REAL processes: a link started the way the launcher starts it is found by the pid in
 * `status.json`, asked to stop (TERM), forced (KILL) when it ignores that, and only reported stopped when the pid is gone; a pid that
 * belongs to another program is left alone.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { checkIsRunnerLinkCommand, createProcessControl, stopLocalLink } from '../runnerUtility/localLinkStop';
import { writeRunnerStatus } from '../runnerUtility/runnerConfig';
import { getRunnerHomePaths, type RunnerHomePaths } from '../runnerUtility/runnerHome';
import { waitUntil } from './runnersTestKit';

let home = '';
let paths: RunnerHomePaths;
const children: ChildProcess[] = [];

/** A stand-in link: a process whose command line is `node …/runnerCli.js run`, that writes its pid to status.json like `run` does. */
function startStandInLink(options: { ignoreTerm: boolean }): ChildProcess {
  const cliPath = path.join(home, 'runnerCli.js');
  fs.writeFileSync(cliPath, [
    `const fs = require('fs');`,
    options.ignoreTerm ? `process.on('SIGTERM', () => undefined);` : `process.on('SIGTERM', () => process.exit(0));`,
    `fs.writeFileSync(${JSON.stringify(path.join(home, 'started'))}, String(process.pid));`,
    `setInterval(() => undefined, 1000);`,
  ].join('\n'));
  const child = spawn(process.execPath, [cliPath, 'run'], { stdio: 'ignore' });
  children.push(child);
  return child;
}

function recordStatus(pid: number): void {
  writeRunnerStatus(paths, { pid, state: 'linked', sinceMs: 1, updatedAtMs: 1, lastError: null, activeJobs: 0, packageId: null });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-'));
  paths = getRunnerHomePaths(home);
  fs.mkdirSync(paths.root, { recursive: true });
});
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  fs.rmSync(home, { recursive: true, force: true });
});

describe('recognising the link', () => {
  it('only `…/runnerCli.js run` is the runner\'s link', () => {
    assert.equal(checkIsRunnerLinkCommand('/usr/bin/node /home/runner/.charness-runner/current/dist/runnerUtility/runnerCli.js run'), true);
    assert.equal(checkIsRunnerLinkCommand('node runnerCli.js run --verbose'), true);
    for (const other of ['node runnerCli.js status', 'node runnerCli.js runaway', '/usr/bin/vim runnerCli.js', 'node other.js run', null]) assert.equal(checkIsRunnerLinkCommand(other), false, String(other));
  });
});

describe('stopping the link on this machine', () => {
  it('asks the link to stop and reports it only when the process is really gone', async () => {
    const link = startStandInLink({ ignoreTerm: false });
    await waitUntil(() => fs.existsSync(path.join(home, 'started')), 'the stand-in link to start');
    recordStatus(link.pid ?? 0);
    assert.equal(await stopLocalLink(paths), null);
    assert.throws(() => process.kill(link.pid ?? 0, 0), 'the process is gone');
  });

  it('kills a link that ignores TERM', async () => {
    const link = startStandInLink({ ignoreTerm: true });
    await waitUntil(() => fs.existsSync(path.join(home, 'started')), 'the stand-in link to start');
    recordStatus(link.pid ?? 0);
    assert.equal(await stopLocalLink(paths, { ...createProcessControl(), terminateGraceMs: 300 }), null);
    assert.throws(() => process.kill(link.pid ?? 0, 0), 'the process is gone');
  });

  it('leaves a pid that belongs to another program alone, and has nothing to do when no link was ever recorded or it is gone', async () => {
    const other = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore' });
    children.push(other);
    recordStatus(other.pid ?? 0);
    assert.equal(await stopLocalLink(paths), null);
    assert.doesNotThrow(() => process.kill(other.pid ?? 0, 0), 'the other program is still running');
    fs.rmSync(paths.status);
    assert.equal(await stopLocalLink(paths), null);
    recordStatus(2 ** 22 + 12345);
    assert.equal(await stopLocalLink(paths), null);
  });
});
