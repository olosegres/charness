/**
 * @description `runners/pairCode.ts`: the pairing code round-trips, the previous (JSON) format is still read, and a damaged or hostile one is refused with the
 * field named and no value quoted (the code carries a private key).
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodePairCode, encodePairCode, getPairCodeFields, joinPairCodeFields, pairCodePrefix, type PairCodeFields } from '../runners/pairCode';
import { createPairCodePayload } from './runnersTestKit';

const jsonPairCodePrefix = 'cr1.';

/** A code of the previous format: the payload (or whatever object) as base64url JSON. */
function encodeJson(object: object): string {
  return `${jsonPairCodePrefix}${Buffer.from(JSON.stringify(object), 'utf8').toString('base64url')}`;
}

/** A code of the current format with the fields (in their order) replaced by `overrides`. */
function encodeFields(overrides: Partial<PairCodeFields>): string {
  return joinPairCodeFields({ ...getPairCodeFields(createPairCodePayload()), ...overrides });
}

describe('pair code', () => {
  it('round-trips every field — the private key comes back as the generator wrote it', () => {
    const payload = createPairCodePayload({ port: 2222 });
    const code = encodePairCode(payload);
    assert.ok(code.startsWith('cr2.'));
    assert.deepEqual(decodePairCode(code), { ok: true, payload });
  });

  it('lists its fields in one order — user, host, port, id, host key type, host key, key body — and is what a shell makes by joining its variables', () => {
    const payload = createPairCodePayload({ host: 'hub.example', port: 2222, user: 'hubuser', pairId: '0123456789ab' });
    const fields = getPairCodeFields(payload);
    assert.deepEqual([fields.user, fields.host, fields.port, fields.pairId, fields.hostKeyType], ['hubuser', 'hub.example', '2222', '0123456789ab', 'ssh-ed25519']);
    assert.equal(fields.hostKeyType + ' ' + fields.hostKeyBlob, payload.hostKey);
    assert.match(fields.privateKeyBody, /^[A-Za-z0-9+/=]+$/, 'the base64 body of the key: no header, no footer, no line break');
    assert.equal(encodePairCode(payload), `cr2.hubuser,hub.example,2222,0123456789ab,${fields.hostKeyType},${fields.hostKeyBlob},${fields.privateKeyBody}`);
    assert.equal(joinPairCodeFields({ ...fields, user: '$u', host: '$h', port: '$p', hostKeyType: '$y', hostKeyBlob: '$z', privateKeyBody: '$k' }), 'cr2.$u,$h,$p,0123456789ab,$y,$z,$k', 'with shell words in place of values');
  });

  it('is one token: no space, quote, backslash or shell character, so a shell or a chat message keeps it whole', () => {
    assert.match(encodePairCode(createPairCodePayload()), /^cr2\.[A-Za-z0-9+/=,._:-]+$/);
    assert.match(encodePairCode(createPairCodePayload({ host: '2001:db8::1' })), /^cr2\.[A-Za-z0-9+/=,._:-]+$/, 'also with an IPv6 address');
  });

  it('still reads the previous format — base64url JSON — that a line made by the version before stays good for its ten minutes', () => {
    const payload = createPairCodePayload({ port: 2222 });
    assert.deepEqual(decodePairCode(encodeJson(payload)), { ok: true, payload });
  });

  it('refuses a text that is not a code, naming the problem', () => {
    assert.equal(decodePairCode('hello').ok, false);
    assert.equal(decodePairCode('cr3.abc').ok, false);
    assert.equal(decodePairCode('cr2.abc').ok, false, 'a list of the wrong length');
    assert.equal(decodePairCode(`${jsonPairCodePrefix}not-json-at-all`).ok, false);
    const code = encodePairCode(createPairCodePayload());
    assert.equal(decodePairCode(`${code},extra`).ok, false, 'one field too many');
    assert.equal(decodePairCode(code.slice(0, code.lastIndexOf(','))).ok, false, 'one field too few');
  });

  it('refuses a code with a malformed field of either format, naming the field', () => {
    const payload = createPairCodePayload();
    const { pairId, ...withoutPairId } = payload;
    void pairId;
    assert.equal(decodePairCode(encodeJson(withoutPairId)).ok, false);
    assert.equal(decodePairCode(encodeJson({ ...payload, extra: 1 })).ok, false);
    const bad: Array<[string, Partial<PairCodeFields>, RegExp]> = [
      ['host', { host: 'two words' }, /host/],
      ['host', { host: '-oProxyCommand=x' }, /host/],
      ['host', { host: 'a;b' }, /host/],
      ['port', { port: '0' }, /port/],
      ['port', { port: '70000' }, /port/],
      ['port', { port: '22abc' }, /port/],
      ['user', { user: 'bad user' }, /user/],
      ['user', { user: '-x' }, /user/],
      ['host key', { hostKeyType: 'ssh-dss' }, /hostKey/],
      ['host key', { hostKeyBlob: 'AAAA\nBBBB' }, /hostKey/],
      ['private key', { privateKeyBody: 'not a key!' }, /privateKey/],
      ['private key', { privateKeyBody: '' }, /privateKey/],
      ['id', { pairId: 'XYZ' }, /pairId/],
    ];
    for (const [label, overrides, field] of bad) {
      const result = decodePairCode(encodeFields(overrides));
      assert.equal(result.ok, false, label);
      if (!result.ok) assert.match(result.error, field, label);
    }
    for (const overrides of [{ host: 'two words' }, { port: '0' }, { user: 'bad user' }, { pairId: 'XYZ' }]) {
      assert.equal(decodePairCode(encodeJson({ ...payload, ...overrides, port: overrides.port === undefined ? payload.port : Number(overrides.port) })).ok, false, JSON.stringify(Object.keys(overrides)));
    }
  });

  it('never quotes the code or its private key in an error', () => {
    const payload = createPairCodePayload();
    const secretBody = getPairCodeFields(payload).privateKeyBody;
    for (const result of [decodePairCode(encodeFields({ host: 'two words' })), decodePairCode(encodeJson({ ...payload, host: 'two words' })), decodePairCode(encodeFields({ port: 'secret-port' }))]) {
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(!result.error.includes(secretBody.slice(0, 40)));
        assert.ok(!result.error.includes('two words') && !result.error.includes('secret-port'));
      }
    }
    const damaged = decodePairCode('cr2.only,three,fields');
    assert.equal(damaged.ok, false);
    if (!damaged.ok) assert.ok(!damaged.error.includes('three'));
  });

  it('refuses an oversized code without parsing it', () => {
    assert.equal(decodePairCode(`${pairCodePrefix}${'A'.repeat(5000)}`).ok, false);
    assert.equal(decodePairCode(`${jsonPairCodePrefix}${'A'.repeat(5000)}`).ok, false);
  });

  it('refuses to encode an invalid payload', () => {
    assert.throws(() => encodePairCode(createPairCodePayload({ host: 'two words' })));
    assert.throws(() => getPairCodeFields(createPairCodePayload({ pairId: 'not an id' })));
  });
});
