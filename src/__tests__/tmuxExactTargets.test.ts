/**
 * @description Exact tmux targets (Jira connector plan J1b). A bare `-t <name>`
 * falls back to a PREFIX match when no session has exactly that name, so with
 * topic 2's session gone a call for it reached topic 20's — and a Jira issue
 * `PROJ-1` sits next to `PROJ-12`. Proven against a REAL tmux server on a
 * PRIVATE socket (`tmux -L <unique>`), never the default server the live bot's
 * sessions run on; the server is killed at the end. Each case also runs the OLD
 * bare target, which must still reach the neighbour — that is the bug.
 *
 * A second check reads every source file under `src/`: each `-t` goes through
 * the helper matching its command's target kind, so a new call site cannot
 * reintroduce a bare name, nor hand a pane command a session target — which
 * tmux refuses and `tmuxAsync` swallows, dropping the keystroke silently.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { getTmuxPaneTarget, getTmuxSessionTarget } from '../utils/tmuxExec';

const execFileAsync = promisify(execFile);
const tmuxTimeoutMs = 5000;
const socketName = `tgcode-test-j1b-${process.pid}-${randomBytes(4).toString('hex')}`;

/** Sessions that stay alive; `cat` echoes what is typed into its pane. */
const topicSession = 'claude--1001111111111-20';
const issueSession = 'cjson-jira-PROJ-PROJ-12';
/** Their prefix neighbours, which do not exist. */
const goneTopicSession = 'claude--1001111111111-2';
const goneIssueSession = 'cjson-jira-PROJ-PROJ-1';

/** Run tmux on the private socket ONLY; resolves the exit status instead of throwing. */
async function runPrivateTmux(...args: string[]): Promise<{ isOk: boolean; stdout: string }> {
  try {
    const { stdout } = await execFileAsync('tmux', ['-L', socketName, ...args], { timeout: tmuxTimeoutMs });
    return { isOk: true, stdout: stdout.toString() };
  } catch {
    return { isOk: false, stdout: '' };
  }
}

async function startSession(name: string): Promise<void> {
  const { isOk } = await runPrivateTmux('new-session', '-d', '-s', name, '-x', '80', '-y', '20', 'cat');
  assert.ok(isOk, `could not start ${name} on the private tmux server`);
}

async function listSessionNames(): Promise<string[]> {
  const { stdout } = await runPrivateTmux('list-sessions', '-F', '#{session_name}');
  return stdout.split('\n').filter((name) => name !== '');
}

async function checkHasTmux(): Promise<boolean> {
  try {
    await execFileAsync('tmux', ['-V'], { timeout: tmuxTimeoutMs });
    return true;
  } catch {
    return false;
  }
}

const capturePane = async (sessionName: string): Promise<string> =>
  (await runPrivateTmux('capture-pane', '-t', getTmuxPaneTarget(sessionName), '-p')).stdout;

