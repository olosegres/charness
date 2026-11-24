/**
 * @description The store of the comments the Jira answer sink keeps up to date (`progressComments.ts`): what is remembered is
 * read back from `DATA_DIR/jira-progress-comments.jsonl` by a restarted process, a comment let go stays let go, a remembered
 * comment replaces the one before it, requests and slots never share an entry, an entry past its age is forgotten, and a line
 * that does not parse is skipped, never fatal.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JiraProgressComments, jiraProgressCommentMaxAgeMs, jiraProgressCommentsFileName } from '../connectors/jira/progressComments';

let dataDir: string;
let nowMs: number;

const filePath = (): string => path.join(dataDir, jiraProgressCommentsFileName);
async function openStore(): Promise<JiraProgressComments> {
  const store = JiraProgressComments.createForDataDir(filePath(), () => nowMs);
  await store.load();
  return store;
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'jira-progress-comments-'));
  nowMs = Date.parse('2026-10-03T12:00:00Z');
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the comments the answer sink edits', () => {
  it('a remembered comment and its thread are found again by a process that reads the file', async () => {
    const store = await openStore();
    assert.equal(store.get('req_1', 'progress'), null);
    store.remember('req_1', 'progress', '10500', '10200');
    store.remember('req_2', 'progress', '10501', null);
    const restarted = await openStore();
    assert.deepEqual(restarted.get('req_1', 'progress'), { commentId: '10500', threadRootId: '10200' });
    assert.deepEqual(restarted.get('req_2', 'progress'), { commentId: '10501', threadRootId: null });
  });

  it('the newest comment replaces the one before it — after a restart too; a comment let go stays let go', async () => {
    const store = await openStore();
    store.remember('req_1', 'progress', '10500', null);
    store.remember('req_1', 'progress', '10600', '10200');
    store.remember('req_3', 'progress', '10700', null);
    store.forget('req_3', 'progress');
    const restarted = await openStore();
    assert.deepEqual(restarted.get('req_1', 'progress'), { commentId: '10600', threadRootId: '10200' });
    assert.equal(restarted.get('req_3', 'progress'), null);
    assert.equal(readFileSync(filePath(), 'utf8').trim().split('\n').length, 5, 'one line per change; letting a progress comment go also keeps it as released');
  });

  it('a request\'s slots are apart: its progress note and its repeating notice are two comments; letting one go leaves the other', async () => {
    const store = await openStore();
    store.remember('req_1', 'progress', '10500', null);
    store.remember('req_1', 'notice:usageLimitWait', '10501', null);
    store.forget('req_1', 'progress');
    assert.equal(store.get('req_1', 'progress'), null);
    assert.equal(store.get('req_1', 'notice:usageLimitWait')?.commentId, '10501');
  });

  it('forgetAll lets go of every slot of ONE request — after a restart too — except the slot it is told to keep', async () => {
    const store = await openStore();
    store.remember('req_1', 'progress', '10500', null);
    store.remember('req_1', 'notice:usageLimitWait', '10501', null);
    store.remember('req_2', 'progress', '10502', null);
    store.forgetAll('req_1', ['progress']);
    assert.equal(store.get('req_1', 'progress')?.commentId, '10500');
    assert.equal(store.get('req_1', 'notice:usageLimitWait'), null);
    store.forgetAll('req_1');
    const restarted = await openStore();
    assert.equal(restarted.get('req_1', 'progress'), null);
    assert.equal(restarted.get('req_2', 'progress')?.commentId, '10502', 'another request\'s comments are not touched');
    restarted.forgetAll('req_3');
    // Several slots can be kept.
    restarted.remember('req_4', 'progress', '10600', null);
    restarted.remember('req_4', 'notice:a', '10601', null);
    restarted.remember('req_4', 'notice:b', '10602', null);
    restarted.forgetAll('req_4', ['progress', 'notice:b']);
    assert.deepEqual(['progress', 'notice:a', 'notice:b'].map((slot) => restarted.get('req_4', slot)?.commentId ?? null), ['10600', null, '10602']);
  });

  it('a progress comment let go before the answer is kept as released: the answer closes it with the one kept now, then settles the request', async () => {
    const store = await openStore();
    store.remember('req_1', 'progress', '10500', null);
    store.remember('req_1', 'notice:usageLimitWait', '10501', null);
    store.forgetAll('req_1');
    assert.equal(store.get('req_1', 'progress'), null, 'let go: the next note is a new comment');
    store.remember('req_1', 'progress', '10600', '10200');
    store.forgetAll('req_1', ['progress']);
    const restarted = await openStore();
    assert.deepEqual(restarted.listToClose('req_1').sort(), ['10500', '10600'], 'the released one survives a restart; a notice is never closed');
    restarted.forgetAll('req_1');
    assert.deepEqual(restarted.listToClose('req_1').sort(), ['10500', '10600'], 'forgetAll keeps what is released');
    assert.deepEqual(restarted.listToClose('req_2'), []);
    restarted.settle('req_1');
    assert.deepEqual(restarted.listToClose('req_1'), []);
    assert.deepEqual((await openStore()).listToClose('req_1'), [], 'settled for good');
  });

  it('letting go what is not remembered writes nothing', async () => {
    const store = await openStore();
    store.forget('req_1', 'progress');
    assert.throws(() => readFileSync(filePath(), 'utf8'), /ENOENT/);
  });

  it('an entry past its age is forgotten: a request quiet for a week gets a new comment', async () => {
    const store = await openStore();
    store.remember('req_1', 'progress', '10500', null);
    nowMs += jiraProgressCommentMaxAgeMs - 1;
    assert.equal(store.get('req_1', 'progress')?.commentId, '10500');
    nowMs += 1;
    assert.equal(store.get('req_1', 'progress'), null);
  });

  it('a line that does not parse is skipped with a warning — the rest is kept', async () => {
    const store = await openStore();
    store.remember('req_1', 'progress', '10500', null);
    appendFileSync(filePath(), 'not json\n{"requestId":""}\n');
    const restarted = await openStore();
    assert.equal(restarted.get('req_1', 'progress')?.commentId, '10500');
  });

  it('a store whose file cannot be written still remembers for this process', async () => {
    // A folder cannot be made under a regular file.
    writeFileSync(path.join(dataDir, 'a-file'), '');
    const store = JiraProgressComments.createForDataDir(path.join(dataDir, 'a-file', jiraProgressCommentsFileName), () => nowMs);
    store.remember('req_1', 'progress', '10500', null);
    assert.equal(store.get('req_1', 'progress')?.commentId, '10500');
  });
});
