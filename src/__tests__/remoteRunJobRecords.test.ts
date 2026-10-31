/**
 * @description `remoteRun/jobRecords.ts` and `jobFiles.ts resolveFetchTarget`: where a job's result files go is decided by the MAIN
 * BOX's own record of the job (written at submit, in the local cache), never by what the runner says — a hostile runner could name any
 * folder of this user in its `meta.json`. A job this machine and user did not submit has no record and its files are not fetched; the
 * `pull:` patterns are those of the recorded project's local `.remote-run`.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveFetchTarget } from '../remoteRun/jobFiles';
import { readLocalJobRecord, writeLocalJobRecord } from '../remoteRun/jobRecords';
import { RemoteRunError } from '../remoteRun/remoteRunError';

const jobId = 'box1-abc234';
const otherJobId = 'box1-bcd345';
const dayMs = 24 * 60 * 60 * 1000;

let workRoot = '';
let cacheDir = '';
let projectRoot = '';

describe('local job records', () => {
  beforeEach(() => {
    workRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'job-records-')));
    cacheDir = path.join(workRoot, 'cache');
    projectRoot = path.join(workRoot, 'project');
    fs.mkdirSync(projectRoot);
  });
  afterEach(() => {
    fs.rmSync(workRoot, { recursive: true, force: true });
  });

  it('what was written is read back; the file and its folder are private to the user', () => {
    writeLocalJobRecord(cacheDir, jobId, { projectRoot, slug: 'project-0123456789', submittedAtMs: 5 });
    assert.deepEqual(readLocalJobRecord(cacheDir, jobId), { projectRoot, slug: 'project-0123456789', submittedAtMs: 5 });
    assert.equal(fs.statSync(path.join(cacheDir, 'jobs', `${jobId}.json`)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(cacheDir, 'jobs')).mode & 0o777, 0o700);
  });

  it('a job nobody here submitted, a damaged record and a record of the wrong shape are all "no record"', () => {
    assert.equal(readLocalJobRecord(cacheDir, jobId), null);
    fs.mkdirSync(path.join(cacheDir, 'jobs'), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'jobs', `${jobId}.json`), '{not json');
    assert.equal(readLocalJobRecord(cacheDir, jobId), null);
    fs.writeFileSync(path.join(cacheDir, 'jobs', `${jobId}.json`), JSON.stringify({ projectRoot: 5 }));
    assert.equal(readLocalJobRecord(cacheDir, jobId), null);
  });

  it('only a job id names a record: a path in its place reads nothing and writes nothing', () => {
    fs.mkdirSync(path.join(cacheDir, 'jobs'), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'secret.json'), JSON.stringify({ projectRoot, slug: 's', submittedAtMs: 1 }));
    assert.equal(readLocalJobRecord(cacheDir, '../secret'), null);
    assert.throws(() => writeLocalJobRecord(cacheDir, '../escape', { projectRoot, slug: 's', submittedAtMs: 1 }), /not a job id/);
    assert.equal(fs.existsSync(path.join(cacheDir, 'escape.json')), false);
  });

  it('records older than the runner keeps its jobs are dropped on the next write, younger ones stay', () => {
    const nowMs = Date.UTC(2026, 10, 1);
    writeLocalJobRecord(cacheDir, jobId, { projectRoot, slug: 's', submittedAtMs: 1 }, nowMs);
    const old = new Date(nowMs - 4 * dayMs);
    fs.utimesSync(path.join(cacheDir, 'jobs', `${jobId}.json`), old, old);
    writeLocalJobRecord(cacheDir, otherJobId, { projectRoot, slug: 's', submittedAtMs: 2 }, nowMs);
    assert.equal(readLocalJobRecord(cacheDir, jobId), null);
    assert.notEqual(readLocalJobRecord(cacheDir, otherJobId), null);
  });
});

describe('resolveFetchTarget', () => {
  beforeEach(() => {
    workRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-target-')));
    projectRoot = path.join(workRoot, 'project');
    fs.mkdirSync(projectRoot);
  });
  afterEach(() => {
    fs.rmSync(workRoot, { recursive: true, force: true });
  });

  it('the recorded project, its runner folder name, and the patterns of ITS local .remote-run', () => {
    fs.writeFileSync(path.join(projectRoot, '.remote-run'), 'pull: out test-results\n');
    assert.deepEqual(resolveFetchTarget({ projectRoot, slug: 'project-0123456789', submittedAtMs: 1 }), { root: projectRoot, slug: 'project-0123456789', patterns: ['out', 'test-results'] });
  });

  it('a project without a .remote-run names no pull pattern: nothing will be copied', () => {
    assert.deepEqual(resolveFetchTarget({ projectRoot, slug: 's', submittedAtMs: 1 }).patterns, []);
  });

  it('no record: refused with the reason — the files of a job this user did not submit here are not fetched', () => {
    assert.throws(() => resolveFetchTarget(null), (error: Error) => error instanceof RemoteRunError && /did not submit the job as this user/.test(error.message));
  });

  it('a project folder that is gone from this machine is refused naming it', () => {
    fs.rmSync(projectRoot, { recursive: true });
    assert.throws(() => resolveFetchTarget({ projectRoot, slug: 's', submittedAtMs: 1 }), (error: Error) => error instanceof RemoteRunError && error.message.includes(projectRoot));
  });
});
