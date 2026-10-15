/**
 * @description Coverage for `src/legacyMigration.ts` — the automatic, idempotent
 * move of the pre-rename config dir, default data dir and `TELEGRAMCODE_*` keys to
 * the Charness names. Every case runs against a temp home dir passed in as
 * `homeDir`, so nothing outside it is read or written.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  hasPendingLegacyMigration,
  migrateLegacyNames,
  migrateLegacyNamesUnderLock,
  type LegacyMigrationOptions,
} from '../legacyMigration';
import { resetLegacyNameState, resolveDefaultDataDir } from '../legacyNames';
import { lockPath, releaseLock } from '../instanceLock';

let homeDir: string;

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-migrate-'));
  resetLegacyNameState();
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
  resetLegacyNameState();
});

const legacyConfigDir = (): string => path.join(homeDir, '.config', 'telegramcode');
const olderConfigDir = (): string => path.join(homeDir, '.config', 'telegram-code');
const canonicalConfigDir = (): string => path.join(homeDir, '.config', 'charness');
const legacyDataDir = (): string => path.join(homeDir, '.telegramCode');
const canonicalDataDir = (): string => path.join(homeDir, '.charness');

function collect(options: Partial<LegacyMigrationOptions> = {}): {
  options: LegacyMigrationOptions;
  logged: string[];
  warned: string[];
} {
  const logged: string[] = [];
  const warned: string[] = [];
  return {
    logged,
    warned,
    options: {
      homeDir,
      env: {},
      log: (line) => logged.push(line),
      warn: (line) => warned.push(line),
      ...options,
    },
  };
}

function writeLegacyConfig(dir: string, content: string, mode = 0o600): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.env'), content, { mode });
  fs.chmodSync(path.join(dir, '.env'), mode);
}

function writeLegacyDataDir(): void {
  fs.mkdirSync(path.join(legacyDataDir(), 'jsonstream', 'thread-1'), { recursive: true });
  fs.writeFileSync(path.join(legacyDataDir(), 'state.json'), '{"marker":"state"}');
  fs.writeFileSync(path.join(legacyDataDir(), 'jsonstream', 'thread-1', 'stdout.jsonl'), 'line\n');
}

function expectSymlinkTo(linkPath: string, relativeTarget: string): void {
  assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true, `${linkPath} is a symlink`);
  assert.equal(fs.readlinkSync(linkPath), relativeTarget);
}

const legacyConfigContent =
  'TELEGRAM_BOT_TOKEN=123:abc\n' +
  'TELEGRAMCODE_EXTRA=one\n' +
  'export TELEGRAMCODE_OTHER="two words"\n' +
  '# TELEGRAMCODE_COMMENTED=kept\n' +
  'GROQ_API_KEY=key\n';

test('a fresh run moves both dirs, leaves relative symlinks, renames the keys and keeps a backup', () => {
  writeLegacyConfig(legacyConfigDir(), legacyConfigContent);
  writeLegacyDataDir();
  const { options, logged, warned } = collect();

  const result = migrateLegacyNames(options);

  // The data is where it is expected, under the new names.
  assert.equal(fs.readFileSync(path.join(canonicalDataDir(), 'state.json'), 'utf8'), '{"marker":"state"}');
  assert.equal(fs.readFileSync(path.join(canonicalDataDir(), 'jsonstream', 'thread-1', 'stdout.jsonl'), 'utf8'), 'line\n');
  // The old paths still work: through a RELATIVE symlink (survives a moved home dir).
  expectSymlinkTo(legacyDataDir(), '.charness');
  expectSymlinkTo(legacyConfigDir(), 'charness');
  assert.equal(fs.readFileSync(path.join(legacyDataDir(), 'state.json'), 'utf8'), '{"marker":"state"}');
  // The keys: only real assignments, comments and values untouched; the mode kept; a backup of the original.
  const migratedEnv = path.join(canonicalConfigDir(), '.env');
  assert.equal(
    fs.readFileSync(migratedEnv, 'utf8'),
    'TELEGRAM_BOT_TOKEN=123:abc\n' +
      'CHARNESS_EXTRA=one\n' +
      'export CHARNESS_OTHER="two words"\n' +
      '# TELEGRAMCODE_COMMENTED=kept\n' +
      'GROQ_API_KEY=key\n',
  );
  assert.equal(fs.statSync(migratedEnv).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(`${migratedEnv}.bak`, 'utf8'), legacyConfigContent);
  assert.equal(fs.statSync(`${migratedEnv}.bak`).mode & 0o777, 0o600);
  // One line per action, none of them a failure, none of them a value.
  assert.equal(logged.length, 3);
  assert.deepEqual(warned, []);
  assert.deepEqual(result.actions, logged);
  assert.match(logged[0], /^\[migrate\] moved ~\/\.config\/telegramcode to ~\/\.config\/charness; .* symlink/);
  assert.match(logged[1], /renamed 2 key\(s\) TELEGRAMCODE_\* to CHARNESS_\* in ~\/\.config\/charness\/\.env \(TELEGRAMCODE_EXTRA, TELEGRAMCODE_OTHER\)/);
  assert.match(logged[2], /^\[migrate\] moved ~\/\.telegramCode to ~\/\.charness; /);
  for (const line of logged) assert.doesNotMatch(line, /123:abc|two words|=one/, 'a value is never logged');
  // The process decides the default data dir again: from now on it is the new one.
  assert.equal(resolveDefaultDataDir(homeDir), canonicalDataDir());
});

test('a second run is a no-op: nothing moves, nothing is logged, no second backup', () => {
  writeLegacyConfig(legacyConfigDir(), legacyConfigContent);
  writeLegacyDataDir();
  migrateLegacyNames(collect().options);
  const snapshot = (): string =>
    JSON.stringify([
      fs.readdirSync(path.join(homeDir, '.config')).sort(),
      fs.readdirSync(canonicalConfigDir()).sort(),
      fs.readdirSync(homeDir).sort(),
      fs.readFileSync(path.join(canonicalConfigDir(), '.env'), 'utf8'),
    ]);
  const before = snapshot();
  const second = collect();

  assert.equal(hasPendingLegacyMigration(second.options), false);
  const result = migrateLegacyNames(second.options);

  assert.deepEqual(result, { actions: [], failures: [] });
  assert.deepEqual(second.logged, []);
  assert.deepEqual(second.warned, []);
  assert.equal(snapshot(), before);
  expectSymlinkTo(legacyDataDir(), '.charness');
});

test('a target that already exists is not touched, and the old dir stays a real dir', () => {
  writeLegacyConfig(legacyConfigDir(), 'TELEGRAMCODE_A=old\n');
  writeLegacyConfig(canonicalConfigDir(), 'TELEGRAM_BOT_TOKEN=new\n');
  writeLegacyDataDir();
  fs.mkdirSync(canonicalDataDir());
  fs.writeFileSync(path.join(canonicalDataDir(), 'state.json'), '{"marker":"new"}');
  const { options, logged, warned } = collect();

  assert.equal(hasPendingLegacyMigration(options), false);
  migrateLegacyNames(options);

  assert.deepEqual(logged, []);
  assert.deepEqual(warned, []);
  assert.equal(fs.lstatSync(legacyDataDir()).isDirectory(), true);
  assert.equal(fs.lstatSync(legacyConfigDir()).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(canonicalDataDir(), 'state.json'), 'utf8'), '{"marker":"new"}');
  assert.equal(fs.readFileSync(path.join(legacyConfigDir(), '.env'), 'utf8'), 'TELEGRAMCODE_A=old\n');
  assert.equal(fs.readFileSync(path.join(canonicalConfigDir(), '.env'), 'utf8'), 'TELEGRAM_BOT_TOKEN=new\n');
});

test('an explicit DATA_DIR is never touched, whatever it names — the config still moves', () => {
  writeLegacyConfig(legacyConfigDir(), legacyConfigContent);
  writeLegacyDataDir();
  const { options, logged } = collect({ env: { DATA_DIR: legacyDataDir() } });

  migrateLegacyNames(options);

  assert.equal(fs.lstatSync(legacyDataDir()).isDirectory(), true, 'still a real dir');
  assert.equal(fs.existsSync(canonicalDataDir()), false);
  assert.equal(fs.lstatSync(canonicalConfigDir()).isDirectory(), true);
  assert.equal(logged.length, 2, 'the config move and its keys, no data dir line');
  assert.ok(logged.every((line) => !line.includes('.telegramCode')));
});

test('an isolated instance (ENV_FILE) migrates nothing', () => {
  writeLegacyConfig(legacyConfigDir(), legacyConfigContent);
  writeLegacyDataDir();
  const { options, logged } = collect({ env: { ENV_FILE: path.join(homeDir, 'instance.env') } });

  assert.equal(hasPendingLegacyMigration(options), false);
  migrateLegacyNames(options);

  assert.deepEqual(logged, []);
  assert.equal(fs.lstatSync(legacyDataDir()).isDirectory(), true);
  assert.equal(fs.lstatSync(legacyConfigDir()).isDirectory(), true);
  assert.equal(fs.existsSync(canonicalConfigDir()), false);
});

test('an old path that is already a symlink (the operator\'s own) is skipped', () => {
  const elsewhere = path.join(homeDir, 'disk2', 'bot-state');
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.symlinkSync(elsewhere, legacyDataDir());
  const { options, logged } = collect();

  migrateLegacyNames(options);

  assert.deepEqual(logged, []);
  assert.equal(fs.readlinkSync(legacyDataDir()), elsewhere);
  assert.equal(fs.existsSync(canonicalDataDir()), false);
});

test('the older ~/.config/telegram-code moves when it is the only one, and the newer wins when both exist', () => {
  writeLegacyConfig(olderConfigDir(), 'TELEGRAMCODE_A=1\n');
  const only = collect();

  migrateLegacyNames(only.options);

  expectSymlinkTo(olderConfigDir(), 'charness');
  assert.equal(fs.readFileSync(path.join(canonicalConfigDir(), '.env'), 'utf8'), 'CHARNESS_A=1\n');
  assert.match(only.logged[0], /moved ~\/\.config\/telegram-code to ~\/\.config\/charness/);

  fs.rmSync(path.join(homeDir, '.config'), { recursive: true });
  writeLegacyConfig(legacyConfigDir(), 'FROM=telegramcode\n');
  writeLegacyConfig(olderConfigDir(), 'FROM=telegram-code\n');

  migrateLegacyNames(collect().options);

  assert.equal(fs.readFileSync(path.join(canonicalConfigDir(), '.env'), 'utf8'), 'FROM=telegramcode\n');
  assert.equal(fs.lstatSync(olderConfigDir()).isDirectory(), true, 'the older dir is left as it is');
});

test('a key that already has its CHARNESS_ twin, a missing .env and a symlinked .env are handled', () => {
  writeLegacyConfig(legacyConfigDir(), 'TELEGRAMCODE_A=old\nCHARNESS_A=new\nTELEGRAMCODE_B=b\r\n');
  const conflict = collect();

  migrateLegacyNames(conflict.options);

  assert.equal(
    fs.readFileSync(path.join(canonicalConfigDir(), '.env'), 'utf8'),
    'TELEGRAMCODE_A=old\nCHARNESS_A=new\nCHARNESS_B=b\r\n',
    'the conflicting key stays, the other is renamed, CRLF is kept',
  );
  assert.match(conflict.logged[1], /renamed 1 key\(s\).*\(TELEGRAMCODE_B\)/);

  // No .env in the dir at all: the dir moves, nothing else is said.
  fs.rmSync(path.join(homeDir, '.config'), { recursive: true });
  fs.mkdirSync(legacyConfigDir(), { recursive: true });
  fs.writeFileSync(path.join(legacyConfigDir(), 'other-file'), 'x');
  const noEnv = collect();
  migrateLegacyNames(noEnv.options);
  assert.equal(noEnv.logged.length, 1);
  assert.deepEqual(noEnv.warned, []);

  // A .env that is a link into the operator's dotfiles: the real file is rewritten, the link stays.
  fs.rmSync(path.join(homeDir, '.config'), { recursive: true });
  const dotfile = path.join(homeDir, 'dotfiles', 'charness.env');
  fs.mkdirSync(path.dirname(dotfile), { recursive: true });
  fs.writeFileSync(dotfile, 'TELEGRAMCODE_C=c\n');
  fs.mkdirSync(legacyConfigDir(), { recursive: true });
  fs.symlinkSync(dotfile, path.join(legacyConfigDir(), '.env'));
  migrateLegacyNames(collect().options);
  assert.equal(fs.readFileSync(dotfile, 'utf8'), 'CHARNESS_C=c\n');
  assert.equal(fs.lstatSync(path.join(canonicalConfigDir(), '.env')).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(`${dotfile}.bak`, 'utf8'), 'TELEGRAMCODE_C=c\n');
});

test('keys left by a start whose rename failed are renamed at the next start — only behind our own symlink', () => {
  // The earlier start moved the dir, left the symlink, and failed before the rewrite.
  fs.mkdirSync(path.join(homeDir, '.config'), { recursive: true });
  writeLegacyConfig(canonicalConfigDir(), 'TELEGRAMCODE_A=1\n');
  fs.symlinkSync('charness', legacyConfigDir());
  const repaired = collect();

  assert.equal(hasPendingLegacyMigration(repaired.options), true);
  migrateLegacyNames(repaired.options);

  assert.equal(fs.readFileSync(path.join(canonicalConfigDir(), '.env'), 'utf8'), 'CHARNESS_A=1\n');
  assert.equal(repaired.logged.length, 1);

  // A charness dir the operator made by hand (no legacy dir, no symlink) keeps whatever keys it has.
  fs.rmSync(path.join(homeDir, '.config'), { recursive: true });
  writeLegacyConfig(canonicalConfigDir(), 'TELEGRAMCODE_A=1\n');
  const handMade = collect();
  migrateLegacyNames(handMade.options);
  assert.equal(fs.readFileSync(path.join(canonicalConfigDir(), '.env'), 'utf8'), 'TELEGRAMCODE_A=1\n');
  assert.deepEqual(handMade.logged, []);
});

test('a second backup never overwrites the first', () => {
  fs.mkdirSync(path.join(homeDir, '.config'), { recursive: true });
  writeLegacyConfig(canonicalConfigDir(), 'TELEGRAMCODE_A=1\n');
  fs.writeFileSync(path.join(canonicalConfigDir(), '.env.bak'), 'the first backup');
  fs.symlinkSync('charness', legacyConfigDir());

  migrateLegacyNames(collect().options);

  assert.equal(fs.readFileSync(path.join(canonicalConfigDir(), '.env.bak'), 'utf8'), 'the first backup');
  const extraBackups = fs.readdirSync(canonicalConfigDir()).filter((name) => /^\.env\.bak\.\d+$/.test(name));
  assert.equal(extraBackups.length, 1);
});

test('a move that fails (another filesystem) is logged, leaves both sides usable and skips its key rename', () => {
  writeLegacyConfig(legacyConfigDir(), 'TELEGRAMCODE_A=1\n');
  writeLegacyDataDir();
  const crossDevice = Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
  const { options, logged, warned } = collect({
    fsOps: {
      ...fs,
      renameSync: (from: fs.PathLike, to: fs.PathLike) => {
        if (String(from) === legacyDataDir()) throw crossDevice;
        fs.renameSync(from, to);
      },
    },
  });

  const result = migrateLegacyNames(options);

  // The data dir stays a usable real dir; the config move was independent and went through.
  assert.equal(fs.lstatSync(legacyDataDir()).isDirectory(), true);
  assert.equal(fs.existsSync(canonicalDataDir()), false);
  assert.equal(fs.readFileSync(path.join(legacyDataDir(), 'state.json'), 'utf8'), '{"marker":"state"}');
  expectSymlinkTo(legacyConfigDir(), 'charness');
  assert.equal(warned.length, 1);
  assert.match(warned[0], /could not move ~\/\.telegramCode to ~\/\.charness \(EXDEV.*\): it stays where it is and is still used/);
  assert.equal(logged.length, 2);
  assert.deepEqual(result.failures, warned);
  // The default data dir is still the old one for this process.
  assert.equal(resolveDefaultDataDir(homeDir), legacyDataDir());
});

test('a failing symlink rolls the move back, so the old path is never left missing', () => {
  writeLegacyDataDir();
  const { options, warned } = collect({
    fsOps: {
      ...fs,
      symlinkSync: () => {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      },
    },
  });

  migrateLegacyNames(options);

  assert.equal(fs.lstatSync(legacyDataDir()).isDirectory(), true);
  assert.equal(fs.existsSync(canonicalDataDir()), false);
  assert.equal(fs.readFileSync(path.join(legacyDataDir(), 'state.json'), 'utf8'), '{"marker":"state"}');
  assert.equal(warned.length, 1);
});

test('under the lock: takes it, migrates, releases it; with nothing to do it never touches the lock', () => {
  const savedHome = process.env.HOME;
  const savedDataDir = process.env.DATA_DIR;
  process.env.HOME = homeDir;
  delete process.env.DATA_DIR;
  try {
    const idle = collect({ env: process.env });
    migrateLegacyNamesUnderLock(idle.options);
    assert.equal(fs.existsSync(canonicalDataDir()), false, 'a fresh home: no lock taken, no dir made');

    writeLegacyDataDir();
    const { options, logged } = collect({ env: process.env });
    const result = migrateLegacyNamesUnderLock(options);

    assert.equal(result.actions.length, 1);
    assert.equal(logged.length, 1);
    expectSymlinkTo(legacyDataDir(), '.charness');
    assert.equal(fs.existsSync(path.join(canonicalDataDir(), 'instance.lock')), false, 'the lock was released');
  } finally {
    releaseLock();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = savedDataDir;
  }
});

test('under the lock: an instance that holds it blocks the migration, which says so and moves nothing', () => {
  const savedHome = process.env.HOME;
  const savedDataDir = process.env.DATA_DIR;
  process.env.HOME = homeDir;
  delete process.env.DATA_DIR;
  try {
    writeLegacyDataDir();
    // pid 1 is always alive and never us: a live holder with another token.
    fs.writeFileSync(
      lockPath(),
      JSON.stringify({ pid: 1, cwd: '/elsewhere', startedAt: '2026-01-01T00:00:00.000Z', tokenHash: 'aaaaaaaaaaaa' }),
    );
    const { options, logged, warned } = collect({ env: process.env });

    migrateLegacyNamesUnderLock(options);

    assert.deepEqual(logged, []);
    assert.equal(warned.length, 1);
    assert.match(warned[0], /skipped: another instance holds the lock/);
    assert.equal(fs.lstatSync(legacyDataDir()).isDirectory(), true);
    assert.equal(fs.existsSync(canonicalDataDir()), false);
    assert.equal(fs.existsSync(path.join(legacyDataDir(), 'instance.lock')), true, 'the holder\'s lock is not ours to remove');
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = savedDataDir;
  }
});

test('the migration is wired at a cold start only: after the lock and before the bot, never from the hot worker', () => {
  const read = (relative: string): string => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
  const botStart = read('cli/bot.ts');
  const hotSupervisor = read('cli/hot.ts');
  const workerEntry = read('cli/botEntry.ts');

  // Plain start: under the lock, before the bot module (and so its state) loads, skipped for a hot worker.
  const lock = botStart.indexOf('await acquireLock();');
  const migrate = botStart.indexOf('if (!options.isHotWorker) migrateLegacyNames();');
  const announce = botStart.indexOf('warnLegacyNamesAtBoot();');
  const importBot = botStart.indexOf("await import('../bot')");
  assert.ok(lock >= 0 && migrate > lock, 'migrates after the lock is held');
  assert.ok(announce > migrate, 'announces only what the migration left');
  assert.ok(importBot > announce, 'before the state is loaded');

  // The worker entry says it is a worker, so a reload never migrates.
  assert.match(workerEntry, /runBot\(\{ isHotWorker: true \}\)/);

  // The supervisor's start: right after its env is read, before it resolves any path in the data dir.
  const supervisorLoad = hotSupervisor.indexOf('loadEnvWithConnectorGuards(projectRoot);');
  const supervisorMigrate = hotSupervisor.indexOf('migrateLegacyNamesUnderLock();');
  const supervisorOwnership = hotSupervisor.indexOf('setOpenCodeOwnershipFileEnv(');
  assert.ok(supervisorLoad >= 0 && supervisorMigrate > supervisorLoad);
  assert.ok(supervisorOwnership > supervisorMigrate, 'the ownership file path is resolved after the move');
});
