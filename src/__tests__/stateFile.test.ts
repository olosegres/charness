/**
 * `stateFile.ts` — `state.json` as a plain object for the code that must not open the `StateStore`: what it returns
 * for a missing file, a file that is not JSON, one that is not an object, and a valid one.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readStateFileObject, stateFileName } from '../stateFile';

describe('readStateFileObject', () => {
  it('is the file\'s top-level object; an empty object for a missing, broken, array or scalar file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-file-'));
    try {
      assert.deepEqual(readStateFileObject(dir), {}, 'no file');
      fs.writeFileSync(path.join(dir, stateFileName), '{not json');
      assert.deepEqual(readStateFileObject(dir), {}, 'not JSON');
      fs.writeFileSync(path.join(dir, stateFileName), '[1, 2]');
      assert.deepEqual(readStateFileObject(dir), {}, 'an array');
      fs.writeFileSync(path.join(dir, stateFileName), '"text"');
      assert.deepEqual(readStateFileObject(dir), {}, 'a scalar');
      fs.writeFileSync(path.join(dir, stateFileName), JSON.stringify({ claudeProfiles: { work: { createdAt: '2026-10-01T00:00:00Z' } }, fallbackChain: [] }));
      assert.deepEqual(readStateFileObject(dir), { claudeProfiles: { work: { createdAt: '2026-10-01T00:00:00Z' } }, fallbackChain: [] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
