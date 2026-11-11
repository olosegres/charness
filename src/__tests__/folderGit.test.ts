/**
 * @description `runGitInAgentFolder` — the git the bot runs in a topic's bound folder for its own reading (the bind's
 * welcome, the todo boards). That folder's `.git/config` is the agent's to write, so the bot must neither run what it
 * names nor hand it the bot's own secrets. Over a real repository:
 *  - a `core.fsmonitor` command the folder's config names is NOT run by a status read (plain `git status` runs it: the
 *    negative control that proves the fixture would catch it);
 *  - whatever git does start gets the bot's environment without `TELEGRAM_BOT_TOKEN` / `OPENCODE_PASSWORD`, and with the
 *    user's own variables.
 *
 * Test case: N/A - Charness has no Jira tracker.
 */

import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runGitInAgentFolder } from '../utils/folderGit';

const gitTimeoutMs = 30_000;
const userVariableName = 'CHARNESS_TEST_USER_TOOL_TOKEN';
const botSecretValue = 'placeholder-bot-secret';
const touchedNames = ['TELEGRAM_BOT_TOKEN', 'OPENCODE_PASSWORD', userVariableName];

let testDirectory = '';
let repositoryPath = '';
let monitorDumpPath = '';
const savedValues: Record<string, string | undefined> = {};

before(() => {
  for (const name of touchedNames) savedValues[name] = process.env[name];
  process.env.TELEGRAM_BOT_TOKEN = botSecretValue;
  process.env.OPENCODE_PASSWORD = botSecretValue;
  process.env[userVariableName] = 'placeholder-user-value';
});

after(() => {
  for (const name of touchedNames) {
    if (savedValues[name] === undefined) delete process.env[name];
    else process.env[name] = savedValues[name];
  }
});

beforeEach(() => {
  testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-folder-git-'));
  repositoryPath = path.join(testDirectory, 'repository');
  monitorDumpPath = path.join(testDirectory, 'monitor-env.txt');
  const monitorPath = path.join(testDirectory, 'monitor.sh');
  // What an agent could write into the folder's git config: a "file-system monitor" that is any command at all.
  fs.writeFileSync(monitorPath, `#!/bin/sh\nenv > '${monitorDumpPath}'\nexit 1\n`, { mode: 0o755 });
  execFileSync('git', ['init', '-q', repositoryPath]);
  execFileSync('git', ['-C', repositoryPath, 'config', 'core.fsmonitor', monitorPath]);
  fs.writeFileSync(path.join(repositoryPath, 'file.txt'), 'changed\n');
});

afterEach(() => {
  fs.rmSync(testDirectory, { recursive: true, force: true });
});

describe('runGitInAgentFolder', () => {
  it('reads a status without running the file-system monitor the folder\'s config names (plain git would run it)', async () => {
    execFileSync('git', ['-C', repositoryPath, 'status', '--porcelain']);
    assert.ok(fs.existsSync(monitorDumpPath), 'control: plain `git status` runs the configured monitor');
    fs.rmSync(monitorDumpPath);

    const status = await runGitInAgentFolder(repositoryPath, ['status', '--porcelain'], gitTimeoutMs);

    assert.equal(status, '?? file.txt', 'the status was read');
    assert.equal(fs.existsSync(monitorDumpPath), false, 'and the monitor never ran');
  });

  it('hands git — and whatever it starts — the bot\'s environment without its own secrets', async () => {
    // An alias that is a shell command shows the environment git hands what it runs.
    const printed = await runGitInAgentFolder(repositoryPath, ['-c', 'alias.printenv=!env', 'printenv'], gitTimeoutMs);
    assert.ok(printed !== null);
    const names = printed.split('\n').map((line) => line.slice(0, line.indexOf('=')));
    assert.ok(names.includes(userVariableName), 'the environment was printed, the user\'s variables in it');
    assert.ok(!names.includes('TELEGRAM_BOT_TOKEN'));
    assert.ok(!names.includes('OPENCODE_PASSWORD'));
  });

  it('a git that fails is null, not an error', async () => {
    assert.equal(await runGitInAgentFolder(path.join(testDirectory, 'missing'), ['symbolic-ref', '--short', 'HEAD'], gitTimeoutMs), null);
  });
});
