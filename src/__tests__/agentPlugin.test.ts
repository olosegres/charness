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
  getExpectedOpenCodeAgentConfigDir,
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
    assert.deepEqual(await getClaudeAgentPluginFlags('claude', undefined, reportVersion('2.1.310 (Claude Code)')), ['--plugin-dir', repoAgentPluginDir]);
    assert.deepEqual(await getClaudeAgentPluginFlags('claude', undefined, reportVersion('2.0.25 (Claude Code)')), ['--plugin-dir', repoAgentPluginDir], 'the first version with the flag');
    const originalLog = console.log;
    console.log = () => {};
    try {
      assert.deepEqual(await getClaudeAgentPluginFlags('claude', undefined, reportVersion('2.0.24 (Claude Code)')), [], 'it would exit «unknown option»');
      assert.deepEqual(await getClaudeAgentPluginFlags('claude', undefined, reportVersion(null)), []);
    } finally {
      console.log = originalLog;
    }
    let isVersionRead = false;
    const recordRead = async (): Promise<string | null> => {
      isVersionRead = true;
      return '2.1.310 (Claude Code)';
    };
    assert.deepEqual(await getClaudeAgentPluginFlags('claude', null, recordRead), []);
    assert.equal(isVersionRead, false, 'no folder, no version read');
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

  test('is created in DATA_DIR with a skills link to the package\'s skills, and OpenCode finds the manager through it', () => {
    const configDir = prepareOpenCodeAgentConfigDir(dataDir);
    assert.equal(configDir, getOpenCodeAgentConfigDir(dataDir));
    assert.equal(fs.readlinkSync(path.join(dataDir, 'opencode-config', 'skills')), skillsTarget);
    assert.ok(fs.existsSync(path.join(dataDir, 'opencode-config', 'skills', 'charness-manager', 'SKILL.md')));
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
    assert.deepEqual(getOpenCodeAgentConfigEnv({}, dataDir), { [openCodeConfigDirEnvName]: getOpenCodeAgentConfigDir(dataDir) });
    const originalLog = console.log;
    console.log = () => {};
    try {
      assert.deepEqual(getOpenCodeAgentConfigEnv({ [openCodeConfigDirEnvName]: '/operator/own' }, dataDir), {});
    } finally {
      console.log = originalLog;
    }
    assert.equal(getExpectedOpenCodeAgentConfigDir({ [openCodeConfigDirEnvName]: '/operator/own' }, dataDir), null);
    assert.equal(getExpectedOpenCodeAgentConfigDir({}, dataDir), getOpenCodeAgentConfigDir(dataDir));
  });

  test('a folder that cannot be prepared is no expected folder: no server is replaced for skills it would not get', () => {
    fs.mkdirSync(path.join(getOpenCodeAgentConfigDir(dataDir), 'skills', 'someone-elses'), { recursive: true });
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(getExpectedOpenCodeAgentConfigDir({}, dataDir), null);
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
    assert.deepEqual(parseOpenCodeServerLaunch(serveCmdline, env(['HOME=/home/user', 'OPENCODE_CONFIG_DIR=/home/user/.charness/opencode-config'])), { kind: 'openCodeServe', configDir: '/home/user/.charness/opencode-config' });
    assert.deepEqual(parseOpenCodeServerLaunch(env(['/usr/lib/node_modules/opencode-ai/bin/opencode.exe', 'serve']), env(['HOME=/home/user'])), { kind: 'openCodeServe', configDir: null });
  });

  test('anything else is unknown: a test runner holding a stand-in server, a sleep, another tool', () => {
    for (const cmdline of [env(['node', '--test', 'fakeOpenCodeServer.ts']), env(['sleep', '3600']), env(['python3', '-m', 'http.server', 'serve']), '']) {
      assert.deepEqual(parseOpenCodeServerLaunch(cmdline, env(['OPENCODE_CONFIG_DIR=/x'])), { kind: 'unknown' }, cmdline);
    }
  });

  test('the boot step replaces only an opencode serve the bot owns, started without the folder it now offers', () => {
    const expected = '/home/user/.charness/opencode-config';
    const started = (configDir: string | null, isOwnedByBot = true) => ({ kind: 'openCodeServe' as const, configDir, isOwnedByBot });
    assert.equal(getOpenCodeAgentSkillsServerAction(started(null), expected), 'replace');
    assert.equal(getOpenCodeAgentSkillsServerAction(started('/old'), expected), 'replace');
    assert.equal(getOpenCodeAgentSkillsServerAction(started(expected), expected), 'none');
    assert.equal(getOpenCodeAgentSkillsServerAction(started(null, false), expected), 'skipNotOwned', 'D5: never a server the bot does not own');
    assert.equal(getOpenCodeAgentSkillsServerAction(started(expected, false), expected), 'none', 'it already offers them');
    assert.equal(getOpenCodeAgentSkillsServerAction({ kind: 'unknown' }, expected), 'skipUnidentified');
    assert.equal(getOpenCodeAgentSkillsServerAction(started(null), null), 'none', 'the bot offers no folder');
    assert.equal(getOpenCodeAgentSkillsServerAction({ kind: 'unknown' }, null), 'none');
    assert.equal(getOpenCodeAgentSkillsServerAction({ kind: 'none' }, expected), 'none', 'no server listens: nothing to replace, nothing to say');
  });

  test('no listener PID found: `none` only when no server answers — an unreadable PID with a server answering stays `unknown`', () => {
    assert.deepEqual(getPidlessServerLaunchReading(false), { kind: 'none' });
    assert.deepEqual(getPidlessServerLaunchReading(true), { kind: 'unknown' }, 'another user\'s server, or no lsof / ss: still said once');
  });
});
