/**
 * @description The agent environment of a tracker conversation (Jira connector
 * plan R32): only the allowlist, never a variable the instance's `ENV_FILE`
 * set; the json-stream wrapper hands claude exactly that (`env -i`, run for
 * real here with `env` standing in for claude); a Telegram topic keeps its
 * environment; and tmux calls on a PRIVATE server start it with that set, so its
 * global environment — inherited by every session, readable by any process on
 * the server — carries no secret (a real tmux server on a private socket in a
 * temp `TMUX_TMPDIR`, killed at the end).
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { addEnvFileVariableNames, agentEnvironmentNames, getAgentEnvironment, resetEnvFileVariableNamesForTests } from '../utils/agentEnvironment';
import { loadEnvFiles } from '../cli/envLoader';
import { getClaudePlatformEnvironment } from '../adapters/claudePlatformFlags';
import { buildWrapperScript, getJsonStreamSessionPaths } from '../utils/jsonStreamHost';
import { getTmuxExecEnv, tmuxOrThrowAsync } from '../utils/tmuxExec';
import { makeJiraKey } from '../connectors/jira/sessionKeyCodec';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';

const execFileAsync = promisify(execFile);
const instanceSecretName = 'CHARNESS_TEST_AI_API_TOKEN';
const instanceSecretValue = 'placeholder-secret-value';

// The recorded ENV_FILE names are module-global: every case starts with none, whatever an earlier one recorded.
beforeEach(() => {
  resetEnvFileVariableNamesForTests();
});

/** Variable names out of `env`-style `NAME=value` lines. */
function getEnvNames(envOutput: string): string[] {
  return envOutput.split('\n').filter(Boolean).map((line) => line.slice(0, line.indexOf('=')));
}

describe('getAgentEnvironment', () => {
  it('passes only the allowlist on', () => {
    const environment = getAgentEnvironment({ HOME: '/home/user', PATH: '/usr/bin', [instanceSecretName]: instanceSecretValue, ANTHROPIC_API_KEY: 'key' });
    assert.deepEqual(environment, { HOME: '/home/user', PATH: '/usr/bin' });
    assert.ok(!agentEnvironmentNames.some((name) => /KEY|TOKEN|SECRET|PASSWORD/.test(name)), 'no credential-shaped name is allowlisted');
  });

  it('never a variable the instance file set, even an allowlisted one', () => {
    addEnvFileVariableNames(['TZ']);
    assert.deepEqual(getAgentEnvironment({ HOME: '/home/user', TZ: 'Europe/Berlin' }), { HOME: '/home/user' });
  });

  it('passes IS_SANDBOX on: the whole bot in a container runs as its root, where Claude Code needs it (plan S8 C20)', () => {
    assert.deepEqual(getAgentEnvironment({ HOME: '/home/user', IS_SANDBOX: '1' }), { HOME: '/home/user', IS_SANDBOX: '1' });
    assert.deepEqual(getAgentEnvironment({ HOME: '/home/user' }), { HOME: '/home/user' }, 'and adds nothing when the bot has none');
  });

  it('starts clean: a name an earlier case recorded is not remembered', () => {
    assert.deepEqual(getAgentEnvironment({ HOME: '/home/user', TZ: 'Europe/Berlin' }), { HOME: '/home/user', TZ: 'Europe/Berlin' });
  });
});

