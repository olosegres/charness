/**
 * @description Whether a json-stream process adopted at boot runs a stale tool
 * list (lifecycle plan L4): a digest equal to the current build's → fresh; a
 * different or missing one → stale. Stale is only a fact the boot logs — the
 * process follows the normal idle lifecycle (compaction, then the stop).
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkIsAdoptedToolListStale } from '../utils/adoptedToolList';

describe('checkIsAdoptedToolListStale', () => {
  it('the same digest means the process got the current tools', () => {
    assert.equal(checkIsAdoptedToolListStale({ persistedDigest: 'd1', currentDigest: 'd1' }), false);
  });

  it('a different digest, or a row written before the digest was tracked, is stale', () => {
    assert.equal(checkIsAdoptedToolListStale({ persistedDigest: 'old', currentDigest: 'd1' }), true);
    assert.equal(checkIsAdoptedToolListStale({ persistedDigest: undefined, currentDigest: 'd1' }), true);
  });
});
