/**
 * @description `runnerUtility/toolInstall.ts`: Pueue from pinned release binaries that must match their sha256 before they are kept,
 * and an rsync that is found (never Apple's `openrsync`, which lacks the options phase 1 uses) or built from its pinned source.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { CommandRunner } from '../selfUpdate/commandRunner';
import { getRunnerHomePaths, type RunnerHomePaths } from '../runnerUtility/runnerHome';
import {
  buildRsync,
  checkIsRsyncUsable,
  describeRsyncRemedy,
  downloadVerified,
  ensurePueue,
  findRsync,
  getPueueAsset,
  parseRsyncVersion,
  parseToolVersion,
  planRsyncBuild,
  pueueAssets,
  type FetchFunction,
  type ToolDeps,
} from '../runnerUtility/toolInstall';

let home = '';
let paths: RunnerHomePaths;

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function createFetch(files: Record<string, Buffer>, requested: string[] = []): FetchFunction {
  return async (url) => {
    requested.push(url);
    const bytes = files[url];
    return { ok: bytes !== undefined, status: bytes === undefined ? 404 : 200, arrayBuffer: async () => Uint8Array.from(bytes ?? Buffer.alloc(0)).buffer };
  };
}

function createDeps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  return {
    runner: async () => ({ ok: false, exitCode: 1, stdout: '', stderr: '', isTimedOut: false }),
    platform: 'linux',
    arch: 'x64',
    environment: { PATH: '/nowhere' },
    fetchImpl: createFetch({}),
    pueueAssetTable: pueueAssets,
    checkExists: () => false,
    cpuCount: 4,
    ...overrides,
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-'));
  paths = getRunnerHomePaths(home);
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('pinned Pueue', () => {
  it('covers the four platforms the runner utility supports, with a sha256 for every binary', () => {
    assert.deepEqual(Object.keys(pueueAssets).sort(), ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']);
    for (const asset of Object.values(pueueAssets)) {
      for (const hash of [asset.pueueSha256, asset.pueuedSha256]) assert.match(hash, /^[0-9a-f]{64}$/);
      assert.match(asset.pueueUrl, /^https:\/\/github\.com\/Nukesor\/pueue\/releases\/download\/v4\.0\.4\/pueue-/);
      assert.match(asset.pueuedUrl, /\/pueued-/);
    }
    assert.equal(getPueueAsset('win32', 'x64'), undefined);
    assert.ok(getPueueAsset('darwin', 'arm64')?.pueueUrl.endsWith('pueue-aarch64-apple-darwin'));
  });

  it('keeps a download only when its sha256 matches, and makes it executable', async () => {
    const bytes = Buffer.from('#!/bin/sh\necho pueue 4.0.4\n');
    const destination = path.join(home, 'bin', 'pueue');
    await downloadVerified('https://example.test/pueue', sha256(bytes), destination, createFetch({ 'https://example.test/pueue': bytes }));
    assert.deepEqual(fs.readFileSync(destination), bytes);
    assert.equal(fs.statSync(destination).mode & 0o777, 0o755);
  });

  it('throws away a download with a wrong checksum — the file never exists under its final name', async () => {
    const destination = path.join(home, 'bin', 'pueue');
    await assert.rejects(downloadVerified('https://example.test/pueue', sha256(Buffer.from('expected')), destination, createFetch({ 'https://example.test/pueue': Buffer.from('tampered') })), /checksum mismatch/);
    assert.equal(fs.existsSync(destination), false);
    assert.deepEqual(fs.existsSync(path.dirname(destination)) ? fs.readdirSync(path.dirname(destination)) : [], []);
  });

  it('reports an HTTP failure', async () => {
    await assert.rejects(downloadVerified('https://example.test/missing', 'a'.repeat(64), path.join(home, 'x'), createFetch({})), /HTTP 404/);
  });

  it('installs pueue and pueued once; a second call downloads nothing', async () => {
    const asset = pueueAssets['linux-x64'];
    const pueue = Buffer.from('pueue-binary');
    const pueued = Buffer.from('pueued-binary');
    const table = { 'linux-x64': { ...asset, pueueSha256: sha256(pueue), pueuedSha256: sha256(pueued) } };
    const requested: string[] = [];
    const deps = createDeps({
      pueueAssetTable: table,
      fetchImpl: createFetch({ [asset.pueueUrl]: pueue, [asset.pueuedUrl]: pueued }, requested),
      checkExists: fs.existsSync,
      runner: async (file) => ({ ok: fs.existsSync(file), exitCode: 0, stdout: 'pueue 4.0.4\n', stderr: '', isTimedOut: false }),
    });
    const first = await ensurePueue(paths, deps);
    assert.ok(first.ok && first.wasInstalled && first.tool.version === '4.0.4');
    assert.deepEqual(requested, [asset.pueueUrl, asset.pueuedUrl]);
    const second = await ensurePueue(paths, deps);
    assert.ok(second.ok && !second.wasInstalled);
    assert.equal(requested.length, 2);
  });

  it('names the problem on an unsupported platform and on a failed download', async () => {
    const unsupported = await ensurePueue(paths, createDeps({ platform: 'freebsd' }));
    assert.ok(!unsupported.ok && /no pinned Pueue binary for freebsd\/x64/.test(unsupported.reason));
    const failed = await ensurePueue(paths, createDeps());
    assert.ok(!failed.ok && /HTTP 404/.test(failed.reason));
  });

  it('reads a version out of --version text', () => {
    assert.equal(parseToolVersion('pueue 4.0.4\n'), '4.0.4');
    assert.equal(parseToolVersion('no digits'), null);
  });
});

describe('rsync', () => {
  const gnuText = 'rsync  version 3.4.1  protocol version 32\nCopyright (C) 1996-2025\n';
  const openText = 'openrsync: protocol version 29\nrsync compatible (2.6.9)\n';

  it('tells rsync from openrsync and refuses what phase 1 cannot use', () => {
    assert.deepEqual(parseRsyncVersion(gnuText), { flavor: 'rsync', version: '3.4.1' });
    assert.deepEqual(parseRsyncVersion(openText), { flavor: 'openrsync', version: null });
    assert.deepEqual(parseRsyncVersion('rsync  version 2.6.9  protocol version 29'), { flavor: 'rsync', version: '2.6.9' });
    assert.equal(parseRsyncVersion('something else'), null);
    assert.equal(checkIsRsyncUsable({ flavor: 'rsync', version: '3.4.1' }), true);
    assert.equal(checkIsRsyncUsable({ flavor: 'rsync', version: '3.1.0' }), true);
    assert.equal(checkIsRsyncUsable({ flavor: 'rsync', version: '3.0.9' }), false);
    assert.equal(checkIsRsyncUsable({ flavor: 'rsync', version: '2.6.9' }), false);
    assert.equal(checkIsRsyncUsable({ flavor: 'openrsync', version: null }), false);
  });

  it('finds a usable rsync past an unusable one, searching PATH then the Homebrew folders', async () => {
    const present = new Set(['/usr/bin/rsync', '/opt/homebrew/bin/rsync']);
    const runner: CommandRunner = async (file) => ({ ok: true, exitCode: 0, stdout: file === '/usr/bin/rsync' ? openText : gnuText, stderr: '', isTimedOut: false });
    const found = await findRsync(paths, createDeps({ runner, checkExists: (candidate) => present.has(candidate), environment: { PATH: '/usr/bin:/bin' } }));
    assert.deepEqual(found, { path: '/opt/homebrew/bin/rsync', version: '3.4.1' });
  });

  it('finds none when the only rsync is openrsync', async () => {
    const runner: CommandRunner = async () => ({ ok: true, exitCode: 0, stdout: openText, stderr: '', isTimedOut: false });
    assert.equal(await findRsync(paths, createDeps({ runner, checkExists: (candidate) => candidate === '/usr/bin/rsync' })), null);
  });

  it('plans the build: unpack, configure without optional libraries, make, install into the runner\'s own folder', () => {
    const steps = planRsyncBuild(paths, 8);
    assert.deepEqual(steps.map((step) => step.file), ['tar', './configure', 'make', 'make']);
    assert.ok(steps[1].args.includes(`--prefix=${path.join(paths.root, 'rsync')}`));
    for (const flag of ['--disable-xxhash', '--disable-zstd', '--disable-lz4', '--disable-openssl', '--with-included-popt', '--with-included-zlib']) assert.ok(steps[1].args.includes(flag), flag);
    assert.deepEqual(steps[2].args, ['-j8']);
    assert.deepEqual(steps[3].args, ['install']);
  });

  it('says the one command to run when there is no compiler', async () => {
    const outcome = await buildRsync(paths, createDeps({ platform: 'darwin' }));
    assert.ok(!outcome.ok);
    if (!outcome.ok) assert.equal(outcome.reason, describeRsyncRemedy('darwin'));
    assert.match(describeRsyncRemedy('darwin'), /xcode-select --install/);
    assert.match(describeRsyncRemedy('linux'), /apt install rsync/);
  });
});
