/**
 * @description `connectors/telegram/runnerLinkNotices.ts`: what this instance has already told the operator about where a runner's link comes from
 * (`DATA_DIR/runner-link-notices.json`), and what is news given that. A concern is told apart by the time of its newest change; a change within a
 * fight's window of a fight already told is the same fight. The file is the instance's own and survives a restart; a file that cannot be used reads
 * as empty and says why.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkIsNewConcern, createLinkNotice, readLinkNotices, writeLinkNotices } from '../connectors/telegram/runnerLinkNotices';
import { linkFightWindowMs, type LinkConcern } from '../runners/linkConcern';

const runnerId = 'a1b2c3d4e5f6';
const baseMs = Date.UTC(2026, 10, 3, 12, 0, 0);
const changed = (atMs: number): LinkConcern => ({ kind: 'sourceChanged', fromSource: '198.51.100.7', toSource: '203.0.113.9', atMs, isLiveReplacement: false });
const fighting = (atMs: number): LinkConcern => ({ kind: 'fighting', sources: ['198.51.100.7', '203.0.113.9'], changeCount: 3, atMs });

let folder = '';
beforeEach(() => { folder = fs.mkdtempSync(path.join(os.tmpdir(), 'lnr-')); });
afterEach(() => { fs.rmSync(folder, { recursive: true, force: true }); });

describe('what is news', () => {
  it('a concern when nothing was told of the runner; not one that was told, nor an older one', () => {
    assert.equal(checkIsNewConcern(changed(baseMs), undefined), true);
    const told = createLinkNotice(runnerId, changed(baseMs));
    assert.equal(checkIsNewConcern(changed(baseMs), told), false, 'the same change');
    assert.equal(checkIsNewConcern(changed(baseMs - 1), told), false, 'an older one');
    assert.equal(checkIsNewConcern(changed(baseMs + 1), told), true, 'a newer change is news');
  });

  it('a fight is told once: the changes that go on within its window are the same fight — one after the window is news', () => {
    const told = createLinkNotice(runnerId, fighting(baseMs));
    assert.equal(told.isFight, true);
    assert.equal(checkIsNewConcern(fighting(baseMs + 60 * 1000), told), false);
    assert.equal(checkIsNewConcern(changed(baseMs + linkFightWindowMs - 1), told), false);
    assert.equal(checkIsNewConcern(changed(baseMs + linkFightWindowMs), told), true);
  });

  it('after a plain change, the next change is news at once (no fight was told)', () => {
    assert.equal(checkIsNewConcern(fighting(baseMs + 1000), createLinkNotice(runnerId, changed(baseMs))), true);
  });
});

describe('the record', () => {
  it('is written whole and read back; a missing file is none', () => {
    const file = path.join(folder, 'notices.json');
    assert.deepEqual(readLinkNotices(file), { notices: [], problem: null });
    writeLinkNotices(file, [createLinkNotice(runnerId, changed(baseMs))]);
    assert.deepEqual(readLinkNotices(file), { notices: [{ runnerId, changeAtMs: baseMs, isFight: false }], problem: null });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  it('a file that is not valid reads as none and says why — the next write replaces it', () => {
    const file = path.join(folder, 'notices.json');
    fs.writeFileSync(file, '{ not json');
    assert.match(readLinkNotices(file).problem ?? '', /is not valid JSON/);
    fs.writeFileSync(file, '{"notices":[{"runnerId":"bad id"}]}');
    assert.match(readLinkNotices(file).problem ?? '', /is invalid/);
    assert.deepEqual(readLinkNotices(file).notices, []);
  });
});