describe('exact tmux targets on a private tmux server', () => {
  let hasTmux = false;
  let socketPath = '';

  // Registered synchronously: node:test ignores a hook registered after an `await`.
  before(async () => {
    hasTmux = await checkHasTmux();
    if (!hasTmux) return;
    await startSession(topicSession);
    await startSession(issueSession);
    socketPath = (await runPrivateTmux('display-message', '-p', '#{socket_path}')).stdout.trim();
  });

  after(async () => {
    if (!hasTmux) return;
    await runPrivateTmux('kill-server');
    // A killed server leaves its socket file behind.
    if (socketPath !== '') fs.rmSync(socketPath, { force: true });
  });

  it('kill-session no longer kills a prefix neighbour; the bare name did', async (t) => {
    if (!hasTmux) {
      t.skip('tmux is not installed');
      return;
    }
    assert.equal((await runPrivateTmux('kill-session', '-t', getTmuxSessionTarget(goneIssueSession))).isOk, false);
    assert.ok((await listSessionNames()).includes(issueSession), 'the neighbour survives the exact target');

    assert.equal((await runPrivateTmux('kill-session', '-t', goneIssueSession)).isOk, true);
    assert.ok(!(await listSessionNames()).includes(issueSession), 'the old bare target killed the neighbour');
    await startSession(issueSession);

    assert.equal((await runPrivateTmux('kill-session', '-t', getTmuxSessionTarget(issueSession))).isOk, true);
    assert.ok(!(await listSessionNames()).includes(issueSession), 'the exact target kills its own session');
    await startSession(issueSession);
  });

  it('has-session no longer finds a prefix neighbour; the bare name did', async (t) => {
    if (!hasTmux) {
      t.skip('tmux is not installed');
      return;
    }
    assert.equal((await runPrivateTmux('has-session', '-t', getTmuxSessionTarget(goneTopicSession))).isOk, false);
    assert.equal((await runPrivateTmux('has-session', '-t', goneTopicSession)).isOk, true);
    assert.equal((await runPrivateTmux('has-session', '-t', getTmuxSessionTarget(topicSession))).isOk, true);
  });

  it('send-keys no longer types into a prefix neighbour; the bare name did', async (t) => {
    if (!hasTmux) {
      t.skip('tmux is not installed');
      return;
    }
    assert.equal((await runPrivateTmux('send-keys', '-t', getTmuxPaneTarget(goneTopicSession), '-l', 'exact-miss')).isOk, false);
    assert.equal((await runPrivateTmux('send-keys', '-t', goneTopicSession, '-l', 'bare-hit')).isOk, true);
    assert.equal((await runPrivateTmux('send-keys', '-t', getTmuxPaneTarget(topicSession), '-l', 'exact-hit')).isOk, true);

    const pane = await capturePane(topicSession);
    assert.ok(!pane.includes('exact-miss'), 'nothing typed through the exact target of a missing session');
    assert.ok(pane.includes('bare-hit'), 'the old bare target typed into the neighbour');
    assert.ok(pane.includes('exact-hit'), 'the exact pane target types into its own session');
  });

  it('the pane target serves every pane and window command, a session target does not', async (t) => {
    if (!hasTmux) {
      t.skip('tmux is not installed');
      return;
    }
    const paneTarget = getTmuxPaneTarget(topicSession);
    assert.match((await runPrivateTmux('display-message', '-p', '-t', paneTarget, '#{pane_width}x#{pane_height}')).stdout, /^80x20/);
    assert.match((await runPrivateTmux('list-panes', '-t', paneTarget, '-F', '#{pane_pid}')).stdout, /^\d+/);
    // Why panes need the trailing `:`.
    assert.equal((await runPrivateTmux('send-keys', '-t', getTmuxSessionTarget(topicSession), 'x')).isOk, false);
  });
});

describe('every tmux -t in the source names its target exactly', () => {
  const srcDir = path.join(__dirname, '..');
  const testDirName = path.basename(__dirname);
  const targetArgRe = /['"]-t['"],\s*([^,)]+)/g;
  const tmuxCommandRe = /tmux(?:Async|OrThrowAsync)\(\s*['"]([a-z-]+)['"]/g;
  /** Commands whose `-t` is a target-session; every other tmux command takes a pane or window. */
  const sessionTargetCommands = new Set(['kill-session', 'has-session']);

  function getSourceFiles(): string[] {
    return fs
      .readdirSync(srcDir, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts') && !file.startsWith(`${testDirName}${path.sep}`));
  }

  /** The tmux command a `-t` at `targetIndex` belongs to: the nearest tmux call opened before it. */
  function getTmuxCommandBefore(source: string, targetIndex: number): string | null {
    let command: string | null = null;
    for (const match of source.matchAll(tmuxCommandRe)) {
      if (match.index > targetIndex) break;
      command = match[1];
    }
    return command;
  }

  it('through the helper matching the command, getTmuxSessionTarget or getTmuxPaneTarget', () => {
    let targetCount = 0;
    for (const file of getSourceFiles()) {
      const source = fs.readFileSync(path.join(srcDir, file), 'utf8');
      for (const match of source.matchAll(targetArgRe)) {
        targetCount += 1;
        const command = getTmuxCommandBefore(source, match.index);
        const expectedHelper =
          command !== null && sessionTargetCommands.has(command) ? 'getTmuxSessionTarget' : 'getTmuxPaneTarget';
        const target = match[1].trim();
        assert.ok(
          target.startsWith(`${expectedHelper}(`),
          `${file}: tmux ${command ?? '<no tmux call>'} -t ${target} — name it with ${expectedHelper}`,
        );
      }
    }
    assert.ok(targetCount > 0, 'the scan found the tmux call sites');
  });
});
