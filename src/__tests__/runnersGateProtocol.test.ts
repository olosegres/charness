/**
 * @description `runners/gateProtocol.ts`: the marker line that opens a gate's answer, and the reader that skips whatever a chatty shell
 * printed before it.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'stream';
import { formatGateMarkerLine, gateMarker, parseGateMarkerLine, readUntilGateMarker, redeemRequestSchema } from '../runners/gateProtocol';
import { createRedeemFixture } from './runnersTestKit';

describe('marker line', () => {
  it('round-trips a request with fields', () => {
    const line = formatGateMarkerLine('link', { package: '0123456789abcdef' });
    assert.equal(line, `${gateMarker} link package=0123456789abcdef\n`);
    assert.deepEqual(parseGateMarkerLine(line.trimEnd()), { request: 'link', fields: { package: '0123456789abcdef' } });
    assert.deepEqual(parseGateMarkerLine(formatGateMarkerLine('unpair').trimEnd()), { request: 'unpair', fields: {} });
  });

  it('is not fooled by anything else', () => {
    for (const text of ['', 'link', `${gateMarker}`, `${gateMarker} nothing`, `${gateMarker} link package=a b`, `x ${gateMarker} link`, `${gateMarker} link package=a;b`]) {
      assert.equal(parseGateMarkerLine(text), null, text);
    }
  });
});

describe('readUntilGateMarker', () => {
  it('drops noise lines before the marker and hands back the bytes that followed it in the same read', async () => {
    const stream = new PassThrough();
    const pending = readUntilGateMarker(stream);
    stream.write('Welcome to the hub!\nmotd line 2\n');
    stream.write(`${gateMarker} package id=abc\nGZIPDATA`);
    const result = await pending;
    assert.ok(result);
    assert.deepEqual(result.marker, { request: 'package', fields: { id: 'abc' } });
    assert.equal(result.rest.toString('utf8'), 'GZIPDATA');
  });

  it('finds a marker that arrives in pieces', async () => {
    const stream = new PassThrough();
    const pending = readUntilGateMarker(stream);
    const line = formatGateMarkerLine('link', { package: 'abc' });
    stream.write(line.slice(0, 7));
    stream.write(line.slice(7, 20));
    stream.write(`${line.slice(20)}tail`);
    const result = await pending;
    assert.equal(result?.marker.request, 'link');
    assert.equal(result?.rest.toString('utf8'), 'tail');
  });

  it('resolves null when the stream ends without a marker', async () => {
    const stream = new PassThrough();
    const pending = readUntilGateMarker(stream);
    stream.end('just noise\n');
    assert.equal(await pending, null);
  });

  it('gives up on a stream that is all noise', async () => {
    const stream = new PassThrough();
    const pending = readUntilGateMarker(stream, 100);
    stream.write(`${'x'.repeat(60)}\n`);
    stream.write(`${'y'.repeat(60)}\n`);
    assert.equal(await pending, null);
  });

  it('leaves the stream paused, so the caller can put the rest back and hand it on', async () => {
    const stream = new PassThrough();
    const pending = readUntilGateMarker(stream);
    stream.write(`${formatGateMarkerLine('redeem')}{"ok":true}\n`);
    const result = await pending;
    assert.ok(result);
    stream.unshift(result.rest);
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.resume();
    stream.end();
    await new Promise((resolve) => { stream.once('end', resolve); });
    assert.equal(Buffer.concat(chunks).toString('utf8'), '{"ok":true}\n');
  });
});

describe('redeem request', () => {
  it('accepts what a runner sends', () => {
    assert.equal(redeemRequestSchema.safeParse(createRedeemFixture().request).success, true);
  });

  it('refuses a key that could smuggle an option or a second line into authorized_keys', () => {
    const { request } = createRedeemFixture();
    for (const publicKey of [`${request.publicKey} extra`, `${request.publicKey}\nssh-rsa AAAA`, `command="x" ${request.publicKey}`, 'ssh-rsa AAAAB3NzaC1yc2E', '']) {
      assert.equal(redeemRequestSchema.safeParse({ ...request, publicKey }).success, false, JSON.stringify(publicKey));
      assert.equal(redeemRequestSchema.safeParse({ ...request, hostKey: publicKey }).success, false, JSON.stringify(publicKey));
    }
  });

  it('refuses an unknown field, a relative work dir and an unknown service kind', () => {
    const { request } = createRedeemFixture();
    assert.equal(redeemRequestSchema.safeParse({ ...request, extra: 1 }).success, false);
    assert.equal(redeemRequestSchema.safeParse({ ...request, workDir: 'relative/path' }).success, false);
    assert.equal(redeemRequestSchema.safeParse({ ...request, serviceKind: 'cron' }).success, false);
  });
});
