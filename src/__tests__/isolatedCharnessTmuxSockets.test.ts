/**
 * @description The flows' "one tmux server, the named one" check reads the sockets of the instance's private TMUX_TMPDIR
 * (`e2e/isolatedCharness.ts`), not every entry of the folder: tmux's own `<socket>.lock` — present while a client starts
 * the server, left behind by a client that lost that race — is no server. A real server stands in for the instance's.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getTmuxEnv, getTmuxSocketDir, listTmuxServerSocketNames } from './e2e/isolatedCharness';

const tmuxTmpDirPrefix = 'charness-socktest-';
const namedServerSocket = 'charness-socktest-named';
const defaultServerSocket = 'default';
const lockFileSuffix = '.lock';

const createdTmuxTmpDirs: string[] = [];

/** A private TMUX_TMPDIR (its own folder, so the user's tmux server is out of reach) holding one running server per name. */
function createTmuxTmpDirWithServers(serverSocketNames: readonly string[]): string {
  const tmuxTmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), tmuxTmpDirPrefix)));
  createdTmuxTmpDirs.push(tmuxTmpDir);
  for (const socketName of serverSocketNames) {
    // `default` is the socket of a call without `-L`.
    const socketArgs = socketName === defaultServerSocket ? [] : ['-L', socketName];
    const started = spawnSync('tmux', [...socketArgs, 'new-session', '-d', '-s', socketName, 'sleep', '60'], { env: getTmuxEnv(tmuxTmpDir), encoding: 'utf8' });
    assert.equal(started.status, 0, `the ${socketName} server started: ${started.stderr}`);
  }
  return tmuxTmpDir;
}

/** What a tmux client that lost the race to start the server leaves beside the live socket: an empty 0600 regular file. */
function plantLeftoverLock(tmuxTmpDir: string, socketName: string): void {
  fs.writeFileSync(path.join(getTmuxSocketDir(tmuxTmpDir), `${socketName}${lockFileSuffix}`), '', { mode: 0o600 });
}

describe('listTmuxServerSocketNames', () => {
  after(() => {
    for (const tmuxTmpDir of createdTmuxTmpDirs) {
      const socketDir = getTmuxSocketDir(tmuxTmpDir);
      // Every server is ended by its FULL socket path, never by name: a bare kill-server could reach the user's own.
      for (const socketName of fs.existsSync(socketDir) ? listTmuxServerSocketNames(tmuxTmpDir) : []) {
        spawnSync('tmux', ['-S', path.join(socketDir, socketName), 'kill-server'], { env: getTmuxEnv(null) });
      }
      fs.rmSync(tmuxTmpDir, { recursive: true, force: true });
    }
  });

  it('names the one running server', () => {
    const tmuxTmpDir = createTmuxTmpDirWithServers([namedServerSocket]);
    assert.deepEqual(listTmuxServerSocketNames(tmuxTmpDir), [namedServerSocket]);
  });

  it('does not count tmux\'s leftover lock beside the live socket as a second server', () => {
    const tmuxTmpDir = createTmuxTmpDirWithServers([namedServerSocket]);
    plantLeftoverLock(tmuxTmpDir, namedServerSocket);
    // The folder listing the check used to compare holds the lock too — the decoy is the very entry that failed the flows.
    assert.deepEqual(fs.readdirSync(getTmuxSocketDir(tmuxTmpDir)).sort(), [namedServerSocket, `${namedServerSocket}${lockFileSuffix}`]);
    assert.deepEqual(listTmuxServerSocketNames(tmuxTmpDir), [namedServerSocket]);
  });

  it('still counts a server started by a call without -L: the check still catches a missing -L', () => {
    const tmuxTmpDir = createTmuxTmpDirWithServers([namedServerSocket, defaultServerSocket]);
    plantLeftoverLock(tmuxTmpDir, defaultServerSocket);
    assert.deepEqual(listTmuxServerSocketNames(tmuxTmpDir).sort(), [namedServerSocket, defaultServerSocket]);
  });
});
