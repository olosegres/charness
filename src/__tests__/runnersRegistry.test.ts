/**
 * @description `runners/hubPairing.ts` + `hubRegistry.ts` + `hubPaths.ts`: making a pairing code, spending it (single use — also under
 * concurrency), expiry and its sweep, runner names, removal and pause, and the files derived from the registry (`known_hosts`, the
 * managed `authorized_keys` block). A registry file that does not validate stops the caller instead of being read as empty.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { extractManagedBlock } from '../runners/authorizedKeys';
import { decodePairCode } from '../runners/pairCode';
import { createHubContext, getHandMadeRunnersPath, getHubFilePaths, getRunnerHostAlias } from '../runners/hubPaths';
import {
  checkIsPairingOpen,
  createPairing,
  pairingLifetimeMs,
  pickFreeRunnerName,
  redeemPairing,
  removePairedRunner,
  sanitizeRunnerName,
  setPairedRunnerPaused,
  sweepExpiredPairings,
} from '../runners/hubPairing';
import { AuthorizedKeysBlockError, authorizedKeysBlockStart } from '../runners/authorizedKeys';
import { HubDerivedFilesError, HubRegistryError, readPairedFile, readPendingFile, writePendingFile } from '../runners/hubRegistry';
import { generateEd25519KeyPair, getPublicKeyFingerprint } from '../runners/sshKeys';
import { createHubFixture, createRedeemFixture, type HubFixture } from './runnersTestKit';

const startMs = Date.UTC(2026, 10, 1, 12, 0, 0);
const hubHostKey = generateEd25519KeyPair('hub-host').publicKey;

let fixture: HubFixture;

function createTestPairing(nowMs: number = startMs) {
  return createPairing(fixture.ctx, { host: 'host.example', port: 2222, hostKey: hubHostKey, label: '@ExampleBot', nowMs, sshUser: 'hubuser' });
}

function readBlock(): string[] {
  return extractManagedBlock(fs.readFileSync(fixture.ctx.authorizedKeysPath, 'utf8'));
}

describe('hub context', () => {
  it('keeps the registry beside runners.json in the user\'s charness config folder', () => {
    const ctx = createHubContext({ homeDir: '/home/user' });
    assert.equal(ctx.dir, '/home/user/.config/charness/runners');
    assert.equal(getHandMadeRunnersPath(ctx.dir), '/home/user/.config/charness/runners.json');
    assert.equal(ctx.authorizedKeysPath, '/home/user/.ssh/authorized_keys');
  });

  it('packs the folder above the cli.js it runs from', () => {
    const ctx = createHubContext({ homeDir: '/home/user', cliPath: '/opt/charness/dist/cli.js' });
    assert.equal(ctx.packageRoot, '/opt/charness');
  });
});

describe('pairing', () => {
  beforeEach(() => {
    fixture = createHubFixture();
  });
  afterEach(() => {
    fixture.cleanup();
  });

  it('makes a code good for 10 minutes: a pending entry, a temporary key line, and a code that carries the private half', async () => {
    const pairing = await createTestPairing();
    assert.equal(pairing.expiresAtMs, startMs + pairingLifetimeMs);
    assert.equal(pairingLifetimeMs, 10 * 60 * 1000);
    const pending = readPendingFile(fixture.ctx.dir).pending;
    assert.equal(pending.length, 1);
    assert.equal(pending[0].pairId, pairing.pairId);
    assert.equal(pending[0].label, '@ExampleBot');
    assert.equal(pending[0].keyFingerprint, getPublicKeyFingerprint(pending[0].publicKey));
    const decoded = decodePairCode(pairing.code);
    assert.ok(decoded.ok);
    assert.deepEqual(decoded.ok && { host: decoded.payload.host, port: decoded.payload.port, user: decoded.payload.user, hostKey: decoded.payload.hostKey, pairId: decoded.payload.pairId }, {
      host: 'host.example',
      port: 2222,
      user: 'hubuser',
      hostKey: hubHostKey,
      pairId: pairing.pairId,
    });
    const block = readBlock();
    assert.equal(block.length, 1);
    assert.ok(block[0].startsWith('restrict,expiry-time="20261101121000Z",command="'));
    assert.ok(block[0].includes(` redeem ${pairing.pairId}"`));
    assert.ok(block[0].includes(pending[0].publicKey));
    assert.ok(!block[0].includes('PRIVATE'));
    assert.equal(checkIsPairingOpen(fixture.ctx, pairing.pairId, startMs + 1), true);
    assert.equal(checkIsPairingOpen(fixture.ctx, pairing.pairId, startMs + pairingLifetimeMs), false);
    assert.equal(checkIsPairingOpen(fixture.ctx, 'ffffffffffff', startMs), false);
  });

  it('keeps the registry folder private and its files 0600', async () => {
    await createTestPairing();
    assert.equal(fs.statSync(fixture.ctx.dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(getHubFilePaths(fixture.ctx.dir).pending).mode & 0o777, 0o600);
  });

  it('spends the code: the runner is registered, the temporary line is replaced by a permanent one, the host key is pinned', async () => {
    const pairing = await createTestPairing();
    const { request } = createRedeemFixture();
    const reply = await redeemPairing(fixture.ctx, pairing.pairId, request, startMs + 1000);
    assert.ok(reply.ok);
    if (!reply.ok) return;
    assert.equal(reply.name, 'mac-mini');
    assert.equal(reply.label, '@ExampleBot');
    assert.equal(reply.host, 'host.example');
    assert.equal(reply.port, 2222);
    const paired = readPairedFile(fixture.ctx.dir);
    assert.equal(paired.rev, 1);
    assert.equal(paired.runners.length, 1);
    assert.deepEqual({ id: paired.runners[0].id, name: paired.runners[0].name, publicKey: paired.runners[0].publicKey, hostKey: paired.runners[0].hostKey, isPaused: paired.runners[0].isPaused, pairId: paired.runners[0].pairId, pairedAtMs: paired.runners[0].pairedAtMs }, {
      id: reply.runnerId,
      name: 'mac-mini',
      publicKey: request.publicKey,
      hostKey: request.hostKey,
      isPaused: false,
      pairId: pairing.pairId,
      pairedAtMs: startMs + 1000,
    });
    assert.equal(readPendingFile(fixture.ctx.dir).pending.length, 0);
    const block = readBlock();
    assert.equal(block.length, 1);
    assert.ok(block[0].startsWith('restrict,command="'), 'no expiry, no pairing line left');
    assert.ok(block[0].endsWith(` ${request.publicKey} charness-runner:${reply.runnerId}`));
    assert.equal(fs.readFileSync(getHubFilePaths(fixture.ctx.dir).knownHosts, 'utf8'), `${getRunnerHostAlias(reply.runnerId)} ${request.hostKey}\n`);
    assert.equal(fs.readFileSync(getHubFilePaths(fixture.ctx.dir).hubPublicKey, 'utf8').split(' ').slice(0, 2).join(' '), reply.hubPublicKey);
    assert.equal(fs.statSync(getHubFilePaths(fixture.ctx.dir).hubKey).mode & 0o777, 0o600);
  });

  it('single use: the same code redeemed again is refused and changes nothing', async () => {
    const pairing = await createTestPairing();
    const first = await redeemPairing(fixture.ctx, pairing.pairId, createRedeemFixture().request, startMs);
    const second = await redeemPairing(fixture.ctx, pairing.pairId, createRedeemFixture().request, startMs);
    assert.ok(first.ok);
    assert.deepEqual(second, { ok: false, reason: 'this pairing code is unknown or already used' });
    assert.equal(readPairedFile(fixture.ctx.dir).runners.length, 1);
    assert.equal(readPairedFile(fixture.ctx.dir).rev, 1);
  });

  it('single use under concurrency: of many simultaneous redeems exactly one wins', async () => {
    const pairing = await createTestPairing();
    const replies = await Promise.all(Array.from({ length: 8 }, () => redeemPairing(fixture.ctx, pairing.pairId, createRedeemFixture().request, startMs)));
    assert.equal(replies.filter((reply) => reply.ok).length, 1);
    assert.equal(readPairedFile(fixture.ctx.dir).runners.length, 1);
    assert.equal(readBlock().length, 1);
  });

  it('refuses a code that never existed', async () => {
    const reply = await redeemPairing(fixture.ctx, 'ffffffffffff', createRedeemFixture().request, startMs);
    assert.equal(reply.ok, false);
    assert.equal(readPairedFile(fixture.ctx.dir).runners.length, 0);
  });

  it('refuses a code after its 10 minutes, and the sweep hands the expired pairing back and drops its line', async () => {
    const pairing = await createTestPairing();
    const late = startMs + pairingLifetimeMs;
    const reply = await redeemPairing(fixture.ctx, pairing.pairId, createRedeemFixture().request, late);
    assert.deepEqual(reply, { ok: false, reason: 'this pairing code has expired' });
    assert.equal(readPairedFile(fixture.ctx.dir).runners.length, 0);
    const expired = await sweepExpiredPairings(fixture.ctx, late);
    assert.deepEqual(expired.map((entry) => entry.pairId), [pairing.pairId]);
    assert.equal(readPendingFile(fixture.ctx.dir).pending.length, 0);
    assert.deepEqual(readBlock(), []);
  });

  it('the sweep keeps a code that is still open, and a code made later does not swallow an expired one', async () => {
    const old = await createTestPairing(startMs);
    const fresh = await createTestPairing(startMs + pairingLifetimeMs + 1000);
    assert.equal(readPendingFile(fixture.ctx.dir).pending.length, 2, 'the expired code stays listed until a sweep hands it back');
    assert.equal(readBlock().length, 1, 'but its line is already gone from authorized_keys');
    const expired = await sweepExpiredPairings(fixture.ctx, startMs + pairingLifetimeMs + 1000);
    assert.deepEqual(expired.map((entry) => entry.pairId), [old.pairId]);
    assert.deepEqual(readPendingFile(fixture.ctx.dir).pending.map((entry) => entry.pairId), [fresh.pairId]);
    assert.deepEqual(await sweepExpiredPairings(fixture.ctx, startMs + pairingLifetimeMs + 1000), []);
  });

  it('refuses a key that is already registered', async () => {
    const same = createRedeemFixture();
    const first = await createTestPairing();
    const second = await createTestPairing();
    assert.ok((await redeemPairing(fixture.ctx, first.pairId, same.request, startMs)).ok);
    const again = await redeemPairing(fixture.ctx, second.pairId, same.request, startMs);
    assert.deepEqual(again, { ok: false, reason: 'this machine is already paired' });
    assert.equal(readPendingFile(fixture.ctx.dir).pending.length, 1, 'the second code stays open');
  });

  it('never replaces a hub key that is only half there — every paired runner trusts it', async () => {
    fs.mkdirSync(fixture.ctx.dir, { recursive: true });
    fs.writeFileSync(getHubFilePaths(fixture.ctx.dir).hubKey, 'a private key without its public half');
    const pairing = await createTestPairing();
    await assert.rejects(redeemPairing(fixture.ctx, pairing.pairId, createRedeemFixture().request, startMs), HubRegistryError);
    assert.equal(fs.readFileSync(getHubFilePaths(fixture.ctx.dir).hubKey, 'utf8'), 'a private key without its public half');
    assert.equal(readPairedFile(fixture.ctx.dir).runners.length, 0);
    assert.equal(checkIsPairingOpen(fixture.ctx, pairing.pairId, startMs), true, 'the code stays usable once the key is fixed');
  });

  it('keeps the operator\'s own keys through a whole cycle', async () => {
    fs.mkdirSync(path.dirname(fixture.ctx.authorizedKeysPath), { recursive: true });
    const foreign = '# mine\nssh-ed25519 AAAAFOREIGN me@laptop\n';
    fs.writeFileSync(fixture.ctx.authorizedKeysPath, foreign);
    const pairing = await createTestPairing();
    const reply = await redeemPairing(fixture.ctx, pairing.pairId, createRedeemFixture().request, startMs);
    assert.ok(reply.ok);
    if (reply.ok) await removePairedRunner(fixture.ctx, reply.name, startMs);
    assert.equal(fs.readFileSync(fixture.ctx.authorizedKeysPath, 'utf8'), foreign);
  });
});

describe('runner names', () => {
  it('turns what a machine calls itself into a valid name', () => {
    assert.equal(sanitizeRunnerName('Mac Mini'), 'mac-mini');
    assert.equal(sanitizeRunnerName('  My_Mac.local '), 'my-mac-local');
    assert.equal(sanitizeRunnerName('---'), 'runner');
    assert.equal(sanitizeRunnerName(''), 'runner');
    const long = sanitizeRunnerName('a'.repeat(23) + '-bbbbbbbb');
    assert.ok(long.length <= 24 && !long.endsWith('-'), long);
  });

  it('adds -2, -3 … until the name is free', () => {
    assert.equal(pickFreeRunnerName('box', new Set()), 'box');
    assert.equal(pickFreeRunnerName('box', new Set(['box'])), 'box-2');
    assert.equal(pickFreeRunnerName('box', new Set(['box', 'box-2'])), 'box-3');
  });

  describe('against the registry', () => {
    beforeEach(() => {
      fixture = createHubFixture();
    });
    afterEach(() => {
      fixture.cleanup();
    });

    it('two machines with one host name get two names; a hand-made runner of that name counts too', async () => {
      fs.mkdirSync(path.dirname(getHandMadeRunnersPath(fixture.ctx.dir)), { recursive: true });
      fs.writeFileSync(getHandMadeRunnersPath(fixture.ctx.dir), JSON.stringify({ runners: [{ name: 'box', ssh: 'runner@runner.example', workDir: '/home/runner/work' }] }));
      const names: string[] = [];
      for (let index = 0; index < 2; index += 1) {
        const pairing = await createTestPairing();
        const reply = await redeemPairing(fixture.ctx, pairing.pairId, createRedeemFixture({ suggestedName: 'Box' }).request, startMs);
        if (reply.ok) names.push(reply.name);
      }
      assert.deepEqual(names, ['box-2', 'box-3']);
    });
  });
});

describe('removing and pausing', () => {
  beforeEach(() => {
    fixture = createHubFixture();
  });
  afterEach(() => {
    fixture.cleanup();
  });

  async function pairOne(suggestedName: string): Promise<{ id: string; name: string }> {
    const pairing = await createTestPairing();
    const reply = await redeemPairing(fixture.ctx, pairing.pairId, createRedeemFixture({ suggestedName }).request, startMs);
    if (!reply.ok) throw new Error(reply.reason);
    return { id: reply.runnerId, name: reply.name };
  }

  it('removing a runner deletes its key line, its host key and its entry, and bumps the revision', async () => {
    const mac = await pairOne('mac');
    const box = await pairOne('box');
    assert.equal(readPairedFile(fixture.ctx.dir).rev, 2);
    const removed = await removePairedRunner(fixture.ctx, 'mac', startMs);
    assert.equal(removed?.id, mac.id);
    const paired = readPairedFile(fixture.ctx.dir);
    assert.deepEqual(paired.runners.map((runner) => runner.id), [box.id]);
    assert.equal(paired.rev, 3);
    assert.equal(readBlock().length, 1);
    assert.ok(readBlock()[0].includes(`charness-runner:${box.id}`));
    assert.ok(!fs.readFileSync(getHubFilePaths(fixture.ctx.dir).knownHosts, 'utf8').includes(mac.id));
  });

  it('a runner can be found by id as well as by name; an unknown one is null', async () => {
    const mac = await pairOne('mac');
    assert.equal(await removePairedRunner(fixture.ctx, 'nobody', startMs), null);
    assert.equal((await removePairedRunner(fixture.ctx, mac.id, startMs))?.name, 'mac');
  });

  it('pause and resume flip the hub-side flag; the revision moves only when it changes', async () => {
    await pairOne('mac');
    const before = readPairedFile(fixture.ctx.dir).rev;
    assert.equal((await setPairedRunnerPaused(fixture.ctx, 'mac', true))?.isPaused, true);
    assert.equal(readPairedFile(fixture.ctx.dir).runners[0].isPaused, true);
    assert.equal(readPairedFile(fixture.ctx.dir).rev, before + 1);
    await setPairedRunnerPaused(fixture.ctx, 'mac', true);
    assert.equal(readPairedFile(fixture.ctx.dir).rev, before + 1);
    assert.equal((await setPairedRunnerPaused(fixture.ctx, 'mac', false))?.isPaused, false);
    assert.equal(await setPairedRunnerPaused(fixture.ctx, 'nobody', true), null);
  });
});

describe('a registry file that does not validate', () => {
  beforeEach(() => {
    fixture = createHubFixture();
  });
  afterEach(() => {
    fixture.cleanup();
  });

  it('stops the caller with the problem named and no value echoed; it is never read as empty', async () => {
    fs.mkdirSync(fixture.ctx.dir, { recursive: true });
    const paired = getHubFilePaths(fixture.ctx.dir).paired;
    fs.writeFileSync(paired, JSON.stringify({ rev: 1, runners: [{ id: 'secret-looking-value' }] }));
    assert.throws(() => readPairedFile(fixture.ctx.dir), (error: Error) => error instanceof HubRegistryError && /paired\.json is invalid/.test(error.message) && !error.message.includes('secret-looking-value'));
    await assert.rejects(createTestPairing(), HubRegistryError);
    assert.equal(fs.readFileSync(paired, 'utf8').includes('secret-looking-value'), true, 'the broken file is left for the operator');
  });

  it('a file that is not JSON is reported as such', () => {
    fs.mkdirSync(fixture.ctx.dir, { recursive: true });
    fs.writeFileSync(getHubFilePaths(fixture.ctx.dir).pending, '{not json');
    assert.throws(() => readPendingFile(fixture.ctx.dir), /pending\.json is not valid JSON/);
  });
});

describe('interrupted operations mend themselves', () => {
  beforeEach(() => {
    fixture = createHubFixture();
  });
  afterEach(() => {
    fixture.cleanup();
  });

  /** A directory where the atomic write of `authorized_keys` wants its temp file: the write fails, whoever runs it. */
  function blockAuthorizedKeysWrite(): () => void {
    const blocker = `${fs.realpathSync(fixture.ctx.authorizedKeysPath)}.${process.pid}.tmp`;
    fs.mkdirSync(blocker);
    return () => fs.rmSync(blocker, { recursive: true });
  }

  it('a code whose pending entry outlived a crash is still single use: another key is refused, the same machine is answered again', async () => {
    const pairing = await createTestPairing();
    const survivingEntry = readPendingFile(fixture.ctx.dir).pending[0];
    const first = createRedeemFixture();
    const reply = await redeemPairing(fixture.ctx, pairing.pairId, first.request, startMs);
    assert.ok(reply.ok);
    // The crash: paired.json was written, pending.json was not.
    writePendingFile(fixture.ctx.dir, { pending: [survivingEntry] });
    assert.equal(checkIsPairingOpen(fixture.ctx, pairing.pairId, startMs), false, 'a used code is not open');

    const stranger = await redeemPairing(fixture.ctx, pairing.pairId, createRedeemFixture().request, startMs);
    assert.deepEqual(stranger, { ok: false, reason: 'this pairing code is unknown or already used' });
    assert.equal(readPairedFile(fixture.ctx.dir).runners.length, 1);

    const again = await redeemPairing(fixture.ctx, pairing.pairId, first.request, startMs, '0123456789abcdef');
    assert.ok(again.ok);
    if (reply.ok && again.ok) {
      assert.equal(again.runnerId, reply.runnerId);
      assert.equal(again.name, reply.name);
      assert.equal(again.packageId, '0123456789abcdef');
      assert.deepEqual({ label: again.label, host: again.host, port: again.port }, { label: '@ExampleBot', host: 'host.example', port: 2222 });
    }
    assert.equal(readPairedFile(fixture.ctx.dir).runners.length, 1);
    assert.equal(readPairedFile(fixture.ctx.dir).rev, 1);
    assert.equal(readPendingFile(fixture.ctx.dir).pending.length, 0, 'the leftover entry is dropped');
  });

  it('removing a runner right after an interrupted redemption does not make its spent code redeemable again', async () => {
    const pairing = await createTestPairing();
    const survivingEntry = readPendingFile(fixture.ctx.dir).pending[0];
    const first = await redeemPairing(fixture.ctx, pairing.pairId, createRedeemFixture({ suggestedName: 'mac' }).request, startMs);
    assert.ok(first.ok);
    // The crash: paired.json was written, pending.json was not. The entry — and its temporary key's line — is still there.
    writePendingFile(fixture.ctx.dir, { pending: [survivingEntry] });
    assert.notEqual(await removePairedRunner(fixture.ctx, 'mac', startMs), null);

    assert.deepEqual(readPendingFile(fixture.ctx.dir).pending, [], 'the spent code\'s entry is gone with the runner');
    assert.deepEqual(readBlock(), [], 'and so is the temporary key\'s line');
    assert.equal(checkIsPairingOpen(fixture.ctx, pairing.pairId, startMs), false);
    const again = await redeemPairing(fixture.ctx, pairing.pairId, createRedeemFixture().request, startMs);
    assert.deepEqual(again, { ok: false, reason: 'this pairing code is unknown or already used' });
    assert.equal(readPairedFile(fixture.ctx.dir).runners.length, 0);
  });

  it('the sweep drops the entry of a used code without handing it back as expired', async () => {
    const pairing = await createTestPairing();
    const survivingEntry = readPendingFile(fixture.ctx.dir).pending[0];
    await redeemPairing(fixture.ctx, pairing.pairId, createRedeemFixture().request, startMs);
    writePendingFile(fixture.ctx.dir, { pending: [survivingEntry] });
    assert.deepEqual(await sweepExpiredPairings(fixture.ctx, startMs + pairingLifetimeMs + 1), []);
    assert.equal(readPendingFile(fixture.ctx.dir).pending.length, 0);
  });

  it('a failure to write authorized_keys after the registry was written leaves a committed runner; asking again installs its key', async () => {
    const pairing = await createTestPairing();
    const { request } = createRedeemFixture();
    const unblock = blockAuthorizedKeysWrite();
    await assert.rejects(redeemPairing(fixture.ctx, pairing.pairId, request, startMs), HubDerivedFilesError);
    assert.equal(readPairedFile(fixture.ctx.dir).runners.length, 1, 'the registry is the commit');
    assert.equal(readPendingFile(fixture.ctx.dir).pending.length, 0);
    assert.ok(!readBlock().some((line) => line.includes('charness-runner:')), 'the key is not installed yet');

    unblock();
    const retry = await redeemPairing(fixture.ctx, pairing.pairId, request, startMs);
    assert.ok(retry.ok);
    const block = readBlock();
    assert.equal(block.length, 1);
    assert.ok(block[0].includes(` ${request.publicKey} charness-runner:`));
    assert.equal(readPairedFile(fixture.ctx.dir).runners.length, 1);
  });

  it('a failure to write known_hosts is reported the same way and mended the same way', async () => {
    const pairing = await createTestPairing();
    const { request } = createRedeemFixture();
    const blocker = `${getHubFilePaths(fixture.ctx.dir).knownHosts}.${process.pid}.tmp`;
    fs.mkdirSync(blocker);
    await assert.rejects(redeemPairing(fixture.ctx, pairing.pairId, request, startMs), (error: Error) => error instanceof HubDerivedFilesError && /known_hosts/.test(error.message));
    fs.rmSync(blocker, { recursive: true });
    assert.ok((await redeemPairing(fixture.ctx, pairing.pairId, request, startMs)).ok);
    assert.ok(fs.readFileSync(getHubFilePaths(fixture.ctx.dir).knownHosts, 'utf8').includes(request.hostKey));
  });

  it('a removal whose key rewrite failed is repaired by the next command, which finds nothing left to remove', async () => {
    const pairing = await createTestPairing();
    const reply = await redeemPairing(fixture.ctx, pairing.pairId, createRedeemFixture({ suggestedName: 'mac' }).request, startMs);
    assert.ok(reply.ok);
    const unblock = blockAuthorizedKeysWrite();
    await assert.rejects(removePairedRunner(fixture.ctx, 'mac', startMs), HubDerivedFilesError);
    assert.equal(readPairedFile(fixture.ctx.dir).runners.length, 0);
    assert.equal(readBlock().length, 1, 'the key line is still there');

    unblock();
    assert.equal(await removePairedRunner(fixture.ctx, 'mac', startMs), null);
    assert.deepEqual(readBlock(), []);
  });

  it('any other operation repairs the files too — a sweep, a pause', async () => {
    const pairing = await createTestPairing();
    await redeemPairing(fixture.ctx, pairing.pairId, createRedeemFixture({ suggestedName: 'mac' }).request, startMs);
    const unblock = blockAuthorizedKeysWrite();
    await assert.rejects(removePairedRunner(fixture.ctx, 'mac', startMs), HubDerivedFilesError);
    unblock();
    await sweepExpiredPairings(fixture.ctx, startMs);
    assert.deepEqual(readBlock(), []);
  });

  it('a damaged authorized_keys block stops the operation before anything is written', async () => {
    fs.mkdirSync(path.dirname(fixture.ctx.authorizedKeysPath), { recursive: true });
    fs.writeFileSync(fixture.ctx.authorizedKeysPath, `${authorizedKeysBlockStart}\nno end marker\n`);
    await assert.rejects(createTestPairing(), AuthorizedKeysBlockError);
    assert.equal(fs.existsSync(getHubFilePaths(fixture.ctx.dir).pending), false);

    fs.writeFileSync(fixture.ctx.authorizedKeysPath, '');
    const pairing = await createTestPairing();
    fs.writeFileSync(fixture.ctx.authorizedKeysPath, `${authorizedKeysBlockStart}\nno end marker\n`);
    await assert.rejects(redeemPairing(fixture.ctx, pairing.pairId, createRedeemFixture().request, startMs), AuthorizedKeysBlockError);
    assert.equal(readPairedFile(fixture.ctx.dir).runners.length, 0, 'the code was not spent');
    assert.equal(readPendingFile(fixture.ctx.dir).pending.length, 1);
    await assert.rejects(removePairedRunner(fixture.ctx, 'anyone', startMs), AuthorizedKeysBlockError);
  });
});
