/**
 * @description The shared rotating JSONL file behind the scheduler run ledger and
 * the request history: append, the one-backup rotation, reading back in order
 * (raw, or validated records), and the never-throw append.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import { RotatingJsonlFile } from '../utils/rotatingJsonlFile';

interface SampleRecord {
  n: number;
}

const smallMaxBytes = 40;

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-jsonl-'));
  filePath = path.join(dir, 'nested', 'log.jsonl');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('RotatingJsonlFile', () => {
  it('reads nothing when no file exists yet', async () => {
    assert.deepEqual(await new RotatingJsonlFile<SampleRecord>(filePath, smallMaxBytes).readLines(), []);
  });

  it('appends owner-only lines and reads them back, the rotated backup first', async () => {
    const file = new RotatingJsonlFile<SampleRecord>(filePath, smallMaxBytes);
    // A file rolls on the append AFTER it passes 40 bytes. Lines 1–9 are 8 bytes,
    // 10+ are 9: 1–6 (48) roll to `.1`, then 7–11 (42) roll over them (1–6 are
    // gone), and 12–14 stay live.
    for (let n = 1; n <= 14; n += 1) assert.equal(file.append({ n }), true);

    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    const numbers = (await file.readLines()).map((line): number => JSON.parse(line).n);
    assert.deepEqual(numbers, [7, 8, 9, 10, 11, 12, 13, 14]);
  });

  it('reads back the records a schema accepts and counts the lines it skips — one torn by a crash, another shape', async () => {
    const file = new RotatingJsonlFile<SampleRecord>(filePath, 1024);
    file.append({ n: 1 });
    fs.appendFileSync(filePath, '{"n": 2\n{"m": 3}\n');
    file.append({ n: 4 });
    assert.deepEqual(await file.readRecords(z.object({ n: z.number() })), { records: [{ n: 1 }, { n: 4 }], skippedCount: 2 });
  });

  it('reports a failed append instead of throwing', () => {
    fs.writeFileSync(path.join(dir, 'nested'), 'a file where the directory should be');
    assert.equal(new RotatingJsonlFile<SampleRecord>(filePath, smallMaxBytes).append({ n: 1 }), false);
  });
});
