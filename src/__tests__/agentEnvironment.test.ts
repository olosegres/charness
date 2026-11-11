/**
 * @description The agent environment of a tracker conversation (Jira connector
 * plan R32): only the allowlist, never a variable the instance's `ENV_FILE`
 * set; the json-stream wrapper hands claude exactly that (`env -i`, run for
 * real here with `env` standing in for claude); a Telegram topic keeps its
 * environment; and tmux calls on a PRIVATE server start it with that set, so its
 * global environment — inherited by every session, readable by any process on
 * the server — carries no secret (a real tmux server on a private socket in a
 * temp `TMUX_TMPDIR`, killed at the end). And for every surface: the bot's own
 * secrets (`TELEGRAM_BOT_TOKEN`, `OPENCODE_PASSWORD`) reach no child it starts
 * for an agent — not a Telegram topic's json-stream claude (run for real), not
 * an OpenCode process, not the default tmux server the bot starts or one an
 * older bot started with them (cleared before a terminal opens on it; the
 * terminal's shell, read for real, has none) — while the user's variables do.
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
import { addEnvFileVariableNames, agentEnvironmentNames, botSecretEnvironmentNames, getAgentEnvironment, getChildProcessEnvironment, resetEnvFileVariableNamesForTests } from '../utils/agentEnvironment';
import { getOpenCodeChildEnv } from '../installManager';
import { TerminalAdapter } from '../adapters/terminalAdapter';
import { loadEnvFiles } from '../cli/envLoader';
import { getClaudePlatformEnvironment } from '../adapters/claudePlatformFlags';
import { buildWrapperScript, claudeSessionStateEventsVariableName, getJsonStreamSessionPaths } from '../utils/jsonStreamHost';
import { getTmuxExecEnv, getTmuxPaneTarget, removeBotSecretsFromTmuxServer, startAgentTmuxSession, tmuxAsync, tmuxOrThrowAsync } from '../utils/tmuxExec';
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

  it('passes XDG_CACHE_HOME on — also when the instance file set it, because the bot follows that value too and the agent must share its remote-run cache; any other name the file set stays out', () => {
    assert.deepEqual(getAgentEnvironment({ HOME: '/home/user', XDG_CACHE_HOME: '/data/cache' }), { HOME: '/home/user', XDG_CACHE_HOME: '/data/cache' });
    addEnvFileVariableNames(['XDG_CACHE_HOME', 'TZ']);
    assert.deepEqual(getAgentEnvironment({ HOME: '/home/user', XDG_CACHE_HOME: '/data/cache', TZ: 'Europe/Berlin' }), { HOME: '/home/user', XDG_CACHE_HOME: '/data/cache' });
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
      // The given environment plus the wrapper's own opt-in to the CLI's session-state events, nothing else.
      assert.deepEqual(getEnvNames(printed).sort(), [claudeSessionStateEventsVariableName, 'HOME', 'LANG'].sort());
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

  it('a call on a private server runs with the allowlist and the socket folder only; the default server gets the bot\'s environment without its secrets', () => {
    assert.deepEqual(getTmuxExecEnv(), { ...getAgentEnvironment(), TMUX_TMPDIR: socketDir });
    const socketNameSaved = process.env.TMUX_SOCKET_NAME;
    delete process.env.TMUX_SOCKET_NAME;
    assert.deepEqual(getTmuxExecEnv(), getChildProcessEnvironment());
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

const userToolVariableName = 'CHARNESS_TEST_USER_TOOL_TOKEN';
const userToolVariableValue = 'placeholder-user-value';
const botSecretValue = 'placeholder-bot-secret';

/** @description An environment that holds the bot's own secrets, the key a json-stream wrapper drops, and a variable of the user's. */
function createBotEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    ...Object.fromEntries(botSecretEnvironmentNames.map((name) => [name, botSecretValue])),
    ANTHROPIC_API_KEY: 'placeholder-key',
    [userToolVariableName]: userToolVariableValue,
  };
}

