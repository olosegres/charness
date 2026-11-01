/**
 * @description `runners/hubAddressCandidates.ts`: which addresses of this machine `/runners` may propose (only globally routable ones —
 * a private, link-local, CGNAT or loopback address means nothing to a runner elsewhere), how an address is spelled back to the operator,
 * and the check plan: the first candidate that answers with THIS machine's own ssh key is proposed, one that answers with a stranger's
 * key or that could not be compared is not.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { NetworkInterfaceInfo } from 'os';
import type { HostKeyScanner } from '../runners/hubAddress';
import { findProposedHubAddress, formatHubAddress, listPublicAddressCandidates } from '../runners/hubAddressCandidates';
import { generateEd25519KeyPair } from '../runners/sshKeys';

const ownKey = generateEd25519KeyPair('own').publicKey;
const strangerKey = generateEd25519KeyPair('stranger').publicKey;

function createInterface(address: string, family: 'IPv4' | 'IPv6', isInternal = false): NetworkInterfaceInfo {
  return { address, family, internal: isInternal, netmask: '', mac: '', cidr: null } as NetworkInterfaceInfo;
}

describe('formatHubAddress', () => {
  it('spells host:port, and brackets an IPv6 host so parseHubAddress reads it back', () => {
    assert.equal(formatHubAddress({ host: '203.0.113.5', port: 22 }), '203.0.113.5:22');
    assert.equal(formatHubAddress({ host: 'host.example', port: 2222 }), 'host.example:2222');
    assert.equal(formatHubAddress({ host: '2001:db8::1', port: 22 }), '[2001:db8::1]:22');
  });
});

describe('listPublicAddressCandidates', () => {
  it('keeps the routable IPv4 and IPv6 addresses, IPv4 first, and drops private, link-local, CGNAT, multicast, loopback and unique-local ones', () => {
    const candidates = listPublicAddressCandidates({
      lo: [createInterface('127.0.0.1', 'IPv4', true), createInterface('::1', 'IPv6', true)],
      eth0: [
        createInterface('10.1.2.3', 'IPv4'),
        createInterface('172.16.0.9', 'IPv4'),
        createInterface('172.32.0.9', 'IPv4'),
        createInterface('192.168.1.5', 'IPv4'),
        createInterface('169.254.3.4', 'IPv4'),
        createInterface('100.64.0.1', 'IPv4'),
        createInterface('100.128.0.1', 'IPv4'),
        createInterface('224.0.0.251', 'IPv4'),
        createInterface('203.0.113.5', 'IPv4'),
        createInterface('2001:db8::1', 'IPv6'),
        createInterface('fe80::1', 'IPv6'),
        createInterface('fd00::1', 'IPv6'),
      ],
      wg0: [createInterface('203.0.113.5', 'IPv4'), createInterface('2606:4700::1', 'IPv6')],
    });
    assert.deepEqual(candidates, ['172.32.0.9', '100.128.0.1', '203.0.113.5', '2001:db8::1', '2606:4700::1']);
  });

  it('a machine with no routable address has no candidate (a cloud VPS behind its provider\'s NAT)', () => {
    assert.deepEqual(listPublicAddressCandidates({ eth0: [createInterface('10.0.0.4', 'IPv4')] }), []);
    assert.deepEqual(listPublicAddressCandidates({}), []);
    assert.deepEqual(listPublicAddressCandidates({ eth0: undefined }), []);
  });
});

describe('findProposedHubAddress', () => {
  function createScanner(answers: Record<string, string | null>): { scan: HostKeyScanner; asked: string[] } {
    const asked: string[] = [];
    return { asked, scan: async (host, port) => { asked.push(`${host}:${port}`); return answers[`${host}:${port}`] ?? null; } };
  }

  it('proposes the first candidate that answers with this machine\'s own key, on port 22, with the key to pin', async () => {
    const { scan } = createScanner({ '203.0.113.5:22': ownKey, '127.0.0.1:22': ownKey });
    assert.deepEqual(await findProposedHubAddress(['203.0.113.5'], scan), { address: { host: '203.0.113.5', port: 22 }, hostKey: ownKey });
  });

  it('skips a candidate that answers with a stranger\'s key, one that does not answer, and goes on to the next', async () => {
    const { scan, asked } = createScanner({
      '198.51.100.1:22': strangerKey,
      '198.51.100.2:22': null,
      '203.0.113.5:22': ownKey,
      '127.0.0.1:22': ownKey,
    });
    const proposed = await findProposedHubAddress(['198.51.100.1', '198.51.100.2', '203.0.113.5'], scan);
    assert.equal(proposed?.address.host, '203.0.113.5');
    assert.ok(asked.includes('198.51.100.1:22') && asked.includes('198.51.100.2:22'));
  });

  it('does not propose an address whose own sshd could not be read for comparison (a proposal is a promise that the check passed)', async () => {
    const { scan } = createScanner({ '203.0.113.5:22': ownKey });
    assert.equal(await findProposedHubAddress(['203.0.113.5'], scan), null);
  });

  it('proposes nothing without candidates', async () => {
    const { scan, asked } = createScanner({});
    assert.equal(await findProposedHubAddress([], scan), null);
    assert.deepEqual(asked, []);
  });
});
