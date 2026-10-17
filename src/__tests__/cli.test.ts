/**
 * @description End-to-end coverage for the `charness` CLI dispatcher.
 *
 * Spawns the CLI as a subprocess (via `tsx`, the same way `yarn dev` runs
 * it) and asserts on stdio + exit code. This catches integration concerns
 * the per-module unit tests miss:
 *
 *   - argv branching (no-arg bot startup vs unknown; removed internal/public
 *     subcommands stay unknown)
 *   - the bot preflight (env load, WORK_ROOT default, lock acquire) runs
 *
 * The bot path is not exercised past preflight — booting the real
 * `startBot()` would try to connect to Telegram. The preflight internals
 * are covered separately by `state.test.ts` and `lock.test.ts`.
 */

import { test, beforeEach, afterEach, before } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let tmpRoot: string;
let claudeShim: string;
// Use the built artifact rather than `--import tsx` so the test doesn't
// depend on Node's module resolution finding `tsx` from a tmpdir cwd. The
// `before()` hook guards against running the test against stale output.
const cliPath = path.resolve(__dirname, '..', '..', 'dist', 'cli.js');
const botEntryPath = path.resolve(__dirname, '..', '..', 'dist', 'cli', 'botEntry.js');

before(() => {
  if (!fs.existsSync(cliPath) || !fs.existsSync(botEntryPath)) {
    throw new Error(
      'Built CLI entries are missing. Run `yarn build` before `yarn test`.',
    );
  }
});

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-cli-e2e-'));
  // A tiny no-op shim CLAUDE_BIN points at, so no spawned subprocess can
  // ever invoke a real claude on the dev machine.
  claudeShim = path.join(tmpRoot, 'claude-shim');
  fs.writeFileSync(claudeShim, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Helper: spawn the CLI with the given subcommand args and a curated env.
 * Always points CLAUDE_BIN at the shim so we never accidentally invoke a
 * real claude on the dev machine. Always points HOME / DATA_DIR at the tmp
 * dir so the lockfile can't collide with reality.
 */
function runCli(
  args: string[],
  extraEnv: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [cliPath, ...args], {
    env: {
      ...process.env,
      CLAUDE_BIN: claudeShim,
      HOME: tmpRoot,
      DATA_DIR: tmpRoot,
      ...extraEnv,
    },
    cwd: tmpRoot,
    encoding: 'utf8',
    timeout: 10_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function getRegexEscapedCanonicalPath(filePath: string): string {
  // Child cwd can canonicalize symlinked temp roots (/var -> /private/var) on macOS.
  return fs.realpathSync(filePath).replace(/\//g, '\\/');
}

test('unknown subcommand exits 2 with usage', () => {
  const { status, stderr } = runCli(['frobnicate']);
  assert.equal(status, 2);
  assert.match(stderr, /Unknown command: frobnicate/);
  assert.match(stderr, /Usage:/);
});

test('removed `cli` passthrough is an unknown command (exit 2, no claude spawn)', () => {
  const { status, stderr } = runCli(['cli', 'claude']);
  assert.equal(status, 2);
  assert.match(stderr, /Unknown command: cli/);
  assert.match(stderr, /Usage:/);
});

test('removed `bot` worker entry is an unknown command', () => {
  const { status, stderr } = runCli(['bot']);
  assert.equal(status, 2);
  assert.match(stderr, /Unknown command: bot/);
  assert.match(stderr, /Usage:/);
});

test('claude-profiles reads the bot cache off DATA_DIR/state.json: --best prints the dir to launch under (empty for default), --json the report, a bad flag exits 2', () => {
  const soon = new Date(Date.now() + 3_600_000).toISOString();
  const bucket = (kind: string, percent: number, scopeModel: string | null = null) => ({ kind, percent, resetsAt: soon, scopeModel });
  fs.writeFileSync(path.join(tmpRoot, 'state.json'), JSON.stringify({
    claudeProfiles: {
      default: { createdAt: '2026-10-01T00:00:00.000Z', loggedIn: true, email: 'me@example.com', subscriptionType: 'max',
        usage: { fetchedAt: soon, source: 'api', buckets: [bucket('session', 20), bucket('weekly_all', 30), bucket('weekly_scoped', 95, 'Fable')] } },
      work: { createdAt: '2026-10-02T00:00:00.000Z', loggedIn: true, email: 'w@example.com', subscriptionType: 'pro',
        usage: { fetchedAt: soon, source: 'api', buckets: [bucket('session', 30), bucket('weekly_all', 40), bucket('weekly_scoped', 10, 'Fable')] } },
    },
  }));
  const fable = runCli(['claude-profiles', '--best', '--model', 'fable']);
  assert.equal(fable.status, 0, fable.stderr);
  assert.equal(fable.stdout, `${path.join(tmpRoot, 'claude-profiles', 'work')}\n`);
  const opus = runCli(['claude-profiles', '--best', '--model=opus']);
  assert.equal(opus.status, 0, opus.stderr);
  assert.equal(opus.stdout, '\n', 'the default profile is an empty line: set no CLAUDE_CONFIG_DIR');
  const json = runCli(['claude-profiles', '--json', '--model', 'fable']);
  assert.equal(json.status, 0, json.stderr);
  const report = JSON.parse(json.stdout) as { recommended: string; profiles: Array<{ name: string; configDir: string | null; headroomPercent: number | null }> };
  assert.equal(report.recommended, 'work');
  assert.deepEqual(report.profiles.map((profile) => [profile.name, profile.configDir === null, profile.headroomPercent]), [['default', true, 5], ['work', false, 60]], 'Fable: default is at 95 % on Fable\'s own window, work at 40 % on the shared weekly one');
  const human = runCli(['claude-profiles']);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /✓ default .*5h 20% 🔄 /);
  assert.match(human.stdout, /• work .*Fable 10% 🔄 /);
  assert.match(human.stdout, /recommended for any model: default/);
  const bad = runCli(['claude-profiles', '--frob']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown option: --frob/);
});

test('claude-profiles with no state file: default is the only profile, with unknown usage, and is recommended', () => {
  const best = runCli(['claude-profiles', '--best']);
  assert.equal(best.status, 0, best.stderr);
  assert.equal(best.stdout, '\n');
  const human = runCli(['claude-profiles']);
  assert.match(human.stdout, /✓ default .*usage not read yet/, 'unknown usage alone is still a usable account, hence recommended');
});

/** A pre-rename install under `tmpRoot`: the old config dir (with an old-named key) and the default data dir. */
function writePreRenameInstall(): { legacyDataDir: string; legacyConfigDir: string; workRoot: string } {
  const legacyDataDir = path.join(tmpRoot, '.telegramCode');
  const legacyConfigDir = path.join(tmpRoot, '.config', 'telegramcode');
  fs.mkdirSync(legacyDataDir);
  fs.writeFileSync(path.join(legacyDataDir, 'state.json'), '{}');
  fs.mkdirSync(legacyConfigDir, { recursive: true });
  fs.writeFileSync(path.join(legacyConfigDir, '.env'), 'CLI_TEST_LEGACY_CONFIG=1\nTELEGRAMCODE_CLI_TEST=1\n');
  const workRoot = path.join(tmpRoot, 'work');
  fs.mkdirSync(workRoot);
  return { legacyDataDir, legacyConfigDir, workRoot };
}

/** What the start needs to get past the lock and into the bot, which then fails fast on the fake token. */
function runPastTheLock(entryPath: string, workRoot: string): { status: number | null; stderr: string } {
  // The old voice keys would make the child announce its own (unrelated) deprecation and write a stt.json.
  const { GROQ_API_KEY: _groqApiKey, OPENAI_API_KEY: _openAiApiKey, ...inheritedEnv } = process.env;
  const r = spawnSync(process.execPath, [entryPath], {
    env: {
      ...inheritedEnv,
      CLAUDE_BIN: claudeShim,
      HOME: tmpRoot,
      DATA_DIR: '',
      TELEGRAM_BOT_TOKEN: 'fake-token-' + Date.now(),
      ALLOWED_GROUP_ID: '-100',
      WORK_ROOT: workRoot,
    },
    cwd: tmpRoot,
    encoding: 'utf8',
    timeout: 20_000,
  });
  return { status: r.status, stderr: r.stderr };
}

test('a cold start moves a pre-rename install once, says what it did in the bot log, and stays silent after', () => {
  const { legacyDataDir, legacyConfigDir, workRoot } = writePreRenameInstall();

  const first = runPastTheLock(cliPath, workRoot);

  const migrateLines = first.stderr.split('\n').filter((line) => line.startsWith('[migrate]'));
  assert.equal(migrateLines.length, 3, first.stderr);
  assert.match(migrateLines[0], /moved ~\/\.config\/telegramcode to ~\/\.config\/charness/);
  assert.match(migrateLines[1], /renamed 1 key\(s\) TELEGRAMCODE_\* to CHARNESS_\* in ~\/\.config\/charness\/\.env \(TELEGRAMCODE_CLI_TEST\)/);
  assert.match(migrateLines[2], /moved ~\/\.telegramCode to ~\/\.charness/);
  assert.doesNotMatch(first.stderr, /deprecated/, 'what the migration fixed is not announced as deprecated');

  const canonicalDataDir = path.join(tmpRoot, '.charness');
  assert.equal(fs.readlinkSync(legacyDataDir), '.charness');
  assert.equal(fs.readlinkSync(legacyConfigDir), 'charness');
  assert.equal(fs.readFileSync(path.join(canonicalDataDir, 'state.json'), 'utf8').startsWith('{'), true);
  assert.equal(
    fs.readFileSync(path.join(tmpRoot, '.config', 'charness', '.env'), 'utf8'),
    'CLI_TEST_LEGACY_CONFIG=1\nCHARNESS_CLI_TEST=1\n',
  );
  const logFile = fs.readdirSync(canonicalDataDir).find((name) => name.startsWith('bot-console-'));
  assert.ok(logFile, 'the console tee kept writing, now into the moved dir');
  assert.match(fs.readFileSync(path.join(canonicalDataDir, logFile), 'utf8'), /\[migrate\] moved ~\/\.telegramCode to ~\/\.charness/);
  assert.equal(fs.existsSync(path.join(canonicalDataDir, 'instance.lock')), false, 'the lock the migration ran under is released at exit');

  const second = runPastTheLock(cliPath, workRoot);

  assert.doesNotMatch(second.stderr, /\[migrate\]|deprecated/, 'a second start finds nothing to do');
});

test('a hot worker reload does not migrate; it announces what the old names still cost', () => {
  const { legacyDataDir, legacyConfigDir, workRoot } = writePreRenameInstall();

  const { stderr } = runPastTheLock(botEntryPath, workRoot);

  assert.doesNotMatch(stderr, /\[migrate\]/);
  assert.equal(fs.lstatSync(legacyDataDir).isDirectory(), true, 'the supervisor and the agents still hold this dir');
  assert.equal(fs.lstatSync(legacyConfigDir).isDirectory(), true);
  assert.equal(fs.existsSync(path.join(tmpRoot, '.charness')), false);
  const deprecations = stderr.split('\n').filter((line) => line.startsWith('[deprecated]'));
  assert.equal(deprecations.filter((line) => line.includes('~/.telegramCode is deprecated')).length, 1, stderr);
  assert.equal(deprecations.filter((line) => line.includes('~/.config/telegramcode is deprecated')).length, 1, stderr);
});

test('a fresh install uses ~/.charness and ~/.config/charness without any deprecation notice', () => {
  fs.mkdirSync(path.join(tmpRoot, '.config', 'charness'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, '.config', 'charness', '.env'), 'CLI_TEST_FRESH_CONFIG=1\n');
  const missingWorkRoot = path.join(tmpRoot, 'missing-work-root');

  const { status, stderr } = runCli([], { DATA_DIR: '', WORK_ROOT: missingWorkRoot });

  assert.equal(status, 1);
  assert.match(stderr, /WORK_ROOT does not exist or is not a directory/);
  assert.doesNotMatch(stderr, /deprecated/);
  assert.ok(fs.existsSync(path.join(tmpRoot, '.charness')), 'the console tee created the default data dir');
});

test('internal hot worker entry invokes the shared runBot preflight', () => {
  const missingWorkRoot = path.join(tmpRoot, 'missing-work-root');
  const result = spawnSync(process.execPath, [botEntryPath], {
    env: {
      ...process.env,
      CLAUDE_BIN: claudeShim,
      HOME: tmpRoot,
      DATA_DIR: path.join(tmpRoot, 'data'),
      TELEGRAM_BOT_TOKEN: 'fake-token-' + Date.now(),
      WORK_ROOT: missingWorkRoot,
    },
    cwd: tmpRoot,
    encoding: 'utf8',
    timeout: 5_000,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /WORK_ROOT does not exist or is not a directory/);
});

test('--help prints usage and exits 0', () => {
  const { status, stderr } = runCli(['--help']);
  assert.equal(status, 0);
  assert.match(stderr, /Usage:/);
  // The removed passthrough must not be advertised any more.
  assert.doesNotMatch(stderr, /cli claude/);
  assert.doesNotMatch(stderr, /(?:charness|telegramcode) bot/);
  // The usage names the command and the config location users are meant to see.
  assert.match(stderr, /^ {2}charness {2,}Start the bot/m);
  assert.match(stderr, /~\/\.config\/charness\/\.env/);
  assert.doesNotMatch(stderr, /telegramcode/);
});

test('--version prints the package version to stdout and exits 0', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8'),
  );
  for (const flag of ['--version', '-v', 'version']) {
    const { status, stdout } = runCli([flag]);
    assert.equal(status, 0, `exit code for ${flag}`);
    assert.equal(stdout.trim(), pkg.version, `stdout for ${flag}`);
  }
});

test('runBot uses $PWD as WORK_ROOT when unset and proceeds past preflight', () => {
  // Use a fake telegram token so the bot can't actually start polling — it'll
  // fail at the Telegram API call. That's fine: we only care that the
  // preflight (env load, WORK_ROOT default, lock acquire) happened.
  const projectDir = fs.mkdtempSync(path.join(tmpRoot, 'project-'));

  const r = spawnSync(process.execPath, [cliPath], {
    env: {
      ...process.env,
      CLAUDE_BIN: claudeShim,
      HOME: tmpRoot,
      DATA_DIR: path.join(tmpRoot, 'data'),
      // Required envs the bot reads — kept fake so it can't talk to Telegram.
      TELEGRAM_BOT_TOKEN: 'fake-token-' + Date.now(),
      ALLOWED_GROUP_ID: '-100',
      // Unset WORK_ROOT so the default kicks in.
      WORK_ROOT: undefined as unknown as string,
    },
    cwd: projectDir,
    encoding: 'utf8',
    timeout: 10_000,
  });

  // The normal wrapper path uses the current directory as the project parent.
  assert.match(
    r.stderr,
    new RegExp(
      `Using \\$PWD as WORK_ROOT: ${getRegexEscapedCanonicalPath(projectDir)}`,
    ),
  );
});

test('runBot exits 1 when WORK_ROOT points at a non-existent directory', () => {
  const bogus = path.join(tmpRoot, 'does-not-exist');
  const r = spawnSync(process.execPath, [cliPath], {
    env: {
      ...process.env,
      CLAUDE_BIN: claudeShim,
      HOME: tmpRoot,
      DATA_DIR: path.join(tmpRoot, 'data'),
      TELEGRAM_BOT_TOKEN: 'fake-token-' + Date.now(),
      ALLOWED_GROUP_ID: '-100',
      WORK_ROOT: bogus,
    },
    cwd: tmpRoot,
    encoding: 'utf8',
    timeout: 5_000,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /WORK_ROOT does not exist or is not a directory/);
  assert.match(r.stderr, new RegExp(bogus.replace(/\//g, '\\/')));
});

test('runBot refuses to start when a foreign lockfile holds the data dir', () => {
  // Plant a lockfile naming pid 1 (init — always alive, never us).
  const dataDir = path.join(tmpRoot, 'data-conflict');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'instance.lock'),
    JSON.stringify({
      pid: 1,
      cwd: '/somewhere-else',
      startedAt: '2026-01-01T00:00:00.000Z',
      tokenHash: 'aaaaaaaaaaaa',
    }),
  );

  const r = spawnSync(process.execPath, [cliPath], {
    env: {
      ...process.env,
      CLAUDE_BIN: claudeShim,
      HOME: tmpRoot,
      DATA_DIR: dataDir,
      TELEGRAM_BOT_TOKEN: 'fake-token-' + Date.now(),
      ALLOWED_GROUP_ID: '-100',
      WORK_ROOT: tmpRoot,
    },
    cwd: tmpRoot,
    encoding: 'utf8',
    timeout: 5_000,
  });

  assert.equal(r.status, 1);
  assert.match(r.stderr, /charness is already running/);
  assert.match(r.stderr, /pid:\s+1/);
  assert.match(r.stderr, /cwd:\s+\/somewhere-else/);

  // Foreign lock must survive — we don't delete other holders' files.
  const stillThere = fs.existsSync(path.join(dataDir, 'instance.lock'));
  assert.equal(stillThere, true);
});

test('runBot accepts an empty ALLOWED_GROUP_ID and boots into pairing mode', () => {
  // Auto-pair: leaving ALLOWED_GROUP_ID empty must NOT trip the fatal
  // "ALLOWED_GROUP_ID must be numeric / is required" guard (the pre-auto-pair
  // behavior) — instead the bot boots with no effective group and the startup
  // banner announces pairing mode. Fresh DATA_DIR ⇒ no persisted pairing ⇒
  // pairing mode is the expected state. Fake token ⇒ the bot fails fast after
  // the banner, exactly like the WORK_ROOT-default test above.
  const projectDir = fs.mkdtempSync(path.join(tmpRoot, 'project-'));
  const r = spawnSync(process.execPath, [cliPath], {
    env: {
      ...process.env,
      CLAUDE_BIN: claudeShim,
      HOME: tmpRoot,
      DATA_DIR: path.join(tmpRoot, 'data-pairing'),
      TELEGRAM_BOT_TOKEN: 'fake-token-' + Date.now(),
      ALLOWED_GROUP_ID: '', // empty ⇒ auto-pair mode
      WORK_ROOT: projectDir,
    },
    cwd: projectDir,
    encoding: 'utf8',
    timeout: 10_000,
  });

  const out = r.stdout + r.stderr;
  // The old fatal guard must be gone for the empty case.
  assert.doesNotMatch(out, /ALLOWED_GROUP_ID (must be|is required)/);
  // Startup banner reached and announced pairing mode.
  assert.match(out, /pairing mode/);
});
