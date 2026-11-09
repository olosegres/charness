/**
 * @description Which callers of the runner's `probe` may start its background prune (`runner.sh probe <work> prune`). The probe that picks a runner for a `run` or an `exec` (`chooseClient`) must not: that
 * prune has no copy to keep, and the project about to be used is typically the least recently used one — the very copy it would take before the job's own `prepare` (which keeps its slug) arrives.
 * Only a VIEW of the runners may: `remote-run runners` and the bot's `/runners` (`probeRunnersOverview`). Proven through a fake `ssh` on the PATH that records the remote command line of every call.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { chooseClient, runRunnersCommand, type CommandContext } from '../remoteRun/commands';
import { createRunnerClient } from '../remoteRun/runnerClient';
import { probeRunners } from '../remoteRun/runners';
import type { RunnersConfig } from '../remoteRun/runnersConfig';
import { getRunnerLinkPaths } from '../runners/hubPaths';
import { writePairedFile } from '../runners/hubRegistry';
import { writeLinkState } from '../runners/linkControl';
import { probeRunnersOverview, readRunnersOverview } from '../runners/runnersOverview';
import { createPairedRunnerFixture } from './remoteRunPairedKit';
import { createHubFixture, type HubFixture } from './runnersTestKit';

const probeText = 'os=Linux\nos_name=Ubuntu\npueue=4.0.4\ncap_android=no\ncap_ios=no\ncap_docker=no\ncap_playwright=no\n';
const runnerConfig: RunnersConfig = { runners: [{ name: 'box1', ssh: 'user@box1.example', workDir: '/w' }] };

let root = '';
let previousPath: string | undefined;
const servers: net.Server[] = [];

/** `ssh` that records the last argument (the remote command), succeeds for everything, and answers a probe with a healthy report. */
function installFakeSsh(): void {
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(root, 'probe.txt'), probeText);
  const script = `#!/bin/bash
last="\${@: -1}"
echo "$last" >> "${path.join(root, 'ssh-calls.log')}"
case "$last" in *" probe "*) cat "${path.join(root, 'probe.txt')}" ;; esac
exit 0
`;
  fs.writeFileSync(path.join(binDir, 'ssh'), script, { mode: 0o755 });
  previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
}

/** The `probe` calls the fake ssh saw, as the words after the script's name (`probe /w` or `probe /w prune`). */
function readProbeCalls(): string[] {
  const log = path.join(root, 'ssh-calls.log');
  const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n') : [];
  return lines.filter((line) => / probe /.test(` ${line} `)).map((line) => line.slice(line.indexOf(' probe ') + 1).trim());
}

function createContext(): CommandContext {
  const stdout: string[] = [];
  return {
    io: { stdout: (text) => { stdout.push(text); }, stderr: () => undefined, cwd: root, env: {}, homeDir: root },
    config: runnerConfig,
    cacheDir: path.join(root, 'cache'),
    script: { name: 'runner-test.sh', text: '' },
    leaseMs: 3000,
    now: () => Date.now(),
    loadRunners: () => runnerConfig,
    runnerPollMs: 10_000,
    probeDeadlineMs: 20_000,
    sleep: async () => undefined,
    watchInterrupts: () => () => undefined,
  };
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'probe-purpose-')));
  fs.mkdirSync(path.join(root, 'cache'));
  installFakeSsh();
});
afterEach(async () => {
  if (previousPath !== undefined) process.env.PATH = previousPath;
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); })));
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the probe asks for the background prune only when a view of the runners wants it', () => {
  it('a plain probe (the default) does not, and `isPruneAllowed` does', async () => {
    const client = createRunnerClient(runnerConfig.runners[0], path.join(root, 'cache'), { name: 'runner-test.sh', text: '' });
    await probeRunners([client]);
    await probeRunners([client], Date.now(), undefined, undefined, { isPruneAllowed: true });
    assert.deepEqual(readProbeCalls(), ['probe /w', 'probe /w prune']);
  });

  it('the probe that picks a runner for a run or an exec (`chooseClient`) never does', async () => {
    const client = await chooseClient(createContext(), { runner: null, needs: null, waitSeconds: 0 });
    assert.equal(client.runner.name, 'box1');
    assert.deepEqual(readProbeCalls(), ['probe /w']);
  });

  it('`remote-run runners` does: it is a view', async () => {
    assert.equal(await runRunnersCommand(createContext()), 0);
    assert.deepEqual(readProbeCalls(), ['probe /w prune']);
  });

  describe('the bot\'s /runners screen', () => {
    let hub: HubFixture;
    beforeEach(() => {
      hub = createHubFixture();
    });
    afterEach(() => {
      hub.cleanup();
    });

    it('does: it is a view too', async () => {
      const runner = createPairedRunnerFixture({ name: 'mac', serviceKind: 'foreground' });
      writePairedFile(hub.ctx.dir, { rev: 1, runners: [runner] });
      const paths = getRunnerLinkPaths(hub.ctx.dir, runner.id);
      fs.mkdirSync(path.dirname(paths.socket), { recursive: true });
      const server = net.createServer((connection) => connection.destroy());
      servers.push(server);
      await new Promise<void>((resolve) => { server.listen(paths.socket, resolve); });
      const nowMs = Date.now();
      writeLinkState(hub.ctx.dir, runner.id, { pid: process.pid, sinceMs: nowMs - 1000, lastBeatMs: nowMs, endedAtMs: null });
      const overview = await readRunnersOverview(hub.ctx, path.join(root, 'cache'), nowMs);
      await probeRunnersOverview(hub.ctx, overview, path.join(root, 'cache'), nowMs);
      assert.equal(readProbeCalls().length, 1, 'the one online machine was probed');
      assert.match(readProbeCalls()[0], / prune$/);
    });
  });
});
