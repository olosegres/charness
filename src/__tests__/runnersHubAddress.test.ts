/**
 * @description `runners/hubAddress.ts`: reading the address runners dial, picking the host key out of `ssh-keyscan` output, and the
 * check that the address answers with THIS machine's sshd — a code pins the key found there, so a stranger's key must never be pinned.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkHubAddress, parseHubAddress, parseKeyscanOutput, type HostKeyScanner } from '../runners/hubAddress';
import { generateEd25519KeyPair, getPublicKeyFingerprint } from '../runners/sshKeys';

const ownKey = generateEd25519KeyPair('own').publicKey;
const strangerKey = generateEd25519KeyPair('stranger').publicKey;
const rsaKey = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCexample';

describe('parseHubAddress', () => {
  it('reads host, host:port, [v6]:port and a bare v6 address; port 22 by default', () => {
    assert.deepEqual(parseHubAddress('host.example'), { ok: true, address: { host: 'host.example', port: 22 } });
    assert.deepEqual(parseHubAddress(' host.example:2222 '), { ok: true, address: { host: 'host.example', port: 2222 } });
    assert.deepEqual(parseHubAddress('203.0.113.5:22'), { ok: true, address: { host: '203.0.113.5', port: 22 } });
    assert.deepEqual(parseHubAddress('[2001:db8::1]:2200'), { ok: true, address: { host: '2001:db8::1', port: 2200 } });
    assert.deepEqual(parseHubAddress('2001:db8::1'), { ok: true, address: { host: '2001:db8::1', port: 22 } });
  });

  it('refuses what is not an address: spaces, options, a bad port', () => {
    for (const text of ['', 'two words', '-oProxyCommand=x', 'host;rm', 'host:0', 'host:70000', 'host:abc', 'user@host']) {
      assert.equal(parseHubAddress(text).ok, false, text);
    }
  });
});

describe('parseKeyscanOutput', () => {
  it('takes the most preferred well-formed key and ignores comments', () => {
    const output = `# host.example:22 SSH-2.0-OpenSSH_9.6\nhost.example ${rsaKey}\nhost.example ${ownKey}\n`;
    assert.equal(parseKeyscanOutput(output), ownKey);
  });

  it('falls back to a lesser type, and to nothing', () => {
    assert.equal(parseKeyscanOutput(`host ${rsaKey}\n`), rsaKey);
    assert.equal(parseKeyscanOutput(''), null);
    assert.equal(parseKeyscanOutput('# only comments\nhost ssh-ed25519 not-base64!!\n'), null);
  });
});

describe('checkHubAddress', () => {
  function createScanner(answers: Record<string, string | null>): { scan: HostKeyScanner; asked: string[] } {
    const asked: string[] = [];
    return { asked, scan: async (host, port) => { asked.push(`${host}:${port}`); return answers[`${host}:${port}`] ?? null; } };
  }

  it('accepts an address that answers with this machine\'s own key and returns the key to pin', async () => {
    const { scan, asked } = createScanner({ 'host.example:22': ownKey, '127.0.0.1:22': ownKey });
    assert.deepEqual(await checkHubAddress({ host: 'host.example', port: 22 }, scan), { ok: true, hostKey: ownKey, note: null });
    assert.deepEqual(asked, ['host.example:22', '127.0.0.1:22']);
  });

  it('refuses an address that answers with another machine\'s key, naming both fingerprints', async () => {
    const { scan } = createScanner({ 'host.example:22': strangerKey, '127.0.0.1:22': ownKey });
    const result = await checkHubAddress({ host: 'host.example', port: 22 }, scan);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.error.includes(getPublicKeyFingerprint(strangerKey)));
      assert.ok(result.error.includes(getPublicKeyFingerprint(ownKey)));
    }
  });

  it('refuses an address where nothing answers', async () => {
    const result = await checkHubAddress({ host: 'host.example', port: 22 }, createScanner({ '127.0.0.1:22': ownKey }).scan);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /nothing answers .* host\.example:22/);
  });

  it('accepts with a note when this machine\'s own sshd cannot be read to compare', async () => {
    const result = await checkHubAddress({ host: 'host.example', port: 2222 }, createScanner({ 'host.example:2222': ownKey }).scan);
    assert.equal(result.ok, true);
    if (result.ok) assert.match(result.note ?? '', /not compared/);
  });

  it('does not compare a loopback address with itself', async () => {
    const { scan, asked } = createScanner({ '127.0.0.1:22': ownKey });
    assert.deepEqual(await checkHubAddress({ host: '127.0.0.1', port: 22 }, scan), { ok: true, hostKey: ownKey, note: null });
    assert.deepEqual(asked, ['127.0.0.1:22']);
  });
});
