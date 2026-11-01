/**
 * @description `runners/pairCode.ts`: the pairing code round-trips, and a damaged or hostile one is refused with the field named and
 * no value quoted (the code carries a private key).
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodePairCode, encodePairCode, pairCodePrefix } from '../runners/pairCode';
import { createPairCodePayload } from './runnersTestKit';

function encodeRaw(object: object): string {
  return `${pairCodePrefix}${Buffer.from(JSON.stringify(object), 'utf8').toString('base64url')}`;
}

describe('pair code', () => {
  it('round-trips every field', () => {
    const payload = createPairCodePayload({ port: 2222 });
    const code = encodePairCode(payload);
    assert.ok(code.startsWith('cr1.'));
    assert.deepEqual(decodePairCode(code), { ok: true, payload });
  });

  it('is one token: url-safe characters only, so a shell or a chat message keeps it whole', () => {
    assert.match(encodePairCode(createPairCodePayload()), /^cr1\.[A-Za-z0-9_-]+$/);
  });

  it('refuses a text that is not a code, naming the problem', () => {
    assert.equal(decodePairCode('hello').ok, false);
    assert.equal(decodePairCode('cr2.abc').ok, false);
    const damaged = decodePairCode(`${pairCodePrefix}not-json-at-all`);
    assert.equal(damaged.ok, false);
  });

  it('refuses a code with a missing, extra or malformed field', () => {
    const payload = createPairCodePayload();
    const { pairId, ...withoutPairId } = payload;
    void pairId;
    assert.equal(decodePairCode(encodeRaw(withoutPairId)).ok, false);
    assert.equal(decodePairCode(encodeRaw({ ...payload, extra: 1 })).ok, false);
    for (const bad of [
      { host: 'two words' },
      { host: '-oProxyCommand=x' },
      { host: 'a;b' },
      { port: 0 },
      { port: 70000 },
      { user: 'bad user' },
      { user: '-x' },
      { hostKey: 'ssh-ed25519 AAAA\nssh-rsa BBBB' },
      { privateKey: 'not a key' },
      { pairId: 'XYZ' },
    ]) {
      assert.equal(decodePairCode(encodeRaw({ ...payload, ...bad })).ok, false, JSON.stringify(Object.keys(bad)));
    }
  });

  it('never quotes the code or its private key in an error', () => {
    const payload = createPairCodePayload();
    const secretBody = payload.privateKey.split('\n')[1];
    const result = decodePairCode(encodeRaw({ ...payload, host: 'two words' }));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(!result.error.includes(secretBody));
      assert.ok(!result.error.includes('two words'));
      assert.match(result.error, /host/);
    }
  });

  it('refuses an oversized code without parsing it', () => {
    assert.equal(decodePairCode(`${pairCodePrefix}${'A'.repeat(5000)}`).ok, false);
  });

  it('refuses to encode an invalid payload', () => {
    assert.throws(() => encodePairCode(createPairCodePayload({ host: 'two words' })));
  });
});
