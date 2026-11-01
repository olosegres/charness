/**
 * @description `runners/tarArchive.ts` + `hubPackage.ts`: the deterministic tar (read back by the system `tar`), and the packed hub
 * package — what it holds and leaves out, an id that depends on the content alone, and a cache that is reused while the source stands
 * still and replaced when it changes.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { gunzipSync } from 'zlib';
import { getHubPackage } from '../runners/hubPackage';
import { getHubFilePaths } from '../runners/hubPaths';
import { createTarArchive, splitTarPath } from '../runners/tarArchive';
import { createHubFixture, type HubFixture } from './runnersTestKit';

function runTar(archive: Buffer, args: string[]): string {
  const result = spawnSync('tar', args, { input: archive, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

describe('tar archive', () => {
  it('is read back by tar: names, contents and modes', () => {
    const archive = createTarArchive([
      { path: 'package.json', content: Buffer.from('{"a":1}\n'), mode: 0o644 },
      { path: 'dist/run.sh', content: Buffer.from('#!/bin/sh\n'), mode: 0o755 },
      { path: 'empty.txt', content: Buffer.alloc(0), mode: 0o644 },
      { path: `dist/${'d'.repeat(120)}/file.js`, content: Buffer.from('long'), mode: 0o644 },
    ]);
    assert.equal(archive.length % 512, 0);
    assert.deepEqual(runTar(archive, ['-tf', '-']).trim().split('\n'), ['package.json', 'dist/run.sh', 'empty.txt', `dist/${'d'.repeat(120)}/file.js`]);
    assert.equal(runTar(archive, ['-xOf', '-', 'package.json']), '{"a":1}\n');
    assert.equal(runTar(archive, ['-xOf', '-', `dist/${'d'.repeat(120)}/file.js`]), 'long');
    const listing = runTar(archive, ['-tvf', '-']);
    assert.match(listing, /^-rw-r--r--.* package\.json$/m);
    assert.match(listing, /^-rwxr-xr-x.* dist\/run\.sh$/m);
  });

  it('gives the same bytes for the same entries', () => {
    const entries = [{ path: 'a.txt', content: Buffer.from('x'), mode: 0o644 }];
    assert.ok(createTarArchive(entries).equals(createTarArchive(entries)));
  });

  it('splits a long path at a slash into prefix and name, and refuses one that cannot be split', () => {
    assert.deepEqual(splitTarPath('short/path.js'), { name: 'short/path.js', prefix: '' });
    const split = splitTarPath(`${'a'.repeat(90)}/${'b'.repeat(90)}`);
    assert.deepEqual(split, { prefix: 'a'.repeat(90), name: 'b'.repeat(90) });
    assert.equal(splitTarPath('c'.repeat(300)), null);
    assert.throws(() => createTarArchive([{ path: 'c'.repeat(300), content: Buffer.alloc(0), mode: 0o644 }]), /too long/);
  });
});

describe('hub package', () => {
  let fixture: HubFixture;
  beforeEach(() => {
    fixture = createHubFixture();
  });
  afterEach(() => {
    fixture.cleanup();
  });

  it('holds package.json, the runner script and dist — without tests, declarations or source maps', () => {
    const hubPackage = getHubPackage(fixture.ctx);
    assert.match(hubPackage.id, /^[0-9a-f]{16}$/);
    const names = runTar(gunzipSync(fs.readFileSync(hubPackage.filePath)), ['-tf', '-']).trim().split('\n');
    assert.deepEqual(names, ['package.json', 'remoteRun/runner.sh', 'dist/cli.js', 'dist/runners/example.js']);
  });

  it('keeps the executable bit of a script', () => {
    const hubPackage = getHubPackage(fixture.ctx);
    const listing = runTar(gunzipSync(fs.readFileSync(hubPackage.filePath)), ['-tvf', '-']);
    assert.match(listing, /^-rwxr-xr-x.* remoteRun\/runner\.sh$/m);
    assert.match(listing, /^-rw-r--r--.* dist\/runners\/example\.js$/m);
  });

  it('reuses the cached package while the source is unchanged', () => {
    const first = getHubPackage(fixture.ctx);
    const modifiedAt = fs.statSync(first.filePath).mtimeMs;
    const second = getHubPackage(fixture.ctx);
    assert.deepEqual(second, first);
    assert.equal(fs.statSync(second.filePath).mtimeMs, modifiedAt);
  });

  it('packs again when the source changes: another id, and only the current file is kept', () => {
    const first = getHubPackage(fixture.ctx);
    fs.writeFileSync(path.join(fixture.ctx.packageRoot, 'dist', 'runners', 'example.js'), 'module.exports = 42; // longer\n');
    const second = getHubPackage(fixture.ctx);
    assert.notEqual(second.id, first.id);
    assert.equal(fs.existsSync(first.filePath), false);
    assert.deepEqual(fs.readdirSync(getHubFilePaths(fixture.ctx.dir).packageDir).filter((name) => name.endsWith('.tgz')), [path.basename(second.filePath)]);
  });

  it('the id is a function of the content alone: the same files in another place give the same id', () => {
    const other = createHubFixture();
    try {
      for (const relative of ['dist/runners/example.js', 'dist/cli.js', 'package.json']) {
        fs.copyFileSync(path.join(fixture.ctx.packageRoot, relative), path.join(other.ctx.packageRoot, relative));
      }
      assert.equal(getHubPackage(other.ctx).id, getHubPackage(fixture.ctx).id);
    } finally {
      other.cleanup();
    }
  });

  it('a package root without dist is an error, not an empty package', () => {
    fs.rmSync(path.join(fixture.ctx.packageRoot, 'dist'), { recursive: true });
    assert.throws(() => getHubPackage(fixture.ctx), /ENOENT/);
  });
});
