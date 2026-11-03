/**
 * @description `remoteRun/heldBackNotice.ts`: the line about held-back secret-looking files is said when the LIST changes, not on every submit —
 * per project, remembered in the local cache as a hash (no file names), reset by an empty list, and never a reason for a submit to fail.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { recordHeldBackFiles } from '../remoteRun/heldBackNotice';

let cacheDir = '';
const slug = 'app-f37c905e8d';

beforeEach(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'held-back-'));
});
afterEach(() => {
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

describe('recordHeldBackFiles', () => {
  it('the first list is news, the same list again is not — in any order', () => {
    assert.equal(recordHeldBackFiles(cacheDir, slug, ['.env', 'keys/a.pem']), true);
    assert.equal(recordHeldBackFiles(cacheDir, slug, ['.env', 'keys/a.pem']), false);
    assert.equal(recordHeldBackFiles(cacheDir, slug, ['keys/a.pem', '.env']), false);
  });

  it('a list that gained or lost a file is news again, once', () => {
    recordHeldBackFiles(cacheDir, slug, ['.env']);
    assert.equal(recordHeldBackFiles(cacheDir, slug, ['.env', 'keys/a.pem']), true);
    assert.equal(recordHeldBackFiles(cacheDir, slug, ['.env', 'keys/a.pem']), false);
    assert.equal(recordHeldBackFiles(cacheDir, slug, ['keys/a.pem']), true);
    assert.equal(recordHeldBackFiles(cacheDir, slug, ['keys/a.pem']), false);
  });

  it('an empty list is never news and resets the memory: the same file held back again later is news again', () => {
    recordHeldBackFiles(cacheDir, slug, ['.env']);
    assert.equal(recordHeldBackFiles(cacheDir, slug, []), false);
    assert.equal(fs.existsSync(path.join(cacheDir, 'held-back', `${slug}.json`)), false);
    assert.equal(recordHeldBackFiles(cacheDir, slug, ['.env']), true);
  });

  it('each project has its own memory, and the file holds a hash, not names, readable by its owner only', () => {
    recordHeldBackFiles(cacheDir, slug, ['secret-name.pem']);
    assert.equal(recordHeldBackFiles(cacheDir, 'other-0123456789', ['secret-name.pem']), true);
    const stored = path.join(cacheDir, 'held-back', `${slug}.json`);
    assert.ok(!fs.readFileSync(stored, 'utf8').includes('secret-name'));
    assert.equal(fs.statSync(stored).mode & 0o777, 0o600);
  });

  it('a cache that cannot be written, an unreadable memory and an odd slug only mean the line is said again — never a failure', () => {
    fs.writeFileSync(path.join(cacheDir, 'held-back'), 'a file where the folder should be');
    assert.equal(recordHeldBackFiles(cacheDir, slug, ['.env']), true);
    assert.equal(recordHeldBackFiles(cacheDir, slug, ['.env']), true);
    fs.rmSync(path.join(cacheDir, 'held-back'));
    fs.mkdirSync(path.join(cacheDir, 'held-back'));
    fs.writeFileSync(path.join(cacheDir, 'held-back', `${slug}.json`), '{not json');
    assert.equal(recordHeldBackFiles(cacheDir, slug, ['.env']), true);
    assert.equal(recordHeldBackFiles(cacheDir, '../escape', ['.env']), true);
    assert.equal(recordHeldBackFiles(cacheDir, '../escape', ['.env']), true);
    assert.equal(fs.existsSync(path.join(cacheDir, '..', 'escape.json')), false);
  });
});
