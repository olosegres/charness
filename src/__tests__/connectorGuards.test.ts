/**
 * @description The isolation guards of Jira connector plan J3, as unit decisions
 * and as wiring: the connector set and every fail-closed guard (D6–D8), the env
 * loader reading ONLY `ENV_FILE` (D7), every tmux call on the instance's own
 * socket (D8), the Telegram call guard (D9), the boot scan touching only the
 * sessions of the platforms an instance serves (J1 review), and source checks
 * that each guard is wired where it must run.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getConnectorGuardErrors, getPreloadGuardErrors } from '../cli/connectorGuards';
import { loadEnvFiles } from '../cli/envLoader';
import { getTmuxBaseArgs, tmuxAsync, tmuxOrThrowAsync } from '../utils/tmuxExec';
import { installTelegramCallGuard, TelegramDisabledError } from '../connectors/telegram/telegramCallGuard';
import { getServedConversations, getServedPlatforms, parseConnectors } from '../platform/connectorSet';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { makeJiraKey } from '../connectors/jira/sessionKeyCodec';

const srcDir = path.join(__dirname, '..');
const placeholderSecret = 'placeholder-secret-value';

/** A Jira-only environment that passes every guard; each case breaks one thing. */
const jiraOnlyEnv = {
  CONNECTORS: 'jira',
  ENV_FILE: '/srv/instance/instance.env',
  TMUX_SOCKET_NAME: 'isolated',
};

describe('parseConnectors', () => {
  it('unset is Telegram only; a list is read in a fixed order', () => {
    assert.deepEqual(parseConnectors(undefined), { ok: true, connectors: ['telegram'] });
    assert.deepEqual(parseConnectors(' '), { ok: true, connectors: ['telegram'] });
    assert.deepEqual(parseConnectors('jira'), { ok: true, connectors: ['jira'] });
    assert.deepEqual(parseConnectors('jira, telegram'), { ok: true, connectors: ['telegram', 'jira'] });
  });

  it('an unknown or empty list fails', () => {
    assert.equal(parseConnectors('telegram,slack').ok, false);
    assert.equal(parseConnectors(',').ok, false);
  });

  it('the served platforms are the connectors', () => {
    assert.deepEqual([...getServedPlatforms(['jira'])], ['jira']);
  });
});

describe('getPreloadGuardErrors', () => {
  it('a shell that marks the instance as Jira must name its env file before any file is read', () => {
    assert.equal(getPreloadGuardErrors({ CONNECTORS: 'jira' }).length, 1);
    assert.deepEqual(getPreloadGuardErrors({ CONNECTORS: 'jira', ENV_FILE: '/srv/instance.env' }), []);
    assert.deepEqual(getPreloadGuardErrors({}), []);
  });

  it('a CONNECTORS the shell sets but that does not parse is refused before any file is read', () => {
    // A typo must not pass as "not Jira" and let the shared config files (another bot's token) be read.
    assert.match(getPreloadGuardErrors({ CONNECTORS: 'jira,Telegram' }).join('\n'), /unknown connector/);
    assert.match(getPreloadGuardErrors({ CONNECTORS: 'slack', ENV_FILE: '/srv/instance.env' }).join('\n'), /unknown connector/);
  });
});