describe('the bot\'s own secrets never reach a child it starts for an agent', () => {
  it('names the Telegram bot token and the operator\'s OpenCode password — and drops only them', () => {
    assert.deepEqual([...botSecretEnvironmentNames].sort(), ['OPENCODE_PASSWORD', 'TELEGRAM_BOT_TOKEN']);
    const childEnvironment = getChildProcessEnvironment(createBotEnvironment({ PATH: '/usr/bin' }));
    assert.deepEqual(childEnvironment, { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'placeholder-key', [userToolVariableName]: userToolVariableValue });
  });

  it('an OpenCode process gets neither them nor the hot-mode handshake; the user\'s variables stay', () => {
    const childEnvironment = getOpenCodeChildEnv({ ...createBotEnvironment({ PATH: '/usr/bin' }), CHARNESS_HOT_RELOAD: '1' });
    for (const name of botSecretEnvironmentNames) assert.equal(childEnvironment[name], undefined, name);
    assert.equal(childEnvironment.CHARNESS_HOT_RELOAD, undefined);
    assert.equal(childEnvironment[userToolVariableName], userToolVariableValue);
  });

  it('a Telegram topic\'s json-stream claude, run for real from a shell that holds them, sees neither them nor the API key', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-env-telegram-wrapper-'));
    try {
      const paths = getJsonStreamSessionPaths(dir);
      execFileSync('mkfifo', [paths.stdinFifo]);
      // `env` stands in for claude: it prints the environment it was started with.
      fs.writeFileSync(paths.wrapperFile, buildWrapperScript('/usr/bin/env', [], dir, paths), { mode: 0o755 });
      await execFileAsync(paths.wrapperFile, [], { env: createBotEnvironment() });
      const names = getEnvNames(fs.readFileSync(paths.stdoutFile, 'utf8'));
      for (const name of [...botSecretEnvironmentNames, 'ANTHROPIC_API_KEY']) assert.ok(!names.includes(name), name);
      assert.ok(names.includes(userToolVariableName), 'the user\'s own variables reach the agent');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the default tmux server the agents and terminals run on holds none of the bot\'s secrets', () => {
  let socketDir: string;
  let isTmuxAvailable = false;
  const touchedNames = ['TMUX_SOCKET_NAME', 'TMUX_TMPDIR', 'TMUX', 'TMUX_PANE', userToolVariableName, ...botSecretEnvironmentNames];
  const savedValues: Record<string, string | undefined> = {};

  const getSocketPath = (): string => path.join(socketDir, `tmux-${process.getuid?.() ?? 0}`, 'default');
  /** tmux on this test's own default socket, run with `environment` — what an older bot, or a shell, would start the server with. */
  const runTmuxAs = (environment: NodeJS.ProcessEnv, ...args: string[]) => execFileAsync('tmux', ['-S', getSocketPath(), ...args], { env: environment });

  before(async () => {
    try {
      await execFileAsync('tmux', ['-V']);
      isTmuxAvailable = true;
    } catch {
      isTmuxAvailable = false;
    }
    for (const name of touchedNames) savedValues[name] = process.env[name];
    delete process.env.TMUX_SOCKET_NAME;
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    Object.assign(process.env, createBotEnvironment({}));
  });

  // The DEFAULT socket of a private folder — the path a Telegram instance's tmux calls take, never the real default server —
  // and a fresh folder per case: a server killed by the case before may still be leaving its socket when the next starts one.
  beforeEach(() => {
    socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-env-default-tmux-'));
    process.env.TMUX_TMPDIR = socketDir;
    // tmux makes this folder itself only for a server it finds through TMUX_TMPDIR, not for one named with `-S`.
    fs.mkdirSync(path.dirname(getSocketPath()), { mode: 0o700 });
  });

  afterEach(async () => {
    const { TMUX: _userTmuxServer, TMUX_PANE: _userTmuxPane, ...envWithoutTmux } = process.env;
    await execFileAsync('tmux', ['-S', getSocketPath(), 'kill-server'], { env: envWithoutTmux }).catch(() => {});
    fs.rmSync(socketDir, { recursive: true, force: true });
  });

  after(() => {
    for (const name of touchedNames) {
      if (savedValues[name] === undefined) delete process.env[name];
      else process.env[name] = savedValues[name];
    }
  });

  async function readGlobalNames(): Promise<string[]> {
    return getEnvNames((await runTmuxAs(getChildProcessEnvironment(), 'show-environment', '-g')).stdout);
  }

  it('with no server running, dropping them starts none', async (context) => {
    if (!isTmuxAvailable) {
      context.skip('tmux is not installed');
      return;
    }
    await removeBotSecretsFromTmuxServer();
    assert.equal(fs.existsSync(getSocketPath()), false);
  });

  it('a server the bot starts for an agent\'s session gets the user\'s variables, not the bot\'s secrets', async (context) => {
    if (!isTmuxAvailable) {
      context.skip('tmux is not installed');
      return;
    }
    await startAgentTmuxSession('new-session', '-d', '-s', 'probe', 'sleep 60');
    const names = await readGlobalNames();
    assert.ok(names.includes(userToolVariableName), 'the server environment was read');
    for (const name of botSecretEnvironmentNames) assert.ok(!names.includes(name), name);
  });

  it('a server an older bot started with them loses them before a terminal is opened on it, and the terminal\'s shell has none', async (context) => {
    if (!isTmuxAvailable) {
      context.skip('tmux is not installed');
      return;
    }
    await runTmuxAs(createBotEnvironment(), 'new-session', '-d', '-s', 'older-bot', 'sleep 60');
    assert.ok((await readGlobalNames()).includes('TELEGRAM_BOT_TOKEN'), 'precondition: the server holds the token');

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-env-terminal-'));
    const terminal = new TerminalAdapter();
    const key = makeTelegramKey(-1001111111111, 77);
    const dumpPath = path.join(workDir, 'shell-env.txt');
    try {
      await terminal.startSession(key, workDir);
      const sessionName = (await tmuxAsync('list-sessions', '-F', '#{session_name}')).split('\n').find((name) => name !== 'older-bot');
      assert.ok(sessionName, 'the terminal session exists');
      // The second guard, for a server whose environment could not be cleared: the shell itself starts under `env -u`.
      const startCommand = await tmuxAsync('display-message', '-p', '-t', getTmuxPaneTarget(sessionName), '#{pane_start_command}');
      for (const name of botSecretEnvironmentNames) assert.ok(startCommand.includes(`'-u' '${name}'`), `the shell starts without ${name}: ${startCommand}`);
      await tmuxAsync('send-keys', '-t', getTmuxPaneTarget(sessionName), `env > ${dumpPath}`, 'Enter');
      const deadline = Date.now() + 30_000;
      while (!(fs.existsSync(dumpPath) && fs.readFileSync(dumpPath, 'utf8').includes(`${userToolVariableName}=`)) && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
      const shellNames = getEnvNames(fs.readFileSync(dumpPath, 'utf8'));
      assert.ok(shellNames.includes(userToolVariableName), 'the shell\'s environment was read');
      for (const name of botSecretEnvironmentNames) assert.ok(!shellNames.includes(name), `the shell: ${name}`);
      for (const name of botSecretEnvironmentNames) assert.ok(!(await readGlobalNames()).includes(name), `the server: ${name}`);
    } finally {
      await terminal.stopSession(key);
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});
