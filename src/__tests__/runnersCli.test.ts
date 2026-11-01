/**
 * @description `runners/runnersCli.ts` + `runnersList.ts`: `charness runners` — the headless twin of `/runners`. Pairing prints the
 * one line and registers the code; `--wait` follows it to «paired» or «expired»; `ls` shows the runners and the codes still open;
 * `remove`, `pause` and `resume` act on the registry; bad input is a usage error, not a stack trace.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { extractManagedBlock } from '../runners/authorizedKeys';
import { getHubFilePaths } from '../runners/hubPaths';
import { pairingLifetimeMs, redeemPairing } from '../runners/hubPairing';
import { readPairedFile, readPendingFile, type PairedRunner } from '../runners/hubRegistry';
import { runRunnersCli, type RunnersCliDeps } from '../runners/runnersCli';
import { formatRunnerList, formatRunnerListLine } from '../runners/runnersList';
import { generateEd25519KeyPair } from '../runners/sshKeys';
import { createHubFixture, createRedeemFixture, type HubFixture } from './runnersTestKit';

const startMs = Date.UTC(2026, 10, 1, 12, 0, 0);
const hubHostKey = generateEd25519KeyPair('hub-host').publicKey;

let fixture: HubFixture;
let nowMs = startMs;

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

function createDeps(overrides: Partial<RunnersCliDeps> = {}): RunnersCliDeps {
  return {
    ctx: fixture.ctx,
    scanHostKey: async () => hubHostKey,
    now: () => nowMs,
    sleep: async () => undefined,
    sshUser: 'hubuser',
    ...overrides,
  };
}

async function runCli(argv: string[], deps: RunnersCliDeps = createDeps()): Promise<CliRun> {
  let stdout = '';
  let stderr = '';
  const code = await runRunnersCli(argv, { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; }, cwd: fixture.root, env: {}, homeDir: fixture.root }, deps);
  return { code, stdout, stderr };
}

async function pairMachine(suggestedName: string): Promise<string> {
  await runCli(['pair', '--host', 'host.example']);
  const pairing = readPendingFile(fixture.ctx.dir).pending.at(-1);
  if (pairing === undefined) throw new Error('no pairing');
  const reply = await redeemPairing(fixture.ctx, pairing.pairId, createRedeemFixture({ suggestedName }).request, nowMs);
  if (!reply.ok) throw new Error(reply.reason);
  return reply.name;
}

describe('charness runners', () => {
  beforeEach(() => {
    fixture = createHubFixture();
    nowMs = startMs;
  });
  afterEach(() => {
    fixture.cleanup();
  });

  it('lists nothing yet and says how to pair', async () => {
    const run = await runCli([]);
    assert.equal(run.code, 0);
    assert.match(run.stdout, /No runners paired yet/);
  });

  it('pair prints the one line, writes the gate, and registers a code that is good for 10 minutes', async () => {
    const run = await runCli(['pair', '--host', 'host.example:2222', '--label', '@ExampleBot']);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /valid 10 minutes, single use/);
    const lines = run.stdout.split('\n').filter((line) => line.startsWith("sh -c '"));
    assert.equal(lines.length, 1);
    const pending = readPendingFile(fixture.ctx.dir).pending;
    assert.equal(pending.length, 1);
    assert.deepEqual({ host: pending[0].host, port: pending[0].port, label: pending[0].label, expiresAtMs: pending[0].expiresAtMs }, { host: 'host.example', port: 2222, label: '@ExampleBot', expiresAtMs: startMs + pairingLifetimeMs });
    assert.ok(lines[0].includes('u="hubuser"'), 'the runner logs in as the hub\'s account');
    assert.ok(lines[0].includes('h="host.example"') && lines[0].includes('p="2222"'));
    assert.match(fs.readFileSync(getHubFilePaths(fixture.ctx.dir).gate, 'utf8'), /runner-gate "\$@"/);
    assert.equal(extractManagedBlock(fs.readFileSync(fixture.ctx.authorizedKeysPath, 'utf8')).length, 1);
  });

  it('pair needs an address, and says so as a usage error', async () => {
    const missing = await runCli(['pair']);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /--host/);
    assert.equal((await runCli(['pair', '--host'])).code, 2);
    assert.equal((await runCli(['pair', '--host', 'two words'])).code, 2);
    assert.equal((await runCli(['pair', '--host', 'host.example', '--bogus'])).code, 2);
    assert.equal(readPendingFile(fixture.ctx.dir).pending.length, 0);
  });

  it('pair refuses an address that does not answer with this machine\'s ssh key, and makes no code', async () => {
    const run = await runCli(['pair', '--host', 'host.example'], createDeps({ scanHostKey: async () => null }));
    assert.equal(run.code, 1);
    assert.match(run.stderr, /nothing answers/);
    assert.equal(readPendingFile(fixture.ctx.dir).pending.length, 0);
    assert.equal(fs.existsSync(fixture.ctx.authorizedKeysPath), false);
  });

  it('pair --wait ends with «paired» when the line is used', async () => {
    let sleeps = 0;
    const deps = createDeps({
      sleep: async () => {
        sleeps += 1;
        const pairing = readPendingFile(fixture.ctx.dir).pending[0];
        if (sleeps === 2) await redeemPairing(fixture.ctx, pairing.pairId, createRedeemFixture({ suggestedName: 'Mac' }).request, nowMs);
      },
    });
    const run = await runCli(['pair', '--host', 'host.example', '--wait'], deps);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /Runner "mac" paired/);
  });

  it('pair --wait ends with «expired» when the line is not used in time, and the code is gone', async () => {
    const deps = createDeps({ sleep: async () => { nowMs += pairingLifetimeMs; } });
    const run = await runCli(['pair', '--host', 'host.example', '--wait'], deps);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /expired unused/);
    assert.equal(readPendingFile(fixture.ctx.dir).pending.length, 0);
    assert.deepEqual(extractManagedBlock(fs.readFileSync(fixture.ctx.authorizedKeysPath, 'utf8')), []);
  });

  it('ls shows a paired runner as offline until its link is up, and a code that is still open', async () => {
    await pairMachine('Mac Mini');
    await runCli(['pair', '--host', 'host.example']);
    const run = await runCli(['ls']);
    assert.equal(run.code, 0);
    assert.match(run.stdout, /^mac-mini — offline, never connected · macOS 15\.1 \(arm64\) · run by hand · charness 3\.7\.0 · paired /m);
    assert.match(run.stdout, /Pairing code open until .* \(host\.example:22\)/);
  });

  it('ls forgets a code that has expired', async () => {
    await runCli(['pair', '--host', 'host.example']);
    nowMs += pairingLifetimeMs + 1;
    const run = await runCli(['ls']);
    assert.doesNotMatch(run.stdout, /Pairing code open/);
    assert.equal(readPendingFile(fixture.ctx.dir).pending.length, 0);
  });

  it('pause and resume change the runner and say so; remove detaches it', async () => {
    const name = await pairMachine('Mac');
    const paused = await runCli(['pause', name]);
    assert.equal(paused.code, 0);
    assert.match(paused.stdout, /paused/);
    assert.equal(readPairedFile(fixture.ctx.dir).runners[0].isPaused, true);
    assert.match((await runCli(['ls'])).stdout, /· paused ·/);
    assert.match((await runCli(['resume', name])).stdout, /resumed/);
    assert.equal(readPairedFile(fixture.ctx.dir).runners[0].isPaused, false);
    const removed = await runCli(['remove', name]);
    assert.equal(removed.code, 0);
    assert.equal(readPairedFile(fixture.ctx.dir).runners.length, 0);
    assert.deepEqual(extractManagedBlock(fs.readFileSync(fixture.ctx.authorizedKeysPath, 'utf8')), []);
  });

  it('remove, pause and resume of an unknown runner fail; a wrong number of names is a usage error', async () => {
    for (const command of ['remove', 'pause', 'resume']) {
      const unknown = await runCli([command, 'nobody']);
      assert.equal(unknown.code, 1, command);
      assert.match(unknown.stderr, /no runner named "nobody"/);
      assert.equal((await runCli([command])).code, 2, command);
      assert.equal((await runCli([command, 'a', 'b'])).code, 2, command);
    }
  });

  it('an unknown command is a usage error; help prints the usage', async () => {
    const unknown = await runCli(['frobnicate']);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /unknown command: frobnicate/);
    const help = await runCli(['help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /charness runners pair --host/);
  });

  it('a broken registry is reported by name, not as a crash', async () => {
    fs.mkdirSync(fixture.ctx.dir, { recursive: true });
    fs.writeFileSync(getHubFilePaths(fixture.ctx.dir).paired, '{broken');
    const run = await runCli(['ls']);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /paired\.json is not valid JSON/);
  });
});

describe('runner list text', () => {
  const runner: PairedRunner = {
    id: 'abcdef012345',
    name: 'box1',
    publicKey: generateEd25519KeyPair('k').publicKey,
    keyFingerprint: 'SHA256:x',
    hostKey: generateEd25519KeyPair('h').publicKey,
    workDir: '/w',
    os: 'Ubuntu 24.04',
    arch: 'x86_64',
    version: '3.7.0',
    serviceKind: 'system-service',
    pairedAtMs: startMs,
    pairId: '0123456789ab',
    isPaused: true,
  };

  it('says online, or since when it is offline, and what is paused', () => {
    assert.match(formatRunnerListLine({ runner, status: { isOnline: true, sinceMs: startMs, lastSeenMs: startMs } }), /^box1 — online · paused · Ubuntu 24\.04 \(x86_64\) · system service · charness 3\.7\.0 · paired \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.match(formatRunnerListLine({ runner: { ...runner, isPaused: false }, status: { isOnline: false, sinceMs: null, lastSeenMs: startMs } }), /^box1 — offline since \d{4}-\d{2}-\d{2} \d{2}:\d{2} · Ubuntu/);
  });

  it('lists only the codes that are still open', () => {
    const open = { pairId: 'a', publicKey: runner.publicKey, keyFingerprint: 'x', expiresAtMs: startMs + 1000, host: 'host.example', port: 22, label: 'l', messageRef: null };
    const text = formatRunnerList([], [open, { ...open, expiresAtMs: startMs - 1 }], startMs);
    assert.equal(text.match(/Pairing code open/g)?.length, 1);
  });
});
