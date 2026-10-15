/**
 * @description Coverage for `src/legacyNames.ts` — the fallbacks to the names the
 * project had before the TelegramCode → Charness rename: the default `DATA_DIR`,
 * the global config dir and the hot-mode handshake variables. Every fallback must
 * (1) lose to the new name, (2) be used when only the old name exists, and
 * (3) be announced once per process, naming the migration doc.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  findLegacyNameUses,
  formatDeprecation,
  hotReloadEnvName,
  openCodeProcessFileEnvName,
  readRenamedEnv,
  renameMigrationDoc,
  resetLegacyNameState,
  resolveDefaultDataDir,
  resolveGlobalConfigEnvPath,
  warnLegacyNameOnce,
  warnLegacyNamesAtBoot,
} from '../legacyNames';
import { resolveDataDir } from '../state';

let homeDir: string;
let savedHome: string | undefined;
let savedDataDir: string | undefined;

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-legacy-'));
  savedHome = process.env.HOME;
  savedDataDir = process.env.DATA_DIR;
  process.env.HOME = homeDir;
  delete process.env.DATA_DIR;
  resetLegacyNameState();
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = savedDataDir;
  fs.rmSync(homeDir, { recursive: true, force: true });
  resetLegacyNameState();
});

function collect(): { lines: string[]; write: (text: string) => void } {
  const lines: string[] = [];
  return { lines, write: (text) => lines.push(text) };
}

test('default DATA_DIR: ~/.charness on a fresh home', () => {
  assert.equal(resolveDefaultDataDir(homeDir), path.join(homeDir, '.charness'));
  assert.equal(resolveDataDir(), path.join(homeDir, '.charness'), 'the bot, the lock and the OpenCode host agree');
});

test('default DATA_DIR: an existing ~/.telegramCode is kept while ~/.charness does not exist', () => {
  fs.mkdirSync(path.join(homeDir, '.telegramCode'));

  assert.equal(resolveDefaultDataDir(homeDir), path.join(homeDir, '.telegramCode'));
  assert.equal(resolveDataDir(), path.join(homeDir, '.telegramCode'));
  assert.equal(fs.existsSync(path.join(homeDir, '.charness')), false, 'nothing is created or moved');
});

test('default DATA_DIR: decided once per process — a ~/.charness that appears later does not move it', () => {
  fs.mkdirSync(path.join(homeDir, '.telegramCode'));
  assert.equal(resolveDefaultDataDir(homeDir), path.join(homeDir, '.telegramCode'));

  fs.mkdirSync(path.join(homeDir, '.charness'));

  assert.equal(resolveDefaultDataDir(homeDir), path.join(homeDir, '.telegramCode'));
  resetLegacyNameState();
  assert.equal(resolveDefaultDataDir(homeDir), path.join(homeDir, '.charness'), 'a restart decides again');
});

test('default DATA_DIR: ~/.charness wins when both exist', () => {
  fs.mkdirSync(path.join(homeDir, '.telegramCode'));
  fs.mkdirSync(path.join(homeDir, '.charness'));

  assert.equal(resolveDefaultDataDir(homeDir), path.join(homeDir, '.charness'));
});

test('default DATA_DIR: an explicit DATA_DIR always wins', () => {
  fs.mkdirSync(path.join(homeDir, '.telegramCode'));
  fs.mkdirSync(path.join(homeDir, '.charness'));
  process.env.DATA_DIR = path.join(homeDir, 'elsewhere');

  assert.equal(resolveDataDir(), path.join(homeDir, 'elsewhere'));
  assert.deepEqual(findLegacyNameUses({ DATA_DIR: process.env.DATA_DIR }, homeDir), []);
});

test('global config: charness, then telegramcode, then telegram-code', () => {
  const dirs = ['charness', 'telegramcode', 'telegram-code'].map((name) => path.join(homeDir, '.config', name));
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.env'), 'X=1\n');
  }

  assert.equal(resolveGlobalConfigEnvPath(homeDir), path.join(dirs[0], '.env'));
  fs.rmSync(dirs[0], { recursive: true });
  assert.equal(resolveGlobalConfigEnvPath(homeDir), path.join(dirs[1], '.env'));
  fs.rmSync(dirs[1], { recursive: true });
  assert.equal(resolveGlobalConfigEnvPath(homeDir), path.join(dirs[2], '.env'));
  fs.rmSync(dirs[2], { recursive: true });
  assert.equal(
    resolveGlobalConfigEnvPath(homeDir),
    path.join(homeDir, '.config', 'charness', '.env'),
    'none exists: the location a fresh install should use',
  );
});

test('renamed env: the new name wins, the old name is the fallback, empty counts as unset', () => {
  assert.equal(readRenamedEnv({}, hotReloadEnvName), undefined);
  assert.equal(readRenamedEnv({ TELEGRAMCODE_HOT_RELOAD: '1' }, hotReloadEnvName), '1');
  assert.equal(readRenamedEnv({ CHARNESS_HOT_RELOAD: 'new', TELEGRAMCODE_HOT_RELOAD: 'old' }, hotReloadEnvName), 'new');
  assert.equal(readRenamedEnv({ CHARNESS_HOT_RELOAD: '', TELEGRAMCODE_HOT_RELOAD: 'old' }, hotReloadEnvName), 'old');
});

test('findLegacyNameUses: nothing is reported on a fresh, fully renamed instance', () => {
  assert.deepEqual(
    findLegacyNameUses(
      { CHARNESS_HOT_RELOAD: '1', CHARNESS_OPENCODE_PROCESS_FILE: '/x', TELEGRAMCODE_HOT_RELOAD: '1' },
      homeDir,
    ),
    [],
    'a legacy variable next to the new one is not a fallback in use',
  );
});

test('findLegacyNameUses: every fallback in use is reported with the old name, the new name and the doc', () => {
  fs.mkdirSync(path.join(homeDir, '.telegramCode'));
  fs.mkdirSync(path.join(homeDir, '.config', 'telegramcode'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.config', 'telegramcode', '.env'), 'X=1\n');

  const uses = findLegacyNameUses(
    { TELEGRAMCODE_HOT_RELOAD: '1', TELEGRAMCODE_OPENCODE_PROCESS_FILE: '/x' },
    homeDir,
  );

  assert.deepEqual(
    uses.map((use) => use.key).sort(),
    [
      'default-data-dir',
      'env:TELEGRAMCODE_HOT_RELOAD',
      'env:TELEGRAMCODE_OPENCODE_PROCESS_FILE',
      'global-config-dir',
    ],
  );
  const messages = uses.map((use) => use.message);
  assert.ok(messages.includes(formatDeprecation('~/.telegramCode', '~/.charness')));
  assert.ok(messages.includes(formatDeprecation('~/.config/telegramcode', '~/.config/charness')));
  assert.ok(messages.some((message) => message.startsWith('TELEGRAMCODE_HOT_RELOAD is deprecated') && message.includes('CHARNESS_HOT_RELOAD')));
  for (const message of messages) assert.match(message, new RegExp(renameMigrationDoc));
  assert.equal(openCodeProcessFileEnvName.current, 'CHARNESS_OPENCODE_PROCESS_FILE');
});

test('an isolated instance (ENV_FILE) reads no global config, so it has nothing to announce about it', () => {
  fs.mkdirSync(path.join(homeDir, '.config', 'telegramcode'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.config', 'telegramcode', '.env'), 'X=1\n');

  assert.deepEqual(findLegacyNameUses({ ENV_FILE: '/srv/instance.env', DATA_DIR: '/srv/data' }, homeDir), []);
});

test('warnLegacyNamesAtBoot: each fallback is printed once, however often it is asked', () => {
  fs.mkdirSync(path.join(homeDir, '.telegramCode'));
  const sink = collect();

  warnLegacyNamesAtBoot({}, homeDir, sink.write);
  warnLegacyNamesAtBoot({}, homeDir, sink.write);

  assert.equal(sink.lines.length, 1);
  assert.match(sink.lines[0], /^\[deprecated\] ~\/\.telegramCode is deprecated, rename it to ~\/\.charness \(see MIGRATION_RENAME_TO_CHARNESS\.md\)\n$/);
});

test('warnLegacyNameOnce: once per key, independent between keys', () => {
  const sink = collect();

  assert.equal(warnLegacyNameOnce('a', 'first', sink.write), true);
  assert.equal(warnLegacyNameOnce('a', 'first again', sink.write), false);
  assert.equal(warnLegacyNameOnce('b', 'second', sink.write), true);

  assert.deepEqual(sink.lines, ['[deprecated] first\n', '[deprecated] second\n']);
});
