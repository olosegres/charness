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
  checkIsOpenCodeServerMissingAgentSkills,
  getClaudeAgentPluginFlags,
  getExpectedOpenCodeAgentConfigDir,
  getOpenCodeAgentConfigDir,
  getOpenCodeAgentConfigEnv,
  openCodeConfigDirEnvName,
  parseOpenCodeServerLaunch,
  prepareOpenCodeAgentConfigDir,
  resolveAgentPluginDir,
} from '../utils/agentPlugin';

const repoAgentPluginDir = path.join(fs.realpathSync(path.resolve(__dirname, '..', '..')), 'agent-plugin');

describe('agentPlugin', () => {
  test('the plugin folder is the package\'s own agent-plugin/', () => {
    assert.equal(resolveAgentPluginDir(), repoAgentPluginDir);
  });

  test('Claude Code gets --plugin-dir with that folder, and nothing when it is missing', () => {
    assert.deepEqual(getClaudeAgentPluginFlags(), ['--plugin-dir', repoAgentPluginDir]);
    assert.deepEqual(getClaudeAgentPluginFlags(null), []);
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

  test('a relative DATA_DIR names the same absolute folder the server is started with', () => {
    assert.equal(getOpenCodeAgentConfigDir('relative-data'), path.join(process.cwd(), 'relative-data', 'opencode-config'));
  });
});

describe('reading a running server\'s launch', () => {
  const env = (entries: string[]): string => `${entries.join('\0')}\0`;
  const serveCmdline = env(['opencode', 'serve', '--hostname', '127.0.0.1', '--port', '4096']);

  test('an opencode serve process: the OPENCODE_CONFIG_DIR it was started with, or none', () => {
    assert.deepEqual(parseOpenCodeServerLaunch(serveCmdline, env(['HOME=/home/user', 'OPENCODE_CONFIG_DIR=/data/charness/opencode-config'])), { kind: 'openCodeServe', configDir: '/data/charness/opencode-config' });
    assert.deepEqual(parseOpenCodeServerLaunch(env(['/usr/lib/node_modules/opencode-ai/bin/opencode.exe', 'serve']), env(['HOME=/home/user'])), { kind: 'openCodeServe', configDir: null });
  });

  test('anything else is unknown: a test runner holding a stand-in server, a sleep, another tool', () => {
    for (const cmdline of [env(['node', '--test', 'fakeOpenCodeServer.ts']), env(['sleep', '3600']), env(['python3', '-m', 'http.server', 'serve']), '']) {
      assert.deepEqual(parseOpenCodeServerLaunch(cmdline, env(['OPENCODE_CONFIG_DIR=/x'])), { kind: 'unknown' }, cmdline);
    }
  });

  test('missing the skills: only an identified server started without the expected folder, and only when the bot offers one', () => {
    const expected = '/data/charness/opencode-config';
    assert.equal(checkIsOpenCodeServerMissingAgentSkills({ kind: 'openCodeServe', configDir: null }, expected), true);
    assert.equal(checkIsOpenCodeServerMissingAgentSkills({ kind: 'openCodeServe', configDir: '/old' }, expected), true);
    assert.equal(checkIsOpenCodeServerMissingAgentSkills({ kind: 'openCodeServe', configDir: expected }, expected), false);
    assert.equal(checkIsOpenCodeServerMissingAgentSkills({ kind: 'unknown' }, expected), false);
    assert.equal(checkIsOpenCodeServerMissingAgentSkills({ kind: 'openCodeServe', configDir: null }, null), false);
  });
});