describe('getConnectorGuardErrors', () => {
  const guard = (env: Record<string, string>, hasJiraConfig = true): string[] =>
    getConnectorGuardErrors({ env, hasJiraConfig, envFileAtLaunch: env.ENV_FILE });

  it('a well-formed Jira-only instance and a plain Telegram one pass', () => {
    assert.deepEqual(guard(jiraOnlyEnv), []);
    assert.deepEqual(guard({ TELEGRAM_BOT_TOKEN: placeholderSecret }, false), []);
  });

  it('a bot token with the telegram connector off is refused — without printing it', () => {
    const errors = guard({ ...jiraOnlyEnv, TELEGRAM_BOT_TOKEN: placeholderSecret });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /TELEGRAM_BOT_TOKEN is set but the telegram connector is off/);
    assert.ok(!errors[0].includes(placeholderSecret));
  });

  it('a Jira instance needs ENV_FILE, its jira.json and its own tmux server', () => {
    const { ENV_FILE: _envFile, ...withoutEnvFile } = jiraOnlyEnv;
    assert.match(guard(withoutEnvFile).join('\n'), /set ENV_FILE/);
    assert.match(guard(jiraOnlyEnv, false).join('\n'), /DATA_DIR has no jira\.json/);
    const { TMUX_SOCKET_NAME: _socket, ...withoutSocket } = jiraOnlyEnv;
    assert.match(guard(withoutSocket).join('\n'), /set TMUX_SOCKET_NAME/);
  });

  it('ENV_FILE that only an env file set is refused — the instance read the shared files', () => {
    // A shared config defining ENV_FILE + CONNECTORS would otherwise pass as an isolated start.
    const jiraErrors = getConnectorGuardErrors({ env: jiraOnlyEnv, hasJiraConfig: true, envFileAtLaunch: undefined });
    assert.deepEqual(jiraErrors, ['ENV_FILE is set inside an env file: it may only come from the launching environment']);
    // An env file that redirects ENV_FILE elsewhere (a hot worker would read that one).
    assert.match(
      getConnectorGuardErrors({ env: jiraOnlyEnv, hasJiraConfig: true, envFileAtLaunch: '/srv/other.env' }).join('\n'),
      /ENV_FILE is set inside an env file/,
    );
    // Also on a Telegram instance, and never when the value came from the launch.
    assert.equal(getConnectorGuardErrors({ env: { ENV_FILE: '/srv/x.env' }, hasJiraConfig: false, envFileAtLaunch: undefined }).length, 1);
    assert.deepEqual(getConnectorGuardErrors({ env: { ENV_FILE: '/srv/x.env' }, hasJiraConfig: false, envFileAtLaunch: '/srv/x.env' }), []);
  });

  it('a tmux socket name may not be the default server or a path, on any instance', () => {
    for (const socketName of ['default', '../live', '/tmp/live.sock', '']) {
      assert.match(guard({ ...jiraOnlyEnv, TMUX_SOCKET_NAME: socketName }).join('\n'), /TMUX_SOCKET_NAME/, socketName);
    }
    assert.match(guard({ TMUX_SOCKET_NAME: 'default' }).join('\n'), /TMUX_SOCKET_NAME/);
  });

  it('a Jira-only instance refuses Atlassian variables in its environment, naming them and nothing more', () => {
    const errors = guard({ ...jiraOnlyEnv, ATLASSIAN_API_TOKEN: placeholderSecret, ATLASSIAN_SITE_NAME: placeholderSecret });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /ATLASSIAN_API_TOKEN, ATLASSIAN_SITE_NAME/);
    assert.ok(!errors[0].includes(placeholderSecret));
    // Next to Telegram (whose tooling may use them) they are not this guard's business.
    assert.deepEqual(guard({ ...jiraOnlyEnv, CONNECTORS: 'telegram,jira', ATLASSIAN_SITE_NAME: placeholderSecret }), []);
  });

  it('an unparsable CONNECTORS is the error itself', () => {
    assert.match(guard({ CONNECTORS: 'slack' }).join('\n'), /unknown connector/);
  });
});

