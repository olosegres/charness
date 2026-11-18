/**
 * @description The isolated instances of the flows host unix sockets (the private tmux server, a runner's link) under the run's
 * `TMPDIR`; a path over the 107 bytes Linux allows fails at connect with «File name too long» — which showed only as a flow that
 * timed out waiting for its agent or for a runner to come online. The layout now refuses such a `TMPDIR` up front and says why:
 *
 *   • a path that fits passes, one byte over is refused with the excess and the path in the message;
 *   • the tmux socket is the one the instance's env file really configures (most flows name none: tmux's own short «default»), and an instance
 *     whose socket would not fit is refused at its start, before charness is spawned;
 *   • the runner link's socket (its worst case: a 12-digit id and the gate's temporary suffix) is checked the same way.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertInstanceTmuxSocketFits, assertUnixSocketPathFits, createIsolatedInstanceLayout, getInstanceTmuxSocketPath, maxUnixSocketPathBytes, type IsolatedInstanceLayout } from './e2e/isolatedCharness';
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

describe('getInstanceTmuxSocketPath — where the instance\'s tmux server really listens', () => {
  const uid = process.getuid?.() ?? 0;

  it('is the private folder, the user\'s sub-folder and the socket name the env file names', () => {
    assert.equal(getInstanceTmuxSocketPath('A=1\nTMUX_TMPDIR=/p/tmux\nTMUX_SOCKET_NAME=mine\nB=2\n'), `/p/tmux/tmux-${uid}/mine`);
  });

  it('is tmux\'s own «default» when the file names no socket — what most flows get, however long their prefix', () => {
    assert.equal(getInstanceTmuxSocketPath('TMUX_TMPDIR=/p/tmux\n'), `/p/tmux/tmux-${uid}/default`);
  });

  it('is nothing when the instance has no private TMUX_TMPDIR: tmux then keeps its socket under /tmp', () => {
    assert.equal(getInstanceTmuxSocketPath('TMUX_SOCKET_NAME=mine\n'), null);
  });
});

describe('an isolated instance under a TMPDIR that is too long', () => {
  let layout: IsolatedInstanceLayout | null = null;
  const longDir = path.join(os.tmpdir(), `socket-path-${'x'.repeat(90)}`);

  afterEach(() => {
    if (layout) fs.rmSync(layout.testRoot, { recursive: true, force: true });
    layout = null;
  });

  it('is refused, before charness is spawned, when the env file puts the tmux server on a long socket name', () => {
    layout = createIsolatedInstanceLayout('charness-socket-test-', ['proj']);
    const envText = `TMUX_TMPDIR=${longDir}\nTMUX_SOCKET_NAME=${layout.tmuxSocketName}\n`;
    assert.throws(() => assertInstanceTmuxSocketFits(envText), /the instance's tmux server: its socket path would be \d+ bytes/);
  });

  it('is not refused for a long socket name it never uses: a flow whose env file names none keeps the short default', () => {
    layout = createIsolatedInstanceLayout('charness-socket-test-', ['proj']);
    assert.doesNotThrow(() => assertInstanceTmuxSocketFits(`TMUX_TMPDIR=${layout?.tmuxTmpDir}\n`));
  });

  it('the runner link of an instance whose HOME is deep is refused the same way', () => {
    assert.throws(() => assertRunnerLinkSocketFits(path.join(longDir, 'home')), /the runner link of the isolated instance: its socket path would be \d+ bytes/);
    assert.doesNotThrow(() => assertRunnerLinkSocketFits('/tmp/h'));
  });
});
