/**
 * @description Claude account profiles — the pure helpers (`utils/claudeProfiles.ts`) and the picker plan
 * (`utils/claudeAccountPickerPlan.ts`): the name gate, the on-disk layout (0700 directory, the shared entries
 * symlinked into `~/.claude`, idempotent, removal that never follows a link), the resolver's fallback to
 * `default` for an unknown pick, the `claude auth status` parser, the `CLAUDE_CONFIG_DIR` recovery from a
 * command line, and the callback codecs with their 64-byte budget.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  checkIsSameClaudeConfigDir,
  checkClaudeProfileDirExists,
  checkIsValidClaudeProfileName,
  claudeProfileNameMaxLength,
  createClaudeProfileLayout,
  defaultClaudeProfileName,
  getClaudeAccountKind,
  normaliseClaudeProfileName,
  parseClaudeAuthStatus,
  parseClaudeConfigDirFromCommand,
  removeClaudeProfileLayout,
  resolveClaudeProfileDir,
  resolveClaudeProfileName,
} from '../utils/claudeProfiles';
import {
  accountLoginCallbackRe,
  accountRemoveCallbackRe,
  accountUseCallbackRe,
  buildAccountPickerRows,
  buildAccountRemoveCallback,
  buildAccountUseCallback,
  countTopicsPerProfile,
  parseAccountCallbackName,
} from '../utils/claudeAccountPickerPlan';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-profiles-'));
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

describe('profile names', () => {
  it('accepts lowercase slugs up to the cap and refuses the reserved default, uppercase, spaces and paths', () => {
    assert.equal(checkIsValidClaudeProfileName('work'), true);
    assert.equal(checkIsValidClaudeProfileName('team-2_b'), true);
    assert.equal(checkIsValidClaudeProfileName('a'.repeat(claudeProfileNameMaxLength)), true);
    assert.equal(checkIsValidClaudeProfileName('a'.repeat(claudeProfileNameMaxLength + 1)), false);
    assert.equal(checkIsValidClaudeProfileName(defaultClaudeProfileName), false);
    assert.equal(checkIsValidClaudeProfileName('Work'), false);
    assert.equal(checkIsValidClaudeProfileName('my work'), false);
    assert.equal(checkIsValidClaudeProfileName('../etc'), false);
    assert.equal(checkIsValidClaudeProfileName('-lead'), false);
    assert.equal(checkIsValidClaudeProfileName(''), false);
  });

  it('normalises the typed name (trim + lowercase) so `/account add Work ` means `work`', () => {
    assert.equal(normaliseClaudeProfileName(' Work '), 'work');
  });

  it('the default profile has no directory; an added one lives under DATA_DIR/claude-profiles/<name>', () => {
    assert.equal(resolveClaudeProfileDir('/data', defaultClaudeProfileName), null);
    assert.equal(resolveClaudeProfileDir('/data', 'work'), path.join('/data', 'claude-profiles', 'work'));
  });
});

describe('profile layout on disk', () => {
  const dataDir = path.join(tempRoot, 'data');
  const homeClaudeDir = path.join(tempRoot, 'home', '.claude');

  it('creates a 0700 directory with the shared entries symlinked into ~/.claude, CLAUDE.md only when present', () => {
    fs.mkdirSync(homeClaudeDir, { recursive: true });
    fs.writeFileSync(path.join(homeClaudeDir, 'settings.json'), '{}');
    const dir = createClaudeProfileLayout({ dataDir, name: 'work', homeClaudeDir });
    assert.equal(dir, path.join(dataDir, 'claude-profiles', 'work'));
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dataDir, 'claude-profiles')).mode & 0o777, 0o700);
    for (const entry of ['projects', 'settings.json', 'skills', 'plugins']) {
      assert.equal(fs.readlinkSync(path.join(dir, entry)), path.join(homeClaudeDir, entry), entry);
    }
    assert.equal(fs.existsSync(path.join(dir, 'CLAUDE.md')), false, 'no user memory → no link');
    assert.ok(fs.statSync(path.join(homeClaudeDir, 'projects')).isDirectory(), '~/.claude/projects is created so the one entry the bot reads never dangles');
    assert.equal(checkClaudeProfileDirExists(dataDir, 'work'), true);
    assert.equal(checkClaudeProfileDirExists(dataDir, defaultClaudeProfileName), true);
  });

  it('a transcript written through the profile lands in the shared ~/.claude/projects', () => {
    const dir = resolveClaudeProfileDir(dataDir, 'work')!;
    fs.mkdirSync(path.join(dir, 'projects', '-work-dir'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'projects', '-work-dir', 'sess.jsonl'), '{}\n');
    assert.ok(fs.existsSync(path.join(homeClaudeDir, 'projects', '-work-dir', 'sess.jsonl')));
  });

  it('is idempotent and links CLAUDE.md once it exists; a real file of the profile is left alone', () => {
    const dir = resolveClaudeProfileDir(dataDir, 'work')!;
    fs.writeFileSync(path.join(dir, '.credentials.json'), '{"claudeAiOauth":{}}', { mode: 0o600 });
    fs.writeFileSync(path.join(homeClaudeDir, 'CLAUDE.md'), '# memory');
    createClaudeProfileLayout({ dataDir, name: 'work', homeClaudeDir });
    assert.equal(fs.readlinkSync(path.join(dir, 'CLAUDE.md')), path.join(homeClaudeDir, 'CLAUDE.md'));
    assert.equal(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8'), '{"claudeAiOauth":{}}', 'the login survives a re-run');
  });

  it('refuses the default and an invalid name', () => {
    assert.throws(() => createClaudeProfileLayout({ dataDir, name: defaultClaudeProfileName, homeClaudeDir }));
    assert.throws(() => createClaudeProfileLayout({ dataDir, name: '../x', homeClaudeDir }));
    assert.throws(() => removeClaudeProfileLayout(dataDir, defaultClaudeProfileName));
  });

  it('removal deletes the profile directory but never what its links point at', () => {
    removeClaudeProfileLayout(dataDir, 'work');
    assert.equal(fs.existsSync(path.join(dataDir, 'claude-profiles', 'work')), false);
    assert.ok(fs.existsSync(path.join(homeClaudeDir, 'projects', '-work-dir', 'sess.jsonl')), 'the shared transcript is untouched');
    assert.ok(fs.existsSync(path.join(homeClaudeDir, 'settings.json')));
    assert.ok(fs.existsSync(path.join(homeClaudeDir, 'CLAUDE.md')));
    assert.equal(checkClaudeProfileDirExists(dataDir, 'work'), false);
  });
});

describe('resolveClaudeProfileName', () => {
  const known = new Set(['work', 'team']);
  it('override wins, then the instance default, then default', () => {
    assert.equal(resolveClaudeProfileName({ globalDefault: 'team', threadOverride: 'work', knownNames: known }), 'work');
    assert.equal(resolveClaudeProfileName({ globalDefault: 'team', threadOverride: undefined, knownNames: known }), 'team');
    assert.equal(resolveClaudeProfileName({ globalDefault: undefined, threadOverride: undefined, knownNames: known }), defaultClaudeProfileName);
  });
  it('an explicit default override beats a non-default instance default', () => {
    assert.equal(resolveClaudeProfileName({ globalDefault: 'team', threadOverride: defaultClaudeProfileName, knownNames: known }), defaultClaudeProfileName);
  });
  it('a pick that names a removed profile falls through instead of launching a dead directory', () => {
    assert.equal(resolveClaudeProfileName({ globalDefault: 'team', threadOverride: 'gone', knownNames: known }), 'team');
    assert.equal(resolveClaudeProfileName({ globalDefault: 'gone', threadOverride: undefined, knownNames: known }), defaultClaudeProfileName);
  });
});

describe('claude auth status', () => {
  it('parses the fields the picker shows and classifies the subscription', () => {
    const status = parseClaudeAuthStatus(JSON.stringify({
      loggedIn: true, authMethod: 'oauth', email: 'ops@example.com', orgId: 'o1', orgName: 'Example Org', subscriptionType: 'max',
    }));
    assert.deepEqual(status, { loggedIn: true, email: 'ops@example.com', subscriptionType: 'max', orgName: 'Example Org' });
    assert.deepEqual(parseClaudeAuthStatus('{"loggedIn":false,"authMethod":"none"}'), { loggedIn: false, email: null, subscriptionType: null, orgName: null });
    assert.equal(parseClaudeAuthStatus('not json'), null);
    assert.equal(parseClaudeAuthStatus('{"email":"x"}'), null, 'no loggedIn → unknown, never logged out');
    assert.equal(getClaudeAccountKind('pro'), 'personal');
    assert.equal(getClaudeAccountKind('Max'), 'personal');
    assert.equal(getClaudeAccountKind('team'), 'corporate');
    assert.equal(getClaudeAccountKind('enterprise'), 'corporate');
    assert.equal(getClaudeAccountKind(null), 'unknown');
    assert.equal(getClaudeAccountKind('something-new'), 'unknown');
  });
});

describe('parseClaudeConfigDirFromCommand', () => {
  it('recovers the single-quoted wrapper / pane value, a bare one, and none for the default profile', () => {
    assert.equal(parseClaudeConfigDirFromCommand("env -u ANTHROPIC_API_KEY 'CLAUDE_CONFIG_DIR=/data/claude-profiles/work' '/opt/bin/claude' '-p'"), '/data/claude-profiles/work');
    assert.equal(parseClaudeConfigDirFromCommand("'env' 'CLAUDE_CONFIG_DIR=/home/user/.charness/claude-profiles/it'\\''s' '/opt/claude' '--session-id' 'u'"), "/home/user/.charness/claude-profiles/it's");
    assert.equal(parseClaudeConfigDirFromCommand('env CLAUDE_CONFIG_DIR=/p/work claude --resume x'), '/p/work');
    assert.equal(parseClaudeConfigDirFromCommand("env -u ANTHROPIC_API_KEY '/opt/bin/claude' '-p'"), null);
    assert.equal(parseClaudeConfigDirFromCommand("'/opt/claude' '--session-id' 'MY_CLAUDE_CONFIG_DIR=x'"), null, 'only a standalone assignment counts');
  });
});

describe('account picker plan', () => {
  it('bakes the name into callback data within the 64-byte cap and parses it back; default only where allowed', () => {
    const longest = 'a'.repeat(claudeProfileNameMaxLength);
    assert.ok(Buffer.byteLength(buildAccountUseCallback(longest)) <= 64);
    assert.ok(Buffer.byteLength(buildAccountRemoveCallback(longest)) <= 64);
    assert.equal(parseAccountCallbackName(buildAccountUseCallback('work'), accountUseCallbackRe, { allowDefault: true }), 'work');
    assert.equal(parseAccountCallbackName('acct_use_default', accountUseCallbackRe, { allowDefault: true }), 'default');
    assert.equal(parseAccountCallbackName('acct_rm_default', accountRemoveCallbackRe, { allowDefault: false }), null);
    assert.equal(parseAccountCallbackName('acct_login_work', accountUseCallbackRe, { allowDefault: true }), null, 'foreign button');
    assert.equal(parseAccountCallbackName('acct_login_work', accountLoginCallbackRe, { allowDefault: true }), 'work');
  });

  it('rows: default first, then the added profiles in creation order, with the active mark and topic counts', () => {
    const rows = buildAccountPickerRows({
      records: {
        team: { createdAt: '2026-10-02T00:00:00Z', loggedIn: true, email: 'team@example.com', subscriptionType: 'team' },
        work: { createdAt: '2026-10-01T00:00:00Z', loggedIn: false },
      },
      defaultStatus: { loggedIn: true, email: 'me@example.com', subscriptionType: 'max' },
      activeName: 'team',
      topicCounts: countTopicsPerProfile(['default', 'team', 'team']),
    });
    assert.deepEqual(rows.map((row) => [row.name, row.isActive, row.kind, row.topicCount, row.loggedIn]), [
      ['default', false, 'personal', 1, true],
      ['work', false, 'unknown', 0, false],
      ['team', true, 'corporate', 2, true],
    ]);
  });
});

describe('checkIsSameClaudeConfigDir', () => {
  it('knows a profile dir reached through the old path of a moved data dir', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-cfgdir-'));
    try {
      const realDir = path.join(root, '.charness', 'claude-profiles', 'work');
      fs.mkdirSync(realDir, { recursive: true });
      fs.symlinkSync('.charness', path.join(root, '.telegramCode'));
      const viaOldPath = path.join(root, '.telegramCode', 'claude-profiles', 'work');

      assert.equal(checkIsSameClaudeConfigDir(viaOldPath, realDir), true);
      assert.equal(checkIsSameClaudeConfigDir(realDir, realDir), true);
      assert.equal(checkIsSameClaudeConfigDir(null, null), true);
      assert.equal(checkIsSameClaudeConfigDir(viaOldPath, path.join(root, '.charness', 'claude-profiles', 'other')), false);
      assert.equal(checkIsSameClaudeConfigDir(viaOldPath, null), false);
      assert.equal(checkIsSameClaudeConfigDir(null, realDir), false);
      assert.equal(checkIsSameClaudeConfigDir('/does/not/exist/a', '/does/not/exist/b'), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