describe('loadEnvFiles with ENV_FILE', () => {
  const touchedKeys = ['ENV_FILE', 'J3_GLOBAL_VALUE', 'J3_LOCAL_VALUE', 'J3_INSTANCE_VALUE', 'J3_INHERITED_VALUE'];
  let tmpRoot: string;
  let originalHome: string | undefined;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-envfile-'));
    originalHome = process.env.HOME;
    originalEnv = Object.fromEntries(touchedKeys.map((key) => [key, process.env[key]]));
    process.env.HOME = tmpRoot;
    for (const dirName of ['telegramcode', 'telegram-code']) {
      fs.mkdirSync(path.join(tmpRoot, '.config', dirName), { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, '.config', dirName, '.env'), 'J3_GLOBAL_VALUE=from-global\n');
    }
    fs.writeFileSync(path.join(tmpRoot, '.env'), 'J3_LOCAL_VALUE=from-local\n');
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    for (const key of touchedKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('reads ONLY that file — no global, legacy or local config — and wins over the inherited value', () => {
    const envFile = path.join(tmpRoot, 'instance.env');
    fs.writeFileSync(envFile, 'J3_INSTANCE_VALUE=from-instance\nJ3_INHERITED_VALUE=from-instance\n');
    process.env.ENV_FILE = envFile;
    process.env.J3_INHERITED_VALUE = 'from-shell';

    assert.deepEqual(loadEnvFiles(tmpRoot), { loaded: [envFile] });
    assert.equal(process.env.J3_INSTANCE_VALUE, 'from-instance');
    assert.equal(process.env.J3_INHERITED_VALUE, 'from-instance');
    assert.equal(process.env.J3_GLOBAL_VALUE, undefined);
    assert.equal(process.env.J3_LOCAL_VALUE, undefined);
  });

  it('a relative or missing ENV_FILE fails instead of falling back to the shared files', () => {
    process.env.ENV_FILE = 'instance.env';
    assert.throws(() => loadEnvFiles(tmpRoot), /absolute path/);
    process.env.ENV_FILE = path.join(tmpRoot, 'missing.env');
    assert.throws(() => loadEnvFiles(tmpRoot), /does not exist/);
    assert.equal(process.env.J3_GLOBAL_VALUE, undefined);
  });

  it('an ENV_FILE that is a directory or unreadable fails instead of loading nothing', () => {
    // dotenv reports these read failures instead of throwing; a silent empty load
    // would start the instance on the inherited environment.
    const instanceDirectory = path.join(tmpRoot, 'instance');
    fs.mkdirSync(instanceDirectory);
    process.env.ENV_FILE = instanceDirectory;
    assert.throws(() => loadEnvFiles(tmpRoot), /not a regular file/);

    const unreadableFile = path.join(tmpRoot, 'unreadable.env');
    fs.writeFileSync(unreadableFile, 'J3_INSTANCE_VALUE=from-instance\n', { mode: 0o000 });
    process.env.ENV_FILE = unreadableFile;
    assert.throws(() => loadEnvFiles(tmpRoot), /could not be read/);
    assert.equal(process.env.J3_INSTANCE_VALUE, undefined);
    assert.equal(process.env.J3_GLOBAL_VALUE, undefined);
  });
});

describe('every tmux call on the instance\'s own server (D8)', () => {
  let fakeBinDir: string;
  let argvLog: string;
  let originalPath: string | undefined;
  let originalSocket: string | undefined;

  beforeEach(() => {
    // A stand-in `tmux` that only records its arguments: no tmux server, the default
    // one included, is ever reached by this test — even with the guard removed.
    fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-faketmux-'));
    argvLog = path.join(fakeBinDir, 'argv.log');
    fs.writeFileSync(path.join(fakeBinDir, 'tmux'), `#!/bin/sh\necho "$*" >> "${argvLog}"\n`, { mode: 0o755 });
    originalPath = process.env.PATH;
    originalSocket = process.env.TMUX_SOCKET_NAME;
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ''}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    if (originalSocket === undefined) delete process.env.TMUX_SOCKET_NAME;
    else process.env.TMUX_SOCKET_NAME = originalSocket;
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
  });

  it('TMUX_SOCKET_NAME puts -L <name> in front of both the best-effort and the strict call', async () => {
    process.env.TMUX_SOCKET_NAME = 'isolated';
    await tmuxAsync('list-sessions', '-F', '#{session_name}');
    await tmuxOrThrowAsync('kill-session', '-t', '=cjson-jira-PROJ-PROJ-1');

    assert.deepEqual(fs.readFileSync(argvLog, 'utf8').trim().split('\n'), [
      '-L isolated list-sessions -F #{session_name}',
      '-L isolated kill-session -t =cjson-jira-PROJ-PROJ-1',
    ]);
    assert.deepEqual(getTmuxBaseArgs(), ['-L', 'isolated']);
  });

  it('without it the call is unchanged (a Telegram instance on the default server)', async () => {
    delete process.env.TMUX_SOCKET_NAME;
    await tmuxAsync('list-sessions');
    assert.equal(fs.readFileSync(argvLog, 'utf8').trim(), 'list-sessions');
  });

  it('no other source file runs tmux itself', () => {
    const spawnTmuxRe = /\b(?:execFile|execFileSync|execFilePromise|spawn|spawnSync|exec|execSync)\(\s*['"`]tmux\b/;
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(fullPath);
        } else if (entry.name.endsWith('.ts') && spawnTmuxRe.test(fs.readFileSync(fullPath, 'utf8'))) {
          offenders.push(path.relative(srcDir, fullPath));
        }
      }
    };
    walk(srcDir);
    assert.deepEqual(offenders, [path.join('utils', 'tmuxExec.ts')]);
  });
});

