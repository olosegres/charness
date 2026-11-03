/**
 * @description `runners/serviceRemoval.ts`: the commands that remove a runner's always-on service (the two LaunchDaemons the admin line installs on a
 * Mac) come from the HUB, built from the labels it can derive — never from the runner account's own program, whose output the agents (who run as that
 * account) can change into anything an admin would then run with `sudo`. Held here: which commands, for which runners, and that nothing the machine
 * chose reaches them.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseProbeOutput } from '../remoteRun/probe';
import type { PairedRunner } from '../runners/hubRegistry';
import { formatServiceRemovalNote, formatServiceRemovalUnknownNote, getServiceRemovalLines, getSystemServiceRemovalCommands, launchDaemonsDir } from '../runners/serviceRemoval';
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
