/**
 * @description `remoteRun/jobId.ts`: the job id codec (`<runner>-<6 base32>`, stored as the Pueue label `rr-<id>`) and the project
 * slug (a name for the runner-side copy that two users, two hosts or two checkouts of one project never share).
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createJobId, getJobLabel, getProjectSlug, parseJobId } from '../remoteRun/jobId';

describe('job ids', () => {
  it('are the runner name, a dash and six base32 characters', () => {
    const id = createJobId('box1');
    assert.match(id, /^box1-[a-z2-7]{6}$/);
  });

  it('are made from the random bytes: the same bytes give the same id, other bytes another', () => {
    const fixed = (bytes: number[]) => () => Buffer.from(bytes);
    assert.equal(createJobId('box1', fixed([0, 0, 0, 0])), 'box1-aaaaaa');
    assert.equal(createJobId('box1', fixed([0, 0, 0, 1])), 'box1-baaaaa');
    assert.notEqual(createJobId('box1', fixed([1, 2, 3, 4])), createJobId('box1', fixed([4, 3, 2, 1])));
  });

  it('parse back to the runner, also for a runner name with dashes', () => {
    assert.deepEqual(parseJobId('box1-abc234'), { runnerName: 'box1' });
    assert.deepEqual(parseJobId('my-big-box-abc234'), { runnerName: 'my-big-box' });
    assert.deepEqual(parseJobId(createJobId('lab-mac')), { runnerName: 'lab-mac' });
  });

  it('refuse what is not an id: no suffix, a suffix of the wrong length or alphabet, uppercase, empty', () => {
    for (const text of ['', 'box1', 'box1-abc23', 'box1-abc2345', 'box1-abc!34', 'Box1-abc234', 'box1_abc234', '-abc234', 'box1-ABC234', 'box1-abc231']) {
      assert.equal(parseJobId(text), null, text);
    }
  });

  it('the Pueue label is rr- plus the id', () => {
    assert.equal(getJobLabel('box1-abc234'), 'rr-box1-abc234');
  });
});

describe('getProjectSlug', () => {
  const owner = { hostname: 'main-box', uid: 1001 };

  it('is the folder name and ten hex characters of the hash of host, user and root', () => {
    assert.match(getProjectSlug('/home/user/src/app', owner), /^app-[0-9a-f]{10}$/);
  });

  it('differs for another user, another host, another root with the same folder name — and is stable', () => {
    const slug = getProjectSlug('/home/user/src/app', owner);
    assert.equal(getProjectSlug('/home/user/src/app', owner), slug);
    assert.notEqual(getProjectSlug('/home/user/src/app', { ...owner, uid: 1002 }), slug);
    assert.notEqual(getProjectSlug('/home/user/src/app', { ...owner, hostname: 'other' }), slug);
    assert.notEqual(getProjectSlug('/home/other/src/app', owner), slug);
  });

  it('is always one safe path component, whatever the folder is called', () => {
    for (const root of ['/p/my project (copy)', '/p/.hidden', '/p/ünï', '/p/a'.padEnd(120, 'x'), '/']) {
      const slug = getProjectSlug(root, owner);
      assert.match(slug, /^[A-Za-z0-9_][A-Za-z0-9._-]*-[0-9a-f]{10}$/, root);
      assert.ok(slug.length <= 52, root);
    }
  });
});
