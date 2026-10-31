/**
 * @description `remoteRun/depsPlan.ts`: the dependencies step — the default command by lockfile, the default key set, what
 * `.remote-run` overrides, and the key itself (a changed lockfile, patch, workspace manifest or command changes it; an unrelated file
 * does not).
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeDepsKey, hashContent, planDepsStep } from '../remoteRun/depsPlan';

const noOverrides = { install: null, installKey: null };

describe('planDepsStep', () => {
  it('picks the command by lockfile', () => {
    assert.equal(planDepsStep(['yarn.lock', 'package.json'], noOverrides)?.command, 'yarn install --immutable');
    assert.equal(planDepsStep(['package-lock.json', 'package.json'], noOverrides)?.command, 'npm ci');
    assert.equal(planDepsStep(['pnpm-lock.yaml', 'package.json'], noOverrides)?.command, 'pnpm install --frozen-lockfile');
  });

  it('two lockfiles: yarn wins, then pnpm', () => {
    assert.equal(planDepsStep(['package-lock.json', 'yarn.lock'], noOverrides)?.command, 'yarn install --immutable');
    assert.equal(planDepsStep(['package-lock.json', 'pnpm-lock.yaml'], noOverrides)?.command, 'pnpm install --frozen-lockfile');
  });

  it('no lockfile, no step', () => {
    assert.equal(planDepsStep(['package.json', 'src/a.ts'], noOverrides), null);
  });

  it('the default key: the lockfile, every package.json, .yarnrc.yml, everything under patches/ — nothing else', () => {
    const plan = planDepsStep(['yarn.lock', 'package.json', 'packages/a/package.json', '.yarnrc.yml', 'patches/x.patch', 'src/a.ts', 'README.md', 'sub/yarn.lock'], noOverrides);
    assert.deepEqual(plan?.keyFiles, ['.yarnrc.yml', 'package.json', 'packages/a/package.json', 'patches/x.patch', 'yarn.lock']);
  });

  it('`install:` replaces the command (and works without a lockfile), `install: none` turns the step off', () => {
    assert.equal(planDepsStep(['package.json'], { install: 'make deps', installKey: null })?.command, 'make deps');
    assert.equal(planDepsStep(['yarn.lock'], { install: 'yarn install --frozen-lockfile', installKey: null })?.command, 'yarn install --frozen-lockfile');
    assert.equal(planDepsStep(['yarn.lock'], { install: 'none', installKey: null }), null);
  });

  it('`install-key:` replaces the default key set with the files its patterns name', () => {
    const plan = planDepsStep(['yarn.lock', 'package.json', 'Makefile', 'deps/a.txt', 'deps/b.txt'], { install: 'make deps', installKey: ['Makefile', 'deps'] });
    assert.deepEqual(plan?.keyFiles, ['Makefile', 'deps/a.txt', 'deps/b.txt']);
  });
});

describe('computeDepsKey', () => {
  const files = [{ path: 'yarn.lock', contentHash: hashContent(Buffer.from('lock v1')) }, { path: 'package.json', contentHash: hashContent(Buffer.from('{}')) }];

  it('is stable: the same command and files give the same key whatever the order', () => {
    assert.equal(computeDepsKey('yarn install', files), computeDepsKey('yarn install', [...files].reverse()));
  });

  it('changes with a key file\'s content, a new key file, or the command', () => {
    const base = computeDepsKey('yarn install', files);
    assert.notEqual(computeDepsKey('yarn install', [{ path: 'yarn.lock', contentHash: hashContent(Buffer.from('lock v2')) }, files[1]]), base);
    assert.notEqual(computeDepsKey('yarn install', [...files, { path: 'patches/x', contentHash: hashContent(Buffer.from('p')) }]), base);
    assert.notEqual(computeDepsKey('yarn install --immutable', files), base);
  });

  it('a file moved to another path is a different key (the path counts, not only the bytes)', () => {
    assert.notEqual(computeDepsKey('c', [{ path: 'a', contentHash: 'h' }]), computeDepsKey('c', [{ path: 'b', contentHash: 'h' }]));
  });
});
