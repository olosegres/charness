/**
 * @description The J3 connector guards at PROCESS level (Jira connector plan
 * J3): the built CLI is spawned with a curated environment and must exit 1 with
 * the guard's message — before the console tee, the lock or the bot module.
 *
 * Safety of the test itself: every spawn also points `WORK_ROOT` at a folder
 * that does not exist, a check the CLI makes right AFTER the guards. Were a
 * guard missing, the process still exits there — never boots a bot — and the
 * test fails on the missing message. The environment is built from scratch, so
 * nothing exported in the developer's shell reaches the child.
 *
 * `scripts/run-isolated.sh` is run with a stand-in `node` that only prints what
 * it received, so the real CLI never starts from that test either.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const cliPath = path.resolve(__dirname, '..', '..', 'dist', 'cli.js');
const runIsolatedPath = path.resolve(__dirname, '..', '..', 'scripts', 'run-isolated.sh');
const placeholderSecret = 'placeholder-secret-value';
const spawnTimeoutMs = 10_000;

let tmpRoot: string;
let dataDir: string;
let missingWorkRoot: string;

before(() => {
  if (!fs.existsSync(cliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
});

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-j3-cli-'));
  dataDir = path.join(tmpRoot, 'data');
  fs.mkdirSync(dataDir);
  missingWorkRoot = path.join(tmpRoot, 'no-such-work-root');
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeEnvFile(lines: Record<string, string>): string {
  const envFile = path.join(tmpRoot, 'instance.env');
  const body = Object.entries({ DATA_DIR: dataDir, WORK_ROOT: missingWorkRoot, ...lines })
    .map(([name, value]) => `${name}=${value}`)
    .join('\n');
  fs.writeFileSync(envFile, `${body}\n`);
  return envFile;
}

function writeJiraConfig(): void {
  fs.writeFileSync(path.join(dataDir, 'jira.json'), '{}\n');
}

function runCli(env: Record<string, string>): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [cliPath], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: tmpRoot,
      DATA_DIR: dataDir,
      WORK_ROOT: missingWorkRoot,
      CLAUDE_BIN: '/bin/false',
      ...env,
    },
    cwd: tmpRoot,
    encoding: 'utf8',
    timeout: spawnTimeoutMs,
  });
  return { status: result.status, stderr: result.stderr };
}

const jiraInstance = { CONNECTORS: 'jira', TMUX_SOCKET_NAME: 'isolated' };

describe('the CLI refuses a start that breaks a connector guard', () => {
  it('a shell that marks the instance as Jira without ENV_FILE stops before any config file is read', () => {
    // The shared config holds a token; had it been read, its own guard would speak too.
    fs.mkdirSync(path.join(tmpRoot, '.config', 'telegramcode'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, '.config', 'telegramcode', '.env'), `TELEGRAM_BOT_TOKEN=${placeholderSecret}\n`);

    const { status, stderr } = runCli({ CONNECTORS: 'jira' });

    assert.equal(status, 1);
    assert.match(stderr, /\[startup\] CONNECTORS lists jira: set ENV_FILE/);
    assert.doesNotMatch(stderr, /TELEGRAM_BOT_TOKEN is set/, 'the shared config was never read');
  });

  it('a bot token with the telegram connector off', () => {
    writeJiraConfig();
    const envFile = writeEnvFile({ ...jiraInstance, TELEGRAM_BOT_TOKEN: placeholderSecret });

    const { status, stderr } = runCli({ ENV_FILE: envFile });

    assert.equal(status, 1);
    assert.match(stderr, /\[startup\] TELEGRAM_BOT_TOKEN is set but the telegram connector is off/);
    assert.ok(!stderr.includes(placeholderSecret), 'the token value is never printed');
  });

  it('a Jira instance without its jira.json', () => {
    const { status, stderr } = runCli({ ENV_FILE: writeEnvFile(jiraInstance) });

    assert.equal(status, 1);
    assert.match(stderr, /\[startup\] CONNECTORS lists jira but DATA_DIR has no jira\.json/);
  });

  it('a Jira instance on the default tmux server', () => {
    writeJiraConfig();
    const { status, stderr } = runCli({ ENV_FILE: writeEnvFile({ CONNECTORS: 'jira' }) });
    assert.equal(status, 1);
    assert.match(stderr, /\[startup\] CONNECTORS lists jira: set TMUX_SOCKET_NAME/);

    const named = runCli({ ENV_FILE: writeEnvFile({ CONNECTORS: 'jira', TMUX_SOCKET_NAME: 'default' }) });
    assert.equal(named.status, 1);
    assert.match(named.stderr, /\[startup\] TMUX_SOCKET_NAME must be a plain name other than "default"/);
  });

  it('a Jira-only instance with inherited Atlassian variables', () => {
    writeJiraConfig();
    const { status, stderr } = runCli({ ENV_FILE: writeEnvFile(jiraInstance), ATLASSIAN_API_TOKEN: placeholderSecret });

    assert.equal(status, 1);
    assert.match(stderr, /\[startup\] a Jira-only instance refuses Atlassian variables in its environment: ATLASSIAN_API_TOKEN/);
    assert.ok(!stderr.includes(placeholderSecret));
  });

  it('an ENV_FILE that is not a readable file stops the start instead of loading nothing', () => {
    // Loading nothing would boot on the inherited environment (here a shell bot token) as a Telegram bot.
    const instanceDirectory = path.join(tmpRoot, 'instance');
    fs.mkdirSync(instanceDirectory);

    const { status, stderr } = runCli({ ENV_FILE: instanceDirectory, TELEGRAM_BOT_TOKEN: placeholderSecret });

    assert.equal(status, 1);
    assert.match(stderr, /ENV_FILE is not a regular file/);
    assert.doesNotMatch(stderr, /WORK_ROOT does not exist/, 'stopped before the start went on');
  });

  it('an unparsable CONNECTORS in the shell stops before $PWD/.env could turn it into a Telegram start', () => {
    fs.writeFileSync(path.join(tmpRoot, '.env'), `CONNECTORS=telegram\nTELEGRAM_BOT_TOKEN=${placeholderSecret}\n`);

    const { status, stderr } = runCli({ CONNECTORS: 'jira,Telegram' });

    assert.equal(status, 1);
    assert.match(stderr, /\[startup\] CONNECTORS has unknown connector\(s\) Telegram/);
    assert.doesNotMatch(stderr, /WORK_ROOT does not exist/, 'stopped before the start went on');
  });

  it('ENV_FILE set inside a shared env file does not pass for an isolated start', () => {
    writeJiraConfig();
    fs.writeFileSync(
      path.join(tmpRoot, '.env'),
      `ENV_FILE=${path.join(tmpRoot, 'instance.env')}\nCONNECTORS=telegram,jira\nTMUX_SOCKET_NAME=isolated\nTELEGRAM_BOT_TOKEN=${placeholderSecret}\n`,
    );

    const { status, stderr } = runCli({});

    assert.equal(status, 1);
    assert.match(stderr, /\[startup\] ENV_FILE is set inside an env file/);
    assert.doesNotMatch(stderr, /WORK_ROOT does not exist/, 'stopped before the start went on');
  });
});

describe('scripts/run-isolated.sh', () => {
  let fakeBinDir: string;

  beforeEach(() => {
    // A stand-in `node`: prints its environment and arguments, starts nothing.
    fakeBinDir = path.join(tmpRoot, 'bin');
    fs.mkdirSync(fakeBinDir);
    fs.writeFileSync(path.join(fakeBinDir, 'node'), '#!/bin/sh\nenv\necho "ARGS:$*"\n', { mode: 0o755 });
  });

  function runIsolated(args: string[], extraEnv: Record<string, string> = {}): { status: number | null; stdout: string } {
    const result = spawnSync('/bin/sh', [runIsolatedPath, ...args], {
      env: {
        ...extraEnv,
        PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ''}`,
        HOME: tmpRoot,
        TELEGRAM_BOT_TOKEN: placeholderSecret,
        ATLASSIAN_API_TOKEN: placeholderSecret,
        CONNECTORS: 'telegram',
      },
      encoding: 'utf8',
      timeout: spawnTimeoutMs,
    });
    return { status: result.status, stdout: result.stdout };
  }

  it('hands the CLI a clean environment: only the allowed variables and ENV_FILE', () => {
    const envFile = writeEnvFile(jiraInstance);
    const { status, stdout } = runIsolated([envFile, 'hot']);

    assert.equal(status, 0);
    // PWD / SHLVL / OLDPWD are set by the stand-in's own shell, not passed in.
    const shellOwnNames = new Set(['PWD', 'SHLVL', 'OLDPWD']);
    const names = stdout
      .split('\n')
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => line.split('=')[0])
      .filter((name) => !shellOwnNames.has(name))
      .sort();
    assert.deepEqual(names, ['ENV_FILE', 'HOME', 'LANG', 'PATH', 'SHELL', 'TERM', 'USER']);
    assert.match(stdout, new RegExp(`^ENV_FILE=${envFile}$`, 'm'));
    assert.match(stdout, /ARGS:.*dist\/cli\.js hot$/m);
    assert.ok(!stdout.includes(placeholderSecret), 'no inherited secret reaches the instance');
  });

  it('passes IS_SANDBOX on when it is set (the telegramcode image runs the instance as root), and only then', () => {
    const envFile = writeEnvFile(jiraInstance);
    const { status, stdout } = runIsolated([envFile], { IS_SANDBOX: '1' });
    assert.equal(status, 0);
    assert.match(stdout, /^IS_SANDBOX=1$/m);
    assert.doesNotMatch(runIsolated([envFile]).stdout, /^IS_SANDBOX=/m);
  });

  it('refuses a relative, missing or non-file env file', () => {
    assert.equal(runIsolated(['instance.env']).status, 2);
    assert.equal(runIsolated([path.join(tmpRoot, 'missing.env')]).status, 2);
    assert.equal(runIsolated([tmpRoot]).status, 2);
  });
});
