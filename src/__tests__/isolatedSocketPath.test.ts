/**
 * @description The isolated instances of the flows host unix sockets (the private tmux server, a runner's link) under the run's
 * `TMPDIR`; a path over the 107 bytes Linux allows fails at connect with «File name too long» — which showed only as a flow that
 * timed out waiting for its agent or for a runner to come online. The layout now refuses such a `TMPDIR` up front and says why:
 *
 *   • a path that fits passes, one byte over is refused with the excess and the path in the message;
 *   • a layout whose tmux socket would not fit is refused BEFORE any folder is created;
 *   • the runner link's socket (its worst case: a 12-digit id and the gate's temporary suffix) is checked the same way.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertUnixSocketPathFits, createIsolatedInstanceLayout, maxUnixSocketPathBytes } from './e2e/isolatedCharness';
import { assertRunnerLinkSocketFits } from './runnersTestKit';

describe('assertUnixSocketPathFits', () => {
  it('lets a path of exactly the limit through, and refuses one byte more — naming the excess and the path', () => {
    const fitting = `/${'a'.repeat(maxUnixSocketPathBytes - 1)}`;
    assert.equal(Buffer.byteLength(fitting), maxUnixSocketPathBytes);
    assert.doesNotThrow(() => assertUnixSocketPathFits(fitting, 'a socket'));
    assert.throws(() => assertUnixSocketPathFits(`${fitting}b`, 'a socket'), (error: Error) =>
      error.message.startsWith('a socket: its socket path would be 108 bytes, 1 over the 107') && error.message.includes(`${fitting}b`) && error.message.includes('shorter'));
  });

  it('counts bytes, not characters', () => {
    const multiByte = `/${'ж'.repeat(60)}`;
    assert.ok(multiByte.length < maxUnixSocketPathBytes && Buffer.byteLength(multiByte) > maxUnixSocketPathBytes);
    assert.throws(() => assertUnixSocketPathFits(multiByte, 'a socket'), /over the 107/);
  });
});

describe('an isolated instance under a TMPDIR that is too long', () => {
  const originalTmpDir = process.env.TMPDIR;
  const longTmpDir = path.join(os.tmpdir(), 'x'.repeat(90));

  afterEach(() => {
    if (originalTmpDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpDir;
  });

  it('is refused before anything is created: the tmux socket would not fit', () => {
    process.env.TMPDIR = longTmpDir;
    assert.throws(() => createIsolatedInstanceLayout('charness-socket-test-', ['proj']), /the isolated instance's tmux server: its socket path would be \d+ bytes/);
    assert.equal(fs.existsSync(longTmpDir), false, 'no folder was made on the way to the refusal');
  });

  it('the runner link of an instance whose HOME is deep is refused the same way', () => {
    assert.throws(() => assertRunnerLinkSocketFits(path.join(longTmpDir, 'home')), /the runner link of the isolated instance: its socket path would be \d+ bytes/);
    assert.doesNotThrow(() => assertRunnerLinkSocketFits('/tmp/h'));
  });
});