describe('installTelegramCallGuard (D9)', () => {
  it('refuses every Bot API call before anything is sent', async () => {
    let sentCalls = 0;
    const host = { callApi: async () => { sentCalls += 1; return true; } };
    installTelegramCallGuard(host);

    await assert.rejects(host.callApi('getMe', {}), TelegramDisabledError);
    await assert.rejects(host.callApi('sendMessage', { text: 'x' }), /"sendMessage" refused/);
    assert.equal(sentCalls, 0);
  });
});

describe('getServedConversations (J1 review)', () => {
  const sessions = [
    { key: makeTelegramKey(-1001111111111, 20), sessionName: 'claude--1001111111111-20' },
    { key: makeJiraKey('PROJ-12'), sessionName: 'claude-jira-PROJ-PROJ-12' },
  ];

  it('a Telegram instance never adopts or kills a Jira session, and a Jira instance never a Telegram one', () => {
    assert.deepEqual(getServedConversations(sessions, getServedPlatforms(['telegram'])).map((s) => s.sessionName), ['claude--1001111111111-20']);
    assert.deepEqual(getServedConversations(sessions, getServedPlatforms(['jira'])).map((s) => s.sessionName), ['claude-jira-PROJ-PROJ-12']);
  });
});

describe('the guards are wired where they must run', () => {
  const readSource = (relativePath: string): string => fs.readFileSync(path.join(srcDir, relativePath), 'utf8');

  it('both CLI starts load the env only through the guarded loader, before any side effect', () => {
    const botStart = readSource(path.join('cli', 'bot.ts'));
    const hotStart = readSource(path.join('cli', 'hot.ts'));
    for (const source of [botStart, hotStart]) {
      assert.match(source, /loadEnvWithConnectorGuards\(/);
      assert.doesNotMatch(source, /\bloadEnvFiles\(/);
    }
    assert.ok(botStart.indexOf('loadEnvWithConnectorGuards(') < botStart.indexOf('installConsoleFileTap('));
    assert.ok(botStart.indexOf('loadEnvWithConnectorGuards(') < botStart.indexOf('acquireLock('));
    assert.ok(hotStart.indexOf('loadEnvWithConnectorGuards(') < hotStart.indexOf('await prepareHotOpenCodeServer('));
    assert.match(hotStart, /includes\('telegram'\)\) await prepareHotOpenCodeServer\(/);
  });

  it('bot.ts guards the Telegram client and filters every boot session scan by the served platforms', () => {
    const botSource = readSource('bot.ts');
    assert.match(botSource, /if \(!ENV\.isTelegramServed\) installTelegramCallGuard\(bot\.telegram\);/);
    // The token is not even read without Telegram — a second line behind the CLI guard.
    assert.match(botSource, /const botToken = isTelegramServed \? \(process\.env\.TELEGRAM_BOT_TOKEN \?\? ''\) : '';/);
    const scans = [...botSource.matchAll(/(.{0,60})\.listExistingTmuxSessions\(\)/g)];
    assert.ok(scans.length >= 3, 'the three tmux backends are scanned');
    for (const [, prefix] of scans) assert.match(prefix, /getServedConversations\(await \w+$/);
  });

  it('every boot scan of the bindings walks the served ones only (R10)', () => {
    const botSource = readSource('bot.ts');
    for (const scanHeader of [
      'async function reattachExistingSessions(',
      'function recoverLimitEpisodesFromDisk(',
      'function healSchedulerMcpForActiveSessions(',
    ]) {
      const start = botSource.indexOf(scanHeader);
      assert.ok(start >= 0, scanHeader);
      const body = botSource.slice(start, botSource.indexOf('\n}\n', start));
      assert.doesNotMatch(body, /state\.listBindings\(\)/, `${scanHeader} walks every binding`);
      assert.match(body, /getServedBindings\(\)/, scanHeader);
    }
    assert.match(botSource, /return getServedConversations\(state\.listBindings\(\), ENV\.servedPlatforms\);/);
  });

  it('bot.ts imports nothing from the CLI layer (R10)', () => {
    assert.doesNotMatch(readSource('bot.ts'), /from '\.\/cli\//);
  });
});
