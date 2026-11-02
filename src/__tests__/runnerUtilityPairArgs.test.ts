/**
 * @description `runnerUtility/pairArgs.ts`: the one option the admin line adds to `charness-runner pair` — taken out of the arguments
 * wherever it stands, so the older argument shapes (`--bootstrap …`, `<code> --package-id <id>`) parse exactly as before.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { serviceFollowsFlag, splitServiceFollowsFlag } from '../runnerUtility/pairArgs';

describe('pair arguments: --service-follows', () => {
  it('is taken out wherever it stands, and the rest keeps its order', () => {
    assert.equal(serviceFollowsFlag, '--service-follows');
    assert.deepEqual(splitServiceFollowsFlag(['--bootstrap', '/tmp/pkg', '--archive', '/tmp/a.tgz', '--package-id', 'abc', '--service-follows', 'cr1.code']), {
      rest: ['--bootstrap', '/tmp/pkg', '--archive', '/tmp/a.tgz', '--package-id', 'abc', 'cr1.code'],
      isServiceFollowing: true,
    });
    assert.deepEqual(splitServiceFollowsFlag(['cr1.code', '--package-id', 'abc', '--service-follows']), { rest: ['cr1.code', '--package-id', 'abc'], isServiceFollowing: true });
    assert.deepEqual(splitServiceFollowsFlag(['--service-follows', 'cr1.code']), { rest: ['cr1.code'], isServiceFollowing: true });
  });

  it('is absent unless given: the plain line\'s arguments come back untouched', () => {
    const plain = ['--bootstrap', '/tmp/pkg', '--archive', '/tmp/a.tgz', '--package-id', 'abc', 'cr1.code'];
    assert.deepEqual(splitServiceFollowsFlag(plain), { rest: plain, isServiceFollowing: false });
    assert.deepEqual(splitServiceFollowsFlag([]), { rest: [], isServiceFollowing: false });
  });

  it('does not take a pairing code that merely contains it', () => {
    assert.deepEqual(splitServiceFollowsFlag(['cr1.--service-follows']), { rest: ['cr1.--service-follows'], isServiceFollowing: false });
  });
});
