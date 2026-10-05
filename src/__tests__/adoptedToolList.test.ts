/**
 * @description The decision for a json-stream process adopted at boot (lifecycle
 * plan L4): a digest equal to the current build's → fresh; a different or
 * missing one → stale, stopped now when idle, else once it stops working (never
 * while it works, L-D2).
 *
 * Test case: N/A — TelegramCode has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideAdoptedToolListRefresh } from '../utils/adoptedToolList';

describe('decideAdoptedToolListRefresh', () => {
  it('the same digest means the process got the current tools: fresh, working or not', () => {
    assert.equal(decideAdoptedToolListRefresh({ persistedDigest: 'd1', currentDigest: 'd1', isWorking: false }), 'fresh');
    assert.equal(decideAdoptedToolListRefresh({ persistedDigest: 'd1', currentDigest: 'd1', isWorking: true }), 'fresh');
  });

  it('a different digest: stopped now when idle, stopped once idle when working', () => {
    assert.equal(decideAdoptedToolListRefresh({ persistedDigest: 'old', currentDigest: 'd1', isWorking: false }), 'stopNow');
    assert.equal(decideAdoptedToolListRefresh({ persistedDigest: 'old', currentDigest: 'd1', isWorking: true }), 'stopWhenIdle');
  });

  it('a row written before the digest was tracked reads as stale', () => {
    assert.equal(decideAdoptedToolListRefresh({ persistedDigest: undefined, currentDigest: 'd1', isWorking: false }), 'stopNow');
  });
});
