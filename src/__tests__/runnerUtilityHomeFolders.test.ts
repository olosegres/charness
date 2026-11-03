/**
 * @description `runnerUtility/homeFolders.ts`: what a runner must not depend on or be able to read in other people's homes. macOS gives every home
 * `750` with group `staff`, and a standard account is in `staff` — so by default the agents' code can read the source code, keys and tokens of
 * the people who use the machine. The runner (and what root runs for it) must not use a program that lives in a home either: it is the other
 * user's to change, and the day they close the folder (`chmod 700`) the runner stops. Both pairing lines say when homes can be read, name them and
 * give the one-line fix.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkCanReadAsSelf,
  describeForeignNode,
  findForeignHome,
  findHomeContaining,
  findReadableHomes,
  formatForeignNodeWarning,
  formatReadableHomesWarning,
  listSubfolders,
  type HomeScanDeps,
} from '../runnerUtility/homeFolders';
import { formatPairingWarnings } from '../runnerUtility/runnerCommands';

describe('which program is inside a home folder', () => {
  it('a path under /Users/<name>, /home/<name>, /root or /var/root is inside one — /Users/Shared too, everyone can write it — and the folder is named', () => {
    assert.equal(findHomeContaining('/Users/alice/.nvm/versions/node/v22.12.0/bin/node'), '/Users/alice');
    assert.equal(findHomeContaining('/home/bob/.local/bin/node'), '/home/bob');
    assert.equal(findHomeContaining('/Users/Shared/tools/node'), '/Users/Shared');
    assert.equal(findHomeContaining('/root/.nvm/bin/node'), '/root');
    assert.equal(findHomeContaining('/var/root/node'), '/var/root');
  });

  it('system places are outside every home, and a look-alike name is no home', () => {
    for (const outside of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node', '/opt/hostedtoolcache/node/22.12.0/x64/bin/node', '/homes/x/node', '/Usersx/y/node', '/Users', '/home']) {
      assert.equal(findHomeContaining(outside), null, outside);
    }
  });

  it('a path is judged as written: `..` is resolved first, so a way out of the home does not hide it', () => {
    assert.equal(findHomeContaining('/usr/local/../../Users/alice/bin/node'), '/Users/alice');
    assert.equal(findHomeContaining('/Users/alice/../../usr/bin/node'), null);
  });

  it('another user\'s home is foreign; the account\'s own home is not', () => {
    assert.equal(findForeignHome('/Users/alice/.nvm/bin/node', '/Users/runner'), '/Users/alice');
    assert.equal(findForeignHome('/Users/runner/.nvm/bin/node', '/Users/runner'), null);
    assert.equal(findForeignHome('/opt/homebrew/bin/node', '/Users/runner'), null);
  });
});

describe('which homes the runner account can read', () => {
  function createScan(layout: Record<string, string[]>, readable: readonly string[]): HomeScanDeps {
    return { listFolders: (parent) => layout[parent] ?? [], checkCanRead: async (folder) => readable.includes(folder) };
  }

  it('names the homes of other users that it can enter and list — sorted — and none that is closed', async () => {
    const scan = createScan({ '/Users': ['bob', 'alice', 'carol', 'runner'], '/home': ['dave'] }, ['/Users/alice', '/Users/bob', '/home/dave']);
    assert.deepEqual(await findReadableHomes('runner', '/Users/runner', scan), ['/Users/alice', '/Users/bob', '/home/dave']);
  });

  it('leaves out its own home, whichever way it is told, and the entries that are no person\'s home', async () => {
    const everything = ['/Users/runner', '/Users/ci-box', '/Users/Shared', '/Users/Guest', '/Users/.localized', '/home/lost+found'];
    const scan = createScan({ '/Users': ['runner', 'ci-box', 'Shared', 'Guest', '.localized'], '/home': ['lost+found'] }, everything);
    assert.deepEqual(await findReadableHomes('runner', null, scan), ['/Users/ci-box']);
    assert.deepEqual(await findReadableHomes('someone-else', '/Users/ci-box', scan), ['/Users/runner'], 'by the home folder, when the name differs');
  });

  it('finds nothing when there are no homes at all', async () => {
    assert.deepEqual(await findReadableHomes('runner', null, createScan({}, [])), []);
  });

  it('lists only folders, and reads a folder the way the account itself would — checked on real folders (skipped as root: root can read anything)', async (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-'));
    try {
      fs.mkdirSync(path.join(root, 'open'));
      fs.mkdirSync(path.join(root, 'closed'), { mode: 0o000 });
      fs.writeFileSync(path.join(root, 'a-file'), 'x');
      assert.deepEqual(listSubfolders(root).sort(), ['closed', 'open']);
      assert.deepEqual(listSubfolders(path.join(root, 'missing')), []);
      assert.equal(await checkCanReadAsSelf(path.join(root, 'open')), true);
      if (process.getuid?.() === 0) context.skip('root can read a closed folder');
      else assert.equal(await checkCanReadAsSelf(path.join(root, 'closed')), false);
    } finally {
      fs.chmodSync(path.join(root, 'closed'), 0o700);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the warnings', () => {
  it('say who can read what, name each home and give the one-line fix for it', () => {
    const lines = formatReadableHomesWarning('runner', ['/Users/alice', '/Users/bob']);
    assert.equal(lines[0], 'Warning: the account runner can read the home folders of other users on this machine: /Users/alice, /Users/bob.');
    assert.match(lines[1], /run as this account and can read what is in them/);
    assert.deepEqual(lines.slice(2), ['  sudo chmod 700 /Users/alice', '  sudo chmod 700 /Users/bob']);
  });

  it('say nothing when no home can be read', () => {
    assert.deepEqual(formatReadableHomesWarning('runner', []), []);
  });

  it('quote a folder name that a shell would split or read specially, so the line to paste does what it says', () => {
    const lines = formatReadableHomesWarning('runner', ['/Users/a b', '/Users/it\'s', '/Users/$(x)']);
    assert.deepEqual(lines.slice(2), ['  sudo chmod 700 \'/Users/a b\'', '  sudo chmod 700 \'/Users/it\'\\\'\'s\'', '  sudo chmod 700 \'/Users/$(x)\'']);
  });

  it('name at most eight homes and count the rest, for a Mac with many users', () => {
    const homes = Array.from({ length: 11 }, (_, index) => `/Users/user${index.toString().padStart(2, '0')}`);
    const lines = formatReadableHomesWarning('runner', homes);
    assert.ok(lines[0].includes('/Users/user07') && !lines[0].includes('/Users/user08'));
    assert.ok(lines[0].endsWith('and 3 more.'));
    assert.equal(lines.filter((line) => line.startsWith('  sudo chmod 700 ')).length, 8);
    assert.equal(lines.at(-1), '  (and the same for the 3 more)');
  });

  it('say that a Node.js in another user\'s home is a dependency on that home — and nothing for a Node outside every home or in the account\'s own', () => {
    const lines = formatForeignNodeWarning('/Users/alice/.nvm/versions/node/v22/bin/node', '/Users/runner');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^Warning: this runner uses the Node\.js at \/Users\/alice\/\.nvm\/versions\/node\/v22\/bin\/node, which lives in the home folder of another user \(\/Users\/alice\)\./);
    assert.match(lines[0], /brew install node/);
    assert.deepEqual(formatForeignNodeWarning('/opt/homebrew/bin/node', '/Users/runner'), []);
    assert.deepEqual(formatForeignNodeWarning('/Users/runner/.nvm/bin/node', '/Users/runner'), []);
    assert.match(describeForeignNode('/home/x/node', '/home/x'), /It stops working when that folder is closed/);
  });

  it('the plain pairing line puts both together; with nothing to say it says nothing', () => {
    const warnings = formatPairingWarnings({ accountName: 'runner', homeDir: '/Users/runner', nodePath: '/Users/alice/.nvm/bin/node', readableHomes: ['/Users/alice'] });
    assert.equal(warnings.length > 0, true);
    assert.ok(warnings.some((line) => line.startsWith('Warning: the account runner can read')));
    assert.ok(warnings.some((line) => line.startsWith('Warning: this runner uses the Node.js at')));
    assert.deepEqual(formatPairingWarnings({ accountName: 'runner', homeDir: '/Users/runner', nodePath: '/opt/homebrew/bin/node', readableHomes: [] }), []);
  });
});
