/**
 * @description `runners/serviceRemoval.ts`: the commands that remove a runner's always-on service (the two LaunchDaemons the admin line installs on a
 * Mac) come from the HUB, built from the labels it can derive — never from the runner account's own program, whose output the agents (who run as that
 * account) can change into anything an admin would then run with `sudo`. Held here: which commands, for which runners, and that nothing the machine
 * chose reaches them.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseProbeOutput } from '../remoteRun/probe';
import type { PairedRunner } from '../runners/hubRegistry';
import { createPairing, redeemPairing } from '../runners/hubPairing';
import { generateEd25519KeyPair } from '../runners/sshKeys';
import { formatServiceRemovalNote, formatServiceRemovalUnknownNote, getServiceRemovalLines, getSystemServiceRemovalCommands, launchDaemonsDir, readServiceRemovalForRunner } from '../runners/serviceRemoval';
import { createHubFixture, createRedeemFixture, type HubFixture } from './runnersTestKit';
import { getRunnerHomePaths } from '../runnerUtility/runnerHome';
import { getServiceNames } from '../runnerUtility/serviceUnits';

function createRunner(overrides: Partial<PairedRunner> = {}): PairedRunner {
  return {
    id: 'a1b2c3d4e5f6',
    name: 'mac',
    publicKey: 'ssh-ed25519 AAAA',
    keyFingerprint: 'SHA256:x',
    hostKey: 'ssh-ed25519 BBBB',
    workDir: getRunnerHomePaths('/Users/runner').workDir,
    os: 'macOS 15.1',
    arch: 'arm64',
    version: '3.8.0',
    serviceKind: 'system-service',
    pairedAtMs: 1,
    pairId: 'aaaaaaaaaaaa',
    label: '@ExampleBot',
    host: 'host.example',
    port: 22,
    isPaused: false,
    ...overrides,
  };
}

describe('the commands that remove an always-on service', () => {
  it('stop the two daemons of THIS runner — the link and its queue — and delete their definitions, in plain launchctl and rm', () => {
    const names = getServiceNames(getRunnerHomePaths('/Users/runner').root);
    assert.deepEqual(getSystemServiceRemovalCommands(createRunner()), [
      `sudo launchctl bootout system/${names.launchdLink}`,
      `sudo launchctl bootout system/${names.launchdPueued}`,
      `sudo rm ${launchDaemonsDir}/${names.launchdLink}.plist ${launchDaemonsDir}/${names.launchdPueued}.plist`,
    ]);
    assert.equal(launchDaemonsDir, '/Library/LaunchDaemons');
  });

  it('are different for another account on the same machine (the labels carry a hash of the state folder), and the same for the same one', () => {
    const first = getSystemServiceRemovalCommands(createRunner({ workDir: getRunnerHomePaths('/Users/runner').workDir }));
    const second = getSystemServiceRemovalCommands(createRunner({ workDir: getRunnerHomePaths('/Users/other').workDir }));
    assert.notDeepEqual(first, second);
    assert.deepEqual(first, getSystemServiceRemovalCommands(createRunner({ workDir: getRunnerHomePaths('/Users/runner').workDir })));
  });

  it('contain nothing the machine chose: not its name, not the text of its folder — a hash in hex and fixed paths, whatever the runner reported', () => {
    const hostile = createRunner({ name: 'x; rm -rf /', workDir: getRunnerHomePaths('/Users/a b;$(touch pwned)`id`').workDir });
    const commands = getSystemServiceRemovalCommands(hostile) ?? [];
    assert.equal(commands.length, 3);
    for (const command of commands) {
      assert.match(command, /^sudo (launchctl bootout system\/com\.charness\.runner(\.pueued)?\.[0-9a-f]{8}|rm \/Library\/LaunchDaemons\/com\.charness\.runner\.[0-9a-f]{8}\.plist \/Library\/LaunchDaemons\/com\.charness\.runner\.pueued\.[0-9a-f]{8}\.plist)$/, command);
    }
  });

  it('are not made for a runner whose reported work folder is not a state folder\'s own — the hub cannot say which daemons are its', () => {
    for (const workDir of ['/Users/runner/work', '/Users/runner/.charness-runner', '/tmp/elsewhere/.charness-runner/other', '']) {
      assert.equal(getSystemServiceRemovalCommands(createRunner({ workDir })), null, workDir);
    }
  });
});

describe('who gets told', () => {
  const systemProbe = parseProbeOutput('os_name=macOS\nservice=system-service');
  const userProbe = parseProbeOutput('os_name=macOS\nservice=user-service');

  it('a machine that runs as an always-on service now — by its last report, else by the registry\'s word', () => {
    assert.equal(getServiceRemovalLines(createRunner({ serviceKind: 'foreground' }), systemProbe).length, 3, 'the report is newer than the day it was paired');
    assert.equal(getServiceRemovalLines(createRunner({ serviceKind: 'system-service' }), null).length, 3, 'never probed: the registry\'s word');
  });

  it('nobody else: a machine run by hand or kept by a user service has no admin\'s commands to wait for — and a report that says so wins over the registry', () => {
    assert.deepEqual(getServiceRemovalLines(createRunner({ serviceKind: 'foreground' }), null), []);
    assert.deepEqual(getServiceRemovalLines(createRunner({ serviceKind: 'user-service' }), null), []);
    assert.deepEqual(getServiceRemovalLines(createRunner({ serviceKind: 'system-service' }), userProbe), []);
  });

  it('a machine the hub cannot name the daemons of gets none — its note says how to find them on the machine', () => {
    assert.deepEqual(getServiceRemovalLines(createRunner({ workDir: '/tmp/x' }), null), []);
    const text = formatServiceRemovalUnknownNote('mac');
    assert.match(text, /cannot say which daemons are its/);
    assert.match(text, /ls \/Library\/LaunchDaemons \| grep com\.charness\.runner/);
  });
});

describe('the note the CLI prints', () => {
  it('says what runs, who may stop it, the commands one per line, and that they come from the hub', () => {
    assert.equal(
      formatServiceRemovalNote('mac', ['sudo launchctl bootout system/a', 'sudo rm /Library/LaunchDaemons/a.plist']),
      [
        '"mac" runs as an always-on service on that machine (two LaunchDaemons), which only an admin there can stop — nothing of charness runs as root. As an admin on that machine, run:',
        '  sudo launchctl bootout system/a',
        '  sudo rm /Library/LaunchDaemons/a.plist',
        'These commands come from this charness host, not from the machine itself.',
        '',
      ].join('\n'),
    );
  });
});

describe('the one reading behind every place that tells how to remove a service', () => {
  let fixture: HubFixture;
  let cacheDir: string;
  beforeEach(() => {
    fixture = createHubFixture();
    cacheDir = path.join(fixture.root, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
  });
  afterEach(() => {
    fixture.cleanup();
  });

  async function pairMachine(overrides: Parameters<typeof createRedeemFixture>[0]): Promise<string> {
    const hostKey = generateEd25519KeyPair('hub-host').publicKey;
    const pairing = await createPairing(fixture.ctx, { host: 'host.example', port: 22, hostKey, label: 'x', nowMs: 1000, sshUser: 'hubuser' });
    const reply = await redeemPairing(fixture.ctx, pairing.pairId, createRedeemFixture({ workDir: getRunnerHomePaths('/Users/runner').workDir, ...overrides }).request, 1000);
    if (!reply.ok) throw new Error(reply.reason);
    return reply.name;
  }

  it('finds a runner by name or id and says how it is kept running and what the admin runs — by the registry\'s word, or by its last report when it has one', async () => {
    const name = await pairMachine({ suggestedName: 'Mac', serviceKind: 'system-service' });
    const found = readServiceRemovalForRunner(fixture.ctx, cacheDir, name);
    assert.equal(found?.runner.name, name);
    assert.equal(found?.kind, 'system-service');
    assert.equal(found?.commands.length, 3);
    assert.equal(readServiceRemovalForRunner(fixture.ctx, cacheDir, found?.runner.id ?? '')?.runner.name, name, 'by id too');
    fs.writeFileSync(path.join(cacheDir, `${name}.probe.json`), JSON.stringify({ seenAtMs: 2000, text: 'os_name=macOS\nservice=user-service' }));
    const reported = readServiceRemovalForRunner(fixture.ctx, cacheDir, name);
    assert.deepEqual([reported?.kind, reported?.commands], ['user-service', []], 'the report is newer than the registry\'s word');
  });

  it('is nothing for a runner that is not paired — and needs nothing but the registry\'s list and the last report: a damaged pairing list or a missing cache folder is no obstacle', async () => {
    const name = await pairMachine({ suggestedName: 'Mac', serviceKind: 'system-service' });
    assert.equal(readServiceRemovalForRunner(fixture.ctx, cacheDir, 'nobody'), null);
    fs.writeFileSync(path.join(fixture.ctx.dir, 'pending.json'), '{ not json');
    assert.equal(readServiceRemovalForRunner(fixture.ctx, path.join(fixture.root, 'no-such-cache'), name)?.commands.length, 3);
  });
});
