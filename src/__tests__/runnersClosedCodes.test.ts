/**
 * @description The trace a closed pairing code leaves (`closed.json`, in `runners/hubRegistry.ts`): a round trip from an owner-only file,
 * the same code noted again keeps one entry, only the newest fifty are kept and NOTHING is dropped for its age, a file that is missing reads
 * as none and one that cannot be used reads as none with the problem handed back (the caller says it once), a trace that cannot be written
 * costs a log line and nothing else, and a file that cannot be used is replaced by the next noting.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { getHubFilePaths, type HubContext } from '../runners/hubPaths';
import { readClosedCodes, recordClosedCode } from '../runners/hubRegistry';
import { createHubFixture, type HubFixture } from './runnersTestKit';

let fixture: HubFixture;
let logged: string[] = [];
let ctx: HubContext;
const startMs = Date.UTC(2026, 10, 1, 12, 0, 0);
const dayMs = 24 * 60 * 60 * 1000;

function createId(index: number): string {
  return index.toString(16).padStart(12, '0');
}

beforeEach(() => {
  fixture = createHubFixture();
  logged = [];
  fs.mkdirSync(fixture.ctx.dir, { recursive: true });
  ctx = { ...fixture.ctx, log: (line) => { logged.push(line); } };
});
afterEach(() => {
  fixture.cleanup();
});

describe('closed pairing codes', () => {
  it('lives in the registry folder as closed.json; a missing file is none, silently; what is noted is read back from an owner-only file, and noting a code again keeps one entry', () => {
    assert.equal(getHubFilePaths(ctx.dir).closed, path.join(ctx.dir, 'closed.json'));
    assert.deepEqual(readClosedCodes(ctx.dir), { codes: [], problem: null });
    recordClosedCode(ctx, createId(1), startMs);
    recordClosedCode(ctx, createId(2), startMs + 1000);
    recordClosedCode(ctx, createId(1), startMs + 2000);
    assert.deepEqual(readClosedCodes(ctx.dir), { codes: [{ pairId: createId(2), closedAtMs: startMs + 1000 }, { pairId: createId(1), closedAtMs: startMs + 2000 }], problem: null });
    assert.equal(fs.statSync(getHubFilePaths(ctx.dir).closed).mode & 0o777, 0o600);
    assert.deepEqual(logged, []);
  });

  it('drops nothing for its age — a message that was unsettled for days (the bot was down) still finds its trace; only the cap of fifty forgets', () => {
    recordClosedCode(ctx, createId(1), startMs);
    recordClosedCode(ctx, createId(2), startMs + 30 * dayMs);
    assert.deepEqual(readClosedCodes(ctx.dir).codes.map((entry) => entry.pairId), [createId(1), createId(2)]);
  });

  it('holds the newest fifty and no more', () => {
    for (let index = 0; index < 60; index += 1) recordClosedCode(ctx, createId(index), startMs + index);
    const { codes } = readClosedCodes(ctx.dir);
    assert.equal(codes.length, 50);
    assert.equal(codes[0].pairId, createId(10));
    assert.equal(codes.at(-1)?.pairId, createId(59));
  });

  it('a file that cannot be used reads as none and hands the problem back — it logs nothing itself, so the caller says it once; the next noting replaces the file and says so', () => {
    const file = getHubFilePaths(ctx.dir).closed;
    fs.writeFileSync(file, '{ not json');
    assert.deepEqual(readClosedCodes(ctx.dir), { codes: [], problem: 'closed.json is not valid JSON; fix or remove it by hand (nothing was changed); the codes in it read as expired' });
    fs.writeFileSync(file, JSON.stringify({ closed: [{ pairId: 'not-an-id', closedAtMs: 1 }] }));
    assert.match(readClosedCodes(ctx.dir).problem ?? '', /^closed\.json is invalid: closed\.0\.pairId .*; the codes in it read as expired$/);
    assert.deepEqual(logged, []);
    recordClosedCode(ctx, createId(1), startMs);
    assert.equal(logged.length, 1, 'replacing a broken file is said');
    assert.match(logged[0], /closed\.json is invalid.*; it is written anew$/);
    assert.deepEqual(readClosedCodes(ctx.dir), { codes: [{ pairId: createId(1), closedAtMs: startMs }], problem: null });
  });

  it('a trace that cannot be written never throws — it is a line in the log and nothing else', () => {
    fs.mkdirSync(getHubFilePaths(ctx.dir).closed); // a folder where the file should be: reading and writing both fail
    assert.doesNotThrow(() => { recordClosedCode(ctx, createId(1), startMs); });
    assert.ok(logged.some((line) => /^closed\.json could not be written \(\w+\); the messages of the code that was just closed will read as expired$/.test(line)), logged.join(' | '));
  });
});
