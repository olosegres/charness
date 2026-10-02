/**
 * @description The shared rotating JSONL file behind the scheduler run ledger and
 * the request history: append, the one-backup rotation, reading back in order,
 * and the never-throw append.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
    // Each line is 8 bytes, so the file rolls once it holds 6 lines (48 > 40):
    // 1–6 roll to `.1`, 7–12 roll over them (1–6 are gone), 13–14 stay live.
    for (let n = 1; n <= 14; n += 1) assert.equal(file.append({ n }), true);

    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    const numbers = (await file.readLines()).map((line): number => JSON.parse(line).n);
    assert.deepEqual(numbers, [7, 8, 9, 10, 11, 12, 13, 14]);
  });

  it('reports a failed append instead of throwing', () => {
    fs.writeFileSync(path.join(dir, 'nested'), 'a file where the directory should be');
    assert.equal(new RotatingJsonlFile<SampleRecord>(filePath, smallMaxBytes).append({ n: 1 }), false);
  });
});
