/**
 * @description How many times a json-stream session's end kills its tmux session. An explicit stop (`/quit`, the idle and
 * the per-turn stop, a backend switch) kills the host and waits for the process in `terminateSessionProcess`; the exit
 * bookkeeping must not kill it a second time, by name and not awaited — that second kill can run after the NEXT start
 * (a `/claude` right after `/quit`) created its own tmux session of the same name, and end it before its initialize
 * handshake ("the CLI exited before its initialize handshake (code=null)"). A process that dies by itself was never
 * killed by the bot: its end still removes the host.
 *
 * `tmux` is a recording stub first on PATH, so no server is touched. The adapter's private session map is reached via
 * bracket access, as in the other json-stream adapter tests; the session's process is a real `sleep`.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ClaudeJsonStreamAdapter, type StreamSession } from '../adapters/claudeJsonStreamAdapter';
import { keyToString } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { buildJsonStreamTmuxSessionName, getJsonStreamSessionPaths } from '../utils/jsonStreamHost';
import { getTmuxSessionTarget } from '../utils/tmuxExec';
import { createStreamSessionFixture } from './claudeJsonStreamSessionFixture';

const key = makeTelegramKey(-100999779, 79);
const stubTmuxName = 'tmux';
const killSessionArgument = 'kill-session';
/** How long after the end the test looks for a late, un-awaited kill: a process spawn is milliseconds, even loaded. */
const lateKillWindowMs = 400;

describe('a json-stream session end kills its tmux session', () => {
  let tmuxStubDir = '';
  let tmuxCallsFile = '';
  let originalPath: string | undefined;
  const sessionDirs: string[] = [];
  const children: ChildProcess[] = [];

  before(() => {
    tmuxStubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-tmux-stub-'));
    tmuxCallsFile = path.join(tmuxStubDir, 'calls.log');
    fs.writeFileSync(path.join(tmuxStubDir, stubTmuxName), `#!/bin/sh\necho "$*" >> '${tmuxCallsFile}'\n`, { mode: 0o755 });
    originalPath = process.env.PATH;
    process.env.PATH = `${tmuxStubDir}${path.delimiter}${originalPath ?? ''}`;
  });

  after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(tmuxStubDir, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(tmuxCallsFile, { force: true });
    for (const child of children.splice(0)) child.kill('SIGKILL');
    for (const dir of sessionDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function readKillSessionCalls(): string[] {
    if (!fs.existsSync(tmuxCallsFile)) return [];
    return fs.readFileSync(tmuxCallsFile, 'utf8').split('\n').filter((line) => line.split(' ').includes(killSessionArgument));
  }

  /** An adapter holding one live session whose process is a real `sleep`, so the stop has something to terminate. */
  function startSession(): { adapter: ClaudeJsonStreamAdapter; session: StreamSession; sessionProcess: ChildProcess } {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-stop-kill-'));
    sessionDirs.push(sessionDir);
    const sessionProcess = spawn('sleep', ['60'], { stdio: 'ignore' });
    children.push(sessionProcess);
    assert.ok(sessionProcess.pid, 'the session\'s process started');
    const adapter = new ClaudeJsonStreamAdapter();
    const session = createStreamSessionFixture({ key, pid: sessionProcess.pid, paths: getJsonStreamSessionPaths(sessionDir) });
    adapter['sessions'].set(keyToString(key), session);
    return { adapter, session, sessionProcess };
  }

  it('an explicit stop kills the tmux session once — the awaited kill — and no late second kill follows', async () => {
    const { adapter } = startSession();
    const stopped = new Promise<void>((resolve) => adapter.once('stopped', () => resolve()));
    adapter.stopSession(key);
    await stopped;
    await new Promise((resolve) => setTimeout(resolve, lateKillWindowMs));
    assert.deepEqual(readKillSessionCalls(), [`${killSessionArgument} -t ${getTmuxSessionTarget(buildJsonStreamTmuxSessionName(key))}`]);
  });

  it('a process that ended by itself still has its tmux session killed', async () => {
    const { adapter, session, sessionProcess } = startSession();
    const closed = new Promise<void>((resolve) => adapter.once('closed', () => resolve()));
    sessionProcess.kill('SIGKILL');
    adapter['finalizeExternalExit'](session, 137);
    await closed;
    await new Promise((resolve) => setTimeout(resolve, lateKillWindowMs));
    assert.deepEqual(readKillSessionCalls(), [`${killSessionArgument} -t ${getTmuxSessionTarget(buildJsonStreamTmuxSessionName(key))}`]);
  });
});
