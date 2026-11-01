/**
 * @description Paired runners as remote-run sees them (`remoteRun/pairedRunners.ts`, `runnersCatalog.ts`): the registry entry becomes the
 * same `RunnerConfig` an entry of `runners.json` is — ssh through the link's `ProxyCommand` with the runner's host key pinned under its
 * alias, quoted so ssh AND rsync's `-e` read it back as the same words, Pueue found from the reported work dir — and the catalog merges
 * both sources (hand-made first, a name in both is an error, a broken file never hides the runners that last loaded).
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { buildPairedRunnerConfig, buildPairedSshOptions, getPairedRunnerPueue, loadPairedRunners, PairedRunnerSetupError, resetPairedRunnersCache } from '../remoteRun/pairedRunners';
import type { RunnerClient } from '../remoteRun/runnerClient';
import { probeRunner } from '../remoteRun/runners';
import { checkIsRemoteRunOffered, loadRunnersCatalog } from '../remoteRun/runnersCatalog';
import { getRunnersConfigPath, resetRunnersConfigCache } from '../remoteRun/runnersConfig';
import { buildRsyncSshCommand, buildSshArgs } from '../remoteRun/ssh';
import { createHubContext, getHubFilePaths, getRunnerLinkPaths } from '../runners/hubPaths';
import { writeLinkState } from '../runners/linkControl';
import { writePairedFile, type PairedRunner } from '../runners/hubRegistry';
import { getRunnerHomePaths } from '../runnerUtility/runnerHome';
import { generateEd25519KeyPair } from '../runners/sshKeys';

const runnerId = 'a1b2c3d4e5f6';
const reportedWorkDir = '/Users/runner/.charness-runner/work';

let homeDir = '';

function createPairedRunner(overrides: Partial<PairedRunner> = {}): PairedRunner {
  return {
    id: runnerId,
    name: 'mac',
    publicKey: generateEd25519KeyPair('client').publicKey,
    keyFingerprint: 'SHA256:x',
    hostKey: generateEd25519KeyPair('server').publicKey,
    workDir: reportedWorkDir,
    os: 'macOS 15.1',
    arch: 'arm64',
    version: '3.8.0',
    serviceKind: 'system-service',
    pairedAtMs: 1,
    pairId: '0123456789ab',
    label: '@ExampleBot',
    host: 'host.example',
    port: 22,
    isPaused: false,
    ...overrides,
  };
}

function writePaired(runners: PairedRunner[]): void {
  writePairedFile(createHubContext({ homeDir }).dir, { rev: 1, runners });
}

function writeRunnersJson(content: object | string): void {
  const filePath = getRunnersConfigPath(homeDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, typeof content === 'string' ? content : JSON.stringify(content));
}

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paired-runners-'));
  resetRunnersConfigCache();
  resetPairedRunnersCache();
});
afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe('the ssh options of a paired runner', () => {
  const input = { runnerId, nodePath: '/usr/bin/node', cliPath: '/opt/charness/dist/cli.js', hubDir: '/home/user/.config/charness/runners' };

  it('go through the link\'s proxy, check the runner\'s pinned host key under its alias, and use only the hub\'s key', () => {
    const options = buildPairedSshOptions(input);
    const text = options.join('\n');
    assert.deepEqual(options.slice(0, 2), ['-F', '/dev/null']);
    assert.ok(options.includes(`ProxyCommand=/usr/bin/node /opt/charness/dist/cli.js runner-proxy /home/user/.config/charness/runners/link/${runnerId}.sock`));
    assert.ok(options.includes(`HostKeyAlias=charness-runner-${runnerId}`));
    assert.ok(options.includes('UserKnownHostsFile=/home/user/.config/charness/runners/known_hosts'));
    assert.ok(options.includes('GlobalKnownHostsFile=/dev/null'));
    assert.ok(options.includes('StrictHostKeyChecking=yes'), 'the host key is pinned, never learned');
    assert.equal(options[options.indexOf('-i') + 1], '/home/user/.config/charness/runners/hub_ed25519');
    assert.ok(options.includes('IdentitiesOnly=yes') && options.includes('IdentityAgent=none'), 'no key of an agent or of the account is offered');
    assert.ok(!/StrictHostKeyChecking=(no|accept-new)/.test(text));
  });

  it('a path with spaces is double-quoted inside the ProxyCommand (never single-quoted: rsync\'s -e parser cannot nest them)', () => {
    const options = buildPairedSshOptions({ ...input, cliPath: '/opt/my charness/dist/cli.js' });
    const proxy = options.find((option) => option.startsWith('ProxyCommand='));
    assert.ok(proxy?.includes('"/opt/my charness/dist/cli.js"'));
    assert.ok(!proxy?.includes("'"));
  });

  it('a hub folder with a space keeps one path one word everywhere: the known-hosts file is double-quoted INSIDE its option (ssh reads UserKnownHostsFile as a whitespace-separated list), the proxy socket inside the ProxyCommand, the key as a plain argument', () => {
    const spacedDir = '/home/my user/.config/charness/runners';
    const options = buildPairedSshOptions({ ...input, hubDir: spacedDir });
    assert.ok(options.includes(`UserKnownHostsFile="${spacedDir}/known_hosts"`), options.join('\n'));
    assert.ok(options.includes(`ProxyCommand=/usr/bin/node /opt/charness/dist/cli.js runner-proxy "${spacedDir}/link/${runnerId}.sock"`));
    assert.equal(options[options.indexOf('-i') + 1], `${spacedDir}/hub_ed25519`, '-i takes its path as an argument: no quotes of its own');
    assert.ok(options.every((option) => !option.includes("'")), 'no single quote anywhere: rsync cannot nest them');
  });

  it('a % in a path is written %% (ssh expands %-tokens in a ProxyCommand, a known-hosts path and an identity file)', () => {
    const options = buildPairedSshOptions({ ...input, hubDir: '/home/us%er/.config/charness/runners' });
    assert.ok(options.includes('UserKnownHostsFile=/home/us%%er/.config/charness/runners/known_hosts'));
    assert.equal(options[options.indexOf('-i') + 1], '/home/us%%er/.config/charness/runners/hub_ed25519');
    assert.ok(options.find((option) => option.startsWith('ProxyCommand='))?.includes('/home/us%%er/'));
  });

  it('a path that holds a quote, a backslash, a $ or a line break is refused — it cannot reach ssh and rsync as the same words', () => {
    for (const unsafe of ["/opt/it's", '/opt/a"b', '/opt/a\\b', '/opt/a$b', '/opt/a`b', '/opt/a\nb']) {
      assert.throws(() => buildPairedSshOptions({ ...input, cliPath: `${unsafe}/cli.js` }), PairedRunnerSetupError, unsafe);
      assert.throws(() => buildPairedSshOptions({ ...input, hubDir: `${unsafe}/runners` }), PairedRunnerSetupError, unsafe);
    }
  });

  it('survive the real shells: ssh\'s own argument list keeps ProxyCommand one word, and the `-e` string of rsync splits back into the same words', () => {
    const config = buildPairedRunnerConfig(createPairedRunner(), { hubDir: '/home/my user/.config/charness/runners', nodePath: '/usr/bin/node', cliPath: '/opt/my charness/dist/cli.js' });
    const rsyncCommand = buildRsyncSshCommand(config, '/tmp/cache');
    // rsync's manual (`-e`): «single- and/or double-quotes preserve spaces in an argument (but not backslashes)», and a doubled single quote
    // is a single quote — so a word is wrapped in single quotes and holds none inside; a POSIX shell reads this input the same way.
    const printed = spawnSync('sh', ['-c', `for word in ${rsyncCommand}; do printf '%s\\n' "$word"; done`], { encoding: 'utf8' }).stdout.split('\n');
    const expected = ['ssh', ...buildSshArgs(config, '/tmp/cache')];
    assert.deepEqual(printed.slice(0, expected.length), expected);
    assert.ok(printed.includes('ProxyCommand=/usr/bin/node "/opt/my charness/dist/cli.js" runner-proxy "/home/my user/.config/charness/runners/link/a1b2c3d4e5f6.sock"'));
    assert.ok(printed.includes('UserKnownHostsFile="/home/my user/.config/charness/runners/known_hosts"'));
  });
});

describe('where a paired runner keeps Pueue', () => {
  it('beside its work dir, in the layout the runner utility itself writes down (runnerHome.ts)', () => {
    const paths = getRunnerHomePaths('/Users/runner');
    assert.equal(paths.workDir, reportedWorkDir);
    assert.deepEqual(getPairedRunnerPueue(reportedWorkDir), { bin: path.join(paths.binDir, 'pueue'), config: paths.pueueConfig });
  });

  it('a work dir that does not follow that layout gives no Pueue paths (the script finds Pueue on the PATH, as for a hand-made runner)', () => {
    assert.equal(getPairedRunnerPueue('/srv/runner-work'), undefined);
    assert.equal(getPairedRunnerPueue('/Users/runner/.charness-runner/other'), undefined);
    assert.equal(getPairedRunnerPueue('~/.charness-runner/work'), undefined);
  });
});

describe('a registry entry as a RunnerConfig', () => {
  it('is addressed by its alias, keeps the reported work dir and the hub\'s pause, and says it is paired', () => {
    const hub = { hubDir: '/home/user/.config/charness/runners', nodePath: '/usr/bin/node', cliPath: '/opt/charness/dist/cli.js' };
    const config = buildPairedRunnerConfig(createPairedRunner({ isPaused: true }), hub);
    assert.equal(config.name, 'mac');
    assert.equal(config.ssh, `charness-runner-${runnerId}`);
    assert.equal(config.workDir, reportedWorkDir);
    assert.deepEqual(config.paired, { runnerId, hubDir: hub.hubDir, isPausedByHub: true });
    assert.equal(config.pueue?.config, getRunnerHomePaths('/Users/runner').pueueConfig);
  });
});

describe('loading the paired runners', () => {
  it('nothing paired: missing, no runners', () => {
    const load = loadPairedRunners(homeDir);
    assert.equal(load.status, 'missing');
    assert.deepEqual(load.config?.runners, []);
  });

  it('reads paired.json (the hub\'s own files, under the user\'s config folder) into runners', () => {
    writePaired([createPairedRunner(), createPairedRunner({ id: 'ffffffffffff', name: 'box1', pairId: 'fedcba987654', workDir: '/home/runner/.charness-runner/work' })]);
    const load = loadPairedRunners(homeDir);
    assert.equal(load.status, 'ok');
    assert.deepEqual(load.config?.runners.map((runner) => runner.name), ['mac', 'box1']);
    assert.equal(load.config?.runners[0].paired?.hubDir, createHubContext({ homeDir }).dir);
    assert.ok(fs.existsSync(getHubFilePaths(createHubContext({ homeDir }).dir).paired));
  });

  it('a file that does not validate is invalid, names the field and no value, and keeps the last good list', () => {
    writePaired([createPairedRunner()]);
    assert.equal(loadPairedRunners(homeDir).status, 'ok');
    const pairedPath = getHubFilePaths(createHubContext({ homeDir }).dir).paired;
    fs.writeFileSync(pairedPath, JSON.stringify({ rev: 'secret-value', runners: [] }));
    const load = loadPairedRunners(homeDir);
    assert.equal(load.status, 'invalid');
    assert.ok(load.status === 'invalid' && load.errors.some((error) => error.startsWith('paired.json rev')) && !load.errors.join('').includes('secret-value'));
    assert.deepEqual(load.config?.runners.map((runner) => runner.name), ['mac']);
  });
});

describe('the catalog of every runner', () => {
  it('lists the hand-made runners first, then the paired ones, and offers remote-run for either alone', () => {
    writeRunnersJson({ runners: [{ name: 'box1', ssh: 'runner@box1.example', workDir: '/w' }] });
    writePaired([createPairedRunner()]);
    const load = loadRunnersCatalog(homeDir);
    assert.equal(load.status, 'ok');
    assert.deepEqual(load.config?.runners.map((runner) => [runner.name, runner.paired === undefined ? 'hand-made' : 'paired']), [['box1', 'hand-made'], ['mac', 'paired']]);
    assert.equal(checkIsRemoteRunOffered(homeDir), true);
  });

  it('nothing at all is missing and offers nothing; only paired runners (no runners.json) work', () => {
    assert.equal(loadRunnersCatalog(homeDir).status, 'missing');
    assert.equal(checkIsRemoteRunOffered(homeDir), false);
    writePaired([createPairedRunner()]);
    assert.equal(loadRunnersCatalog(homeDir).status, 'ok');
    assert.equal(checkIsRemoteRunOffered(homeDir), true);
  });

  it('a name in both sources is an error that names it; the hand-made entry stays, the paired duplicate is left out', () => {
    writeRunnersJson({ runners: [{ name: 'mac', ssh: 'runner@mac.example', workDir: '/w' }] });
    writePaired([createPairedRunner()]);
    const load = loadRunnersCatalog(homeDir);
    assert.equal(load.status, 'invalid');
    assert.ok(load.status === 'invalid' && load.errors.some((error) => error.includes('runner "mac" is in runners.json and also paired')));
    assert.deepEqual(load.config?.runners.map((runner) => runner.ssh), ['runner@mac.example']);
  });

  it('a broken runners.json is invalid with its errors, yet the paired runners still count as offered', () => {
    writePaired([createPairedRunner()]);
    writeRunnersJson('{ not json');
    const load = loadRunnersCatalog(homeDir);
    assert.equal(load.status, 'invalid');
    assert.ok(load.status === 'invalid' && load.errors.some((error) => error.startsWith('runners.json')));
    assert.equal(checkIsRemoteRunOffered(homeDir), true);
  });

  it('a runner whose paths cannot be put on an ssh line is reported by name and left out of the list', () => {
    const unsafeHome = path.join(homeDir, "it's");
    writePairedFile(createHubContext({ homeDir: unsafeHome }).dir, { rev: 1, runners: [createPairedRunner()] });
    const load = loadPairedRunners(unsafeHome);
    assert.equal(load.status, 'invalid');
    assert.ok(load.status === 'invalid' && load.errors[0].startsWith('paired runner "mac":'));
    assert.deepEqual(load.config?.runners, []);
  });
});

describe('probing a paired runner', () => {
  const probeText = 'os=Linux\nos_name=Ubuntu\npueue=4.0.4\ncap_android=no\ncap_ios=no\ncap_docker=no\ncap_playwright=no\npaused=no\nservice=user-service\n';
  const linkSeenAtMs = Date.UTC(2026, 10, 1, 14, 2);
  const probeSeenAtMs = Date.UTC(2026, 9, 30, 9, 0);
  let shortRoot = '';
  let hubDir = '';
  let cacheDir = '';
  let scriptChecks = 0;

  /** A client whose ssh is never used for the link check; `ensureScript` / `call` count what reaches the runner. */
  function createClient(isPausedByHub: boolean): RunnerClient {
    const refuse = (): never => {
      throw new Error('not used by the probe');
    };
    return {
      runner: { name: 'mac', ssh: `charness-runner-${runnerId}`, workDir: reportedWorkDir, paired: { runnerId, hubDir, isPausedByHub } },
      cacheDir,
      rsyncSshCommand: 'ssh',
      ensureScript: async () => { scriptChecks += 1; },
      getAbsoluteWorkDir: refuse,
      call: async () => ({ exitCode: 0, stdout: probeText, stderr: '', isTimedOut: false }),
      callOrThrow: refuse,
      stream: refuse,
    };
  }

  function listenOnLinkSocket(): Promise<net.Server> {
    fs.mkdirSync(path.dirname(getRunnerLinkPaths(hubDir, runnerId).socket), { recursive: true });
    return new Promise((resolve) => {
      const server = net.createServer((connection) => connection.destroy());
      server.listen(getRunnerLinkPaths(hubDir, runnerId).socket, () => resolve(server));
    });
  }

  beforeEach(() => {
    // Short names: a unix socket path may be about 100 bytes at most, and TMPDIR can be long.
    shortRoot = fs.mkdtempSync(path.join('/tmp', 'rpl-'));
    hubDir = path.join(shortRoot, 'r');
    cacheDir = path.join(shortRoot, 'c');
    fs.mkdirSync(cacheDir);
    scriptChecks = 0;
  });
  afterEach(() => {
    fs.rmSync(shortRoot, { recursive: true, force: true });
  });

  it('a link that accepts connections is online: the script is checked and the probe is the runner\'s own', async () => {
    const server = await listenOnLinkSocket();
    try {
      const report = await probeRunner(createClient(false), 1234);
      assert.equal(report.status, 'online');
      assert.ok(report.status === 'online' && report.probe.serviceKind === 'user-service' && report.isPausedByHub === false);
      assert.equal(scriptChecks, 1);
      assert.equal(JSON.parse(fs.readFileSync(path.join(cacheDir, 'mac.probe.json'), 'utf8')).seenAtMs, 1234, 'the answer is kept as the snapshot an offline runner shows');
    } finally {
      server.close();
    }
  });

  it('a link nobody listens on is offline at once — no ssh call is made — and last seen is the link\'s own heartbeat, not the older probe', async () => {
    fs.writeFileSync(path.join(cacheDir, 'mac.probe.json'), JSON.stringify({ seenAtMs: probeSeenAtMs, text: probeText }));
    writeLinkState(hubDir, runnerId, { pid: 1, sinceMs: 1, lastBeatMs: linkSeenAtMs - 5000, endedAtMs: linkSeenAtMs });
    const report = await probeRunner(createClient(false));
    assert.equal(report.status, 'offline');
    assert.ok(report.status === 'offline' && report.reason === 'the runner is not connected' && report.lastSeenAtMs === linkSeenAtMs);
    assert.ok(report.status === 'offline' && report.lastProbe?.serviceKind === 'user-service', 'the snapshot of the last probe is still shown');
    assert.equal(scriptChecks, 0);
  });

  it('a dead socket file left behind by a gate that went away does not make it online', async () => {
    const server = await listenOnLinkSocket();
    // Closing a listening server removes its path; leave an inert file in its place, as a gate that was killed does.
    await new Promise((resolve) => { server.close(resolve); });
    fs.writeFileSync(getRunnerLinkPaths(hubDir, runnerId).socket, '');
    const report = await probeRunner(createClient(false));
    assert.equal(report.status, 'offline');
    assert.equal(scriptChecks, 0);
  });

  it('with no link state at all, last seen falls back to the last probe; with neither it is never seen', async () => {
    fs.writeFileSync(path.join(cacheDir, 'mac.probe.json'), JSON.stringify({ seenAtMs: probeSeenAtMs, text: probeText }));
    const withSnapshot = await probeRunner(createClient(false));
    assert.ok(withSnapshot.status === 'offline' && withSnapshot.lastSeenAtMs === probeSeenAtMs);
    fs.rmSync(path.join(cacheDir, 'mac.probe.json'));
    const withNothing = await probeRunner(createClient(false));
    assert.ok(withNothing.status === 'offline' && withNothing.lastSeenAtMs === null && withNothing.lastProbe === null);
  });

  it('the hub\'s pause is carried on the report, online or offline', async () => {
    const offline = await probeRunner(createClient(true));
    assert.equal(offline.isPausedByHub, true);
    const server = await listenOnLinkSocket();
    try {
      assert.equal((await probeRunner(createClient(true))).isPausedByHub, true);
    } finally {
      server.close();
    }
  });
});
