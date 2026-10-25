/**
 * @description The suite's private tmux (`globalTestSetup.ts`): a test process gets its own `TMUX_TMPDIR`, so neither it
 * nor what it spawns reaches the host's default tmux server (a live bot may run there); and on exit every server a test
 * left in that folder — the default socket and a named one — is ended by its full socket path before the folder goes.
 * Proven on decoys the test starts itself, inside a child process run under the setup; the host's servers are never
 * touched.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const setupPath = path.join(__dirname, 'globalTestSetup.ts');
/** The named socket the child starts besides the default one (`tmux -L`). */
const decoySocketName = 'decoy';
/** What the child runs: a server on the default socket and one on a named socket, each a detached `sleep`, then it exits. */
const childScript = [
  "const { spawnSync } = require('node:child_process');",
  "const start = (args) => spawnSync('tmux', [...args, 'new-session', '-d', 'sleep 600'], { stdio: 'ignore' });",
  "const pid = (args) => spawnSync('tmux', [...args, 'display-message', '-p', '#{pid}'], { encoding: 'utf8' }).stdout.trim();",
  'start([]);',
  `start(['-L', '${decoySocketName}']);`,
  `console.log(JSON.stringify({ tmuxTmpDir: process.env.TMUX_TMPDIR, pids: [pid([]), pid(['-L', '${decoySocketName}'])] }));`,
].join('\n');
/** Bounds the child: two tmux starts and its exit handler. */
const childTimeoutMs = 30 * 1000;

function checkIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('the suite\'s private tmux folder', () => {
  it('a test process gets its own TMUX_TMPDIR, and its exit ends every server it left there, then removes the folder', () => {
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--import', setupPath, '-e', childScript], {
      encoding: 'utf8',
      timeout: childTimeoutMs,
      env: { ...process.env, TMUX_TMPDIR: '' },
    });
    assert.equal(child.status, 0, child.stderr);
    const report: { tmuxTmpDir: string; pids: string[] } = JSON.parse(child.stdout.trim().split('\n').at(-1) ?? '{}');
    assert.match(report.tmuxTmpDir, /charness-test-tmux-/, 'a private folder, not the host default');
    const pids = report.pids.map(Number);
    assert.equal(pids.filter((pid) => Number.isInteger(pid) && pid > 0).length, 2, `both decoy servers started: ${JSON.stringify(report.pids)}`);
    assert.deepEqual(pids.filter(checkIsPidAlive), [], 'every decoy server was ended at exit, the named one included');
    assert.equal(fs.existsSync(report.tmuxTmpDir), false, 'the folder is gone');
  });
});
