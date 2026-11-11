/**
 * @description `utils/agentPlugin.ts`: where the bot finds the skills it gives its agents, the Claude Code flags that
 * load them — none when the folder is missing, so a broken install starts its sessions without them instead of failing —
 * and the OpenCode side: the bot-owned config folder whose `skills` links to the package's, what the server's
 * environment gets (nothing when the operator set `OPENCODE_CONFIG_DIR`), and how a running server's launch is read
 * from `/proc` (only an `opencode … serve` process is ever judged, never a listener the bot cannot identify).
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  getClaudeAgentPluginFlags,
  getOpenCodeAgentSkillsExpectation,
  getOpenCodeAgentConfigDir,
  getOpenCodeAgentConfigEnv,
  getOpenCodeAgentSkillsServerAction,
  getPidlessServerLaunchReading,
  openCodeConfigDirEnvName,
  parseOpenCodeServerLaunch,
  prepareOpenCodeAgentConfigDir,
  readClaudeCodeVersion,
  resolveAgentPluginDir,
} from '../utils/agentPlugin';

const repoAgentPluginDir = path.join(fs.realpathSync(path.resolve(__dirname, '..', '..')), 'agent-plugin');

describe('agentPlugin', () => {
  test('the plugin folder is the package\'s own agent-plugin/', () => {
    assert.equal(resolveAgentPluginDir(), repoAgentPluginDir);
  });

  test('Claude Code gets --plugin-dir with that folder; nothing when it is missing, for a CLI older than the flag or of unreadable version', async () => {
    const reportVersion = (version: string | null) => async (): Promise<string | null> => version;
    assert.deepEqual(await getClaudeAgentPluginFlags('claude', true, undefined, reportVersion('2.1.310 (Claude Code)')), ['--plugin-dir', repoAgentPluginDir]);
    assert.deepEqual(await getClaudeAgentPluginFlags('claude', true, undefined, reportVersion('2.0.25 (Claude Code)')), ['--plugin-dir', repoAgentPluginDir], 'the first version with the flag');
    const originalLog = console.log;
    console.log = () => {};
    try {
      assert.deepEqual(await getClaudeAgentPluginFlags('claude', true, undefined, reportVersion('2.0.24 (Claude Code)')), [], 'it would exit «unknown option»');
      assert.deepEqual(await getClaudeAgentPluginFlags('claude', true, undefined, reportVersion(null)), []);
    } finally {
      console.log = originalLog;
    }
    let isVersionRead = false;
    const recordRead = async (): Promise<string | null> => {
      isVersionRead = true;
      return '2.1.310 (Claude Code)';
    };
    assert.deepEqual(await getClaudeAgentPluginFlags('claude', true, null, recordRead), []);
    assert.equal(isVersionRead, false, 'no folder, no version read');
  });

  test('a conversation with the bot\'s skills switched off gets no --plugin-dir, and the CLI is not even asked its version', async () => {
    let isVersionRead = false;
    const recordRead = async (): Promise<string | null> => {
      isVersionRead = true;
      return '2.1.310 (Claude Code)';
    };
    assert.deepEqual(await getClaudeAgentPluginFlags('claude', false, undefined, recordRead), []);
    assert.equal(isVersionRead, false);
    assert.deepEqual(await getClaudeAgentPluginFlags('claude', true, undefined, recordRead), ['--plugin-dir', repoAgentPluginDir], 'the same call with the skills on loads them');
  });

  test('the CLI version is read once per binary; a failed read is not remembered', async () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-claude-version-'));
    try {
      const callsFile = path.join(binDir, 'calls');
      const binary = path.join(binDir, 'claude');
      fs.writeFileSync(binary, `#!/bin/sh\necho call >> '${callsFile}'\necho '2.1.310 (Claude Code)'\n`, { mode: 0o755 });
      assert.equal(await readClaudeCodeVersion(binary), '2.1.310 (Claude Code)');
      assert.equal(await readClaudeCodeVersion(binary), '2.1.310 (Claude Code)');
      assert.equal(fs.readFileSync(callsFile, 'utf8'), 'call\n', 'one run of --version');

      const broken = path.join(binDir, 'broken-claude');
      fs.writeFileSync(broken, `#!/bin/sh\necho call >> '${callsFile}.broken'\nexit 1\n`, { mode: 0o755 });
      assert.equal(await readClaudeCodeVersion(broken), null);
      assert.equal(await readClaudeCodeVersion(broken), null);
      assert.equal(fs.readFileSync(`${callsFile}.broken`, 'utf8'), 'call\ncall\n', 'tried again');
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });
});

describe('the OpenCode config folder', () => {
  let dataDir = '';
  const skillsTarget = path.join(repoAgentPluginDir, 'skills');

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-agent-plugin-'));
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('is created in DATA_DIR with a skills link to the package\'s skills, and OpenCode finds the orchestration add-on through it', () => {
    const configDir = prepareOpenCodeAgentConfigDir(dataDir);
    assert.equal(configDir, getOpenCodeAgentConfigDir(dataDir));
    assert.equal(fs.readlinkSync(path.join(dataDir, 'opencode-config', 'skills')), skillsTarget);
    assert.ok(fs.existsSync(path.join(dataDir, 'opencode-config', 'skills', 'charness-orchestration', 'SKILL.md')));
    assert.equal(prepareOpenCodeAgentConfigDir(dataDir), configDir, 'a second boot finds it ready');
  });

  test('a stale link (the package moved) is re-pointed; a skills folder that is not the bot\'s link is left alone', () => {
    const skillsLink = path.join(getOpenCodeAgentConfigDir(dataDir), 'skills');
    fs.mkdirSync(path.dirname(skillsLink), { recursive: true });
    fs.symlinkSync('/old/package/agent-plugin/skills', skillsLink);
    assert.equal(prepareOpenCodeAgentConfigDir(dataDir), getOpenCodeAgentConfigDir(dataDir));
    assert.equal(fs.readlinkSync(skillsLink), skillsTarget);

    fs.unlinkSync(skillsLink);
    fs.mkdirSync(path.join(skillsLink, 'someone-elses'), { recursive: true });
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(prepareOpenCodeAgentConfigDir(dataDir), null);
    } finally {
      console.warn = originalWarn;
    }
    assert.ok(fs.existsSync(path.join(skillsLink, 'someone-elses')), 'untouched');
  });

  test('nothing to link without the plugin folder', () => {
    assert.equal(prepareOpenCodeAgentConfigDir(dataDir, null), null);
    assert.equal(fs.existsSync(getOpenCodeAgentConfigDir(dataDir)), false);
  });

  test('the server gets OPENCODE_CONFIG_DIR with the folder; an operator\'s own variable is kept and nothing is added', () => {
    assert.deepEqual(getOpenCodeAgentConfigEnv({}, dataDir, true), { [openCodeConfigDirEnvName]: getOpenCodeAgentConfigDir(dataDir) });
    const originalLog = console.log;
    console.log = () => {};
    try {
      assert.deepEqual(getOpenCodeAgentConfigEnv({ [openCodeConfigDirEnvName]: '/operator/own' }, dataDir, true), {});
    } finally {
      console.log = originalLog;
    }
    assert.deepEqual(getOpenCodeAgentSkillsExpectation({ [openCodeConfigDirEnvName]: '/operator/own' }, dataDir, true), { kind: 'unmanaged' });
    assert.deepEqual(getOpenCodeAgentSkillsExpectation({}, dataDir, true), { kind: 'offered', configDir: getOpenCodeAgentConfigDir(dataDir) });
  });

  test('with the instance\'s skills switched off the server gets no folder, and none is prepared for it', () => {
    assert.deepEqual(getOpenCodeAgentConfigEnv({}, dataDir, false), {});
    assert.equal(fs.existsSync(getOpenCodeAgentConfigDir(dataDir)), false, 'nothing is linked for a server that is not to offer it');
    assert.deepEqual(getOpenCodeAgentSkillsExpectation({}, dataDir, false), { kind: 'withheld', configDir: getOpenCodeAgentConfigDir(dataDir) });
    assert.deepEqual(getOpenCodeAgentSkillsExpectation({ [openCodeConfigDirEnvName]: '/operator/own' }, dataDir, false), { kind: 'unmanaged' }, 'the operator\'s own variable is theirs either way');
  });

  test('a folder that cannot be prepared is no expected folder: no server is replaced for skills it would not get', () => {
    fs.mkdirSync(path.join(getOpenCodeAgentConfigDir(dataDir), 'skills', 'someone-elses'), { recursive: true });
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      assert.deepEqual(getOpenCodeAgentSkillsExpectation({}, dataDir, true), { kind: 'unmanaged' });
    } finally {
      console.warn = originalWarn;
    }
  });

  test('a relative DATA_DIR names the same absolute folder the server is started with', () => {
    assert.equal(getOpenCodeAgentConfigDir('relative-data'), path.join(process.cwd(), 'relative-data', 'opencode-config'));
  });
});

describe('reading a running server\'s launch', () => {
  const env = (entries: string[]): string => `${entries.join('\0')}\0`;
  const serveCmdline = env(['opencode', 'serve', '--hostname', '127.0.0.1', '--port', '4096']);

  test('an opencode serve process: the OPENCODE_CONFIG_DIR it was started with, or none', () => {
    assert.deepEqual(parseOpenCodeServerLaunch(serveCmdline, env(['HOME=/home/user', 'OPENCODE_CONFIG_DIR=/home/user/.charness/opencode-config'])), { kind: 'openCodeServe', configDir: '/home/user/.charness/opencode-config', isPasswordProtected: false });
    assert.deepEqual(parseOpenCodeServerLaunch(env(['/usr/lib/node_modules/opencode-ai/bin/opencode.exe', 'serve']), env(['HOME=/home/user'])), { kind: 'openCodeServe', configDir: null, isPasswordProtected: false });
  });

  test('an opencode serve process started with a password, or with an empty one — which OpenCode reads as none', () => {
    assert.deepEqual(parseOpenCodeServerLaunch(serveCmdline, env(['HOME=/home/user', 'OPENCODE_SERVER_PASSWORD=a-generated-password'])), { kind: 'openCodeServe', configDir: null, isPasswordProtected: true });
    assert.deepEqual(parseOpenCodeServerLaunch(serveCmdline, env(['OPENCODE_SERVER_PASSWORD='])), { kind: 'openCodeServe', configDir: null, isPasswordProtected: false });
    assert.deepEqual(parseOpenCodeServerLaunch(serveCmdline, env(['XOPENCODE_SERVER_PASSWORD=not-this-one'])), { kind: 'openCodeServe', configDir: null, isPasswordProtected: false }, 'only the exact variable counts');
  });

  test('anything else is unknown: a test runner holding a stand-in server, a sleep, another tool', () => {
    for (const cmdline of [env(['node', '--test', 'fakeOpenCodeServer.ts']), env(['sleep', '3600']), env(['python3', '-m', 'http.server', 'serve']), '']) {
      assert.deepEqual(parseOpenCodeServerLaunch(cmdline, env(['OPENCODE_CONFIG_DIR=/x'])), { kind: 'unknown' }, cmdline);
    }
  });

  test('the boot step replaces only an opencode serve the bot owns, started without the folder it now offers', () => {
    const botFolder = '/home/user/.charness/opencode-config';
    const offered = { kind: 'offered' as const, configDir: botFolder };
    const started = (configDir: string | null, isOwnedByBot = true) => ({ kind: 'openCodeServe' as const, configDir, isPasswordProtected: true, isOwnedByBot });
    assert.equal(getOpenCodeAgentSkillsServerAction(started(null), offered), 'replace');
    assert.equal(getOpenCodeAgentSkillsServerAction(started('/old'), offered), 'replace');
    assert.equal(getOpenCodeAgentSkillsServerAction(started(botFolder), offered), 'none');
    assert.equal(getOpenCodeAgentSkillsServerAction(started(null, false), offered), 'skipNotOwned', 'D5: never a server the bot does not own');
    assert.equal(getOpenCodeAgentSkillsServerAction(started(botFolder, false), offered), 'none', 'it already offers them');
    assert.equal(getOpenCodeAgentSkillsServerAction({ kind: 'unknown' }, offered), 'skipUnidentified');
    assert.equal(getOpenCodeAgentSkillsServerAction(started(null), { kind: 'unmanaged' }), 'none', 'the bot offers no folder');
    assert.equal(getOpenCodeAgentSkillsServerAction({ kind: 'unknown' }, { kind: 'unmanaged' }), 'none');
    assert.equal(getOpenCodeAgentSkillsServerAction({ kind: 'none' }, offered), 'none', 'no server listens: nothing to replace, nothing to say');
  });

  test('with the instance\'s skills off, the boot step replaces an owned server that carries the bot\'s folder — and only that', () => {
    const botFolder = '/home/user/.charness/opencode-config';
    const withheld = { kind: 'withheld' as const, configDir: botFolder };
    const started = (configDir: string | null, isOwnedByBot = true) => ({ kind: 'openCodeServe' as const, configDir, isPasswordProtected: true, isOwnedByBot });
    assert.equal(getOpenCodeAgentSkillsServerAction(started(botFolder), withheld), 'replace');
    assert.equal(getOpenCodeAgentSkillsServerAction(started(null), withheld), 'none', 'it already offers nothing');
    assert.equal(getOpenCodeAgentSkillsServerAction(started('/operator/own'), withheld), 'none', 'a folder of the operator\'s is not the bot\'s to take away');
    assert.equal(getOpenCodeAgentSkillsServerAction(started(botFolder, false), withheld), 'skipNotOwned', 'D5: never a server the bot does not own');
    assert.equal(getOpenCodeAgentSkillsServerAction({ kind: 'unknown' }, withheld), 'skipUnidentified');
    assert.equal(getOpenCodeAgentSkillsServerAction({ kind: 'none' }, withheld), 'none');
  });

  test('no listener PID found: `none` only when no server answers — an unreadable PID with a server answering stays `unknown`', () => {
    assert.deepEqual(getPidlessServerLaunchReading(false), { kind: 'none' });
    assert.deepEqual(getPidlessServerLaunchReading(true), { kind: 'unknown' }, 'another user\'s server, or no lsof / ss: still said once');
  });
});
