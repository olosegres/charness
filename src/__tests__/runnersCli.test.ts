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
import path from 'path';
import { parseProbeOutput } from '../remoteRun/probe';
import { extractManagedBlock } from '../runners/authorizedKeys';
import { getHubFilePaths } from '../runners/hubPaths';
import { cancelPairing, redeemPairing } from '../runners/hubPairing';
import { pairingLifetimeMs } from '../runners/pairingTiming';
import { readPairedFile, readPendingFile, type PairedRunner } from '../runners/hubRegistry';
import { getCurrentServiceKind } from '../runners/runnerServiceKind';
import { adminLineTrustSentence, runRunnersCli, type RunnersCliDeps } from '../runners/runnersCli';
import { formatRunnerList, formatRunnerListLine } from '../runners/runnersList';
import { refreshStaleSnapshots } from '../runners/runnersOverview';
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
    cacheDir: path.join(fixture.root, 'cache'),
    refreshStale: refreshStaleSnapshots,
    scanHostKey: async () => hubHostKey,
    now: () => nowMs,
    sleep: async () => undefined,
    sshUser: 'hubuser',
    ...overrides,
  };
}

async function runCli(argv: string[], deps: RunnersCliDeps = createDeps(), env: NodeJS.ProcessEnv = {}): Promise<CliRun> {
  let stdout = '';
  let stderr = '';
  const code = await runRunnersCli(argv, { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; }, cwd: fixture.root, env, homeDir: fixture.root }, deps);
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

  it('pair prints ONE line — the one that works with sudo for an admin account and without it for the runner account itself — with the words that say which word to change, writes the gate, and registers a code that is good for 10 minutes', async () => {
    const run = await runCli(['pair', '--host', 'host.example:2222', '--label', '@ExampleBot']);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /valid 10 minutes, single use/);
    const textLines = run.stdout.split('\n');
    const lines = textLines.filter((line) => line.includes("sh -c '"));
    assert.equal(lines.length, 1, 'one line, not two');
    const [line] = lines;
    assert.ok(line.startsWith("sudo sh -c '") && line.endsWith(' runner'), 'the account is the last word, «runner» by default');
    // The CLI is the other place the line is offered (the one agents use): it says what the line does to the machine, as the Telegram message does.
    assert.equal(adminLineTrustSentence, 'It runs code from this charness host as root on that machine');
    assert.match(textLines[textLines.indexOf(line) - 2], /^From an admin account of the runner machine; it pairs "runner" and keeps it running\. It runs code from this charness host as root on that machine:$/);
    // …and, below it, which word to change and how to pair without admin rights.
    const below = textLines.slice(textLines.indexOf(line) + 1).join('\n');
    assert.match(below, /The last word, "runner", is the account the runner and the agents' code run as: change it if the account is named otherwise\. It must be an existing standard \(non-admin\) account, not your main one\./);
    assert.match(below, /Without admin rights: run the same line in the terminal of that account itself, without the leading "sudo"/);
    assert.match(below, /Anyone with the line can attach a machine to this charness until it is used or expires\./);
    const pending = readPendingFile(fixture.ctx.dir).pending;
    assert.equal(pending.length, 1);
    assert.deepEqual({ host: pending[0].host, port: pending[0].port, label: pending[0].label, expiresAtMs: pending[0].expiresAtMs }, { host: 'host.example', port: 2222, label: '@ExampleBot', expiresAtMs: startMs + pairingLifetimeMs });
    assert.ok(line.includes('u="hubuser"') && line.includes('h="host.example"') && line.includes('p="2222"'), 'the runner logs in as the hub\'s account, at the address given');
    assert.match(fs.readFileSync(getHubFilePaths(fixture.ctx.dir).gate, 'utf8'), /runner-gate "\$@"/);
    assert.equal(extractManagedBlock(fs.readFileSync(fixture.ctx.authorizedKeysPath, 'utf8')).length, 1);
  });

  it('pair --account puts the named account at the end of the admin line, and refuses a name that is not a plain account name', async () => {
    const run = await runCli(['pair', '--host', 'host.example', '--account', 'ci.runner-2']);
    assert.equal(run.code, 0, run.stderr);
    assert.ok(run.stdout.split('\n').some((line) => line.startsWith("sudo sh -c '") && line.endsWith(" ci.runner-2")));
    assert.match(run.stdout, /it pairs "ci\.runner-2"/);
    assert.match(run.stdout, /The last word, "ci\.runner-2", is the account/);
    const before = readPendingFile(fixture.ctx.dir).pending.length;
    for (const bad of ['-n', 'a b', 'x;y', '$(id)', '']) {
      const refused = await runCli(['pair', '--host', 'host.example', '--account', bad]);
      assert.equal(refused.code, 2, bad);
      assert.match(refused.stderr, /--account must be a plain account name/);
    }
    assert.equal((await runCli(['pair', '--host', 'host.example', '--account'])).code, 2);
    assert.equal(readPendingFile(fixture.ctx.dir).pending.length, before, 'a refused name makes no code');
  });

  it('pair honours the test seam that shortens a code (a flow cannot wait ten minutes)', async () => {
    const run = await runCli(['pair', '--host', 'host.example'], createDeps(), { CHARNESS_TEST_TIMINGS: JSON.stringify({ pairingLifetimeMs: 5000 }) });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /valid 5 seconds, single use/);
    assert.equal(readPendingFile(fixture.ctx.dir).pending[0].expiresAtMs, startMs + 5000);
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

  it('pair --wait ends with exit 0 when the line was pasted for a machine that was already paired (its code is closed, not used): nothing new was paired, and it is no failure', async () => {
    let sleeps = 0;
    const deps = createDeps({
      sleep: async () => {
        sleeps += 1;
        const pairing = readPendingFile(fixture.ctx.dir).pending[0];
        if (sleeps === 2) assert.equal(await cancelPairing(fixture.ctx, pairing.pairId, nowMs), true);
      },
    });
    const run = await runCli(['pair', '--host', 'host.example', '--wait'], deps);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stderr, '');
    assert.match(run.stdout, /The pairing line was used on a machine that was already paired: nothing new was paired\.\n$/);
    assert.equal(readPairedFile(fixture.ctx.dir).runners.length, 0);
    assert.equal(readPendingFile(fixture.ctx.dir).pending.length, 0);
  });

  it('pair --wait with a closed.json that cannot be used says so ONCE on stderr and ends like an expiry (exit 1): the code is gone and nothing says it was closed', async () => {
    let sleeps = 0;
    const deps = createDeps({
      sleep: async () => {
        sleeps += 1;
        const pairing = readPendingFile(fixture.ctx.dir).pending[0];
        if (sleeps === 2) {
          assert.equal(await cancelPairing(fixture.ctx, pairing.pairId, nowMs), true);
          fs.writeFileSync(getHubFilePaths(fixture.ctx.dir).closed, '{ not json');
        }
      },
    });
    const run = await runCli(['pair', '--host', 'host.example', '--wait'], deps);
    assert.equal(run.code, 1);
    assert.equal(run.stderr.split('closed.json is not valid JSON').length, 2, run.stderr);
    assert.match(run.stderr, /expired unused/);
    assert.doesNotMatch(run.stdout, /already paired/);
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

  it('ls says how a runner is kept running as the machine last reported it, not as the registry recorded it at pairing — and, for a machine that is not online, makes no ssh call', async () => {
    const name = await pairMachine('Mac Mini');
    const deps = createDeps();
    assert.match((await runCli(['ls'], deps)).stdout, / · run by hand · /, 'never probed: the registry\'s pairing-time word is all there is');
    fs.mkdirSync(deps.cacheDir, { recursive: true });
    fs.writeFileSync(path.join(deps.cacheDir, `${name}.probe.json`), JSON.stringify({ seenAtMs: nowMs, text: 'os_name=macOS\nservice=user-service' }));
    const run = await runCli(['ls'], deps);
    assert.match(run.stdout, /^mac-mini — offline since [\d-]+ [\d:]+ · macOS 15\.1 \(arm64\) · user service · charness 3\.7\.0 · paired /m, 'the snapshot speaks; the link, which is down, still decides online or not');
    assert.doesNotMatch(run.stdout, /run by hand/);
  });

  it('ls asks the machines whose report is stale (the list says which) before it prints, and shows what they answer — the link still decides «online»', async () => {
    await pairMachine('Mac Mini');
    const asked: string[] = [];
    const refreshStale: RunnersCliDeps['refreshStale'] = async (_ctx, overview) => {
      asked.push(...overview.entries.map((entry) => entry.runner.name));
      return { ...overview, entries: overview.entries.map((entry) => ({ ...entry, isOnline: true, probe: parseProbeOutput('os_name=macOS\nservice=system-service') })) };
    };
    const run = await runCli(['ls'], createDeps({ refreshStale }));
    assert.deepEqual(asked, ['mac-mini'], 'asked once, by the very overview ls read');
    assert.match(run.stdout, /^mac-mini — online · macOS 15\.1 \(arm64\) · system service · charness 3\.7\.0 · paired /m);
    assert.doesNotMatch(run.stdout, /run by hand/);
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

  describe('an always-on service', () => {
    const systemWorkDir = '/Users/runner/.charness-runner/work';
    const daemonCommands = [
      /sudo launchctl bootout system\/com\.charness\.runner\.[0-9a-f]{8}\n/,
      /sudo launchctl bootout system\/com\.charness\.runner\.pueued\.[0-9a-f]{8}\n/,
      /sudo rm \/Library\/LaunchDaemons\/com\.charness\.runner\.[0-9a-f]{8}\.plist \/Library\/LaunchDaemons\/com\.charness\.runner\.pueued\.[0-9a-f]{8}\.plist\n/,
    ];

    async function pairWith(overrides: Parameters<typeof createRedeemFixture>[0]): Promise<string> {
      await runCli(['pair', '--host', 'host.example']);
      const pairing = readPendingFile(fixture.ctx.dir).pending.at(-1);
      if (pairing === undefined) throw new Error('no pairing');
      const reply = await redeemPairing(fixture.ctx, pairing.pairId, createRedeemFixture({ suggestedName: 'Mac Mini', workDir: systemWorkDir, ...overrides }).request, nowMs);
      if (!reply.ok) throw new Error(reply.reason);
      return reply.name;
    }

    it('`remove` of a machine that runs as an always-on service says it keeps running there until an admin removes it, with the commands — made by this hub', async () => {
      const name = await pairWith({ serviceKind: 'system-service' });
      const removed = await runCli(['remove', name]);
      assert.equal(removed.code, 0);
      assert.match(removed.stdout, /^Runner "mac-mini" removed: its key is deleted and its link cut; /);
      assert.match(removed.stdout, /\n"mac-mini" runs as an always-on service on that machine \(two LaunchDaemons\), which only an admin there can stop — nothing of charness runs as root\. As an admin on that machine, run:\n/);
      for (const command of daemonCommands) assert.match(removed.stdout, command);
      assert.match(removed.stdout, /These commands come from this charness host, not from the machine itself\.\n$/);
    });

    it('`remove` goes by what the machine last REPORTED: «run by hand» in the registry, an always-on service in its last report', async () => {
      const name = await pairWith({ serviceKind: 'foreground' });
      const deps = createDeps();
      fs.mkdirSync(deps.cacheDir, { recursive: true });
      fs.writeFileSync(path.join(deps.cacheDir, `${name}.probe.json`), JSON.stringify({ seenAtMs: nowMs, text: 'os_name=macOS\nservice=system-service' }));
      const removed = await runCli(['remove', name], deps);
      assert.match(removed.stdout, /runs as an always-on service on that machine/);
    });

    it('`remove` of any other machine says nothing about a service', async () => {
      for (const serviceKind of ['foreground', 'user-service'] as const) {
        const name = await pairWith({ serviceKind, suggestedName: serviceKind });
        const removed = await runCli(['remove', name]);
        assert.equal(removed.code, 0);
        assert.doesNotMatch(removed.stdout, /always-on|launchctl/, serviceKind);
      }
    });

    it('`service-removal <name>` prints the commands without removing anything', async () => {
      const name = await pairWith({ serviceKind: 'system-service' });
      const shown = await runCli(['service-removal', name]);
      assert.equal(shown.code, 0);
      for (const command of daemonCommands) assert.match(shown.stdout, command);
      assert.equal(readPairedFile(fixture.ctx.dir).runners.length, 1, 'the runner is still paired');
    });

    it('`service-removal` of a machine that is not an always-on service says there is nothing to remove; of an unknown runner it fails; of one whose folder the hub cannot place it says how to look on the machine', async () => {
      const byHand = await pairWith({ serviceKind: 'foreground', suggestedName: 'by hand' });
      const none = await runCli(['service-removal', byHand]);
      assert.equal(none.code, 0);
      assert.match(none.stdout, /^Runner "by-hand" does not run as an always-on service \(run by hand\): there is nothing for an admin to remove\.\n$/);
      const unknown = await runCli(['service-removal', 'nobody']);
      assert.equal(unknown.code, 1);
      assert.match(unknown.stderr, /no runner named "nobody"/);
      const odd = await pairWith({ serviceKind: 'system-service', suggestedName: 'odd', workDir: '/srv/runner-work' });
      const unplaced = await runCli(['service-removal', odd]);
      assert.equal(unplaced.code, 0);
      assert.match(unplaced.stdout, /cannot say which daemons are its/);
      assert.equal((await runCli(['service-removal'])).code, 2);
      assert.match((await runCli(['help'])).stdout, /charness runners service-removal <name> {5}the admin's commands that remove a runner's always-on service/);
    });
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
    label: '@ExampleBot',
    host: 'host.example',
    port: 22,
    isPaused: true,
  };

  it('says online, or since when it is offline, and what is paused', () => {
    assert.match(formatRunnerListLine({ runner, isOnline: true, lastSeenMs: startMs, probe: null }), /^box1 — online · paused · Ubuntu 24\.04 \(x86_64\) · system service · charness 3\.7\.0 · paired \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.match(formatRunnerListLine({ runner: { ...runner, isPaused: false }, isOnline: false, lastSeenMs: startMs, probe: null }), /^box1 — offline since \d{4}-\d{2}-\d{2} \d{2}:\d{2} · Ubuntu/);
    assert.match(formatRunnerListLine({ runner: { ...runner, isPaused: false }, isOnline: false, lastSeenMs: null, probe: null }), /^box1 — offline, never connected · Ubuntu/);
  });

  it('says «lid closed» instead of «online» for a linked machine whose Mac has its lid shut — and never for an offline one', () => {
    assert.match(formatRunnerListLine({ runner, isOnline: true, lastSeenMs: startMs, probe: null, isLidClosed: true }), /^box1 — lid closed \(takes no new jobs until its lid is opened \(a job already running there goes on\)\) · paused · Ubuntu/);
    assert.match(formatRunnerListLine({ runner: { ...runner, isPaused: false }, isOnline: false, lastSeenMs: startMs, probe: null, isLidClosed: true }), /^box1 — offline since /);
  });

  it('a row carries the note of a link that came from another address, or whose links fight — and nothing when the link is as it was', () => {
    const base = { runner: { ...runner, isPaused: false }, isOnline: true, lastSeenMs: startMs, probe: null };
    const changed = formatRunnerListLine({ ...base, linkConcern: { kind: 'sourceChanged', fromSource: '198.51.100.7', toSource: '203.0.113.9', atMs: startMs, isLiveReplacement: false } });
    assert.match(changed, / \(its link now comes from 203\.0\.113\.9, before from 198\.51\.100\.7, \d{4}-\d{2}-\d{2} \d{2}:\d{2}\)$/);
    const fight = formatRunnerListLine({ ...base, linkConcern: { kind: 'fighting', sources: ['198.51.100.7', '203.0.113.9'], changeCount: 3, atMs: startMs } });
    assert.match(fight, / \(links from 198\.51\.100\.7, 203\.0\.113\.9 keep replacing each other: 3 switches in 10 minutes — two machines may be using this runner's key;/);
    assert.ok(!formatRunnerListLine({ ...base, linkConcern: null }).includes('link'), 'nothing to say');
    assert.ok(!formatRunnerListLine(base).includes('(its link'), 'nothing to say');
    const both = formatRunnerListLine({ ...base, isReportDoubtful: true, linkConcern: { kind: 'fighting', sources: ['a', 'b'], changeCount: 3, atMs: startMs } });
    assert.ok(both.indexOf('(no report yet; it did not answer)') > 0 && both.indexOf('(links from') > both.indexOf('(no report yet'), 'both notes, the report\'s first');
  });

  it('how it is kept running: the latest probe first (live, or the last snapshot of a machine that is off), the registry only where the probe has none', () => {
    const registryByHand = { ...runner, serviceKind: 'foreground' } as const;
    assert.equal(getCurrentServiceKind(registryByHand, parseProbeOutput('service=user-service')), 'user-service');
    assert.equal(getCurrentServiceKind(registryByHand, parseProbeOutput('service=system-service')), 'system-service');
    assert.equal(getCurrentServiceKind(registryByHand, parseProbeOutput('os_name=Ubuntu')), 'foreground', 'a probe with no word on it leaves the registry\'s');
    assert.equal(getCurrentServiceKind(registryByHand, null), 'foreground', 'never probed');
    const line = (probeText: string | null, isOnline: boolean): string =>
      formatRunnerListLine({ runner: registryByHand, isOnline, lastSeenMs: startMs, probe: probeText === null ? null : parseProbeOutput(probeText) });
    assert.match(line('service=user-service', true), / · user service · /);
    assert.match(line('service=system-service', false), / · system service · /, 'the last snapshot of an offline machine speaks too');
    assert.match(line(null, true), / · run by hand · /);
  });

  it('lists only the codes that are still open', () => {
    const open = { pairId: 'a', publicKey: runner.publicKey, keyFingerprint: 'x', expiresAtMs: startMs + 1000, host: 'host.example', port: 22, label: 'l', messageRef: null };
    const text = formatRunnerList([], [open, { ...open, expiresAtMs: startMs - 1 }], startMs);
    assert.equal(text.match(/Pairing code open/g)?.length, 1);
  });
});
