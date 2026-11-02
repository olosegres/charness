/**
 * @description `runners/hubClosedCodes.ts`: the trace a closed pairing code leaves (`closed.json`) — a round trip, the same code noted again
 * keeps one entry, old entries and entries beyond the newest fifty go, and a file that is missing reads as none while one that cannot be
 * used reads as none and says so through the hub's log.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { closedCodeKeepMs, readClosedCodes, recordClosedCode } from '../runners/hubClosedCodes';
import type { HubContext } from '../runners/hubPaths';
import { createHubFixture, type HubFixture } from './runnersTestKit';

let fixture: HubFixture;
let logged: string[] = [];
let ctx: HubContext;
const startMs = Date.UTC(2026, 10, 1, 12, 0, 0);

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
  it('a missing file is none, silently; what is noted is read back from an owner-only file, and noting a code again keeps one entry', () => {
    assert.deepEqual(readClosedCodes(ctx), []);
    assert.deepEqual(logged, []);
    recordClosedCode(ctx, createId(1), startMs);
    recordClosedCode(ctx, createId(2), startMs + 1000);
    recordClosedCode(ctx, createId(1), startMs + 2000);
    assert.deepEqual(readClosedCodes(ctx), [{ pairId: createId(2), closedAtMs: startMs + 1000 }, { pairId: createId(1), closedAtMs: startMs + 2000 }]);
    assert.equal(fs.statSync(path.join(ctx.dir, 'closed.json')).mode & 0o777, 0o600);
  });

  it('forgets a code a day after it was closed — as long as an unsettled message is retried — and keeps the newer ones', () => {
    recordClosedCode(ctx, createId(1), startMs);
    recordClosedCode(ctx, createId(2), startMs + closedCodeKeepMs - 1000);
    recordClosedCode(ctx, createId(3), startMs + closedCodeKeepMs);
    assert.deepEqual(readClosedCodes(ctx).map((entry) => entry.pairId), [createId(2), createId(3)]);
  });

  it('holds the newest fifty and no more', () => {
    for (let index = 0; index < 60; index += 1) recordClosedCode(ctx, createId(index), startMs + index);
    const closed = readClosedCodes(ctx);
    assert.equal(closed.length, 50);
    assert.equal(closed[0].pairId, createId(10));
    assert.equal(closed.at(-1)?.pairId, createId(59));
  });

  it('a file that cannot be used reads as none and says why through the hub\'s log; the next noting replaces it', () => {
    const file = path.join(ctx.dir, 'closed.json');
    fs.writeFileSync(file, '{ not json');
    assert.deepEqual(readClosedCodes(ctx), []);
    fs.writeFileSync(file, JSON.stringify({ closed: [{ pairId: 'not-an-id', closedAtMs: 1 }] }));
    assert.deepEqual(readClosedCodes(ctx), []);
    assert.deepEqual(logged, ['closed.json is not valid JSON; the codes in it read as expired', 'closed.json is invalid; the codes in it read as expired']);
    recordClosedCode(ctx, createId(1), startMs);
    assert.deepEqual(readClosedCodes(ctx), [{ pairId: createId(1), closedAtMs: startMs }]);
  });
});
