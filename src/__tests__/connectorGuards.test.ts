/**
 * @description The isolation guards of Jira connector plan J3, as unit decisions
 * and as wiring: the connector set and every fail-closed guard (D6–D8), the env
 * loader reading ONLY `ENV_FILE` (D7), every tmux call on the instance's own
 * socket (D8), the Telegram call guard (D9), the boot scan touching only the
 * sessions of the platforms an instance serves (J1 review), and source checks
 * that each guard is wired where it must run.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getConnectorGuardErrors, getPreloadGuardErrors } from '../cli/connectorGuards';
import { loadEnvFiles } from '../cli/envLoader';
import { getTmuxBaseArgs, tmuxAsync, tmuxOrThrowAsync } from '../utils/tmuxExec';
import { installTelegramCallGuard, TelegramDisabledError, telegramCallRefusedLogPrefix } from '../connectors/telegram/telegramCallGuard';
import type { CallApiHost } from '../outputTrace';
import {
  checkIsServedConversation,
  getServedConversations,
  getServedPlatforms,
  parseConnectors,
} from '../platform/connectorSet';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { makeJiraKey } from '../connectors/jira/sessionKeyCodec';
import { getModulesLoadedBy } from './loadedModulesProbe';

const srcDir = path.join(__dirname, '..');
const placeholderSecret = 'placeholder-secret-value';
/** A Node the Jira connector runs on, so the other guards are tested alone. */
const supportedNodeVersion = '22.12.0';

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
    getConnectorGuardErrors({ env, hasJiraConfig, envFileAtLaunch: env.ENV_FILE, nodeVersion: supportedNodeVersion });

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
    const jiraErrors = getConnectorGuardErrors({ env: jiraOnlyEnv, hasJiraConfig: true, envFileAtLaunch: undefined, nodeVersion: supportedNodeVersion });
    assert.deepEqual(jiraErrors, ['ENV_FILE is set inside an env file: it may only come from the launching environment']);
    // An env file that redirects ENV_FILE elsewhere (a hot worker would read that one).
    assert.match(
      getConnectorGuardErrors({ env: jiraOnlyEnv, hasJiraConfig: true, envFileAtLaunch: '/srv/other.env', nodeVersion: supportedNodeVersion }).join('\n'),
      /ENV_FILE is set inside an env file/,
    );
    // Also on a Telegram instance, and never when the value came from the launch.
    assert.equal(getConnectorGuardErrors({ env: { ENV_FILE: '/srv/x.env' }, hasJiraConfig: false, envFileAtLaunch: undefined, nodeVersion: supportedNodeVersion }).length, 1);
    assert.deepEqual(getConnectorGuardErrors({ env: { ENV_FILE: '/srv/x.env' }, hasJiraConfig: false, envFileAtLaunch: '/srv/x.env', nodeVersion: supportedNodeVersion }), []);
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

  it('R20: a Jira instance refuses a Node below 22.12; a Telegram one does not care', () => {
    const withNode = (env: Record<string, string>, nodeVersion: string): string[] =>
      getConnectorGuardErrors({ env, hasJiraConfig: true, envFileAtLaunch: env.ENV_FILE, nodeVersion });
    const tooOld = 'CONNECTORS lists jira: Node 22.11.0 is too old — the Jira connector needs Node 22.12 or newer';
    assert.deepEqual(withNode(jiraOnlyEnv, '22.11.0'), [tooOld]);
    assert.match(withNode(jiraOnlyEnv, '20.19.1').join('\n'), /Node 20\.19\.1 is too old/);
    for (const supported of ['22.12.0', '22.23.1', '23.0.0', '24.4.1']) assert.deepEqual(withNode(jiraOnlyEnv, supported), [], supported);
    assert.deepEqual(withNode({}, '20.19.1'), []);
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

    // A regular file whose read fails for every user: root (the whole bot in a container runs as one) reads a
    // mode-000 file without complaint, while this one answers EIO.
    const unreadableFile = '/proc/self/mem';
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
    const host: CallApiHost = { callApi: async () => { sentCalls += 1; return true; } };
    installTelegramCallGuard(host);

    await assert.rejects(host.callApi('getMe', {}), TelegramDisabledError);
    await assert.rejects(host.callApi('sendMessage', { text: 'x' }), /"sendMessage" refused/);
    assert.equal(sentCalls, 0);
  });

  it('logs a refused call itself — a caller that swallows the rejection cannot hide it — once per method', async (context) => {
    const errorLines: string[] = [];
    context.mock.method(console, 'error', (line: string) => { errorLines.push(line); });
    const host: CallApiHost = { callApi: async () => true };
    installTelegramCallGuard(host);

    await host.callApi('sendChatAction', {}).catch(() => {});
    await assert.rejects(host.callApi('sendChatAction', {}), TelegramDisabledError);
    await host.callApi('sendMessage', { text: 'x' }).catch(() => {});

    assert.equal(errorLines.length, 2, 'a repeat of the same method is refused but not logged again');
    assert.ok(errorLines[0].startsWith(`${telegramCallRefusedLogPrefix} sendChatAction:`));
    assert.ok(errorLines[1].startsWith(`${telegramCallRefusedLogPrefix} sendMessage:`));
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

  it('checkIsServedConversation is the same rule for a single key', () => {
    const [topic, issue] = sessions;
    assert.equal(checkIsServedConversation(topic.key, getServedPlatforms(['telegram'])), true);
    assert.equal(checkIsServedConversation(issue.key, getServedPlatforms(['telegram'])), false);
    assert.equal(checkIsServedConversation(issue.key, getServedPlatforms(['telegram', 'jira'])), true);
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

  it('the boot restore of persisted questions and retries skips an unserved conversation (R10)', () => {
    const botSource = readSource('bot.ts');
    // Each skip must come before the scan first acts on the conversation.
    for (const [scanHeader, firstAction] of [
      ['function restorePendingQuestions(', 'getThreadAdapter(key)'],
    ] as const) {
      const start = botSource.indexOf(scanHeader);
      assert.ok(start >= 0, scanHeader);
      const body = botSource.slice(start, botSource.indexOf('\n}\n', start));
      const skip = body.indexOf('if (!checkIsServedConversation(key, ENV.servedPlatforms)) continue;');
      const action = body.indexOf(firstAction);
      assert.ok(action >= 0, `${scanHeader}: ${firstAction}`);
      assert.ok(skip >= 0 && skip < action, `${scanHeader} acts on every conversation`);
    }
    // The retries' restore is `restoreApiRetryTimers` (apiRetryKick.ts, whose own test proves a skipped record is
    // neither armed nor dropped): the bot hands it the served filter, and the module skips before it arms a timer.
    const restoreStart = botSource.indexOf('function restoreApiRetries(');
    assert.ok(restoreStart >= 0);
    assert.match(botSource.slice(restoreStart, botSource.indexOf('\n}\n', restoreStart)), /isServed: \(key\) => checkIsServedConversation\(key, ENV\.servedPlatforms\),/);
    const kickSource = readSource('apiRetryKick.ts');
    const retrySkip = kickSource.indexOf('if (!deps.isServed(key)) continue;');
    assert.ok(retrySkip >= 0 && retrySkip < kickSource.indexOf('setTimeout('), 'the retries\' restore acts on every conversation');
  });

  it('bot.ts imports nothing from the CLI layer (R10)', () => {
    assert.doesNotMatch(readSource('bot.ts'), /from '\.\/cli\//);
  });

  it('the guards load only their own small module set — they run before any env file is read (J4)', () => {
    const { projectModules } = getModulesLoadedBy('cli/connectorGuards.ts');
    // A module joins this list only once it is known to read no settings at load time.
    const allowed = [
      'cli/connectorGuards.ts', 'cli/envLoader.ts', 'connectors/jira/configFile.ts', 'platform/connectorSet.ts',
      'requests/requestGroup.ts', 'sessionKey.ts', 'state.ts', 'utils/agentEnvironment.ts', 'utils/autoContinueOnLimit.ts',
      'utils/compactOnIdle.ts', 'utils/displayVerbosity.ts', 'utils/minutesOverride.ts', 'utils/threadToggle.ts', 'utils/topicView.ts',
    ];
    assert.deepEqual(projectModules.filter((name) => !allowed.includes(name)), []);
    assert.ok(projectModules.includes('cli/connectorGuards.ts'), 'the probe is not vacuous');
  });
});
