/**
 * @description `runners/authorizedKeys.ts`: the managed block of the account's `authorized_keys` — every line outside the markers is
 * kept byte for byte, a damaged block is refused, and the key lines are forced-command keys with NO forwarding (`restrict`), whose
 * folder path cannot break out of `command="…"`.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  AuthorizedKeysBlockError,
  authorizedKeysBlockEnd,
  authorizedKeysBlockStart,
  buildRunnerKeyLine,
  buildTempKeyLine,
  extractManagedBlock,
  formatExpiryTime,
  replaceManagedBlock,
  writeManagedBlock,
} from '../runners/authorizedKeys';
import { generateEd25519KeyPair } from '../runners/sshKeys';

const foreignText = '# my own keys\nssh-ed25519 AAAAFOREIGN1 me@laptop\n\nssh-rsa AAAAFOREIGN2 old@box\n';
const keyLine = 'restrict ssh-ed25519 AAAA charness-runner:one';

describe('replaceManagedBlock', () => {
  it('appends a block after the operator\'s lines and keeps them exactly', () => {
    const next = replaceManagedBlock(foreignText, [keyLine]);
    assert.equal(next, `${foreignText}${authorizedKeysBlockStart}\n${keyLine}\n${authorizedKeysBlockEnd}\n`);
  });

  it('adds the missing final newline before appending', () => {
    const next = replaceManagedBlock('ssh-rsa AAAAX no-newline', [keyLine]);
    assert.ok(next.startsWith('ssh-rsa AAAAX no-newline\n'));
    assert.ok(next.endsWith(`${authorizedKeysBlockEnd}\n`));
  });

  it('makes a block in an empty or missing file', () => {
    assert.equal(replaceManagedBlock('', [keyLine]), `${authorizedKeysBlockStart}\n${keyLine}\n${authorizedKeysBlockEnd}\n`);
  });

  it('replaces the block in place; lines before and after it are untouched', () => {
    const withBlock = `before\n${authorizedKeysBlockStart}\nold line\n${authorizedKeysBlockEnd}\nafter\n`;
    assert.equal(replaceManagedBlock(withBlock, ['new one', 'new two']), `before\n${authorizedKeysBlockStart}\nnew one\nnew two\n${authorizedKeysBlockEnd}\nafter\n`);
  });

  it('no lines removes the block and nothing else', () => {
    const withBlock = `before\n${authorizedKeysBlockStart}\nold line\n${authorizedKeysBlockEnd}\nafter\n`;
    assert.equal(replaceManagedBlock(withBlock, []), 'before\nafter\n');
  });

  it('no lines and no block leaves the text as it is', () => {
    assert.equal(replaceManagedBlock(foreignText, []), foreignText);
    assert.equal(replaceManagedBlock('', []), '');
  });

  it('is idempotent', () => {
    const once = replaceManagedBlock(foreignText, [keyLine]);
    assert.equal(replaceManagedBlock(once, [keyLine]), once);
  });

  it('refuses a damaged block instead of guessing which lines are its own', () => {
    for (const damaged of [
      `a\n${authorizedKeysBlockStart}\nb\n`,
      `a\n${authorizedKeysBlockEnd}\nb\n`,
      `${authorizedKeysBlockEnd}\nx\n${authorizedKeysBlockStart}\n`,
      `${authorizedKeysBlockStart}\n${authorizedKeysBlockEnd}\n${authorizedKeysBlockStart}\n${authorizedKeysBlockEnd}\n`,
    ]) {
      assert.throws(() => replaceManagedBlock(damaged, [keyLine]), AuthorizedKeysBlockError);
    }
  });

  it('extractManagedBlock returns the lines between the markers', () => {
    assert.deepEqual(extractManagedBlock(replaceManagedBlock(foreignText, ['one', 'two'])), ['one', 'two']);
    assert.deepEqual(extractManagedBlock(foreignText), []);
  });
});

describe('formatExpiryTime', () => {
  it('is sshd\'s YYYYMMDDHHMMSSZ in UTC, whole seconds', () => {
    assert.equal(formatExpiryTime(0), '19700101000000Z');
    assert.equal(formatExpiryTime(Date.UTC(2026, 10, 1, 14, 5, 9, 999)), '20261101140509Z');
  });
});

describe('key lines', () => {
  const publicKey = generateEd25519KeyPair('line').publicKey;
  const common = { publicKey, gatePath: '/home/u/.config/charness/runners/gate', keysPath: '/home/u/.ssh/authorized_keys', dir: '/home/u/.config/charness/runners' };

  it('a pairing\'s key expires and may only call the gate\'s redeem mode', () => {
    const line = buildTempKeyLine({ ...common, expiresAtMs: Date.UTC(2026, 10, 1, 14, 15, 0), pairId: 'abcdef012345' });
    assert.equal(
      line,
      `restrict,expiry-time="20261101141500Z",command="/home/u/.config/charness/runners/gate --dir /home/u/.config/charness/runners --keys /home/u/.ssh/authorized_keys redeem abcdef012345" ${publicKey} charness-pairing:abcdef012345`,
    );
  });

  it('a runner\'s key never expires and names the gate\'s runner mode', () => {
    const line = buildRunnerKeyLine({ ...common, runnerId: '0123456789ab' });
    assert.equal(
      line,
      `restrict,command="/home/u/.config/charness/runners/gate --dir /home/u/.config/charness/runners --keys /home/u/.ssh/authorized_keys runner 0123456789ab" ${publicKey} charness-runner:0123456789ab`,
    );
  });

  it('turns every kind of forwarding off with `restrict` and enables none back', () => {
    const line = buildRunnerKeyLine({ ...common, runnerId: '0123456789ab' });
    assert.ok(line.startsWith('restrict,'));
    assert.ok(!/port-forwarding|agent-forwarding|X11-forwarding|permitopen|permitlisten|pty|user-rc/i.test(line.slice(0, line.indexOf('command='))));
  });

  it('single-quotes a folder path with a space for the shell sshd runs the command in', () => {
    const line = buildRunnerKeyLine({ ...common, gatePath: '/home/a b/runners/gate', dir: '/home/a b/runners', runnerId: '0123456789ab' });
    assert.ok(line.includes(`command="'/home/a b/runners/gate' --dir '/home/a b/runners' --keys`));
  });

  it('refuses a path a command option could not carry (a quote, a backslash, a line break)', () => {
    for (const dir of ['/home/a"b', '/home/a\\b', "/home/a'b", '/home/a\nb']) {
      assert.throws(() => buildRunnerKeyLine({ ...common, dir, runnerId: '0123456789ab' }), AuthorizedKeysBlockError, dir);
    }
  });
});

describe('writeManagedBlock', () => {
  let home = '';
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('creates ~/.ssh as 0700 and the file as 0600', () => {
    const file = path.join(home, '.ssh', 'authorized_keys');
    writeManagedBlock(file, [keyLine]);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(extractManagedBlock(fs.readFileSync(file, 'utf8')), [keyLine]);
  });

  it('keeps the operator\'s keys and leaves an existing folder\'s mode alone', () => {
    const file = path.join(home, '.ssh', 'authorized_keys');
    fs.mkdirSync(path.dirname(file), { mode: 0o755 });
    fs.chmodSync(path.dirname(file), 0o755);
    fs.writeFileSync(file, foreignText, { mode: 0o644 });
    writeManagedBlock(file, [keyLine]);
    assert.ok(fs.readFileSync(file, 'utf8').startsWith(foreignText));
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o755);
  });

  it('writes nothing when nothing changes, and does not create a file for an empty block', () => {
    const file = path.join(home, '.ssh', 'authorized_keys');
    writeManagedBlock(file, []);
    assert.equal(fs.existsSync(file), false);
    writeManagedBlock(file, [keyLine]);
    const before = fs.statSync(file).ino;
    writeManagedBlock(file, [keyLine]);
    assert.equal(fs.statSync(file).ino, before);
  });

  it('writes through a symlink into the file it points to', () => {
    const real = path.join(home, 'dotfiles', 'authorized_keys');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, foreignText);
    const link = path.join(home, '.ssh', 'authorized_keys');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(real, link);
    writeManagedBlock(link, [keyLine]);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.deepEqual(extractManagedBlock(fs.readFileSync(real, 'utf8')), [keyLine]);
  });

  it('does not touch a file with a damaged block', () => {
    const file = path.join(home, '.ssh', 'authorized_keys');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const damaged = `${authorizedKeysBlockStart}\nno end\n`;
    fs.writeFileSync(file, damaged);
    assert.throws(() => writeManagedBlock(file, [keyLine]), AuthorizedKeysBlockError);
    assert.equal(fs.readFileSync(file, 'utf8'), damaged);
  });
});