describe('the env loader records what ENV_FILE set', () => {
  let tmpRoot: string;
  const touchedNames = ['ENV_FILE', 'LANG', instanceSecretName];
  let savedValues: Record<string, string | undefined>;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-env-'));
    savedValues = Object.fromEntries(touchedNames.map((name) => [name, process.env[name]]));
  });

  afterEach(() => {
    for (const name of touchedNames) {
      if (savedValues[name] === undefined) delete process.env[name];
      else process.env[name] = savedValues[name];
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('an allowlisted name the file sets does not reach the agent; the launch environment\'s others do', () => {
    const envFile = path.join(tmpRoot, 'instance.env');
    fs.writeFileSync(envFile, `LANG=xx_XX.UTF-8\n${instanceSecretName}=${instanceSecretValue}\n`);
    process.env.ENV_FILE = envFile;
    loadEnvFiles(tmpRoot);
    assert.equal(process.env.LANG, 'xx_XX.UTF-8', 'the instance itself runs with what its file set');
    const environment = getAgentEnvironment();
    assert.equal(environment.LANG, undefined);
    assert.equal(environment[instanceSecretName], undefined);
    assert.equal(environment.HOME, process.env.HOME);
  });
});

describe('getClaudePlatformEnvironment', () => {
  it('a tracker conversation gets the allowlist; a Telegram topic keeps its environment', () => {
    assert.deepEqual(getClaudePlatformEnvironment(makeJiraKey('PROJ-12')), getAgentEnvironment());
    assert.equal(getClaudePlatformEnvironment(makeTelegramKey(-1001111111111, 42)), null);
  });
});

describe('a Jira agent in the container', () => {
  const savedValue = process.env.IS_SANDBOX;
  afterEach(() => {
    if (savedValue === undefined) delete process.env.IS_SANDBOX;
    else process.env.IS_SANDBOX = savedValue;
  });

  it('starts with IS_SANDBOX when the bot has it, and without it when not; a Telegram topic keeps its environment', () => {
    process.env.IS_SANDBOX = '1';
    assert.equal(getClaudePlatformEnvironment(makeJiraKey('PROJ-12'))?.IS_SANDBOX, '1');
    assert.equal(getClaudePlatformEnvironment(makeTelegramKey(-1001111111111, 42)), null);
    delete process.env.IS_SANDBOX;
    assert.equal(getClaudePlatformEnvironment(makeJiraKey('PROJ-12'))?.IS_SANDBOX, undefined);
  });
});

describe('the json-stream wrapper with an environment', () => {
  it('claude gets exactly that environment — nothing of the shell that runs the wrapper', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-env-wrapper-'));
    try {
      const paths = getJsonStreamSessionPaths(dir);
      execFileSync('mkfifo', [paths.stdinFifo]);
      // `env` stands in for claude: it prints the environment it was started with.
      const script = buildWrapperScript('/usr/bin/env', [], dir, paths, { HOME: '/home/user', LANG: "C.UTF-8 'quoted'" });
      fs.writeFileSync(paths.wrapperFile, script, { mode: 0o755 });
      await execFileAsync(paths.wrapperFile, [], { env: { ...process.env, [instanceSecretName]: instanceSecretValue, ANTHROPIC_API_KEY: 'key' } });
      const printed = fs.readFileSync(paths.stdoutFile, 'utf8');
      assert.deepEqual(getEnvNames(printed).sort(), ['HOME', 'LANG']);
      assert.ok(printed.includes("LANG=C.UTF-8 'quoted'"), 'a value is passed verbatim');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('tmux on a private server starts it clean', () => {
  const socketName = `agent-env-${process.pid}-${randomBytes(4).toString('hex')}`;
  let socketDir: string;
  let isTmuxAvailable = false;
  const savedValues: Record<string, string | undefined> = {};
  const touchedNames = ['TMUX_SOCKET_NAME', 'TMUX_TMPDIR', instanceSecretName];

  before(async () => {
    try {
      await execFileAsync('tmux', ['-V']);
      isTmuxAvailable = true;
    } catch {
      isTmuxAvailable = false;
    }
    socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-env-tmux-'));
    for (const name of touchedNames) savedValues[name] = process.env[name];
    process.env.TMUX_SOCKET_NAME = socketName;
    process.env.TMUX_TMPDIR = socketDir;
    process.env[instanceSecretName] = instanceSecretValue;
  });

  after(async () => {
    // Only the private server this test started, named by the FULL path of its socket and run without `TMUX` /
    // `TMUX_PANE`: from inside a tmux session a command that does not name its server goes to the one `$TMUX` names.
    const { TMUX: _userTmuxServer, TMUX_PANE: _userTmuxPane, ...envWithoutTmux } = process.env;
    const socketPath = path.join(socketDir, `tmux-${process.getuid?.() ?? 0}`, socketName);
    await execFileAsync('tmux', ['-S', socketPath, 'kill-server'], { env: envWithoutTmux }).catch(() => {});
    for (const name of touchedNames) {
      if (savedValues[name] === undefined) delete process.env[name];
      else process.env[name] = savedValues[name];
    }
    fs.rmSync(socketDir, { recursive: true, force: true });
  });

  it('a call on a private server runs with the allowlist and the socket folder only; the default server keeps the bot\'s environment', () => {
    assert.deepEqual(getTmuxExecEnv(), { ...getAgentEnvironment(), TMUX_TMPDIR: socketDir });
    const socketNameSaved = process.env.TMUX_SOCKET_NAME;
    delete process.env.TMUX_SOCKET_NAME;
    assert.equal(getTmuxExecEnv(), undefined);
    process.env.TMUX_SOCKET_NAME = socketNameSaved;
  });

  it('its global environment, and a session\'s, hold no secret of the bot\'s environment', async (context) => {
    if (!isTmuxAvailable) {
      context.skip('tmux is not installed');
      return;
    }
    await tmuxOrThrowAsync('new-session', '-d', '-s', 'probe', 'sleep 60');
    const globalNames = getEnvNames(await tmuxOrThrowAsync('show-environment', '-g'));
    assert.ok(globalNames.includes('HOME'), 'the server environment was read');
    assert.ok(!globalNames.includes(instanceSecretName), 'no secret in the server environment');
    const sessionEnvironment = await tmuxOrThrowAsync('show-environment', '-t', '=probe');
    assert.ok(!sessionEnvironment.includes(instanceSecretValue));
    assert.ok(fs.existsSync(path.join(socketDir, `tmux-${process.getuid?.() ?? 0}`, socketName)), 'the server is the private one');
  });
});
