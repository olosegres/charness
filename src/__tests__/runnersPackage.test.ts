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
import { getHubPackage, openHubPackage, supersededArchiveGraceMs } from '../runners/hubPackage';
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

  it('holds package.json, its lock, the runner script and dist — without tests, declarations or source maps', () => {
    const hubPackage = getHubPackage(fixture.ctx);
    assert.match(hubPackage.id, /^[0-9a-f]{16}$/);
    const names = runTar(gunzipSync(fs.readFileSync(hubPackage.filePath)), ['-tf', '-']).trim().split('\n');
    assert.deepEqual(names, ['package.json', 'package-lock.json', 'remoteRun/runner.sh', 'remoteRun/pickNode.sh', 'dist/cli.js', 'dist/runners/example.js']);
  });

  it('gives the runner a package.json cut down to the dependencies the runner needs — the hub\'s name, version and engines, none of its other dependencies or scripts', () => {
    const archive = gunzipSync(fs.readFileSync(getHubPackage(fixture.ctx).filePath));
    assert.deepEqual(JSON.parse(runTar(archive, ['-xOf', '-', 'package.json'])), {
      name: 'charness',
      version: '0.0.0-test',
      license: 'MIT',
      engines: { node: '>=22.12' },
      dependencies: { ssh2: '^1.17.0', zod: '^4.4.3' },
    });
  });

  it('ships the runner\'s lock as package-lock.json — for `npm ci` to install exactly what it records — with the hub\'s own version on it, and every package at a registry tarball with its hash', () => {
    const archive = gunzipSync(fs.readFileSync(getHubPackage(fixture.ctx).filePath));
    const lock = JSON.parse(runTar(archive, ['-xOf', '-', 'package-lock.json']));
    assert.equal(lock.lockfileVersion, 3);
    assert.deepEqual([lock.name, lock.version, lock.packages[''].name, lock.packages[''].version], ['charness', '0.0.0-test', 'charness', '0.0.0-test']);
    assert.deepEqual(lock.packages[''].dependencies, { ssh2: '^1.17.0', zod: '^4.4.3' });
    assert.deepEqual(Object.keys(lock.packages), ['', 'node_modules/ssh2', 'node_modules/zod']);
    for (const [key, entry] of Object.entries<{ resolved: string; integrity: string }>(lock.packages)) {
      if (key === '') continue;
      assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\/\S+\.tgz$/, key);
      assert.match(entry.integrity, /^sha512-/, key);
    }
  });

  it('is a different package — a different id — when only the lock changes: what a runner installs is part of what it runs', () => {
    const before = getHubPackage(fixture.ctx).id;
    const lockPath = path.join(fixture.ctx.packageRoot, 'remoteRun', 'runner-package-lock.json');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    lock.packages['node_modules/zod'].version = '4.4.4';
    fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    assert.notEqual(getHubPackage(fixture.ctx).id, before);
  });

  it('refuses to pack when the lock no longer matches package.json — saying how to bring it up to date — and when the lock is missing', () => {
    const packageJsonPath = path.join(fixture.ctx.packageRoot, 'package.json');
    const original = fs.readFileSync(packageJsonPath, 'utf8');
    fs.writeFileSync(packageJsonPath, original.replace('"ssh2": "^1.17.0"', '"ssh2": "^1.18.0"'));
    assert.throws(() => getHubPackage(fixture.ctx), /the runner's lock expects ssh2@\^1\.17\.0, but package\.json says \^1\.18\.0: run `yarn runner-lock`/);
    fs.writeFileSync(packageJsonPath, original);
    fs.rmSync(path.join(fixture.ctx.packageRoot, 'remoteRun', 'runner-package-lock.json'));
    assert.throws(() => getHubPackage(fixture.ctx), /ENOENT/);
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

  function changeSource(content: string): void {
    fs.writeFileSync(path.join(fixture.ctx.packageRoot, 'dist', 'runners', 'example.js'), content);
  }

  function listArchives(): string[] {
    return fs.readdirSync(getHubFilePaths(fixture.ctx.dir).packageDir).filter((name) => name.endsWith('.tgz')).sort();
  }

  it('packs again when the source changes: another id, current.json points at the new archive', () => {
    const first = getHubPackage(fixture.ctx);
    changeSource('module.exports = 42; // longer\n');
    const second = getHubPackage(fixture.ctx);
    assert.notEqual(second.id, first.id);
    assert.equal(getHubPackage(fixture.ctx).filePath, second.filePath);
  });

  it('keeps the archive it replaced for the grace period: a gate that was handed its path a moment ago must still find it', () => {
    const first = getHubPackage(fixture.ctx);
    changeSource('module.exports = 42; // longer\n');
    const second = getHubPackage(fixture.ctx);
    assert.deepEqual(listArchives(), [path.basename(first.filePath), path.basename(second.filePath)].sort());
    assert.ok(runTar(gunzipSync(fs.readFileSync(first.filePath)), ['-xOf', '-', 'dist/runners/example.js']).includes('module.exports = 1'));
  });

  it('removes a superseded archive once it is older than the grace period, and never the current one', () => {
    const first = getHubPackage(fixture.ctx);
    changeSource('module.exports = 42; // longer\n');
    const second = getHubPackage(fixture.ctx);
    const longAgo = new Date(Date.now() - supersededArchiveGraceMs - 60_000);
    fs.utimesSync(first.filePath, longAgo, longAgo);
    fs.utimesSync(second.filePath, longAgo, longAgo);
    getHubPackage(fixture.ctx);
    assert.deepEqual(listArchives(), [path.basename(second.filePath)]);
  });

  it('interleaved packers of two versions do not take each other\'s archive away, and a reader that opened one first reads it whole', async () => {
    const reader = await openHubPackage(fixture.ctx);
    const readerArchive = getHubPackage(fixture.ctx);
    changeSource('module.exports = 42; // the next version\n');
    const newer = getHubPackage(fixture.ctx);
    // The older source is packed again late (a packer that was slow): its archive appears next to the newer one.
    changeSource('module.exports = 1;\n');
    const olderAgain = getHubPackage(fixture.ctx);
    assert.equal(olderAgain.id, readerArchive.id);
    assert.ok(fs.existsSync(newer.filePath), 'the newer archive is not removed by the late packer');
    const archive = gunzipSync(await reader.handle.readFile());
    await reader.handle.close();
    assert.ok(runTar(archive, ['-xOf', '-', 'dist/runners/example.js']).includes('module.exports = 1'));
  });

  it('a reader holds its file open: removing the archive afterwards does not cut the download', async () => {
    const reader = await openHubPackage(fixture.ctx);
    const current = getHubPackage(fixture.ctx);
    fs.rmSync(current.filePath);
    const archive = gunzipSync(await reader.handle.readFile());
    await reader.handle.close();
    assert.ok(runTar(archive, ['-tf', '-']).includes('package.json'));
  });

  it('opening the package packs it when nothing is cached, and the id matches the file', async () => {
    const reader = await openHubPackage(fixture.ctx);
    await reader.handle.close();
    assert.equal(reader.id, getHubPackage(fixture.ctx).id);
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
